'use strict';

/** 115 云下载脚本共用的 API、错误处理和目录整理基础能力。 */
const http = require('node:http');
const https = require('node:https');

const CLOUD_DOWNLOAD_CID = '739884770980370058';
const API_BASE_URL = 'http://127.0.0.1:1150';
const FILE_LIST_PAGE_SIZE = 200;

const COMMON_ERROR_CODES = Object.freeze({
  API_INVALID_JSON: 21,
  API_HTTP_ERROR: 22,
  API_TIMEOUT: 23,
  API_UNREACHABLE: 24,
  FILE_LIST_INVALID: 50,
  DELETE_FILES_FAILED: 51,
  DOWNLOAD_DIR_ID_MISSING: 53,
  RENAME_DIR_FAILED: 54,
  TASK_CLEAR_FAILED: 56,
  UNEXPECTED_ERROR: 99,
});

class FlowError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FlowError';
    this.code = code;
  }
}

function createFlowError(code, message, cause) {
  return new FlowError(code, message, cause);
}

function asFlowError(error, code, message) {
  if (error instanceof FlowError) {
    return error;
  }
  const detail = error?.message || String(error);
  return createFlowError(code, `${message}: ${detail}`, error);
}

function formatError(error) {
  const code = Number.isInteger(error?.code)
    ? error.code
    : COMMON_ERROR_CODES.UNEXPECTED_ERROR;
  return `[错误码 ${code}] ${error?.message || String(error)}`;
}

function createStepLogger() {
  let stepNumber = 0;
  return (message, details) => {
    stepNumber += 1;
    const suffix = details === undefined
      ? ''
      : ` | ${typeof details === 'string' ? details : JSON.stringify(details)}`;
    console.log(`[步骤 ${String(stepNumber).padStart(3, '0')}] ${message}${suffix}`);
  };
}

function validateFileList(response) {
  if (
    response?.state === false
    || Number(response?.errNo ?? response?.errCode ?? response?.errcode ?? response?.errno ?? 0) !== 0
    || !Array.isArray(response?.data)
  ) {
    throw createFlowError(
      COMMON_ERROR_CODES.FILE_LIST_INVALID,
      '文件列表接口失败或返回格式错误: data 必须是数组',
    );
  }
  return response.data;
}

function isSuccessfulApiResponse(response) {
  return response?.state === true
    && Number(response?.errno ?? response?.errcode ?? 0) === 0;
}

