#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const {chromium} = require("playwright-core");

const BASE_URL = "https://heimacili.org";
const SEARCH_RESULTS_TITLE_SUFFIX = "磁力链接与种子 - 黑马磁力";
const DETAIL_TITLE_SUFFIX = "磁力链接与种子详情 - 黑马磁力";

const ERROR_DEFINITIONS = Object.freeze({
    UNKNOWN: {code: "HMC001", exitCode: 1},
    KEYWORD_ARGUMENT_MISSING: {code: "HMC002", exitCode: 2},
    KEYWORD_ARGUMENT_DUPLICATE: {code: "HMC003", exitCode: 3},
    UNKNOWN_ARGUMENT: {code: "HMC004", exitCode: 4},
    KEYWORD_EMPTY: {code: "HMC005", exitCode: 5},
    BROWSER_NOT_FOUND: {code: "HMC010", exitCode: 10},
    BROWSER_LAUNCH_FAILED: {code: "HMC011", exitCode: 11},
    BROWSER_CLOSE_FAILED: {code: "HMC012", exitCode: 12},
    SEARCH_PAGE_LOAD_FAILED: {code: "HMC020", exitCode: 20},
    SEARCH_CONTROLS_NOT_FOUND: {code: "HMC021", exitCode: 21},
    SEARCH_SUBMIT_FAILED: {code: "HMC022", exitCode: 22},
    SEARCH_RESULTS_TIMEOUT: {code: "HMC023", exitCode: 23},
    MATCH_MENU_NOT_FOUND: {code: "HMC024", exitCode: 24},
    EXACT_MATCH_OPTION_NOT_FOUND: {code: "HMC025", exitCode: 25},
    EXACT_MATCH_SUBMIT_FAILED: {code: "HMC026", exitCode: 26},
    SEARCH_DOM_READ_FAILED: {code: "HMC027", exitCode: 27},
    MP4_NOT_FOUND: {code: "HMC030", exitCode: 30},
    FILE_SIZE_INVALID: {code: "HMC031", exitCode: 31},
    DETAIL_HREF_MISSING: {code: "HMC032", exitCode: 32},
    DETAIL_LINK_NOT_FOUND: {code: "HMC033", exitCode: 33},
    DETAIL_POPUP_FAILED: {code: "HMC040", exitCode: 40},
    DETAIL_RESULTS_TIMEOUT: {code: "HMC041", exitCode: 41},
    DETAIL_CONTENT_MISSING: {code: "HMC050", exitCode: 50},
    DETAIL_TITLE_MISSING: {code: "HMC051", exitCode: 51},
    DETAIL_METADATA_MISSING: {code: "HMC052", exitCode: 52},
    DETAIL_SIZE_MISSING: {code: "HMC053", exitCode: 53},
    DETAIL_DATE_MISSING: {code: "HMC054", exitCode: 54},
    MAGNET_MISSING: {code: "HMC055", exitCode: 55},
    DETAIL_DOM_READ_FAILED: {code: "HMC056", exitCode: 56},
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
    if (error instanceof ScriptError) {
        return error;
    }

    const detail = error?.message ? `: ${error.message}` : "";
    return new ScriptError(definition, `${message}${detail}`, {cause: error});
}

function logDebug(message, value) {
    const suffix = value === undefined
        ? ""
        : ` ${typeof value === "string" ? value : JSON.stringify(value)}`;
    process.stderr.write(`[debug] ${message}${suffix}\n`);
}

function parseArguments(argv) {
    let keyword = null;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === "--keyword") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                throw new ScriptError(
                    ERROR_DEFINITIONS.KEYWORD_ARGUMENT_MISSING,
                    "--keyword 后必须提供关键词",
                );
            }
            if (keyword !== null) {
                throw new ScriptError(
                    ERROR_DEFINITIONS.KEYWORD_ARGUMENT_DUPLICATE,
                    "--keyword 只能指定一次",
                );
            }
            keyword = value.trim();
            index += 1;
            continue;
        }

        if (argument.startsWith("--keyword=")) {
            if (keyword !== null) {
                throw new ScriptError(
                    ERROR_DEFINITIONS.KEYWORD_ARGUMENT_DUPLICATE,
                    "--keyword 只能指定一次",
                );
            }
            keyword = argument.slice("--keyword=".length).trim();
            continue;
        }

        throw new ScriptError(
            ERROR_DEFINITIONS.UNKNOWN_ARGUMENT,
            `未知参数: ${argument}`,
        );
    }

    return keyword;
}

function askForKeyword() {
    const prompt = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
    });

    return new Promise((resolve) => {
        prompt.question("请输入 keyword：", (answer) => {
            prompt.close();
            resolve(answer.trim());
        });
    });
}

