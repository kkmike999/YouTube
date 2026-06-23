#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

// 所有 HTTP 请求统一使用 15 秒超时，并携带浏览器标识和年龄验证 Cookie。
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  Referer: 'https://www.javbus.com/',
  Cookie: 'existmag=all; dv=1; age=verified',
};
// 支持常规番号（如 SONE-930、200GANA-3270）和数字下划线格式。
const CODE_PATTERN = /\d*[A-Za-z]+-\d+|\d+_\d+/;

// 缓存动态导入结果，避免每次请求都重新加载 ESM 格式的 node-fetch。
let fetchPromise;

/**
 * 从一行任意文本中提取第一个有效番号。
 *
 * @param {unknown} line 待检查的文本。
 * @returns {string|null} 提取到的番号；未匹配时返回 null。
 */
function extractCode(line) {
  const match = String(line).match(CODE_PATTERN);
  return match ? match[0] : null;
}

/**
 * 将带单位的文件大小转换为字节数，供磁力条目排序使用。
 *
 * @param {unknown} sizeString 文件大小，例如 1.5GB、500MB。
 * @returns {number} 换算后的字节数；格式无效时返回 0。
 */
function parseSize(sizeString) {
  const normalized = String(sizeString).toUpperCase().trim();
  const numberPart = normalized.match(/[\d.]+/);

  if (!numberPart) {
    return 0;
  }

  const value = Number.parseFloat(numberPart[0]);
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (normalized.includes('GB')) {
    return value * 1024 * 1024 * 1024;
  }
  if (normalized.includes('MB')) {
    return value * 1024 * 1024;
  }
  if (normalized.includes('KB')) {
    return value * 1024;
  }

  return value;
}

/**
 * 解码抓取结果中常见的 HTML 命名实体和数字实体。
 *
 * @param {unknown} value 包含 HTML 实体的内容。
 * @returns {string} 解码后的文本。
 */
function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00a0',
    quot: '"',
  };

  return String(value).replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi,
    (entity, name) => {
      if (name.startsWith('#')) {
        // 数字实体同时支持十进制（&#123;）和十六进制（&#x7b;）。
        const hexadecimal = name[1].toLowerCase() === 'x';
        const numberText = hexadecimal ? name.slice(2) : name.slice(1);
        const codePoint = Number.parseInt(numberText, hexadecimal ? 16 : 10);

        if (Number.isInteger(codePoint)) {
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return entity;
          }
        }
      }

      return namedEntities[name.toLowerCase()] ?? entity;
    },
  );
}

/**
 * 移除 HTML 标签、注释、脚本和样式，只保留可读文本。
 *
 * @param {unknown} html HTML 片段。
 * @returns {string} 清理并解码后的纯文本。
 */
function stripTags(html) {
  return decodeHtmlEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

/**
 * 从 HTML 片段中提取指定标签的属性字符串和内部 HTML。
 *
 * 这里只处理页面中结构简单且确定的 h3、tr、td、a 标签，
 * 不承担通用 HTML DOM 解析器的职责。
 *
 * @param {string} html HTML 片段。
 * @param {string} tagName 要提取的标签名。
 * @returns {Array<{attributes: string, innerHtml: string}>} 匹配到的元素。
 */
function extractElements(html, tagName) {
  const pattern = new RegExp(
    `<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}\\s*>`,
    'gi',
  );
  const elements = [];
  let match;

  while ((match = pattern.exec(html)) !== null) {
    elements.push({
      attributes: match[1],
      innerHtml: match[2],
    });
  }

  return elements;
}

/**
 * 从标签属性字符串中读取指定属性，兼容单双引号和无引号值。
 *
 * @param {string} attributes 标签的原始属性字符串。
 * @param {string} name 属性名。
 * @returns {string} 解码后的属性值；不存在时返回空字符串。
 */
function getAttribute(attributes, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const match = String(attributes).match(pattern);

  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/**
 * 获取元素自身的直接文本，排除嵌套标签中的文字。
 *
 * JAVBus 的首个链接内可能嵌套标记；磁力名称只应读取链接自身文本，
 * “高清”等附加标签需要单独判断。
 *
 * @param {string} html 元素内部 HTML。
 * @returns {string} 解码后的直接文本。
 */
function getDirectText(html) {
  const tokens = String(html).split(/(<[^>]+>)/g);
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  let depth = 0;
  let text = '';

  // 通过标签深度判断文本是否直接属于当前元素。
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (depth === 0) {
        text += token;
      }
      continue;
    }

    if (/^<\s*\//.test(token)) {
      depth = Math.max(0, depth - 1);
      continue;
    }

    const tagMatch = token.match(/^<\s*([A-Za-z][\w:-]*)/);
    if (
      tagMatch &&
      !token.endsWith('/>') &&
      !voidTags.has(tagMatch[1].toLowerCase())
    ) {
      depth += 1;
    }
  }

  return decodeHtmlEntities(text).trim();
}

