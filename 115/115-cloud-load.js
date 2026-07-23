/**
 * 115 云下载自动化脚本
 *
 * 功能：
 * 1. 从本机 115 HTTP API 获取 Cookie，并使用本机 Chrome/Edge 打开 115 网盘。
 * 2. 检测登录状态，通过本机 115 HTTP API 将 magnet 链接添加为云下载任务。
 * 3. 支持通过“番号”读取 ../jav/temp/<番号>.md 中的磁力链和标题。
 * 4. 下载任务创建后，将对应目录重命名为 Markdown 中的标题。
 * 5. 通过本机 115 HTTP API 删除目录中不含完整番号或番号字母、数字部分的文件。
 *
 * 参数：
 *   node 115-cloud-load.js [--cloud-load <magnet链接>] [--番号 <番号>]
 * 未传参数时会使用交互式输入。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
let chromium;

try {
  ({ chromium } = require('playwright-core'));
} catch {
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error("错误: 未安装 playwright-core。请先在终端中运行 'npm install'");
    process.exit(1);
  }
}

const CLOUD_DOWNLOAD_CID = '739884770980370058';
const COOKIE_API_BASE_URL = 'http://127.0.0.1:1150';
let logStepNumber = 0;

/** 打印带递增序号的操作日志，便于定位执行进度。 */
function logStep(message, details) {
  logStepNumber += 1;
  const suffix = details === undefined
    ? ''
    : ` | ${typeof details === 'string' ? details : JSON.stringify(details)}`;
  console.log(`[步骤 ${String(logStepNumber).padStart(3, '0')}] ${message}${suffix}`);
}

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
    throw new Error(
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
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--cloud-load') {
      parsed.cloudLoadUrl = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith('--cloud-load=')) {
      parsed.cloudLoadUrl = argument.slice('--cloud-load='.length);
    } else if (argument === '--番号') {
      parsed.avCode = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith('--番号=')) {
      parsed.avCode = argument.slice('--番号='.length);
    } else if (argument.startsWith('-')) {
      throw new Error(`未知参数: ${argument}`);
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }

  logStep('命令行参数解析完成', parsed);
  return parsed;
}

/** 按番号查找对应的 Markdown 文件，支持文件名大小写不一致。 */
function findMarkdownPath(avCode) {
  logStep('开始查找番号 Markdown 文件', avCode);
  const markdownDir = path.join(__dirname, '..', 'jav', 'temp');
  const exactPath = path.join(markdownDir, `${avCode}.md`);
  if (fs.existsSync(exactPath)) {
    logStep('找到完全匹配的 Markdown 文件', exactPath);
    return exactPath;
  }

  if (!fs.existsSync(markdownDir)) {
    logStep('Markdown 目录不存在', markdownDir);
    return exactPath;
  }

  const lowerAvCode = avCode.toLowerCase();
  const matchedName = fs.readdirSync(markdownDir).find((name) => (
    path.extname(name).toLowerCase() === '.md'
      && path.basename(name, path.extname(name)).toLowerCase() === lowerAvCode
  ));

  const markdownPath = matchedName ? path.join(markdownDir, matchedName) : exactPath;
  logStep(matchedName ? '找到忽略大小写匹配的 Markdown 文件' : '未找到番号 Markdown 文件', markdownPath);
  return markdownPath;
}

/** 解析 Markdown 表格并返回指定番号所在行的字段数据。 */
function parseMarkdownRow(markdownPath, avCode) {
  logStep('开始读取 Markdown 文件', markdownPath);
  const content = fs.readFileSync(markdownPath, 'utf8');
  logStep('Markdown 文件读取完成', `字符数=${content.length}`);
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('| --'));

  if (lines.length < 2) {
    logStep('Markdown 中没有可解析的数据行');
    return null;
  }

  const parseCells = (line) => line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  const headers = parseCells(lines[0]);
  logStep('Markdown 表头解析完成', headers);

  for (const line of lines.slice(1)) {
    const cells = parseCells(line);
    if (cells[0] && cells[0].toLowerCase() === avCode.toLowerCase()) {
      const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
      logStep('找到番号对应的 Markdown 数据行', row);
      return row;
    }
  }

  logStep('Markdown 中未找到番号对应的数据行', avCode);
  return null;
}