function create115Client(options = {}) {
  const baseUrl = options.baseUrl || API_BASE_URL;
  const logStep = options.logStep || (() => {});

  function requestApi(method, apiPath, body = null, requestOptions = {}) {
    const payload = body === null ? null : JSON.stringify(body);
    const url = new URL(apiPath, baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    logStep('准备请求 115 API', `${method} ${apiPath}`);

    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method,
          headers: {
            ...requestOptions.headers,
            ...(payload === null ? {} : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }),
          },
        },
        (response) => {
          response.on('error', reject);
          let responseBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            responseBody += chunk;
          });
          response.on('end', () => {
            let data;
            try {
              data = responseBody ? JSON.parse(responseBody) : null;
            } catch (error) {
              reject(createFlowError(
                COMMON_ERROR_CODES.API_INVALID_JSON,
                `115 API 返回的不是有效 JSON: ${error.message}`,
                error,
              ));
              return;
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(createFlowError(
                COMMON_ERROR_CODES.API_HTTP_ERROR,
                data?.message || `115 API 请求失败: HTTP ${response.statusCode}`,
              ));
              return;
            }

            logStep('115 API 请求成功', `${method} ${apiPath}`);
            resolve(data);
          });
        },
      );

      const timeoutMs = requestOptions.timeoutMs ?? 10000;
      const timeout = setTimeout(() => {
        const error = createFlowError(COMMON_ERROR_CODES.API_TIMEOUT, '115 API 请求超时');
        request.destroy(error);
        reject(error);
      }, timeoutMs);
      request.on('close', () => clearTimeout(timeout));
      request.on('error', (error) => {
        reject(error instanceof FlowError
          ? error
          : createFlowError(
            COMMON_ERROR_CODES.API_UNREACHABLE,
            `无法访问 115 API: ${error.message}`,
            error,
          ));
      });

      if (payload !== null) {
        request.write(payload);
      }
      request.end();
    });
  }

  /** 单次读取已完成任务；合法的 tasks=null 空列表视为空数组。 */
  async function listCompletedCloudTasks(requestOptions = {}) {
    const remaining = requestOptions.deadline === undefined
      ? Infinity
      : requestOptions.deadline - Date.now();
    if (remaining <= 0) {
      throw createFlowError(COMMON_ERROR_CODES.API_TIMEOUT, '已完成任务列表查询超时');
    }
    const response = await requestApi('GET', '/115/task_lists?stat=11', null, {
      timeoutMs: Math.min(requestOptions.timeoutMs ?? 10000, remaining),
    });
    const emptyTasks = response?.tasks === null && Number(response?.count) === 0;
    if (!isSuccessfulApiResponse(response)
      || (!Array.isArray(response?.tasks) && !emptyTasks)) {
      throw createFlowError(
        COMMON_ERROR_CODES.API_INVALID_JSON,
        '已完成任务列表接口失败或 tasks 格式无效',
      );
    }
    return response.tasks || [];
  }

  async function listAllFiles(cateId) {
    const files = [];
    let offset = 0;

    while (true) {
      const query = new URLSearchParams({
        cid: String(cateId),
        offset: String(offset),
        limit: String(FILE_LIST_PAGE_SIZE),
      });
      const response = await requestApi('GET', `/115/files?${query.toString()}`);
      const pageFiles = validateFileList(response);
      files.push(...pageFiles);

      const total = Number(response?.count);
      offset += pageFiles.length;
      if (
        pageFiles.length === 0
        || pageFiles.length < FILE_LIST_PAGE_SIZE
        || (Number.isFinite(total) && offset >= total)
      ) {
        break;
      }
    }
    return files;
  }

  async function renameDirectory(directory, title) {
    const oldName = String(directory?.name || directory?.n || '');
    if (oldName === title) {
      logStep('目录已经是目标标题，跳过重命名', title);
      return false;
    }

    const fid = String(directory?.fid || directory?.cid || '').trim();
    if (!fid) {
      throw createFlowError(
        COMMON_ERROR_CODES.DOWNLOAD_DIR_ID_MISSING,
        `目录缺少 fid 和 cid: ${oldName}`,
      );
    }

    logStep('正在通过本机 API 重命名目录', { fid, oldName, newName: title });
    const response = await requestApi('POST', '/115/rename', { fid, new_name: title });
    if (!isSuccessfulApiResponse(response)) {
      throw createFlowError(
        COMMON_ERROR_CODES.RENAME_DIR_FAILED,
        `重命名目录失败: ${response?.error || response?.message || '接口返回失败状态'}`,
      );
    }
    logStep('已通过 API 重命名目录', `${oldName} -> ${title}`);
    return true;
  }

  async function deleteFiles(fileIds) {
    if (fileIds.length === 0) {
      return null;
    }
    const response = await requestApi('POST', '/115/delete', { fid: fileIds });
    if (!isSuccessfulApiResponse(response)) {
      throw createFlowError(
        COMMON_ERROR_CODES.DELETE_FILES_FAILED,
        `删除文件失败: ${response?.error || response?.message || '接口返回失败状态'}`,
      );
    }
    return response;
  }

  async function deleteCloudTask(infoHash) {
    const hash = typeof infoHash === 'string' ? infoHash.trim() : '';
    if (!hash) {
      logStep('缺少 info_hash，跳过删除云下载任务记录');
      return null;
    }

    logStep('正在通过本机 API 删除云下载任务记录', hash);
    const response = await requestApi('POST', '/115/task_del', { hash: [hash] });
    if (!isSuccessfulApiResponse(response)) {
      throw createFlowError(
        COMMON_ERROR_CODES.TASK_CLEAR_FAILED,
        `删除云下载任务记录失败: ${response?.error || response?.message || '接口返回失败状态'}`,
      );
    }
    logStep('云下载任务记录删除完成', response);
    return response;
  }

  async function notifyCloudDownload(type, result, message, data) {
    logStep('正在广播云下载事件', type);
    const response = await requestApi('POST', '/115/clouddownload/notify', {
      type,
      result,
      message,
      data,
    });
    if (response?.result !== 0) {
      throw createFlowError(
        COMMON_ERROR_CODES.UNEXPECTED_ERROR,
        `广播云下载事件失败: ${response?.message || '接口返回失败状态'}`,
      );
    }
    logStep('云下载事件已广播', type);
    return response;
  }

  return {
    deleteCloudTask,
    deleteFiles,
    listAllFiles,
    listCompletedCloudTasks,
    notifyCloudDownload,
    renameDirectory,
    requestApi,
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAvCode(code, extractCode = null, invalidCodeError = 13) {
  const trimmed = String(code || '').trim();
  const fc2Match = trimmed.match(/FC2(?:[-_]?PPV)?[-_]?\d+/i);
  const extracted = fc2Match?.[0] || extractCode?.(trimmed) || trimmed;
  const tokens = extracted.toUpperCase().match(/[A-Z]+|\d+/g) || [];
  if (tokens.length < 2) {
    throw createFlowError(invalidCodeError, `无法识别番号格式: ${code}`);
  }
  return { code: extracted.toUpperCase(), tokens };
}

function createCodeMatcher(tokens) {
  const body = tokens.map(escapeRegExp).join('[\\s._-]*');
  const pattern = new RegExp(`(^|[^A-Z0-9])${body}(?![A-Z0-9])`, 'i');
  return (name) => pattern.test(String(name || ''));
}

async function cleanupDirectory(client, cateId, codeMatcher, logStep = () => {}) {
  logStep('开始清理目录中不符合番号规则的文件');
  const files = await client.listAllFiles(cateId);
  const fileIds = [];

  for (const file of files) {
    const name = String(file?.name || file?.n || '');
    if (codeMatcher(name)) {
      logStep('文件名包含番号，保留文件', name);
      continue;
    }

    const fileId = String(file?.fid || '').trim();
    if (!fileId) {
      logStep('非文件或缺少 fid，跳过删除', name);
      continue;
    }
    logStep('文件名不符合番号规则，加入删除列表', { name, fileId });
    fileIds.push(fileId);
  }

  if (fileIds.length === 0) {
    logStep('没有需要删除的不含番号文件');
    return 0;
  }

  await client.deleteFiles(fileIds);
  logStep('已通过 API 删除不符合番号规则的文件', `数量=${fileIds.length}`);
  return fileIds.length;
}

module.exports = {
  API_BASE_URL,
  CLOUD_DOWNLOAD_CID,
  COMMON_ERROR_CODES,
  FlowError,
  asFlowError,
  cleanupDirectory,
  create115Client,
  createCodeMatcher,
  createFlowError,
  createStepLogger,
  formatError,
  normalizeAvCode,
};