/**
 * 判断名称是否包含字母且所有字母均为大写。
 *
 * @param {string} name 磁力名称。
 * @returns {boolean} 是否符合 Python str.isupper() 的主要行为。
 */
function isUpperCaseName(name) {
  return name.toLowerCase() !== name.toUpperCase() && name === name.toUpperCase();
}

/**
 * 从非空磁力数组中选出文件大小最大的条目。
 *
 * @param {Array<{sizeBytes: number}>} magnets 磁力条目。
 * @returns {object} 文件大小最大的条目。
 */
function maxBySize(magnets) {
  return magnets.reduce((largest, magnet) =>
    magnet.sizeBytes > largest.sizeBytes ? magnet : largest,
  );
}

/**
 * 解析 AJAX 返回的磁力表格，并按既定优先级选择最佳磁力。
 *
 * 筛选顺序：
 * 1. 有 4K 条目时，选择其中体积最大的条目。
 * 2. 否则从后向前选择首个“名称全大写且带高清链接”的条目。
 * 3. 仍未匹配时，选择所有条目中体积最大的条目。
 *
 * @param {string} html 包含 tr 表格行的 HTML 片段。
 * @returns {object|null} 最佳磁力条目；没有有效数据时返回 null。
 */
function getBestMagnet(html) {
  const magnets = [];

  // 每行前三列依次为磁力名称、文件大小和分享日期。
  for (const row of extractElements(html, 'tr')) {
    const columns = extractElements(row.innerHtml, 'td');
    if (columns.length < 3) {
      continue;
    }

    const links = extractElements(columns[0].innerHtml, 'a');
    if (links.length === 0) {
      continue;
    }

    const name = getDirectText(links[0].innerHtml);
    const sizeString = stripTags(columns[1].innerHtml);

    // 第一个链接是磁力链接，后续链接用于判断是否存在“高清”标记。
    magnets.push({
      name,
      sizeStr: sizeString,
      sizeBytes: parseSize(sizeString),
      date: stripTags(columns[2].innerHtml),
      link: getAttribute(links[0].attributes, 'href'),
      nameIsUpper: isUpperCaseName(name),
      hasHdLink: links
        .slice(1)
        .some((link) => stripTags(link.innerHtml) === '高清'),
    });
  }

  if (magnets.length === 0) {
    return null;
  }

  // 排除磁力名称中带有 "-C" 的条目（通常为非正片内容）。
  const filteredMagnets = magnets.filter(
    (magnet) => !magnet.name.includes('-C '),
  );

  const candidates = filteredMagnets.length > 0 ? filteredMagnets : magnets;

  const fourKMagnets = candidates.filter((magnet) =>
    magnet.name.toUpperCase().includes('4K'),
  );
  if (fourKMagnets.length > 0) {
    return maxBySize(fourKMagnets);
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index].nameIsUpper && candidates[index].hasHdLink) {
      return candidates[index];
    }
  }

  return maxBySize(candidates);
}

