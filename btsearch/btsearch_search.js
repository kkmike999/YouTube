#!/usr/bin/env node

"use strict";

const {createHash, randomBytes} = require("node:crypto");
const https = require("node:https");

const BASE_URL = "https://www.btsearch.love";
const TIMEOUT = 45000;
const SEARCH_PAGE_SIZE = 100;
const DETAIL_CONCURRENCY = 4;
const ERROR_DEFINITIONS = Object.freeze({
    UNKNOWN: {code: "BTS001", exitCode: 1},
    ARGUMENT_INVALID: {code: "BTS002", exitCode: 2},
    SEARCH_FAILED: {code: "BTS020", exitCode: 20},
    PAGINATION_FAILED: {code: "BTS021", exitCode: 21},
    DETAIL_FAILED: {code: "BTS030", exitCode: 30},
    DETAIL_CONTENT_MISSING: {code: "BTS031", exitCode: 31},
    FILE_SIZE_INVALID: {code: "BTS032", exitCode: 32},
    NO_CANDIDATE: {code: "BTS040", exitCode: 40},
});

class ScriptError extends Error {
    constructor(definition, message, options = {}) {
        super(message, options);
        this.name = "ScriptError";
        this.code = definition.code;
        this.exitCode = definition.exitCode;
    }
}

function toScriptError(error, definition, message) {
    if (error instanceof ScriptError) return error;
    return new ScriptError(definition, `${message}: ${error.message}`, {cause: error});
}

function logDebug(message, value) {
    process.stderr.write(`[debug] ${message}${value === undefined ? "" : ` ${JSON.stringify(value)}`}\n`);
}

function parseArguments(argv) {
    let keyword = null;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        let value;
        if (argument === "--keyword") {
            value = argv[++index];
            if (value === undefined || value.startsWith("--")) {
                throw new ScriptError(ERROR_DEFINITIONS.ARGUMENT_INVALID, "--keyword 后必须提供关键词");
            }
        } else if (argument.startsWith("--keyword=")) {
            value = argument.slice("--keyword=".length);
        } else {
            throw new ScriptError(ERROR_DEFINITIONS.ARGUMENT_INVALID, `未知参数: ${argument}`);
        }
        if (keyword !== null) {
            throw new ScriptError(ERROR_DEFINITIONS.ARGUMENT_INVALID, "--keyword 只能指定一次");
        }
        keyword = value.trim();
    }
    if (!keyword) {
        throw new ScriptError(ERROR_DEFINITIONS.ARGUMENT_INVALID, "必须提供非空 --keyword 参数");
    }
    return keyword;
}

function parseFileSize(text) {
    const match = text.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|Byte|Bytes|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
    if (!match) {
        throw new ScriptError(ERROR_DEFINITIONS.FILE_SIZE_INVALID, `无法识别文件大小: ${text}`);
    }
    const powers = {b: 0, byte: 0, bytes: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4};
    const bytes = Number(match[1]) * (1024 ** powers[match[2].toLowerCase()]);
    if (!Number.isFinite(bytes)) {
        throw new ScriptError(ERROR_DEFINITIONS.FILE_SIZE_INVALID, `文件大小超出范围: ${text}`);
    }
    return bytes;
}

function isEligibleTitle(record, keyword) {
    return record.spans.some((span) => span.toUpperCase().includes(keyword.toUpperCase()))
        && !/-(AI|U|UC|C)$/i.test(record.title);
}

function createApiHeaders(params = {}) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(4).toString("hex");
    const parts = [`timestamp=${timestamp}`, `nonce=${nonce}`];
    for (const [key, value] of Object.entries(params)) {
        parts.push(`${key}=${value}`);
    }
    const sign = createHash("md5")
        .update(`${parts.sort().join("&")}&key=long2ice`, "utf8")
        .digest("hex").toUpperCase();
    return {"x-timestamp": timestamp, "x-nonce": nonce, "x-sign": sign};
}

function requestApi(endpoint, params = {}) {
    const url = new URL(endpoint, BASE_URL);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
    }
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {Accept: "application/json", ...createApiHeaders(params)},
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
                clearTimeout(timer);
                try {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        throw new Error(`接口 ${endpoint} 返回 ${response.statusCode}`);
                    }
                    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (payload?.error) throw new Error(`接口错误: ${payload.error}`);
                    resolve(payload);
                } catch (error) {
                    reject(error);
                }
            });
        });
        const timer = setTimeout(() => request.destroy(new Error(`接口请求超时: ${endpoint}`)), TIMEOUT);
        request.on("error", reject);
        request.on("close", () => clearTimeout(timer));
    });
}