/** 读取番号数据，并在未显式提供时从 Markdown 中取得磁力链接。 */
async function readAvCodeRow(avCode, cloudLoadUrl, prompt) {
  logStep('开始读取番号关联数据', { avCode, hasCloudLoadUrl: Boolean(cloudLoadUrl) });
  if (!avCode) {
    logStep('未提供番号，跳过 Markdown 读取');
    return {
      rowData: null,
      cloudLoadUrl,
      avCode,
    };
  }

  let markdownPath = findMarkdownPath(avCode);
  if (!fs.existsSync(markdownPath)) {
    console.error(
      `错误: 找不到文件 ${markdownPath}，请先运行 node jav/jav_magnet.js --番号 ${avCode} 生成该文件`,
    );
    const input = await prompt.ask('请重新输入番号（直接回车跳过）: ');
    logStep(input ? '已接收重新输入的番号' : '未重新输入番号', input || undefined);
    if (input) {
      avCode = input;
      markdownPath = findMarkdownPath(avCode);
    }
  }

  let rowData = null;
  if (fs.existsSync(markdownPath)) {
    try {
      rowData = parseMarkdownRow(markdownPath, avCode);
      if (!cloudLoadUrl && rowData?.磁力链?.startsWith('magnet:?')) {
        cloudLoadUrl = rowData.磁力链;
        logStep('已从 Markdown 取得磁力链接');
      }
    } catch (error) {
      console.error(`读取或解析 ${markdownPath} 失败: ${error.message}`);
    }
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
    throw new Error('Cookies API 返回格式错误: 顶层数据必须是数组');
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

/** 请求本机 115 HTTP API 并解析 JSON 响应。 */
function requestApi(method, apiPath, body = null) {
  const payload = body === null ? null : JSON.stringify(body);
  logStep('准备请求本机 115 API', `${method} ${apiPath}`);

  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL(apiPath, COOKIE_API_BASE_URL),
      {
        method,
        headers: payload === null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        logStep('已收到本机 115 API 响应头', `${method} ${apiPath} HTTP ${response.statusCode}`);
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          logStep('本机 115 API 响应接收完成', `${method} ${apiPath} 字符数=${responseBody.length}`);
          let data;
          try {
            data = responseBody ? JSON.parse(responseBody) : null;
          } catch (error) {
            logStep('本机 115 API 响应 JSON 解析失败', `${method} ${apiPath}`);
            reject(new Error(`115 API 返回的不是有效 JSON: ${error.message}`));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            logStep('本机 115 API 返回失败状态', `${method} ${apiPath} HTTP ${response.statusCode}`);
            reject(new Error(
              data?.message || `115 API 请求失败: HTTP ${response.statusCode}`,
            ));
            return;
          }

          resolve(data);
          logStep('本机 115 API 请求成功', `${method} ${apiPath}`);
        });
      },
    );

    request.setTimeout(10000, () => {
      logStep('本机 115 API 请求超时', `${method} ${apiPath}`);
      request.destroy(new Error('115 API 请求超时'));
    });
    request.on('error', (error) => {
      logStep('本机 115 API 请求发生错误', `${method} ${apiPath}: ${error.message}`);
      reject(new Error(`无法访问 115 API: ${error.message}`));
    });

    if (payload !== null) {
      logStep('正在写入本机 115 API 请求体', `${method} ${apiPath} 字节数=${Buffer.byteLength(payload)}`);
      request.write(payload);
    }
    logStep('正在发送本机 115 API 请求', `${method} ${apiPath}`);
    request.end();
  });
}

/** 从本机 API 获取 Cookie，并转换为 Playwright 格式。 */
async function loadCookiesFromApi() {
  logStep('开始从本机 API 加载 Cookies');
  const cookies = await requestApi('GET', '/115/cookies/get');
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
    '/115/cookies/update',
    { cookies: serializeCookiesForApi(cookies) },
  );
  logStep(`已通过 ${COOKIE_API_BASE_URL}/115/cookies/update 更新 Cookies`);
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

