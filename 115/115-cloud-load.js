/**
 * 115 云下载自动化脚本
 *
 * 功能：
 * 1. 从本机 115 HTTP API 获取 Cookie，并使用本机 Chrome/Edge 打开 115 网盘。
 * 2. 检测登录状态，通过本机 115 HTTP API 将 magnet 链接添加为云下载任务。
 * 3. 接收 jav_magnet.js 返回的 JSON，从中取得磁力链接和标题。
 * 4. 下载任务创建后，将对应目录重命名为 JSON 中的标题。
 * 5. 任务创建失败或重命名成功后，通过本机 115 HTTP API 清理已完成的云下载任务记录。
 * 6. 通过本机 115 HTTP API 删除目录中不含完整番号或番号字母、数字部分的文件。
 *
 * 参数：
 *   node 115-cloud-load.js [--cloud-load <magnet链接>] [--code <番号>] [--jav-json <JSON>]
 * 未传参数时会使用交互式输入。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
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
} = require('./115-comm');
let chromium;

const ERROR_CODES = Object.freeze({
  ...COMMON_ERROR_CODES,
  PLAYWRIGHT_NOT_INSTALLED: 10,
  BROWSER_NOT_FOUND: 11,
  UNKNOWN_ARGUMENT: 12,
  INVALID_MAGNET_URL: 13,
  INVALID_JSON: 14,
  INVALID_JSON_ROOT: 15,
  MISSING_JSON_CODE: 16,
  JSON_CODE_MISMATCH: 17,
  INVALID_COOKIES_RESPONSE: 20,
  LOAD_COOKIES_FAILED: 25,
  BROWSER_LAUNCH_FAILED: 30,
  BROWSER_CONTEXT_FAILED: 31,
  BROWSER_PAGE_FAILED: 32,
  COOKIE_INJECTION_FAILED: 33,
  WANGPAN_NAVIGATION_FAILED: 34,
  CLOUD_TASK_FAILED: 40,
  TOAST_FAILED: 41,
  DOWNLOAD_DIR_NOT_FOUND: 52,
  DIRECTORY_CLEANUP_FAILED: 55,
  SAVE_COOKIES_FAILED: 60,
  BROWSER_CLOSE_FAILED: 61,
});

try {
  ({ chromium } = require('playwright-core'));
} catch {
  try {
    ({ chromium } = require('playwright'));
  } catch {
    const error = createFlowError(
      ERROR_CODES.PLAYWRIGHT_NOT_INSTALLED,
      "未安装 playwright-core。请先在终端中运行 'npm install'",
    );
    console.error(formatError(error));
    process.exit(error.code);
  }
}

const DOWNLOAD_DIR_RETRY_COUNT = 10;
const DOWNLOAD_DIR_RETRY_INTERVAL_MS = 1000;
const logStep = createStepLogger();
const client = create115Client({ logStep });
const { requestApi } = client;

/** 等待指定的毫秒数后继续执行。 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 在当前页面显示错误提示。 */
async function toast(page, message) {
  await page.evaluate((text) => {
    if (typeof window.toast === 'function') {
      window.toast(text);
      return;
    }

    const element = document.createElement('div');
    element.textContent = text;
    Object.assign(element.style, {
      position: 'fixed',
      top: '24px',
      left: '50%',
      zIndex: '2147483647',
      padding: '12px 20px',
      color: '#fff',
      background: 'rgba(0, 0, 0, 0.8)',
      borderRadius: '6px',
      transform: 'translateX(-50%)',
    });
    document.body.appendChild(element);
  }, String(message || '添加云下载任务失败'));
}