function getBrowserExecutablePath() {
    const configuredPaths = [
        process.env.CHROME_PATH,
        process.env.EDGE_PATH,
        process.env.BROWSER_PATH,
    ];
    const installationRoots = [
        process.env.PROGRAMFILES,
        process.env["PROGRAMFILES(X86)"],
        process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const installedPaths = installationRoots.flatMap((root) => [
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);

    return [...configuredPaths, ...installedPaths]
        .find((candidate) => candidate && fs.existsSync(candidate));
}

function parseFileSize(sizeText) {
    const match = sizeText.trim().match(
        /^([0-9]+(?:\.[0-9]+)?)\s*(Byte|Bytes|KB|MB|GB|TB)$/i,
    );

    if (!match) {
        throw new ScriptError(
            ERROR_DEFINITIONS.FILE_SIZE_INVALID,
            `无法识别文件大小: ${sizeText}`,
        );
    }

    const unitPowers = {
        byte: 0,
        bytes: 0,
        kb: 1,
        mb: 2,
        gb: 3,
        tb: 4,
    };
    const value = Number.parseFloat(match[1]);
    const power = unitPowers[match[2].toLowerCase()];
    return value * (1024 ** power);
}

async function waitForSearchResultsPage(
    page,
    stage,
    errorDefinition = ERROR_DEFINITIONS.SEARCH_RESULTS_TIMEOUT,
) {
    logDebug(`${stage}，等待结果页 title:`, SEARCH_RESULTS_TITLE_SUFFIX);
    try {
        await page.waitForFunction(
            (titleSuffix) => document.title.trim().endsWith(titleSuffix),
            SEARCH_RESULTS_TITLE_SUFFIX,
            {
                polling: 500,
                timeout: 120000,
            },
        );
    } catch (error) {
        throw toScriptError(error, errorDefinition, `${stage}等待结果页超时`);
    }
    logDebug(`${stage}，结果页已就绪:`, {
        title: await page.title(),
        url: page.url(),
    });
}

async function openSelectedDetailPage(searchPage, selected) {
    const resultLists = searchPage.locator("ul.list-unstyled");
    const selectedList = resultLists.nth(selected.listIndex);
    const titleLink = selectedList.locator("a.result-resource-title.common-link");
    try {
        await titleLink.waitFor({state: "visible", timeout: 30000});
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.DETAIL_LINK_NOT_FOUND,
            "未找到可点击的详情标题",
        );
    }
    logDebug("点击详情标题:", {
        href: selected.href,
        listIndex: selected.listIndex,
    });

    let detailPage;
    try {
        [detailPage] = await Promise.all([
            searchPage.waitForEvent("popup", {timeout: 30000}),
            titleLink.click(),
        ]);
        await detailPage.waitForLoadState("domcontentloaded");
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.DETAIL_POPUP_FAILED,
            "点击详情标题或打开详情标签页失败",
        );
    }
    logDebug("详情标签页已打开:", {
        title: await detailPage.title(),
        url: detailPage.url(),
    });

    logDebug("等待详情页 title:", DETAIL_TITLE_SUFFIX);
    try {
        await detailPage.waitForFunction(
            (titleSuffix) => document.title.trim().endsWith(titleSuffix),
            DETAIL_TITLE_SUFFIX,
            {
                polling: 500,
                timeout: 120000,
            },
        );
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.DETAIL_RESULTS_TIMEOUT,
            "等待详情页 title 超时",
        );
    }
    logDebug("详情页已就绪:", {
        title: await detailPage.title(),
        url: detailPage.url(),
    });

    return detailPage;
}