function normalizeSearchText(html) {
    const entities = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "};
    return html.replace(/<[^>]*>/g, "")
        .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
            const key = entity.toLowerCase();
            if (!key.startsWith("#")) return entities[key];
            const codePoint = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
            return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
        })
        .replace(/\s+/g, " ").trim();
}

async function performSearch(keyword) {
    const records = new Map();
    const seenSignatures = new Set();
    let offset = 0;
    while (true) {
        let snapshot;
        try {
            const params = {
                keyword, limit: SEARCH_PAGE_SIZE, offset,
                mode: "", time: "", sort: "", sort_type: "asc", size: "",
            };
            const payload = await requestApi("/api/search", params);
            if (!Number.isSafeInteger(payload?.total) || payload.total < 0 || !Array.isArray(payload.data)) {
                throw new Error("搜索接口返回的 total 或 data 无效");
            }
            snapshot = {
                total: payload.total,
                signature: JSON.stringify(payload.data.map((item) => item.id)),
                records: payload.data.map((item) => {
                    if (!/^\d+$/.test(String(item.id)) || typeof item.name !== "string") {
                        throw new Error("搜索结果缺少有效的 id 或 name");
                    }
                    return {
                        id: item.id,
                        url: `${BASE_URL}/torrent/${item.id}`,
                        title: normalizeSearchText(item.name),
                        spans: Array.from(item.name.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi),
                            (match) => normalizeSearchText(match[1])),
                    };
                }),
            };
        } catch (error) {
            const definition = offset === 0 ? ERROR_DEFINITIONS.SEARCH_FAILED : ERROR_DEFINITIONS.PAGINATION_FAILED;
            throw toScriptError(error, definition, `读取搜索接口失败 offset=${offset}`);
        }
        if (seenSignatures.has(snapshot.signature)) {
            throw new ScriptError(ERROR_DEFINITIONS.PAGINATION_FAILED, "分页结果重复，无法确认已遍历全部记录");
        }
        seenSignatures.add(snapshot.signature);
        snapshot.records.forEach((record) => {
            if (!records.has(record.url)) records.set(record.url, record);
        });
        logDebug("读取搜索分页", {offset, total: snapshot.total, count: snapshot.records.length});
        if (offset + snapshot.records.length >= snapshot.total) break;
        if (snapshot.records.length === 0) {
            throw new ScriptError(ERROR_DEFINITIONS.PAGINATION_FAILED, "结果总数尚未遍历完成，但当前页为空");
        }
        offset += snapshot.records.length;
    }
    return Array.from(records.values()).filter((record) => isEligibleTitle(record, keyword));
}

function formatFileSize(value) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        throw new ScriptError(ERROR_DEFINITIONS.FILE_SIZE_INVALID, `无效的字节大小: ${value}`);
    }
    // 保留 API 的精确字节数，避免四舍五入影响最大文件的选择。
    return `${value} B`;
}

async function readDetail(record) {
    try {
        const payload = await requestApi(`/api/torrent/${record.id}`);
        const createdAt = new Date(payload?.created_at);
        if (String(payload?.id) !== String(record.id) || typeof payload?.name !== "string" || !payload.name.trim()
            || !/^[a-f\d]{40}$/i.test(payload?.hash || "") || !payload?.created_at
            || !Number.isFinite(createdAt.getTime()) || !Array.isArray(payload?.torrentfile)
            || payload.torrentfile.some((file) => typeof file?.name !== "string" || !file.name.trim())) {
            throw new ScriptError(ERROR_DEFINITIONS.DETAIL_CONTENT_MISSING, `详情必要字段或文件列表缺失: ${record.url}`);
        }
        const detail = {
            title: payload.name.replace(/\s+/g, " ").trim(),
            url: `${BASE_URL}/torrent/${record.id}`,
            size: formatFileSize(payload.size),
            date: createdAt.toLocaleDateString("zh-CN", {timeZone: "Asia/Shanghai"}),
            link: `magnet:?xt=urn:btih:${payload.hash}`,
            files: payload.torrentfile.map((file) => ({
                name: file.name.replace(/\s+/g, " ").trim(),
                size: formatFileSize(file.size),
            })),
        };
        logDebug("读取详情", {title: detail.title, fileCount: detail.files.length});
        return detail;
    } catch (error) {
        throw toScriptError(error, ERROR_DEFINITIONS.DETAIL_FAILED, `详情读取失败 ${record.url}`);
    }
}