/** 收集目录内文件名不包含完整番号或其字母、数字部分的文件 ID。 */
/** [filesJsonArray] // {"data":[{"cid":"3383959617360493686","pid":"739884770980370058","n":"示例目录","fc":0,"name":"示例目录"},{"fid":"3479022661739218855","cid":"739884770980370058","n":"示例视频.mp4","s":763992447,"fc":1,"ico":"mp4","sha":"...","name":"示例视频.mp4"}]} */
async function collectNonAvCodeFileIds(filesJsonArray, avCode) {
  // 步骤 1：从文件列表响应中提取文件项。
  logStep('开始扫描目录文件并判断是否保留', avCode);
  const files = Array.isArray(filesJsonArray?.data)
    ? filesJsonArray.data
    : [];
  logStep('已取得当前目录文件项数量', files.length);
  const avCodeLower = avCode.toLowerCase();
  const parts = avCode.split('-');
  const fileIds = [];

  // 步骤 2：逐个判断文件名是否符合保留规则。
  for (const file of files) {
    const name = String(file?.name || '');
    const nameLower = name.toLowerCase();

    // 保留规则一：文件名包含完整番号。
    if (nameLower.includes(avCodeLower)) {
      logStep('文件名包含完整番号，保留文件', name);
      continue;
    }

    // 保留规则二：文件名同时包含番号的字母部分和数字部分。
    if (
      parts.length >= 2
      && nameLower.includes(parts[0].toLowerCase())
      && nameLower.includes(parts[1].toLowerCase())
    ) {
      logStep('文件名包含番号的字母和数字部分，保留文件', name);
      continue;
    }

    // 只有真实文件的 fid 才能提交删除；目录等无 fid 项不处理。
    const fileId = String(file?.fid || '').trim();
    if (!fileId) {
      logStep('文件缺少有效的 fid，跳过删除', name);
      continue;
    }

    logStep('文件不符合番号规则，加入删除列表', { name, fileId });
    fileIds.push(fileId);
  }

  logStep('目录文件扫描完成', `待删除数量=${fileIds.length}`);
  return fileIds;
}

/** 在当前目录中查找并删除不符合番号规则的文件。 */
async function cleanupNonAvCodeFilesInDir(cateId, avCode) {
  // 步骤 1：校验清理目录和番号。
  logStep('开始清理目录中不符合番号规则的文件', avCode);
  if (!avCode || !cateId) {
    logStep('缺少目录 ID 或番号，跳过文件清理', { cateId, avCode });
    return;
  }

  // 步骤 2：通过 API 获取目标目录的文件列表。
  logStep('请求已下载目录文件列表');
  const filesJsonArray = await requestApi(
    'GET',
    `/115/files?cid=${encodeURIComponent(cateId)}`,
  );

  // {"data":[{"cid":"3383959617360493686","pid":"739884770980370058","n":"示例目录","fc":0,"name":"示例目录"},{"fid":"3479022661739218855","cid":"739884770980370058","n":"示例视频.mp4","s":763992447,"fc":1,"ico":"mp4","sha":"...","name":"示例视频.mp4"}]}
  logStep('文件列表', filesJsonArray);

  // 步骤 3：按照番号规则收集需要删除的文件 ID。
  const fileIds = await collectNonAvCodeFileIds(filesJsonArray, avCode);
  if (fileIds.length === 0) {
    logStep('没有需要通过 API 删除的不含番号文件');
    return;
  }

  // 步骤 4：一次性向删除接口提交所有待删除文件 ID。
  logStep('正在通过本机 API 删除不符合番号规则的文件', fileIds);
  const response = await requestApi(
    'POST',
    '/115/delete',
    { fid: fileIds },
  );
  logStep('删除接口响应', response);

  // 步骤 5：校验删除结果，避免把接口失败误记为成功。
  if (response?.state !== true || Number(response?.errno ?? response?.errcode ?? 0) !== 0) {
    logStep('删除接口返回失败，文件可能未被删除', response);
    return;
  }
  logStep(`已通过 API 提交删除 ${fileIds.length} 个不含番号的文件`);
}

/**
 * 按 Markdown 数据重命名下载目录，并清理目录中的无关文件。
 *
 * [cloudTaskJson] {"state":true,"errno":0,"errtype":"","errcode":0,"info_hash":"...","name":"SAVR-1029.8K","url":"magnet:?xt=urn:btih:..."}
 */