/** 从候选路径中返回第一个真实存在的路径。 */
function firstExistingPath(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

/** 从环境变量和常见安装目录中查找 Chrome 或 Edge 可执行文件。 */
function getBrowserExecutablePath() {
  logStep('开始查找 Chrome 或 Edge 可执行文件');
  const envPath = firstExistingPath([
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.BROWSER_PATH,
  ]);
  if (envPath) {
    logStep('已从环境变量找到浏览器', envPath);
    return envPath;
  }

  const baseDirs = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const candidates = [];

  for (const baseDir of baseDirs) {
    candidates.push(
      path.join(baseDir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(baseDir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  }

  const executablePath = firstExistingPath(candidates);
  logStep(executablePath ? '已从常见安装目录找到浏览器' : '常见安装目录中未找到浏览器', executablePath);
  return executablePath;
}

/** 生成 Playwright 浏览器启动配置，并确保本机浏览器可用。 */
function getLaunchOptions() {
  logStep('正在生成浏览器启动配置');
  const executablePath = getBrowserExecutablePath();
  if (!executablePath) {
    throw createFlowError(
      ERROR_CODES.BROWSER_NOT_FOUND,
      '未找到 Chrome 或 Edge，请安装浏览器，或设置 CHROME_PATH / EDGE_PATH / BROWSER_PATH',
    );
  }

  const options = {
    headless: true,
    executablePath,
  };
  logStep('浏览器启动配置生成完成', options);
  return options;
}

/** 创建用于命令行交互输入的提示器。 */
function createPrompt() {
  logStep('正在创建命令行交互接口');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    /** 显示问题并返回去除首尾空白后的用户输入。 */
    ask(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
      });
    },
    /** 关闭命令行输入输出接口。 */
    close() {
      logStep('正在关闭命令行交互接口');
      rl.close();
    },
  };
}

/** 解析磁力链接和番号等命令行参数。 */
function parseArguments(args = process.argv.slice(2)) {
  logStep('开始解析命令行参数', args);
  const parsed = {
    cloudLoadUrl: null,
    avCode: null,
    javJson: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--cloud-load') {
      parsed.cloudLoadUrl = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith('--cloud-load=')) {
      parsed.cloudLoadUrl = argument.slice('--cloud-load='.length);
    } else if (argument === '--code') {
      const nextArgument = args[index + 1];
      if (nextArgument !== undefined && !nextArgument.startsWith('-')) {
        parsed.avCode = nextArgument || null;
        index += 1;
      }
    } else if (argument.startsWith('--code=')) {
      parsed.avCode = argument.slice('--code='.length) || null;
    } else if (argument === '--jav-json') {
      parsed.javJson = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith('--jav-json=')) {
      parsed.javJson = argument.slice('--jav-json='.length);
    } else if (argument.startsWith('-')) {
      throw createFlowError(ERROR_CODES.UNKNOWN_ARGUMENT, `未知参数: ${argument}`);
    } else {
      throw createFlowError(ERROR_CODES.UNKNOWN_ARGUMENT, `未知参数: ${argument}`);
    }
  }

  logStep('命令行参数解析完成', parsed);
  return parsed;
}