async function readDetails(records) {
    const resources = new Array(records.length);
    let nextIndex = 0;
    let stopped = false;
    const worker = async () => {
        try {
            while (!stopped && nextIndex < records.length) {
                const index = nextIndex++;
                const record = records[index];
                resources[index] = {record, detail: await readDetail(record)};
            }
        } catch (error) {
            stopped = true;
            throw toScriptError(error, ERROR_DEFINITIONS.DETAIL_FAILED, "并发读取详情失败");
        }
    };
    const outcomes = await Promise.allSettled(
        Array.from({length: Math.min(DETAIL_CONCURRENCY, records.length)}, () => worker()),
    );
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed) {
        throw toScriptError(failed.reason, ERROR_DEFINITIONS.DETAIL_FAILED, "详情读取失败");
    }
    return resources;
}

function findBestSearchResult(resources, keyword, has4K, random = Math.random) {
    const upperKeyword = keyword.toUpperCase();
    const candidates = resources.flatMap((resource, resourceIndex) => resource.detail.files
        .map((file, fileIndex) => ({resource, resourceIndex, file, fileIndex}))
        .filter(({file}) => file.name.toUpperCase().includes(upperKeyword) && /\.mp4$/i.test(file.name))
        .map((candidate) => ({...candidate, sizeBytes: parseFileSize(candidate.file.size)})));
    if (!candidates.length) {
        throw new ScriptError(ERROR_DEFINITIONS.NO_CANDIDATE, "未找到包含关键词的有效 MP4 文件");
    }
    const largest = (items) => items.reduce((best, item) => item.sizeBytes > best.sizeBytes ? item : best);
    const randomResource = (items) => {
        const groups = new Map();
        items.forEach((item) => {
            const key = item.resource.record.url;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        });
        const pool = Array.from(groups.values());
        return largest(pool[Math.floor(random() * pool.length)]);
    };
    let selected;
    if (has4K) {
        const preferred = candidates.filter(({resource}) => /\[4K\]@R90s/i.test(resource.record.title));
        selected = largest(preferred.length ? preferred : candidates);
    } else {
        const first = candidates.filter(({file}) => /hhd800\.com/i.test(file.name));
        const second = candidates.filter(({file}) => /(?:4k688|489155|javkok)\.com/i.test(file.name));
        const third = candidates.filter(({file, resource}) => /madoubt\.com/i.test(file.name)
            || /SIS001/i.test(resource.record.title));
        selected = first.length ? largest(first)
            : second.length ? randomResource(second)
                : third.length ? randomResource(third) : largest(candidates);
    }
    logDebug("选中的 MP4", {name: selected.file.name, size: selected.file.size, url: selected.resource.record.url});
    return selected.resource.detail;
}

async function main() {
    const keyword = parseArguments(process.argv.slice(2));
    const records = await performSearch(keyword);
    const fourK = records.filter((record) => /4K/i.test(record.title));
    const has4K = fourK.length > 0;
    const eligible = has4K ? fourK : records;
    if (!eligible.length) {
        throw new ScriptError(ERROR_DEFINITIONS.NO_CANDIDATE, "未找到符合标题规则的资源");
    }
    logDebug("标题筛选完成", {count: records.length, fourKCount: fourK.length});
    const resources = await readDetails(eligible);
    const detail = findBestSearchResult(resources, keyword, has4K);
    const result = [{
        code: keyword,
        title: detail.title,
        url: detail.url,
        magnet: {name: detail.title, size: detail.size, date: detail.date, link: detail.link, files: detail.files},
    }];
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
}

if (require.main === module) {
    main().catch((error) => {
        const scriptError = toScriptError(error, ERROR_DEFINITIONS.UNKNOWN, "未分类错误");
        process.stderr.write(`[${scriptError.code}] 错误: ${scriptError.message}\n`);
        process.exitCode = scriptError.exitCode;
    });
}

module.exports = {
    ERROR_DEFINITIONS,
    parseArguments,
    parseFileSize,
    isEligibleTitle,
    createApiHeaders,
    performSearch,
    readDetail,
    readDetails,
    findBestSearchResult,
};