async function renameDirAndCleanup(rowData, avCode, cloudTaskJson) {
  // 步骤 1：校验 Markdown 数据和云下载任务名称。
  logStep('开始执行下载目录重命名与文件清理', {
    avCode,
    hasRowData: Boolean(rowData),
    taskName: cloudTaskJson?.name || null,
  });
  if (!rowData || !cloudTaskJson?.name) {
    logStep('缺少 Markdown 数据或云下载任务名称，跳过目录整理');
    return;
  }

  // 步骤 2：等待 115 创建云下载目录。
  logStep('云下载任务数据', cloudTaskJson);
  logStep('等待 3 秒，让云下载目录创建完成');
  await sleep(3000);

  // 步骤 3：读取重命名所需的新标题。
  const title = rowData['标题'];
  if (!title) {
    logStep('Markdown 数据中没有标题，跳过目录整理');
    return;
  }

  // 步骤 4：通过 API 获取云下载根目录列表。
  logStep('正在读取[云下载]根目录文件列表');
  const filesJson = await requestApi(
    'GET',
    `/115/files?cid=${encodeURIComponent(CLOUD_DOWNLOAD_CID)}`,
  );

  // {"data":[{"cid":"3383959617360493686","pid":"739884770980370058","n":"示例目录","fc":0,"name":"示例目录"},{"fid":"3479022661739218855","cid":"739884770980370058","n":"示例视频.mp4","s":763992447,"fc":1,"ico":"mp4","sha":"-","name":"示例视频.mp4"}],"count":2,"file_count":1,"folder_count":1,"page_size":200,"cid":"739884770980370058","path":[{"name":"根目录","cid":"0","pid":"0"},{"name":"云下载","cid":"739884770980370058","pid":"0"}],"offset":0,"limit":200,"state":true,"error":"","errNo":0}
  logStep('文件列表接口响应', filesJson);
  const files = Array.isArray(filesJson?.data)
    ? filesJson.data
    : [filesJson?.data].filter(Boolean);

  // 步骤 5：用云下载接口返回的原始任务名定位对应目录。
  const fileJson = files.find((file) => file?.name === cloudTaskJson.name);
  if (!fileJson) {
    logStep('未找到云下载任务对应目录', cloudTaskJson.name);
    return;
  }

  // 步骤 6：取得重命名使用的 ID，以及后续读取目录内容使用的 CID。
  const fid = fileJson['fid'] || fileJson['cid'];
  const cateId = String(fileJson['cid'] || '').trim();
  if (!fid) {
    logStep('目录数据缺少 fid 和 cid，跳过重命名', fileJson.name);
    return;
  }

  // 步骤 7：通过 API 重命名目录。
  logStep('正在通过本机 API 重命名目录', { fid, oldName: fileJson.name, newName: title });
  const rspJson = await requestApi(
    'POST',
    '/115/rename',
    { fid, new_name: title },
  );
  //  {"state":true,"error":"","errno":0,"data":{"3479728362388194351":"SAVR-1029 【VR】あま姉..."}}
  logStep('重命名接口响应', rspJson);

  // 重命名失败时停止，避免在目录状态不明确时继续删除文件。
  if (rspJson?.state !== true || Number(rspJson?.errno ?? rspJson?.errcode ?? 0) !== 0) {
    logStep('重命名目录失败，跳过文件清理', rspJson);
    return;
  }
  logStep('已通过 API 重命名目录', `${fileJson.name} -> ${title}`);

  // 步骤 8：使用目录 CID 获取内容并删除不符合番号规则的文件。
  await cleanupNonAvCodeFilesInDir(cateId, avCode);
  logStep('下载目录重命名与文件清理完成');
}