/**
 * 延迟加载 ESM 格式的 node-fetch，并复用同一个导入 Promise。
 *
 * @returns {Promise<Function>} node-fetch 的默认导出函数。
 */
async function getFetch() {
  if (!fetchPromise) {
    fetchPromise = import('node-fetch').then((module) => module.default);
  }

  return fetchPromise;
}

/**
 * 发送带统一请求头和超时控制的 GET 请求，并读取响应文本。
 *
 * @param {string} url 请求地址。
 * @returns {Promise<{status: number, text: string}>} HTTP 状态码和响应正文。
 */
async function fetchText(url) {
  const fetch = await getFetch();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // AbortController 在超时后主动终止请求，避免单个番号长期阻塞。
    const response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: controller.signal,
    });
    const text = await response.text();

    return {
      status: response.status,
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 获取单个番号的标题、详情页地址和最佳磁力信息。
 *
 * 先访问详情页提取标题及 AJAX 参数，再请求磁力表格片段进行筛选。
 *
 * @param {string} code 番号。
 * @returns {Promise<{title: string, url: string, magnet: object|null}>} 抓取结果。
 */
async function getJavInfo(code) {
  const url = `https://www.javbus.com/${code}`;
  console.log(`访问 ${url} ...`);

  try {
    const response = await fetchText(url);
    if (response.status !== 200) {
      return {
        title: `请求失败: ${response.status}`,
        url,
        magnet: null,
      };
    }

    const titleElement = extractElements(response.text, 'h3')[0];
    const title = titleElement ? stripTags(titleElement.innerHtml) : '未找到标题';
    const gidMatch = response.text.match(/var gid = (\d+);/);
    const ucMatch = response.text.match(/var uc = (\d+);/);
    const imageMatch = response.text.match(/var img = '([^']+)';/);
    let magnet = null;

    if (gidMatch && ucMatch && imageMatch) {
      // AJAX 接口依赖详情页脚本中的 gid、uc、img 参数。
      const query = new URLSearchParams({
        gid: gidMatch[1],
        lang: 'zh',
        img: imageMatch[1],
        uc: ucMatch[1],
        floor: String((Date.now() % 1000) + 1),
      });
      const ajaxUrl =
        `https://www.javbus.com/ajax/uncledatoolsbyajax.php?${query.toString()}`;

      try {
        const ajaxResponse = await fetchText(ajaxUrl);
        if (ajaxResponse.status === 200) {
          magnet = getBestMagnet(ajaxResponse.text);
        }
      } catch (error) {
        console.log(`获取磁力链接失败: ${error.message}`);
      }
    }

    return { title, url, magnet };
  } catch (error) {
    console.error(`获取 ${code} 信息时发生错误: ${error.message}`);
    return null;
  }
}

/**
 * 打印命令行用法和支持的参数。
 *
 * @returns {void}
 */
function printUsage() {
  console.log(`用法:
  node jav/jav_scraper.js --番号 SONE-930
  node jav/jav_scraper.js --番号 SONE-930 ABC-123
  node jav/jav_scraper.js

选项:
  --番号 <番号...>  可指定多个番号；未指定时读取当前目录的 content.txt
  --help, -h        显示帮助`);
}

/**
 * 解析命令行参数，收集 --番号 后面的一个或多个值。
 *
 * @param {string[]} argv 不包含 node 和脚本路径的参数数组。
 * @returns {{help: boolean, codeArguments: string[]}} 参数解析结果。
 * @throws {Error} 遇到未知参数或未放在 --番号 后的普通参数时抛出。
 */
function parseArgs(argv) {
  const codes = [];
  let readingCodes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      return { help: true, codeArguments: [] };
    }

    if (argument === '--番号') {
      readingCodes = true;
      continue;
    }

    if (argument.startsWith('--番号=')) {
      readingCodes = true;
      codes.push(argument.slice('--番号='.length));
      continue;
    }

    if (argument.startsWith('-')) {
      throw new Error(`未知参数: ${argument}`);
    }

    if (!readingCodes) {
      throw new Error(`未知参数: ${argument}`);
    }

    codes.push(argument);
  }

  return { help: false, codeArguments: codes };
}

