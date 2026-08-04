"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    + "AppleWebKit/537.36 (KHTML, like Gecko) "
    + "Chrome/150.0.0.0 Safari/537.36";

function getCodeArgument(args) {
    const inlineArgument = args.find((arg) => arg.startsWith("--code="));

    if (inlineArgument) {
        return inlineArgument.slice("--code=".length).trim();
    }

    const codeIndex = args.indexOf("--code");
    if (codeIndex !== -1) {
        return (args[codeIndex + 1] || "").trim();
    }

    return "";
}

function askForCode() {
    const input = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        input.question("请输入番号：", (answer) => {
            input.close();
            resolve(answer.trim());
        });
    });
}

function decodeHtmlEntities(text) {
    const namedEntities = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: "\"",
    };

    return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, value) => {
        if (value.startsWith("#")) {
            const isHex = value[1].toLowerCase() === "x";
            const numberText = value.slice(isHex ? 2 : 1);
            const codePoint = Number.parseInt(numberText, isHex ? 16 : 10);

            return Number.isNaN(codePoint) ? entity : String.fromCodePoint(codePoint);
        }

        return namedEntities[value.toLowerCase()] ?? entity;
    });
}

function getClassNames(openingTag) {
    const classAttribute = openingTag.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    return classAttribute ? classAttribute[2].split(/\s+/) : [];
}

function getArticleResult(article, index) {
    const actressItems = article.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
    const actressItem = actressItems.find((item) => {
        const openingTag = item.match(/^<li\b[^>]*>/i)[0];
        return getClassNames(openingTag).includes("actress-name");
    });

    if (!actressItem) {
        throw new Error(`第 ${index + 1} 个 article.archive-list 中未找到 li.actress-name`);
    }

    const linkMatch = actressItem.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
        throw new Error("li.actress-name 中未找到 a 元素");
    }

    const actressName = decodeHtmlEntities(linkMatch[1].replace(/<[^>]*>/g, ""))
        .replace(/\s+/g, " ")
        .trim();

    if (!actressName) {
        throw new Error("li.actress-name 中的 a 文本为空");
    }

    const codeItem = actressItems.find((item) => {
        const iconTags = item.match(/<i\b[^>]*>/gi) || [];
        return iconTags.some((tag) => getClassNames(tag).includes("fa-circle-o"));
    });

    if (!codeItem) {
        throw new Error(`第 ${index + 1} 个 article.archive-list 中未找到番号`);
    }

    const code = decodeHtmlEntities(codeItem.replace(/<[^>]*>/g, ""))
        .replace(/\s+/g, " ")
        .trim();

    if (!code) {
        throw new Error(`第 ${index + 1} 个 article.archive-list 中的番号为空`);
    }

    return {
        code,
        actress_name: actressName,
    };
}

function getSearchResults(html) {
    const articles = (html.match(/<article\b[^>]*>[\s\S]*?<\/article>/gi) || [])
        .filter((article) => {
            const openingTag = article.match(/^<article\b[^>]*>/i)[0];
            return getClassNames(openingTag).includes("archive-list");
        });

    if (articles.length === 0) {
        throw new Error("页面中未找到 article.archive-list 元素");
    }

    return articles.map(getArticleResult);
}

async function getFetch() {
    if (typeof globalThis.fetch === "function") {
        return globalThis.fetch;
    }

    const {default: nodeFetch} = await import("node-fetch");
    return nodeFetch;
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

async function getSearchResultsWithBrowser(url) {
    const {chromium} = require("playwright-core");
    const executablePath = getBrowserExecutablePath();

    if (!executablePath) {
        throw new Error(
            "响应中没有 article，且未找到 Chrome/Edge；"
            + "请安装浏览器或设置 CHROME_PATH/EDGE_PATH/BROWSER_PATH",
        );
    }

    const browser = await chromium.launch({
        executablePath,
        headless: true,
    });

    try {
        const context = await browser.newContext({
            locale: "ja-JP",
            userAgent: BROWSER_USER_AGENT,
        });
        const page = await context.newPage();
        await page.goto(url.toString(), {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });
        const articles = page.locator("article.archive-list");
        await articles.first().waitFor({
            state: "attached",
            timeout: 30000,
        });

        return await articles.evaluateAll((articleNodes) => articleNodes.map((article, index) => {
            const actressName = (article.querySelector("li.actress-name a")?.textContent || "")
                .replace(/\s+/g, " ")
                .trim();
            const code = (Array.from(article.querySelectorAll("li"))
                .find((item) => item.querySelector("i.fa-circle-o"))?.textContent || "")
                .replace(/\s+/g, " ")
                .trim();

            if (!actressName) {
                throw new Error(`第 ${index + 1} 个 article.archive-list 中的女优名为空`);
            }
            if (!code) {
                throw new Error(`第 ${index + 1} 个 article.archive-list 中的番号为空`);
            }

            return {
                code,
                actress_name: actressName,
            };
        }));
    } finally {
        await browser.close();
    }
}

async function fetchSearchResults(url) {
    const fetch = await getFetch();
    const response = await fetch(url, {
        headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "accept-language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6,zh;q=0.5,zh-TW;q=0.4",
            priority: "u=0, i",
            "upgrade-insecure-requests": "1",
            "user-agent": BROWSER_USER_AGENT,
        },
    });

    if (response.ok) {
        const html = await response.text();
        try {
            return getSearchResults(html);
        } catch {
            // 可能是 HTTP 200 的验证页，交给真实浏览器加载并解析 DOM。
        }
    }

    return getSearchResultsWithBrowser(url);
}

async function main() {
    const codeArgument = getCodeArgument(process.argv.slice(2));
    const code = codeArgument || await askForCode();

    if (!code) {
        throw new Error("番号不能为空");
    }

    const url = new URL("https://av-wiki.net/");
    url.searchParams.set("s", code);

    const results = await fetchSearchResults(url);

    console.log(JSON.stringify(results));
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
