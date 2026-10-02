#!/usr/bin/env node

'use strict';

/**
 * 修复已经完成、但没有成功整理的 115 云下载目录。
 *
 * 用法：
 *   node 115/115-repair-download.js --code SONE-930
 *   node 115/115-repair-download.js --code=SONE-930
 *
 * 流程：
 * 1. 根据番号获取完整标题。
 * 2. 在 115「云下载」目录中按目录名识别对应目录；目录名没有番号时，
 *    再检查目录内的文件名。
 * 3. 只有唯一匹配时才重命名，避免误操作其他下载目录。
 * 4. 删除该目录内文件名不含番号的文件（目录和无 fid 项不会删除）。
 */
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { extractCode, getJavInfo } = require('../jav/jav_scraper');
const {
  CLOUD_DOWNLOAD_CID,
  COMMON_ERROR_CODES,
  cleanupDirectory,
  create115Client,
  createCodeMatcher,
  createFlowError,
  createStepLogger,
  normalizeAvCode,
} = require('./115-comm');

const execFileAsync = promisify(execFile);

const ERROR_CODES = Object.freeze({
  ...COMMON_ERROR_CODES,
  UNKNOWN_ARGUMENT: 12,
  CODE_MISSING: 13,
  CODE_INVALID: 14,
  METADATA_NOT_FOUND: 15,
  DOWNLOAD_DIR_NOT_FOUND: 52,
  DOWNLOAD_DIR_AMBIGUOUS: 57,
});

const logStep = createStepLogger();
const client = create115Client({ logStep });
const flowError = createFlowError;

function parseArguments(args = process.argv.slice(2)) {
  let code = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--code') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw flowError(ERROR_CODES.CODE_MISSING, '--code 后必须提供番号');
      }
      code = value;
      index += 1;
    } else if (argument.startsWith('--code=')) {
      code = argument.slice('--code='.length);
    } else {
      throw flowError(ERROR_CODES.UNKNOWN_ARGUMENT, `未知参数: ${argument}`);
    }
  }

  return { code: code?.trim() || null };
}

function askForCode() {
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    prompt.question('请输入要重新整理的番号: ', (answer) => {
      prompt.close();
      resolve(answer.trim());
    });
  });
}

function isDirectory(file) {
  return Boolean(String(file?.cid || '').trim())
    && (Number(file?.fc) === 0 || (!file?.fid && file?.fc === undefined));
}

async function findMatchingDirectory(codeMatcher) {
  logStep('读取「云下载」根目录并按番号匹配目录名');
  const rootFiles = await client.listAllFiles(CLOUD_DOWNLOAD_CID);
  const directories = rootFiles.filter(isDirectory);
  const nameMatches = directories.filter((directory) => codeMatcher(directory?.name || directory?.n));

  if (nameMatches.length === 1) {
    return nameMatches[0];
  }
  if (nameMatches.length > 1) {
    throw flowError(
      ERROR_CODES.DOWNLOAD_DIR_AMBIGUOUS,
      `发现多个目录名匹配番号: ${nameMatches.map((item) => item?.name || item?.n).join('、')}`,
    );
  }

  logStep('目录名未匹配，开始检查各目录内的文件名', `目录数=${directories.length}`);
  const contentMatches = [];
  for (const directory of directories) {
    const cateId = String(directory.cid);
    const children = await client.listAllFiles(cateId);
    if (children.some((file) => codeMatcher(file?.name || file?.n))) {
      contentMatches.push(directory);
    }
  }

  if (contentMatches.length === 0) {
    throw flowError(ERROR_CODES.DOWNLOAD_DIR_NOT_FOUND, '没有找到目录名或内部文件名包含该番号的目录');
  }
  if (contentMatches.length > 1) {
    throw flowError(
      ERROR_CODES.DOWNLOAD_DIR_AMBIGUOUS,
      `发现多个目录的内容匹配番号: ${contentMatches.map((item) => item?.name || item?.n).join('、')}`,
    );
  }
  return contentMatches[0];
}

function isUsableTitle(title, codeMatcher = null) {
  const value = String(title || '').trim();
  return Boolean(value)
    && value !== '未找到标题'
    && !value.startsWith('请求失败:')
    && (!codeMatcher || codeMatcher(value));
}

async function lookupWithBtsearch(code) {
  const scriptPath = path.join(__dirname, '..', 'btsearch', 'btsearch_search.js');
  logStep('改用 btsearch 获取番号标题');
  const { stdout } = await execFileAsync(
    process.execPath,
    [scriptPath, '--keyword', code],
    { cwd: path.join(__dirname, '..'), maxBuffer: 10 * 1024 * 1024 },
  );
  const records = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  return Array.isArray(records) ? records[0] : records;
}

async function loadMetadata(code, codeMatcher) {
  let record = null;

  if (!/^FC2(?:[-_]?PPV)?[-_]?\d+/i.test(code)) {
    logStep('正在通过 jav 数据源获取番号标题', code);
    const result = await getJavInfo(code);
    if (result && isUsableTitle(result.title, codeMatcher)) {
      record = { code, ...result };
    }
  }

  if (!record) {
    try {
      record = await lookupWithBtsearch(code);
    } catch (error) {
      throw flowError(
        ERROR_CODES.METADATA_NOT_FOUND,
        `获取番号标题失败: ${error?.stderr?.trim() || error.message}`,
        error,
      );
    }
  }

  if (!isUsableTitle(record?.title, codeMatcher)) {
    throw flowError(ERROR_CODES.METADATA_NOT_FOUND, `没有取得包含 ${code} 的有效标题`);
  }
  return record;
}

async function main() {
  logStep('脚本启动');
  const args = parseArguments();
  const inputCode = args.code || await askForCode();
  if (!inputCode) {
    throw flowError(ERROR_CODES.CODE_MISSING, '番号不能为空');
  }

  const { code, tokens } = normalizeAvCode(inputCode, extractCode, ERROR_CODES.CODE_INVALID);
  const codeMatcher = createCodeMatcher(tokens);
  logStep('番号解析完成', code);

  const metadata = await loadMetadata(code, codeMatcher);
  logStep('已取得目标标题', metadata.title);

  const directory = await findMatchingDirectory(codeMatcher);
  const cateId = String(directory?.cid || '').trim();
  if (!cateId) {
    throw flowError(ERROR_CODES.DOWNLOAD_DIR_ID_MISSING, '匹配目录缺少 cid');
  }
  logStep('已唯一识别目标目录', { name: directory?.name || directory?.n, cid: cateId });

  await client.renameDirectory(directory, metadata.title.trim());
  await cleanupDirectory(client, cateId, codeMatcher, logStep);
  logStep('历史云下载目录整理完成');
}

main().catch((error) => {
  const code = Number.isInteger(error?.code) ? error.code : ERROR_CODES.UNEXPECTED_ERROR;
  console.error(`[错误码 ${code}] ${error?.message || String(error)}`);
  process.exitCode = code;
});