/** 启动浏览器、注入 Cookie、添加云下载任务并执行目录整理。 */
async function check115Login(cloudLoadUrl, avCode, rowData) {
  // 阶段 1：整理并记录输入参数。
  logStep('开始执行 115 云下载自动化流程');
  if (cloudLoadUrl) {
    logStep('正在解码磁力链接参数');
    cloudLoadUrl = decodeURIComponent(cloudLoadUrl);
    logStep('磁力链接参数解码完成');
  }
  logStep('自动化流程输入数据', {
    cloudLoadUrl,
    avCode,
    rowData,
  });

  // 阶段 2：从本机 API 获取登录 Cookie。
  let cookies;
  try {
    logStep('正在获取登录 Cookies');
    cookies = await loadCookiesFromApi();
    logStep(`已从 ${COOKIE_API_BASE_URL}/115/cookies/get 获取 ${cookies.length} 个 Cookies`);
  } catch (error) {
    console.error(`错误: ${error.message}`);
    logStep('获取登录 Cookies 失败，自动化流程结束');
    return;
  }

  // 阶段 3：启动浏览器，供登录状态展示和 Cookie 同步使用。
  logStep('正在启动 Chromium（请保持关注弹出的浏览器窗口）');
  let browser;
  try {
    browser = await chromium.launch({
      ...getLaunchOptions(),
      timeout: 45000,
    });
    logStep('Chromium 启动成功');
  } catch (error) {
    console.error(`启动浏览器失败: ${error.message}`);
    console.error(
      '若仍失败：1) 关闭其它占用调试端口的 Chrome；'
        + '2) 设置环境变量 CHROME_PATH 或 EDGE_PATH 为浏览器完整路径；'
        + '3) 确认已安装 Chrome 或 Edge。',
    );
    logStep('Chromium 启动失败，自动化流程结束');
    return;
  }

  // 阶段 4：创建独立浏览器上下文和页面。
  logStep('正在创建浏览器上下文');
  const context = await browser.newContext();
  logStep('浏览器上下文创建完成');
  logStep('正在创建浏览器页面');
  const page = await context.newPage();
  logStep('浏览器页面创建完成');
  let cloudTaskRsp = null;

  try {
    // 阶段 5：注入 Cookie、检查登录状态并打开云下载目录。
    await injectCookies(page, context, cookies);
    const isLoggedIn = detectLoginStatus(cookies);
    await gotoWangpan(page);

    // 阶段 6：登录有效且存在磁力链接时，通过 API 添加任务。
    if (isLoggedIn && cloudLoadUrl) {
      logStep('登录有效且存在磁力链接，开始创建云下载任务');

      // {"state":true,"errno":0,"errcode":0,"data":[{"state":true,"errno":0,"errtype":"","errcode":0,"info_hash":"...","name":"SAVR-1029.8K","url":"magnet:?xt=urn:btih:..."}]}
      cloudTaskRsp = await addCloudTask(cloudLoadUrl);
      const cloudTaskJson = cloudTaskRsp?.data?.[0];
      const cloudTaskSucceeded = (
        cloudTaskRsp?.state === true
        && Number(cloudTaskRsp?.errcode ?? cloudTaskRsp?.errno ?? 0) === 0
        && cloudTaskJson?.state === true
      );
      if (!cloudTaskSucceeded) {
        logStep('云下载任务创建失败', cloudTaskRsp);
        try {
          logStep('正在页面中显示云下载错误提示');
          await toast(page, cloudTaskRsp?.error_msg);
          logStep('云下载错误提示显示完成');
        } catch (error) {
          console.error(`显示云下载错误提示失败: ${error.message}`);
        }
        logStep('等待 3 秒后关闭浏览器');
        await sleep(3000);
        try {
          logStep('正在关闭浏览器');
          await browser.close();
          logStep('浏览器已关闭');
        } catch (error) {
          console.error(`关闭浏览器失败: ${error.message}`);
        }
        return;
      }
      logStep('云下载任务创建成功');
    } else {
      logStep('未满足创建云下载任务条件', { isLoggedIn, hasCloudLoadUrl: Boolean(cloudLoadUrl) });
    }
  } catch (error) {
    console.error(`【状态: 检查或操作过程出错】: ${error.message}`);
  }

  try {
    // 阶段 7：确认任务数据存在后，执行 API 重命名和文件清理。
    logStep('开始执行任务创建后的目录整理阶段');
    // {"state":true,"errno":0,"errtype":"","errcode":0,"info_hash":"...","name":"SAVR-1029.8K","url":"magnet:?xt=urn:btih:..."}
    const cloudTaskJson = cloudTaskRsp?.data?.[0];
    if (cloudTaskJson) {
      await renameDirAndCleanup(rowData, avCode, cloudTaskJson);
    } else {
      logStep('没有可整理的云下载任务数据，跳过目录重命名与清理');
    }
  } catch (error) {
    console.error(`重命名过程出错: ${error.message}`);
  }

  // 阶段 8：保存最新 Cookie 并关闭浏览器。
  logStep('主要操作完毕，浏览器将在 3 秒后自动关闭');
  await sleep(3000);
  try {
    await saveContextCookies(context);
  } catch (error) {
    console.error(`更新 Cookies 失败: ${error.message}`);
  }
  logStep('正在关闭浏览器');
  await browser.close();
  logStep('浏览器已关闭，115 云下载自动化流程结束');
}

/** 处理参数或交互输入，并组织执行完整的云下载自动化流程。 */
async function main() {
  // 步骤 1：解析命令行参数。
  logStep('脚本启动');
  let args;
  try {
    args = parseArguments();
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
    return;
  }

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
      console.error("错误: 离线下载链接必须以 'magnet:?' 开头");
      process.exitCode = 1;
      return;
    }
    logStep('离线下载链接格式校验通过');

    // 步骤 4：按番号读取 Markdown，并补全磁力链接和标题数据。
    const avCodeResult = await readAvCodeRow(avCode, cloudLoadUrl, prompt);

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
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
});