async function performSearch(page, keyword) {
    const searchPageUrl = new URL("/search", BASE_URL).toString();
    logDebug("打开搜索页:", searchPageUrl);
    let initialResponse;
    try {
        initialResponse = await page.goto(searchPageUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.SEARCH_PAGE_LOAD_FAILED,
            "打开搜索页失败",
        );
    }
    logDebug("搜索页初始加载:", {
        status: initialResponse?.status() ?? null,
        title: await page.title(),
        url: page.url(),
    });

    const keywordInput = page.locator('#search-form input[name="keyword"]');
    const searchButton = page.locator("#search-form button.search-btn");
    logDebug("等待首页搜索控件:", {
        keywordInput: '#search-form input[name="keyword"]',
        searchButton: "#search-form button.search-btn",
    });
    try {
        await keywordInput.waitFor({state: "visible", timeout: 30000});
        await searchButton.waitFor({state: "visible", timeout: 30000});
        await keywordInput.fill(keyword);
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.SEARCH_CONTROLS_NOT_FOUND,
            "搜索框或搜索按钮不可用",
        );
    }
    logDebug("已填写搜索框:", keyword);

    let searchResponse;
    try {
        [searchResponse] = await Promise.all([
            page.waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: 30000,
            }),
            searchButton.click(),
        ]);
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.SEARCH_SUBMIT_FAILED,
            "点击搜索或等待首次导航失败",
        );
    }
    logDebug("首次搜索完成:", {
        status: searchResponse?.status() ?? null,
        title: await page.title(),
        url: page.url(),
    });
    await waitForSearchResultsPage(page, "首次搜索导航完成");

    const matchMenuButton = page.locator("#search-type");
    try {
        await matchMenuButton.waitFor({state: "visible", timeout: 30000});
        await matchMenuButton.click();
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.MATCH_MENU_NOT_FOUND,
            "搜索模式菜单不可用",
        );
    }
    logDebug("已展开搜索模式菜单");

    const exactMatchOption = page.locator(
        'ul[aria-labelledby="search-type"] a[onclick*="match"][onclick*="exact"]',
    );
    try {
        await exactMatchOption.waitFor({state: "visible", timeout: 30000});
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.EXACT_MATCH_OPTION_NOT_FOUND,
            "精准匹配选项不可用",
        );
    }
    let exactResponse;
    try {
        [exactResponse] = await Promise.all([
            page.waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: 30000,
            }),
            exactMatchOption.click(),
        ]);
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.EXACT_MATCH_SUBMIT_FAILED,
            "点击精准匹配或等待导航失败",
        );
    }
    await waitForSearchResultsPage(
        page,
        "精准匹配导航完成",
        ERROR_DEFINITIONS.EXACT_MATCH_SUBMIT_FAILED,
    );
    logDebug("已选择精准匹配:", {
        status: exactResponse?.status() ?? null,
        mode: (await page.locator("#so-match-btn").textContent())?.trim() || "",
        title: await page.title(),
        url: page.url(),
    });
}

async function findBestSearchResult(page) {
    let extraction;
    try {
        extraction = await page.locator("ul.list-unstyled").evaluateAll((lists) => {
        const normalizeText = (text) => (text || "").replace(/\s+/g, " ").trim();
        const results = [];
        let resourceFileCount = 0;
        let resultListCount = 0;

        lists.forEach((list, listIndex) => {
            const titleLink = list.querySelector("a.result-resource-title.common-link");
            if (!titleLink) {
                return;
            }

            resultListCount += 1;

            list.querySelectorAll("li.result-resource-file").forEach((file, fileIndex) => {
                resourceFileCount += 1;
                const sizeElement = file.querySelector(".result-resource-file-size");
                const nameElement = Array.from(file.children).find(
                    (child) => !child.classList.contains("result-resource-file-size"),
                );
                const fileName = normalizeText(nameElement?.textContent);
                const size = normalizeText(sizeElement?.textContent);

                if (!/\.mp4$/i.test(fileName) || !size) {
                    return;
                }

                results.push({
                    fileIndex,
                    fileName,
                    href: titleLink.getAttribute("href") || "",
                    listIndex,
                    size,
                });
            });
        });

        return {
            candidates: results,
            listUnstyledCount: lists.length,
            resourceFileCount,
            resultListCount,
        };
        });
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.SEARCH_DOM_READ_FAILED,
            "读取搜索结果 DOM 失败",
        );
    }

    const {candidates} = extraction;
    logDebug("搜索页 DOM 统计:", {
        listUnstyled: extraction.listUnstyledCount,
        resultLists: extraction.resultListCount,
        resourceFiles: extraction.resourceFileCount,
        mp4Candidates: candidates.length,
    });
    logDebug("MP4 候选:", candidates.map((candidate) => ({
        fileName: candidate.fileName,
        size: candidate.size,
        href: candidate.href,
    })));

    if (candidates.length === 0) {
        throw new ScriptError(
            ERROR_DEFINITIONS.MP4_NOT_FOUND,
            "搜索结果中未找到 MP4 文件",
        );
    }

    const preferred = candidates.filter((candidate) => /hhd800/i.test(candidate.fileName));
    const eligible = preferred.length > 0 ? preferred : candidates;
    logDebug("hhd800 候选数量:", preferred.length);

    const ranked = eligible.map((candidate) => ({
        ...candidate,
        sizeBytes: parseFileSize(candidate.size),
    }));
    ranked.sort((left, right) => (
        right.sizeBytes - left.sizeBytes
        || left.listIndex - right.listIndex
        || left.fileIndex - right.fileIndex
    ));

    const selected = ranked[0];
    if (!selected.href) {
        throw new ScriptError(
            ERROR_DEFINITIONS.DETAIL_HREF_MISSING,
            "选中的搜索结果缺少详情页链接",
        );
    }

    logDebug("选中的 MP4:", {
        fileName: selected.fileName,
        size: selected.size,
        sizeBytes: selected.sizeBytes,
        href: selected.href,
    });

    return selected;
}