/** 解析 JSON 对象，并校验其番号是否与指定番号一致。 */
function parseJsonRecord(javJson, avCode) {
  logStep('开始解析 jav_magnet JSON 返回值', `字符数=${javJson.length}`);
  let record;
  try {
    record = JSON.parse(javJson.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw createFlowError(ERROR_CODES.INVALID_JSON, `jav_magnet JSON 解析失败: ${error.message}`, error);
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createFlowError(ERROR_CODES.INVALID_JSON_ROOT, 'JSON 顶层数据必须是对象');
  }

  if (typeof record.code !== 'string' || !record.code.trim()) {
    throw createFlowError(ERROR_CODES.MISSING_JSON_CODE, 'JSON 对象必须包含非空字符串 code');
  }

  const isMatched = !avCode || record.code.toLowerCase() === avCode.toLowerCase();
  logStep(
    isMatched ? 'JSON 对象的番号校验通过' : 'JSON 对象的番号与参数不匹配',
    isMatched ? record : { jsonCode: record.code, avCode },
  );
  return isMatched ? record : null;
}

/** 读取传入的番号数据，并在未显式提供时从 JSON 中取得磁力链接。 */
function readAvCodeRow(avCode, javJson, cloudLoadUrl) {
  logStep('开始解析番号关联数据', {
    avCode,
    hasJavJson: Boolean(javJson),
    hasCloudLoadUrl: Boolean(cloudLoadUrl),
  });
  let rowData = null;
  if (javJson) {
    rowData = parseJsonRecord(javJson, avCode);
    if (!rowData) {
      throw createFlowError(
        ERROR_CODES.JSON_CODE_MISMATCH,
        `JSON 对象的 code 与参数 ${avCode || '(未指定)'} 不匹配`,
      );
    }
    // --code 为空时，使用 javJson 记录中的 code。
    avCode = avCode || rowData.code;
    if (!cloudLoadUrl && rowData.magnet?.link?.startsWith('magnet:?')) {
      cloudLoadUrl = rowData.magnet.link;
      logStep('已从 JSON 返回值取得磁力链接');
    }
  } else {
    logStep('未传入 jav_magnet JSON，跳过番号数据解析');
  }

  const result = {
    rowData,
    cloudLoadUrl,
    avCode,
  };
  logStep('番号关联数据读取完成', {
    avCode: result.avCode,
    hasRowData: Boolean(result.rowData),
    hasCloudLoadUrl: Boolean(result.cloudLoadUrl),
  });
  return result;
}

/** 将 API 返回的 Cookie 数组转换为 Playwright 可注入的格式。 */
function normalizeCookies(cookiesList) {
  logStep('开始规范化 Cookies', `原始数量=${Array.isArray(cookiesList) ? cookiesList.length : '无效'}`);
  if (!Array.isArray(cookiesList)) {
    throw createFlowError(
      ERROR_CODES.INVALID_COOKIES_RESPONSE,
      'Cookies API 返回格式错误: 顶层数据必须是数组',
    );
  }

  const normalizedCookies = cookiesList
    .filter((cookie) => cookie && 'name' in cookie && 'value' in cookie)
    .map((cookie) => {
      const playwrightCookie = {
        name: String(cookie.name),
        value: String(cookie.value),
        domain: cookie.domain || '.115.com',
        path: cookie.path || '/',
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
      };

      if (!cookie.session && Number.isFinite(cookie.expirationDate)) {
        playwrightCookie.expires = cookie.expirationDate;
      }

      const sameSiteMap = {
        strict: 'Strict',
        lax: 'Lax',
        none: 'None',
        no_restriction: 'None',
      };
      const sameSite = sameSiteMap[String(cookie.sameSite || '').toLowerCase()];
      if (sameSite) {
        playwrightCookie.sameSite = sameSite;
      }

      return playwrightCookie;
    });
  logStep('Cookies 规范化完成', `有效数量=${normalizedCookies.length}`);
  return normalizedCookies;
}

/** 从本机 API 获取 Cookie，并转换为 Playwright 格式。 */
async function loadCookiesFromApi() {
  logStep('开始从本机 API 加载 Cookies');
  const cookies = await requestApi('GET', '/cookies/get?host=115.com');
  const normalizedCookies = normalizeCookies(cookies);
  logStep('从本机 API 加载 Cookies 完成', `数量=${normalizedCookies.length}`);
  return normalizedCookies;
}

/** 将 Playwright Cookie 转回 API 接受的 JSON Cookie 格式。 */
function serializeCookiesForApi(cookies) {
  logStep('开始序列化浏览器 Cookies', `数量=${cookies.length}`);
  const serializedCookies = cookies.map((cookie) => {
    const serialized = {
      domain: cookie.domain || '.115.com',
      hostOnly: !String(cookie.domain || '').startsWith('.'),
      httpOnly: Boolean(cookie.httpOnly),
      name: String(cookie.name),
      path: cookie.path || '/',
      sameSite: cookie.sameSite ? String(cookie.sameSite).toLowerCase() : 'unspecified',
      secure: Boolean(cookie.secure),
      session: !(Number.isFinite(cookie.expires) && cookie.expires > 0),
      storeId: '0',
      value: String(cookie.value),
    };

    if (!serialized.session) {
      serialized.expirationDate = cookie.expires;
    }

    return serialized;
  });
  logStep('浏览器 Cookies 序列化完成', `数量=${serializedCookies.length}`);
  return serializedCookies;
}

/** 读取浏览器上下文中的最新 Cookies，并通过本机 API 更新缓存。 */
async function saveContextCookies(context) {
  logStep('开始读取浏览器上下文中的 Cookies');
  const cookies = await context.cookies();
  logStep('浏览器上下文 Cookies 读取完成', `数量=${cookies.length}`);
  logStep('开始将最新 Cookies 保存到本机 API');
  await requestApi(
    'POST',
    '/cookies/update',
    {
      host: '115.com',
      cookies: serializeCookiesForApi(cookies),
    },
  );
  logStep(`已通过 ${API_BASE_URL}/cookies/update 更新 Cookies`);
}

/** 预访问 115 域名并向浏览器上下文注入登录 Cookie。 */
async function injectCookies(page, context, cookies) {
  logStep('正在预访问 115.com 以注入 Cookies');
  await page.goto('https://115.com/404', { waitUntil: 'domcontentloaded' });
  logStep('115.com 预访问完成');
  logStep(`正在注入 ${cookies.length} 个 Cookies`);
  await context.addCookies(cookies);
  logStep('Cookies 注入完成');
}

/** 根据 Cookie 中是否存在非空 UID 判断当前登录状态。 */
function detectLoginStatus(cookies) {
  logStep('开始根据 UID Cookie 检测登录状态');
  const uidCookie = cookies.find((cookie) => (
    cookie.name === 'UID'
      && typeof cookie.value === 'string'
      && cookie.value.trim()
  ));

  if (uidCookie) {
    logStep('【状态: 已登录】Cookie 中存在非空 UID');
    return true;
  }

  logStep('【状态: 未登录】Cookie 中未发现非空 UID');
  return false;
}

/** 跳转到预设的 115 云下载目录。 */
async function gotoWangpan(page) {
  const wangpanUrl = `https://115.com/?mode=wangpan&cid=${CLOUD_DOWNLOAD_CID}`;
  logStep('正在跳转到云下载目录', wangpanUrl);
  await page.goto(wangpanUrl, { waitUntil: 'domcontentloaded' });
  logStep('云下载目录页面加载完成');
}

/**
 * 通过本机 115 HTTP API 提交磁力链接。
 * 返回值，JSON对象
 */
async function addCloudTask(cloudLoadUrl) {
  // 步骤 1：确认存在可提交的磁力链接。
  if (!cloudLoadUrl) {
    logStep('未提供磁力链接，跳过添加云下载任务');
    return;
  }

  // 步骤 2：通过本机 API 创建云下载任务。
  logStep('准备通过本机 API 添加云下载任务', cloudLoadUrl);
  const rspJson = await requestApi(
    'POST',
    '/115/clouddownload/add_task_urls',
    { url: [cloudLoadUrl] },
  );

  // 步骤 3：记录并返回完整响应，交给主流程判断任务是否创建成功。
  // {"state":true,"errno":0,"errcode":0,"data":[{"state":true,"errno":0,"errtype":"","errcode":0,"info_hash":"...","name":"SAVR-1029.8K","url":"magnet:?xt=urn:btih:..."}]}
  logStep('云下载接口响应', rspJson);
  return rspJson;
}

/**
 * 按 JSON 数据重命名下载目录，并清理目录中的无关文件。
 *
 * [cloudTaskJson] {"state":true,"errno":0,"errtype":"","errcode":0,"info_hash":"...","name":"SAVR-1029.8K","url":"magnet:?xt=urn:btih:..."}
 */
async function renameDirAndCleanup(rowData, avCode, cloudTaskJson) {
  // 步骤 1：校验 JSON 数据和云下载任务名称。
  logStep('开始执行下载目录重命名与文件清理', {
    avCode,
    hasRowData: Boolean(rowData),
    taskName: cloudTaskJson?.name || null,
  });
  if (!rowData || !cloudTaskJson?.name) {
    logStep('缺少 JSON 数据或云下载任务名称，跳过目录整理');
    return;
  }

  // 步骤 2：等待 115 创建云下载目录。
  logStep('云下载任务数据', cloudTaskJson);
  let fileJson;
  for (let attempt = 1; attempt <= DOWNLOAD_DIR_RETRY_COUNT; attempt += 1) {
    logStep(
      `等待 ${DOWNLOAD_DIR_RETRY_INTERVAL_MS / 1000} 秒后检查云下载目录（${attempt}/${DOWNLOAD_DIR_RETRY_COUNT}）`,
    );
    await sleep(DOWNLOAD_DIR_RETRY_INTERVAL_MS);

    logStep('正在读取[云下载]根目录文件列表');
    const files = await client.listAllFiles(CLOUD_DOWNLOAD_CID);
    logStep('云下载根目录文件数量', files.length);

    fileJson = files.find((file) => file?.name === cloudTaskJson.name);
    if (fileJson) {
      break;
    }

    logStep('本次检查未找到云下载任务对应目录', {
      attempt,
      taskName: cloudTaskJson.name,
    });
  }

  if (!fileJson) {
    logStep('重试后仍未找到云下载任务对应目录', cloudTaskJson.name);
    throw createFlowError(
      ERROR_CODES.DOWNLOAD_DIR_NOT_FOUND,
      `未找到云下载任务对应目录: ${cloudTaskJson.name}`,
    );
  }

  // 步骤 3：读取重命名所需的新标题。
  const title = rowData.title;
  if (!title) {
    logStep('JSON 数据中没有标题，跳过目录整理');
    return;
  }

  // 步骤 4：取得后续读取目录内容使用的 CID。
  const cateId = String(fileJson['cid'] || '').trim();
  if (!cateId) {
    logStep('目录数据缺少 cid，无法整理', fileJson.name);
    throw createFlowError(
      ERROR_CODES.DOWNLOAD_DIR_ID_MISSING,
      `目录数据缺少 cid: ${fileJson.name}`,
    );
  }

  // 步骤 5：通过 API 重命名目录。
  await client.renameDirectory(fileJson, title);

  // 步骤 6：重命名成功后，清理已完成的云下载任务记录。
  try {
    await client.clearCompletedCloudTasks();
  } catch (error) {
    throw asFlowError(error, ERROR_CODES.TASK_CLEAR_FAILED, '清理已完成的云下载任务失败');
  }

  // 步骤 7：使用目录 CID 获取内容并删除不符合番号规则的文件。
  const { tokens } = normalizeAvCode(avCode);
  await cleanupDirectory(client, cateId, createCodeMatcher(tokens), logStep);
  logStep('下载目录重命名与文件清理完成');
}

/** 启动浏览器、注入 Cookie、添加云下载任务并执行目录整理。 */
async function check115Login(cloudLoadUrl, avCode, rowData) {
  // 阶段 1：整理并记录输入参数。
  logStep('开始执行 115 云下载自动化流程');
  if (cloudLoadUrl) {
    logStep('正在解码磁力链接参数');
    try {
      cloudLoadUrl = decodeURIComponent(cloudLoadUrl);
    } catch (error) {
      throw asFlowError(error, ERROR_CODES.INVALID_MAGNET_URL, '磁力链接参数解码失败');
    }
    logStep('磁力链接参数解码完成');
  }
  logStep('自动化流程输入数据', {
    cloudLoadUrl,
    avCode,
    rowData,
  });

  let browser;
  try {
    // 阶段 2：从本机 API 获取登录 Cookie。
    let cookies;
    try {
      logStep('正在获取登录 Cookies');
      cookies = await loadCookiesFromApi();
      logStep(`已从 ${API_BASE_URL}/cookies/get 获取 ${cookies.length} 个 Cookies`);
    } catch (error) {
      logStep('获取登录 Cookies 失败，自动化流程结束');
      throw asFlowError(error, ERROR_CODES.LOAD_COOKIES_FAILED, '获取登录 Cookies 失败');
    }

    // 阶段 3：启动浏览器，供登录状态展示和 Cookie 同步使用。
    logStep('正在启动 Chromium（请保持关注弹出的浏览器窗口）');
    try {
      browser = await chromium.launch({
        ...getLaunchOptions(),
        timeout: 45000,
      });
      logStep('Chromium 启动成功');
    } catch (error) {
      logStep('Chromium 启动失败，自动化流程结束');
      throw asFlowError(error, ERROR_CODES.BROWSER_LAUNCH_FAILED, '启动浏览器失败');
    }

    // 阶段 4：创建独立浏览器上下文和页面。
    logStep('正在创建浏览器上下文');
    let context;
    try {
      context = await browser.newContext();
    } catch (error) {
      throw asFlowError(error, ERROR_CODES.BROWSER_CONTEXT_FAILED, '创建浏览器上下文失败');
    }
    logStep('浏览器上下文创建完成');
    logStep('正在创建浏览器页面');
    let page;
    try {
      page = await context.newPage();
    } catch (error) {
      throw asFlowError(error, ERROR_CODES.BROWSER_PAGE_FAILED, '创建浏览器页面失败');
    }
    logStep('浏览器页面创建完成');
    let cloudTaskRsp = null;

    // 阶段 5：注入 Cookie、检查登录状态并打开云下载目录。
    try {
      await injectCookies(page, context, cookies);
    } catch (error) {
      throw asFlowError(error, ERROR_CODES.COOKIE_INJECTION_FAILED, '注入 Cookies 失败');
    }
    const isLoggedIn = detectLoginStatus(cookies);
    try {
      await gotoWangpan(page);
    } catch (error) {
      throw asFlowError(error, ERROR_CODES.WANGPAN_NAVIGATION_FAILED, '打开云下载目录失败');
    }

    // 阶段 6：登录有效且存在磁力链接时，通过 API 添加任务。
    if (isLoggedIn && cloudLoadUrl) {
      logStep('登录有效且存在磁力链接，开始创建云下载任务');

      // {"state":true,"errno":0,"errcode":0,"data":[{"state":true,"errno":0,"errtype":"","errcode":0,"info_hash":"...","name":"SAVR-1029.8K","url":"magnet:?xt=urn:btih:..."}]}
      try {
        cloudTaskRsp = await addCloudTask(cloudLoadUrl);
      } catch (error) {
        throw asFlowError(error, ERROR_CODES.CLOUD_TASK_FAILED, '创建云下载任务请求失败');
      }
      const cloudTaskJson = cloudTaskRsp?.data?.[0];
      const cloudTaskSucceeded = (
        cloudTaskRsp?.state === true
        && Number(cloudTaskRsp?.errcode ?? cloudTaskRsp?.errno ?? 0) === 0
        && cloudTaskJson?.state === true
      );
      if (!cloudTaskSucceeded) {
        logStep('云下载任务创建失败', cloudTaskRsp);
        try {
          await client.clearCompletedCloudTasks();
        } catch (error) {
          logStep('云下载任务创建失败后清理已完成任务失败', error?.message || String(error));
        }
        try {
          logStep('正在页面中显示云下载错误提示');
          await toast(page, cloudTaskRsp?.error_msg);
          logStep('云下载错误提示显示完成');
        } catch (error) {
          throw asFlowError(error, ERROR_CODES.TOAST_FAILED, '显示云下载错误提示失败');
        }
        throw createFlowError(
          ERROR_CODES.CLOUD_TASK_FAILED,
          `云下载任务创建失败: ${cloudTaskRsp?.error_msg || cloudTaskRsp?.message || '接口返回失败状态'}`,
        );
      }
      logStep('云下载任务创建成功');
    } else {
      logStep('未满足创建云下载任务条件', { isLoggedIn, hasCloudLoadUrl: Boolean(cloudLoadUrl) });
    }
    // 阶段 7：确认任务数据存在后，执行 API 重命名和文件清理。
    logStep('开始执行任务创建后的目录整理阶段');
    // {"state":true,"errno":0,"errtype":"","errcode":0,"info_hash":"...","name":"SAVR-1029.8K","url":"magnet:?xt=urn:btih:..."}
    const cloudTaskJson = cloudTaskRsp?.data?.[0];
    if (cloudTaskJson) {
      try {
        await renameDirAndCleanup(rowData, avCode, cloudTaskJson);
      } catch (error) {
        throw asFlowError(error, ERROR_CODES.DIRECTORY_CLEANUP_FAILED, '下载目录整理失败');
      }
    } else {
      logStep('没有可整理的云下载任务数据，跳过目录重命名与清理');
    }

    // 阶段 8：保存最新 Cookie。
    logStep('主要操作完毕，正在保存最新 Cookies');
    try {
      await saveContextCookies(context);
    } catch (error) {
      throw asFlowError(error, ERROR_CODES.SAVE_COOKIES_FAILED, '更新 Cookies 失败');
    }
  } finally {
    if (browser) {
      logStep('正在关闭浏览器');
      try {
        await browser.close();
      } catch (error) {
        throw asFlowError(error, ERROR_CODES.BROWSER_CLOSE_FAILED, '关闭浏览器失败');
      }
      logStep('浏览器已关闭');
    }
  }
  logStep('115 云下载自动化流程结束');
}

/** 处理参数或交互输入，并组织执行完整的云下载自动化流程。 */
async function main() {
  // 步骤 1：解析命令行参数。
  logStep('脚本启动');
  const args = parseArguments();

  const prompt = createPrompt();
  let cloudLoadUrl;
  let avCode;

  try {
    // 步骤 2：无参数时交互输入；有参数时直接采用解析结果。
    if (process.argv.length === 2) {
      logStep('未提供任何参数，将逐个提示输入（可直接回车跳过）');
      const cloudLoadInput = await prompt.ask('离线下载链接 [默认: 不添加]: ');
      logStep(cloudLoadInput ? '已接收离线下载链接输入' : '未输入离线下载链接');
      cloudLoadUrl = cloudLoadInput || null;
      const avCodeInput = await prompt.ask('番号 [默认: 不添加]: ');
      logStep(avCodeInput ? '已接收番号输入' : '未输入番号', avCodeInput || undefined);
      avCode = avCodeInput || null;
    } else {
      logStep('使用命令行参数作为输入');
      cloudLoadUrl = args.cloudLoadUrl;
      avCode = args.avCode;
    }

    // 步骤 3：校验磁力链接格式。
    logStep('正在校验离线下载链接格式');
    if (cloudLoadUrl && !cloudLoadUrl.trim().startsWith('magnet:?')) {
      throw createFlowError(
        ERROR_CODES.INVALID_MAGNET_URL,
        "离线下载链接必须以 'magnet:?' 开头",
      );
    }
    logStep('离线下载链接格式校验通过');

    // 步骤 4：解析 jav_magnet JSON 返回值，并补全磁力链接和标题数据。
    const avCodeResult = readAvCodeRow(avCode, args.javJson, cloudLoadUrl);

    // 步骤 5：执行登录、添加任务、重命名和清理流程。
    logStep('正在调用完整的 115 自动化流程');
    await check115Login(
      avCodeResult.cloudLoadUrl,
      avCodeResult.avCode,
      avCodeResult.rowData,
    );
    logStep('完整的 115 自动化流程调用结束');
  } finally {
    // 步骤 6：无论流程成功或失败都关闭交互输入接口。
    prompt.close();
  }
}

logStep('正在进入 main 函数');
main().catch((error) => {
  const flowError = error instanceof FlowError
    ? error
    : asFlowError(error, ERROR_CODES.UNEXPECTED_ERROR, '未处理的流程异常');
  console.error(formatError(flowError));
  process.exitCode = flowError.code;
});
