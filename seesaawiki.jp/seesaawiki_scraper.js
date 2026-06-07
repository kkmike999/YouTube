const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(
    /&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi,
    (entity, code) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return namedEntities[code.toLowerCase()] ?? entity;
    },
  );
}

function getAttribute(tag, attributeName) {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attributePattern = new RegExp(
    `\\s${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = tag.match(attributePattern);
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function stripTags(value) {
  return decodeHtmlEntities(
    value
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function getFirstTextNode(value) {
  const withoutIgnoredContent = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const textParts = withoutIgnoredContent
    .split(/<[^>]+>/)
    .map((part) => decodeHtmlEntities(part).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return textParts[0] ?? "";
}

function cleanCellHtml(cellHtml) {
  return cellHtml
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\|/g, "&#124;")
    .trim();
}

function findTitle(html) {
  const divPattern = /<div\b([^>]*)>([\s\S]*?)<\/div>/gi;
  for (const match of html.matchAll(divPattern)) {
    const openingTag = `<div${match[1]}>`;
    const classNames = getAttribute(openingTag, "class").split(/\s+/);
    if (!classNames.includes("title")) {
      continue;
    }

    const headingMatch = match[2].match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (headingMatch) {
      return stripTags(headingMatch[1]);
    }
  }
  return "";
}

function findTableHtml(html, tableId) {
  const tablePattern = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  for (const match of html.matchAll(tablePattern)) {
    const openingTag = `<table${match[1]}>`;
    if (getAttribute(openingTag, "id") === tableId) {
      return match[2];
    }
  }
  return "";
}

function extractRows(tableHtml) {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(
    (match) => match[1],
  );
}

function extractCells(rowHtml) {
  return [
    ...rowHtml.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi),
  ].map((match) => match[1]);
}

function extractLinks(cellHtml) {
  return [...cellHtml.matchAll(/<a\b[^>]*>/gi)]
    .map((match) => getAttribute(match[0], "href"))
    .filter(Boolean);
}

function extractImageSource(cellHtml) {
  const imageTag = cellHtml.match(/<img\b[^>]*>/i);
  return imageTag ? getAttribute(imageTag[0], "src").trim() : "";
}

function updateMonthlyJson(mdDir, yearMonth, coverCandidates, mdFilename) {
  const monthlyJsonPath = path.join(mdDir, "monthly.json");
  const randomCover =
    coverCandidates.length > 0
      ? coverCandidates[Math.floor(Math.random() * coverCandidates.length)]
      : "";
  const newItem = {
    year_month: yearMonth,
    cover: randomCover,
    url: `/md/${mdFilename}`,
  };

  let monthlyData = [];
  if (fs.existsSync(monthlyJsonPath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(monthlyJsonPath, "utf8"));
      if (Array.isArray(loaded)) {
        monthlyData = loaded;
      }
    } catch {
      monthlyData = [];
    }
  }

  if (
    monthlyData.some(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        item.year_month === yearMonth,
    )
  ) {
    return false;
  }

  monthlyData.unshift(newItem);
  fs.writeFileSync(
    monthlyJsonPath,
    `${JSON.stringify(monthlyData, null, 2)}\n`,
    "utf8",
  );
  return true;
}

async function fetchPageHtml(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const pageBytes = await response.arrayBuffer();
  return new TextDecoder("euc-jp").decode(pageBytes);
}

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    let url = process.argv[2]?.trim() ?? "";
    if (!url) {
      console.log("Usage: node seesaawiki_scraper.js <url>");
      url = (await rl.question("请输入 URL: ")).trim();
      if (!url) {
        console.log("未输入 URL，退出。");
        return;
      }
    }

    console.log(`Fetching ${url}`);
    const html = await fetchPageHtml(url);

    const title = findTitle(html);
    const pageTitle = title || "未知标题";
    if (!title) {
      console.log("Could not find title node.");
    }

    const normalizedTitle = pageTitle.replace(
      /^(\d{4})~~(\d{1,2})月$/,
      (_, year, month) => `${year}_${String(Number(month)).padStart(2, "0")}`,
    );
    const safeTitle = normalizedTitle.replace(/[\\/*?:"<>|]/g, "");
    console.log(`Title processing: '${pageTitle}' -> '${safeTitle}'`);

    const tableHtml = findTableHtml(html, "content_block_1");
    if (!tableHtml) {
      console.log("Could not find table #content_block_1");
      return;
    }

    const mdLines = [
      "| 女友名 | 出道作品封面 | 作品海报 | 女优详情链接 | javbus | missav | ",
      "| --- | --- | --- | --- | --- | --- |",
    ];
    const coverCandidates = [];

    for (const rowHtml of extractRows(tableHtml)) {
      const cells = extractCells(rowHtml);
      if (cells.length < 5) {
        continue;
      }

      const actressName = getFirstTextNode(cells[0]).replace(
        /\|/g,
        "&#124;",
      );
      const coverHtml = cleanCellHtml(cells[1]);
      const posterHtml = cleanCellHtml(cells[2]);
      const coverSource = extractImageSource(cells[1]);
      if (coverSource) {
        coverCandidates.push(coverSource);
      }

      const detailLinks = extractLinks(cells[4]);
      const actressLink = detailLinks[2] ?? "";
      if (!actressName && !actressLink && !coverHtml && !posterHtml) {
        continue;
      }

      const javbusLink = `https://www.javbus.com/search/${actressName}`;
      const missavLink = `https://missav.live/search/${actressName}`;
      mdLines.push(
        `| ${actressName} | ${coverHtml} | ${posterHtml} | [seesaawiki](${actressLink}) | [javbus](${javbusLink}) | [missav](${missavLink}) | `,
      );
    }

    const outDir = path.join(__dirname, "html", "md");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${safeTitle}.md`);
    fs.writeFileSync(outPath, `${mdLines.join("\n")}\n`, "utf8");

    const confirmUpdate = (
      await rl.question("是否更新 monthly.json？[y/N]: ")
    )
      .trim()
      .toLowerCase();
    if (confirmUpdate === "y" || confirmUpdate === "yes") {
      const updated = updateMonthlyJson(
        outDir,
        safeTitle,
        coverCandidates,
        path.basename(outPath),
      );
      if (updated) {
        console.log(
          `Updated monthly json: ${path.join(outDir, "monthly.json")}`,
        );
      } else {
        console.log(
          `monthly.json 已存在 year_month=${safeTitle}，未做更新。`,
        );
      }
    } else {
      console.log("已跳过更新 monthly.json。");
    }

    console.log(`Successfully generated markdown at: ${outPath}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`运行失败: ${error.message}`);
  process.exitCode = 1;
});