async function readDetail(page) {
    let result;
    try {
        result = await page.evaluate(() => {
        const normalizeText = (text) => (text || "").replace(/\s+/g, " ").trim();
        const contentColumn = Array.from(
            document.querySelectorAll(".container-fluid > .row > .col-md-6"),
        ).find((column) => column.querySelector(":scope > h3"));

        if (!contentColumn) {
            return {
                errorKey: "DETAIL_CONTENT_MISSING",
                message: "详情页中未找到资源内容区域",
            };
        }

        const title = normalizeText(contentColumn.querySelector(":scope > h3")?.textContent);
        if (!title) {
            return {
                errorKey: "DETAIL_TITLE_MISSING",
                message: "详情页中未找到主标题",
            };
        }

        const detailPanel = Array.from(contentColumn.querySelectorAll(":scope > .panel"))
            .find((panel) => normalizeText(panel.querySelector(".panel-heading")?.textContent)
                === "资源详情");
        if (!detailPanel) {
            return {
                errorKey: "DETAIL_METADATA_MISSING",
                message: "详情页中未找到资源详情列表",
            };
        }

        const detailItems = Array.from(detailPanel.querySelectorAll("ul.list-unstyled > li"))
            .map((item) => normalizeText(item.textContent));
        const readField = (label) => {
            const prefixPattern = new RegExp(`^${label}[：:]\\s*(.+)$`);
            const item = detailItems.find((text) => prefixPattern.test(text));
            return item ? item.match(prefixPattern)[1].trim() : "";
        };
        const size = readField("文件大小");
        const date = readField("收录时间");
        const link = contentColumn.querySelector("a#magnet")?.getAttribute("href")?.trim() || "";

        if (!size) {
            return {
                errorKey: "DETAIL_SIZE_MISSING",
                message: "详情页中未找到文件大小",
            };
        }
        if (!date) {
            return {
                errorKey: "DETAIL_DATE_MISSING",
                message: "详情页中未找到收录时间",
            };
        }
        if (!link) {
            return {
                errorKey: "MAGNET_MISSING",
                message: "详情页中未找到磁力链接",
            };
        }

        return {title, size, date, link};
        });
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.DETAIL_DOM_READ_FAILED,
            "读取详情页 DOM 失败",
        );
    }

    if (result.errorKey) {
        throw new ScriptError(ERROR_DEFINITIONS[result.errorKey], result.message);
    }

    return result;
}

async function main() {
    const argumentKeyword = parseArguments(process.argv.slice(2));
    const keyword = argumentKeyword === null
        ? await askForKeyword()
        : argumentKeyword;

    if (!keyword) {
        throw new ScriptError(ERROR_DEFINITIONS.KEYWORD_EMPTY, "keyword 不能为空");
    }

    const executablePath = getBrowserExecutablePath();
    if (!executablePath) {
        throw new ScriptError(
            ERROR_DEFINITIONS.BROWSER_NOT_FOUND,
            "未找到 Chrome/Edge，请安装浏览器或设置 CHROME_PATH/EDGE_PATH/BROWSER_PATH",
        );
    }
    logDebug("浏览器路径:", executablePath);

    let browser;
    try {
        browser = await chromium.launch({
            executablePath,
            headless: false,
        });
    } catch (error) {
        throw toScriptError(
            error,
            ERROR_DEFINITIONS.BROWSER_LAUNCH_FAILED,
            "启动浏览器失败",
        );
    }

    try {
        const page = await browser.newPage();
        logDebug("搜索 keyword:", keyword);
        await performSearch(page, keyword);

        const selected = await findBestSearchResult(page);
        const detailPage = await openSelectedDetailPage(page, selected);
        const detail = await readDetail(detailPage);
        logDebug("详情字段:", {
            title: detail.title,
            size: detail.size,
            date: detail.date,
            hasMagnet: Boolean(detail.link),
        });
        const result = [{
            code: keyword,
            title: detail.title,
            url: detailPage.url(),
            magnet: {
                name: detail.title,
                size: detail.size,
                date: detail.date,
                link: detail.link,
            },
        }];

        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result;
    } finally {
        try {
            await browser.close();
        } catch (error) {
            throw toScriptError(
                error,
                ERROR_DEFINITIONS.BROWSER_CLOSE_FAILED,
                "关闭浏览器失败",
            );
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        const scriptError = error instanceof ScriptError
            ? error
            : toScriptError(error, ERROR_DEFINITIONS.UNKNOWN, "未分类错误");
        console.error(`[${scriptError.code}] 错误: ${scriptError.message}`);
        process.exitCode = scriptError.exitCode;
    });
}

module.exports = {
    findBestSearchResult,
    ERROR_DEFINITIONS,
    openSelectedDetailPage,
    parseArguments,
    parseFileSize,
    performSearch,
    readDetail,
    waitForSearchResultsPage,
};
