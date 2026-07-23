#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { extractCode, getJavInfo } = require('./jav_scraper');

/**
 * 打印命令行用法和支持的参数。
 *
 * @returns {void}
 */
function printUsage() {
  console.log(`用法:
  node jav/jav_magnet.js --番号 SONE-930
  node jav/jav_magnet.js --番号 SONE-930 ABC-123
  node jav/jav_magnet.js

选项:
  --番号 <番号...>  可指定多个番号；未指定时提示输入
  --help, -h        显示帮助`);
}

/**
 * 解析 --番号 参数及其后续的一个或多个番号。
 *
 * @param {string[]} argv 不包含 node 和脚本路径的参数数组。
 * @returns {{help: boolean, codeArguments: string[]}} 参数解析结果。
 * @throws {Error} 遇到未知参数或位置错误的普通参数时抛出。
 */
function parseArgs(argv) {
  const codeArguments = [];
  let readingCodes = false;

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      return { help: true, codeArguments: [] };
    }

    if (argument === '--番号') {
      readingCodes = true;
      continue;
    }

    if (argument.startsWith('--番号=')) {
      readingCodes = true;
      codeArguments.push(argument.slice('--番号='.length));
      continue;
    }

    if (argument.startsWith('-')) {
      throw new Error(`未知参数: ${argument}`);
    }

    if (!readingCodes) {
      throw new Error(`未知参数: ${argument}`);
    }

    codeArguments.push(argument);
  }

  return { help: false, codeArguments };
}

/**
 * 在命令行显示问题并等待用户输入一行内容。
 *
 * @param {string} question 提示文字。
 * @returns {Promise<string>} 用户输入的原始文本。
 */
function ask(question) {
  const prompt = readline.createInterface({
    input: process.stdin,
    // 提示信息写入标准错误，保证标准输出始终是可解析的 JSON。
    output: process.stderr,
  });

  return new Promise((resolve) => {
    prompt.question(question, (answer) => {
      prompt.close();
      resolve(answer);
    });
  });
}

/**
 * jav_magnet.js 命令行入口。
 *
 * 从参数或交互输入取得番号，调用 jav_scraper.js 抓取数据，
 * 将 JSON 数组输出到控制台并写入 jav/temp/{最后一个番号}.json。
 *
 * @returns {Promise<object[]>} 抓取到的结构化结果。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return [];
  }

  let codes;
  if (args.codeArguments.length > 0) {
    // 参数可能带有其他文字，只保留其中有效的番号。
    codes = args.codeArguments.map(extractCode).filter(Boolean);
  } else {
    // 无参数时支持用空格或逗号等任意非番号字符分隔多个输入。
    const userInput = (await ask('请输入番号: ')).trim();
    codes = userInput.match(/\d*[A-Za-z]+-\d+|\d+_\d+/g) ?? [];
  }

  if (codes.length === 0) {
    console.error('错误：未提取到有效番号。');
    return [];
  }

  const records = [];

  // 按输入顺序逐个抓取，并把每个结果追加到同一个 JSON 数组。
  for (const code of codes) {
    const result = await getJavInfo(code);

    if (result === null) {
      console.error(`\n错误：获取 ${code} 信息失败，退出脚本。`);
      process.exitCode = 1;
      return records;
    }

    const { title, url, magnet } = result;
    records.push({
      code,
      title,
      url,
      magnet: magnet
        ? {
            name: magnet.name,
            size: magnet.sizeStr,
            sizeBytes: magnet.sizeBytes,
            date: magnet.date,
            link: magnet.link,
          }
        : null,
    });
  }

  const output = JSON.stringify(records, null, 2);
  console.log(output);

  // 保持原 Python 行为：多个番号时以最后一个番号作为输出文件名。
  const outputPath = path.join(__dirname, 'temp', `${codes.at(-1)}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  console.error(`\n已写入: ${outputPath}`);

  return records;
}

// 捕获未处理错误，输出简洁错误信息并设置非零退出码。
if (require.main === module) {
  main().catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}