/**
 * 清理 Markdown 表格单元格中的分隔符和换行符。
 *
 * @param {unknown} value 单元格内容。
 * @returns {string} 可安全写入表格的文本。
 */
function escapeTableCell(value) {
  return String(value).replace(/\|/g, '-').replace(/\r?\n/g, ' ');
}

/**
 * 将表头和二维数据格式化为 GitHub 风格 Markdown 表格。
 *
 * @param {unknown[][]} rows 表格数据。
 * @param {string[]} headers 表头。
 * @returns {string} 完整 Markdown 表格。
 */
function formatMarkdownTable(rows, headers) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  for (const row of rows) {
    lines.push(`| ${row.map(escapeTableCell).join(' | ')} |`);
  }

  return lines.join('\n');
}

/**
 * 异步等待指定时间，用于降低连续请求频率。
 *
 * @param {number} milliseconds 等待毫秒数。
 * @returns {Promise<void>} 等待结束后完成的 Promise。
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * jav_scraper.js 命令行入口。
 *
 * 优先使用 --番号 参数；没有参数时从当前工作目录的 content.txt 逐行读取。
 * 抓取完成后生成 result.md，并在末尾附加成功获取的磁力链列表。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  let codes = [];
  if (args.codeArguments.length > 0) {
    // 参数中可能包含额外说明，因此仍通过 extractCode 提取标准番号。
    codes = args.codeArguments.map(extractCode).filter(Boolean);
    if (codes.length === 0) {
      console.log('错误：未从 --番号 参数中提取到有效番号。');
      return;
    }
  } else {
    // 与原 Python 脚本保持一致：content.txt 使用当前工作目录定位。
    const contentPath = path.resolve('content.txt');
    let content;

    try {
      content = fs.readFileSync(contentPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('错误：未找到 content.txt 文件，请确保该文件在同一目录下。');
      } else {
        console.log(`读取文件出错: ${error.message}`);
      }
      return;
    }

    codes = content
      .split(/\r?\n/)
      .map(extractCode)
      .filter(Boolean);
    if (codes.length === 0) {
      console.log('未在 content.txt 中提取到任何番号。');
      return;
    }
  }

  console.log('开始获取数据...\n');
  console.log('| 番号 | 标题 |');
  console.log('|---|---|');

  const rows = [];
  const magnetLinks = [];

  // 串行抓取并间隔一秒，避免短时间内向目标站点发送大量请求。
  for (const code of codes) {
    const { title, url, magnet } = await getJavInfo(code);
    const cleanTitle = escapeTableCell(title);

    if (magnet) {
      rows.push([
        code,
        cleanTitle,
        url,
        escapeTableCell(magnet.name),
        magnet.sizeStr,
        magnet.date,
        magnet.link,
      ]);
      magnetLinks.push(magnet.link);
    } else {
      rows.push([code, cleanTitle, url, '未找到磁力', '-', '-', '-']);
    }

    console.log(`| ${code} | ${cleanTitle} |`);
    await sleep(1000);
  }

  const headers = [
    '番号',
    '标题',
    '链接',
    '磁力名稱',
    '檔案大小',
    '分享日期',
    '磁力链',
  ];
  let output = formatMarkdownTable(rows, headers);

  if (magnetLinks.length > 0) {
    output += `\n\n-----磁力链列表-----\n\n${magnetLinks.join('\n')}\n`;
  }

  const outputFile = 'result.md';
  fs.writeFileSync(outputFile, output, 'utf8');
  console.log(`\n完成！结果已保存至 ${outputFile}`);
}

// 仅在直接执行此文件时运行 CLI；被 jav_magnet.js 引用时只导出公共方法。
if (require.main === module) {
  main().catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}

// 提供给 jav_magnet.js 及后续测试代码复用。
module.exports = {
  extractCode,
  getBestMagnet,
  getJavInfo,
  parseSize,
};
