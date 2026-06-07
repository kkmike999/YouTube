/**
 * 115 云下载自动化脚本
 *
 * 功能：
 * 1. 从 JSON 文件加载 115 Cookie，并使用本机 Chrome/Edge 打开 115 网盘。
 * 2. 检测登录状态，将 magnet 链接添加为云下载任务。
 * 3. 支持通过“番号”读取 ../jav/temp/<番号>.md 中的磁力链、磁力链目录名和标题。
 * 4. 下载任务创建后，将对应目录重命名为 Markdown 中的标题。
 * 5. 进入下载目录，删除文件名中不含完整番号或番号字母、数字部分的文件。
 *
 * 参数：
 *   node 115-cloud-load.js [Cookie文件] [--cloud-load <magnet链接>] [--番号 <番号>]
 * 未传参数时会使用交互式输入；默认 Cookie 文件为 cookies/cookies_115.json。
 */
const fs = require('fs');
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
const DEFAULT_COOKIE_FILE = path.join(__dirname, 'cookies', 'cookies_115.json');

/** 等待指定的毫秒数后继续执行。 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 从候选路径中返回第一个真实存在的路径。 */
function firstExistingPath(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

/** 从环境变量和常见安装目录中查找 Chrome 或 Edge 可执行文件。 */
function getBrowserExecutablePath() {
  const envPath = firstExistingPath([
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.BROWSER_PATH,
  ]);
  if (envPath) {
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

  return firstExistingPath(candidates);
}

/** 生成 Playwright 浏览器启动配置，并确保本机浏览器可用。 */
function getLaunchOptions() {
  const executablePath = getBrowserExecutablePath();
  if (!executablePath) {
    throw new Error(
      '未找到 Chrome 或 Edge，请安装浏览器，或设置 CHROME_PATH / EDGE_PATH / BROWSER_PATH',
    );
  }

  return {
    headless: false,
    executablePath,
  };
}

/** 创建用于命令行交互输入的提示器。 */
function createPrompt() {
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
      rl.close();
    },
  };
}

/** 解析 Cookie 文件、磁力链接和番号等命令行参数。 */
function parseArguments(args = process.argv.slice(2)) {
  const parsed = {
    cookieFile: null,
    cloudLoadUrl: null,
    bangou: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--cloud-load') {
      parsed.cloudLoadUrl = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith('--cloud-load=')) {
      parsed.cloudLoadUrl = argument.slice('--cloud-load='.length);
    } else if (argument === '--番号') {
      parsed.bangou = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith('--番号=')) {
      parsed.bangou = argument.slice('--番号='.length);
    } else if (argument.startsWith('-')) {
      throw new Error(`未知参数: ${argument}`);
    } else if (!parsed.cookieFile) {
      parsed.cookieFile = argument;
    } else {
      throw new Error(`多余参数: ${argument}`);
    }
  }

  return parsed;
}

/** 按番号查找对应的 Markdown 文件，支持文件名大小写不一致。 */
function findMarkdownPath(bangou) {
  const markdownDir = path.join(__dirname, '..', 'jav', 'temp');
  const exactPath = path.join(markdownDir, `${bangou}.md`);
  if (fs.existsSync(exactPath)) {
    return exactPath;
  }

  if (!fs.existsSync(markdownDir)) {
    return exactPath;
  }

  const lowerBangou = bangou.toLowerCase();
  const matchedName = fs.readdirSync(markdownDir).find((name) => (
    path.extname(name).toLowerCase() === '.md'
      && path.basename(name, path.extname(name)).toLowerCase() === lowerBangou
  ));

  return matchedName ? path.join(markdownDir, matchedName) : exactPath;
}

/** 解析 Markdown 表格并返回指定番号所在行的字段数据。 */
function parseMarkdownRow(markdownPath, bangou) {
  const content = fs.readFileSync(markdownPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('| --'));

  if (lines.length < 2) {
    return null;
  }

  const parseCells = (line) => line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  const headers = parseCells(lines[0]);

  for (const line of lines.slice(1)) {
    const cells = parseCells(line);
    if (cells[0] && cells[0].toLowerCase() === bangou.toLowerCase()) {
      return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    }
  }

  return null;
}

/** 读取番号数据，并在未显式提供时从 Markdown 中取得磁力链接。 */
async function readBangouRow(bangou, cloudLoadUrl, prompt) {
  if (!bangou) {
    return {
      rowData: null,
      cloudLoadUrl,
      bangou,
    };
  }

  let markdownPath = findMarkdownPath(bangou);
  if (!fs.existsSync(markdownPath)) {
    console.error(
      `错误: 找不到文件 ${markdownPath}，请先运行 jav_magnet.py --番号 ${bangou} 生成该文件`,
    );
    const input = await prompt.ask('请重新输入番号（直接回车跳过）: ');
    if (input) {
      bangou = input;
      markdownPath = findMarkdownPath(bangou);
    }
  }

  let rowData = null;
  if (fs.existsSync(markdownPath)) {
    try {
      rowData = parseMarkdownRow(markdownPath, bangou);
      if (!cloudLoadUrl && rowData?.磁力链?.startsWith('magnet:?')) {
        cloudLoadUrl = rowData.磁力链;
      }
    } catch (error) {
      console.error(`读取或解析 ${markdownPath} 失败: ${error.message}`);
    }
  }

  return {
    rowData,
    cloudLoadUrl,
    bangou,
  };
}

/** 读取 Cookie JSON 文件并转换为 Playwright 可注入的 Cookie 格式。 */
function loadCookiesFromFile(cookieFile) {
  if (!fs.existsSync(cookieFile)) {
    throw new Error(`找不到 Cookie 文件: ${cookieFile}`);
  }

  let cookiesList;
  try {
    cookiesList = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
  } catch (error) {
    throw new Error(`读取或解析 Cookie JSON 文件失败: ${error.message}`);
  }

  if (!Array.isArray(cookiesList)) {
    throw new Error('读取或解析 Cookie JSON 文件失败: 顶层数据必须是数组');
  }

  return cookiesList
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
}

/** 在页面及其所有 iframe 中查找符合条件的元素。 */
async function findLocatorInFrames(
  page,
  selector,
  { timeout = 3000, visible = false } = {},
) {
  const deadline = Date.now() + timeout;

  do {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector).first();
      try {
        if (await locator.count()) {
          if (!visible || await locator.isVisible()) {
            return { frame, locator };
          }
        }
      } catch {
        // The frame may have navigated while being inspected.
      }
    }

    if (Date.now() < deadline) {
      await sleep(100);
    }
  } while (Date.now() < deadline);

  return null;
}

/** 预访问 115 域名并向浏览器上下文注入登录 Cookie。 */
async function injectCookies(page, context, cookies) {
  console.log('正在预访问 115.com 以注入 Cookies...');
  await page.goto('https://115.com/404', { waitUntil: 'domcontentloaded' });
  console.log(`正在注入 ${cookies.length} 个 Cookies...`);
  await context.addCookies(cookies);
}

/** 访问 115 首页并根据页面特征判断当前登录状态。 */
async function detectLoginStatus(page) {
  const homeUrl = 'https://115.com/';
  console.log(`正在访问 ${homeUrl} 进行状态检测...`);
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
  console.log('等待页面加载完成，进行状态检测...');

  if (await findLocatorInFrames(page, 'login-card', { timeout: 5000 })) {
    console.log('【状态: 未登录】(检测到 <login-card> 登录组件框)');
    return false;
  }
  if (await findLocatorInFrames(page, '.login-finished', { timeout: 2000 })) {
    console.log('【状态: 已登录】(检测到传统的 login-finished 元素)');
    return true;
  }
  if (
    await findLocatorInFrames(page, 'div.user-info', { timeout: 2000 })
    || await findLocatorInFrames(page, 'div#js_top_panel_box', { timeout: 2000 })
  ) {
    console.log('【状态: 已登录】(检测到用户个人信息面板区域)');
    return true;
  }

  console.log(
    '【状态: 未知】(页面未出现明显的登录框，但也未发现已登录的特征元素，请手动观察弹出的浏览器核实)',
  );
  return false;
}

/** 跳转到预设的 115 云下载目录。 */
async function gotoWangpan(page) {
  const wangpanUrl = `https://115.com/?mode=wangpan&cid=${CLOUD_DOWNLOAD_CID}`;
  console.log(`正在重定向到 云下载 ${wangpanUrl} ...`);
  await page.goto(wangpanUrl, { waitUntil: 'domcontentloaded' });
}

/** 根据目录 ID 跳转到指定的 115 网盘目录。 */
async function gotoWangpanByCid(page, cateId) {
  const wangpanUrl = `https://115.com/?cid=${cateId}&mode=wangpan`;
  console.log(`正在跳转到目录: ${wangpanUrl}`);
  await page.goto(wangpanUrl, { waitUntil: 'domcontentloaded' });
}

/** 打开添加云下载窗口，提交磁力链接并刷新任务列表。 */
async function addCloudTask(page, cloudLoadUrl) {
  if (!cloudLoadUrl) {
    return;
  }

  console.log(`\n准备添加云下载任务: ${cloudLoadUrl}`);
  await sleep(2000);

  try {
    const dropdown = await findLocatorInFrames(
      page,
      '.context-menu[data-dropdown-content="upload_btn_add_dir"]',
      { timeout: 3000 },
    );
    if (dropdown) {
      await dropdown.locator.evaluate((element) => {
        element.style.display = 'block';
      });
    }
  } catch (error) {
    console.log(`显示菜单项失败 (可忽略): ${error.message}`);
  }

  const addButton = await findLocatorInFrames(
    page,
    'xpath=//a[@menu="offline_task" and .//i[contains(@class, "ifo-linktask")]]',
    { timeout: 5000 },
  );
  if (!addButton) {
    console.log('未找到【添加云下载】按钮');
    return;
  }

  await addButton.locator.click({ force: true });
  console.log('已点击【添加云下载】按钮');

  const textarea = await findLocatorInFrames(page, '#js_offline_new_add', {
    timeout: 5000,
    visible: true,
  });
  if (!textarea) {
    console.log('未找到链接输入框');
    return;
  }

  await textarea.locator.fill(cloudLoadUrl);
  console.log('已输入下载链接');

  const startButton = await findLocatorInFrames(page, '[data-btn="start"]', {
    timeout: 5000,
    visible: true,
  });
  if (!startButton) {
    console.log('未找到【开始下载】按钮');
    return;
  }

  await startButton.locator.click();
  console.log('已点击【开始下载】按钮');
  console.log('等待 2 秒...');
  await sleep(2000);
  console.log('正在刷新界面...');
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** 在文件列表中按完整 title 属性查找列表项。 */
async function getListItemByTitle(frame, titleText, timeout = 3000) {
  const deadline = Date.now() + timeout;

  do {
    const items = frame.locator('.list-contents li[title]');
    const count = await items.count();
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      if (await item.getAttribute('title') === titleText) {
        return item;
      }
    }

    if (Date.now() < deadline) {
      await sleep(100);
    }
  } while (Date.now() < deadline);

  return null;
}

/** 右键点击列表项并打开重命名对话框。 */
async function openRenameDialog(page, listItem) {
  await listItem.click({ button: 'right' });
  await sleep(500);

  const renameItem = await findLocatorInFrames(
    page,
    'xpath=//li[@val="edit_name"]//a[.//span[text()="重命名"]]',
    { timeout: 3000, visible: true },
  );
  if (!renameItem) {
    console.log('未找到【重命名】菜单项');
    return false;
  }

  await renameItem.locator.click();
  await sleep(500);
  return true;
}

/** 填写新名称并确认提交重命名操作。 */
async function submitRename(page, newTitle) {
  const input = await findLocatorInFrames(page, '[rel="txt"]', {
    timeout: 3000,
    visible: true,
  });
  if (!input) {
    console.log('未找到重命名输入框');
    return false;
  }

  await input.locator.fill(newTitle);
  await sleep(300);

  const confirmButton = await findLocatorInFrames(page, '[btn="confirm"]', {
    timeout: 3000,
    visible: true,
  });
  if (!confirmButton) {
    return false;
  }

  await confirmButton.locator.click();
  return true;
}

/** 选中目录内文件名不包含完整番号或其字母、数字部分的文件。 */
async function selectNonBangouFiles(innerList, bangou) {
  const items = innerList.locator(':scope > li');
  const count = await items.count();
  const bangouLower = bangou.toLowerCase();
  const parts = bangou.split('-');
  let selectedCount = 0;

  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const title = await item.getAttribute('title') || '';
    const titleLower = title.toLowerCase();

    if (titleLower.includes(bangouLower)) {
      console.log(`li_title=${title} 包含番号 ${bangou} 跳过`);
      continue;
    }

    if (
      parts.length >= 2
      && titleLower.includes(parts[0].toLowerCase())
      && titleLower.includes(parts[1].toLowerCase())
    ) {
      console.log(`li_title=${title} 包含番号 ${bangou} 的字母和数字部分 跳过`);
      continue;
    }

    console.log(`li_title=${title} 选中`);
    await item.evaluate((element) => {
      element.className = 'selected';
    });
    selectedCount += 1;
  }

  return selectedCount;
}

/** 删除已选中的文件，并在确认对话框中完成操作。 */
async function deleteSelectedFiles(page, frame, selectedCount) {
  if (selectedCount <= 0) {
    return;
  }

  const operateBox = frame.locator('#js_operate_box').first();
  if (!(await operateBox.count())) {
    return;
  }

  await operateBox.evaluate((element) => {
    element.style.left = '170px';
    if (element.style.display) {
      element.style.display = 'flex';
    }
  });
  await sleep(200);

  let deleteButton = operateBox.locator('li[menu="delete"] a').first();
  if (!(await deleteButton.count())) {
    deleteButton = operateBox.locator('li[menu="delete"]').first();
  }
  if (!(await deleteButton.count())) {
    console.log('未找到删除按钮');
    return;
  }

  try {
    await deleteButton.evaluate((element) => {
      element.scrollIntoView({ block: 'center' });
    });
    await sleep(200);
  } catch {
    // Scrolling is only a best-effort step.
  }

  await deleteButton.click({ force: true });
  await sleep(2000);

  const confirmSelectors = [
    'div.dialog-box.window-current a.dgac-confirm[btn="confirm"]',
    'xpath=//div[contains(@class,"dialog-box") and contains(@class,"window-current")]//a[@btn="confirm"]',
    'xpath=//div[contains(@class,"dialog-box") and contains(@class,"window-current")]//a[normalize-space(text())="确定"]',
  ];
  let confirmButton = null;

  for (const selector of confirmSelectors) {
    confirmButton = await findLocatorInFrames(page, selector, {
      timeout: 1500,
      visible: true,
    });
    if (confirmButton) {
      break;
    }
  }

  if (!confirmButton) {
    console.log('未找到确认按钮（当前文档与 top 文档均未命中）');
    return;
  }

  try {
    await confirmButton.locator.evaluate((element) => {
      element.scrollIntoView({ block: 'center' });
    });
    await sleep(200);
  } catch {
    // Scrolling is only a best-effort step.
  }

  await confirmButton.locator.click({ force: true });
  console.log(`已删除 ${selectedCount} 个不含番号的文件`);
}

/** 在当前目录中查找并删除不符合番号规则的文件。 */
async function cleanupNonBangouFilesInDir(page, bangou) {
  const listContainer = await findLocatorInFrames(page, '.list-contents', {
    timeout: 5000,
  });
  if (!listContainer || !bangou) {
    console.log(`inner_list=${listContainer?.locator || null}, bangou=${bangou} 清理不含番号的文件失败 return`);
    return;
  }

  let innerList = listContainer.locator.locator('ul').first();
  if (!(await innerList.count())) {
    innerList = listContainer.frame.locator('.list-contents ul').first();
  }
  if (!(await innerList.count())) {
    console.log(`inner_list=null, bangou=${bangou} 清理不含番号的文件失败 return`);
    return;
  }

  const selectedCount = await selectNonBangouFiles(innerList, bangou);
  await deleteSelectedFiles(page, listContainer.frame, selectedCount);
}

/** 按 Markdown 数据重命名下载目录，并清理目录中的无关文件。 */
async function renameDirAndCleanup(page, rowData, bangou) {
  if (!rowData) {
    return;
  }

  await sleep(4000);
  const magnetDirName = rowData['磁力链目录名'];
  const title = rowData['标题'];
  if (!magnetDirName || !title) {
    return;
  }

  const listContainer = await findLocatorInFrames(page, '.list-contents', {
    timeout: 5000,
  });
  if (!listContainer) {
    return;
  }

  const listItem = await getListItemByTitle(listContainer.frame, magnetDirName);
  if (!listItem) {
    console.log(`未找到 title=${magnetDirName} 的列表项`);
    return;
  }

  const cateId = await listItem.getAttribute('cate_id');
  if (!(await openRenameDialog(page, listItem))) {
    return;
  }
  if (!(await submitRename(page, title))) {
    return;
  }

  console.log(`已重命名: ${magnetDirName} -> ${title}`);
  await sleep(1000);

  if (cateId) {
    await gotoWangpanByCid(page, cateId);
    await sleep(4000);
  } else {
    await listItem.click();
    await sleep(4000);
  }

  await cleanupNonBangouFilesInDir(page, bangou);
  await gotoWangpanByCid(page, CLOUD_DOWNLOAD_CID);
  await sleep(1000);
}

/** 启动浏览器、注入 Cookie、添加云下载任务并执行目录整理。 */
async function check115Login(cookieFile, cloudLoadUrl, bangou, rowData) {
  if (cloudLoadUrl) {
    cloudLoadUrl = decodeURIComponent(cloudLoadUrl);
  }
  console.log(
    `check_115_login: cookie_file=${cookieFile}, cloud_load_url=${cloudLoadUrl}, `
      + `番号=${bangou}, row_data=${JSON.stringify(rowData)}`,
  );

  let cookies;
  try {
    cookies = loadCookiesFromFile(cookieFile);
  } catch (error) {
    console.error(`错误: ${error.message}`);
    return;
  }

  console.log('正在启动 Chromium... (请保持关注弹出的浏览器窗口)');
  let browser;
  try {
    browser = await chromium.launch({
      ...getLaunchOptions(),
      timeout: 45000,
    });
  } catch (error) {
    console.error(`启动浏览器失败: ${error.message}`);
    console.error(
      '若仍失败：1) 关闭其它占用调试端口的 Chrome；'
        + '2) 设置环境变量 CHROME_PATH 或 EDGE_PATH 为浏览器完整路径；'
        + '3) 确认已安装 Chrome 或 Edge。',
    );
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await injectCookies(page, context, cookies);
    const isLoggedIn = await detectLoginStatus(page);
    await gotoWangpan(page);

    if (isLoggedIn && cloudLoadUrl) {
      await addCloudTask(page, cloudLoadUrl);
    }
  } catch (error) {
    console.error(`【状态: 检查或操作过程出错】: ${error.message}`);
  }

  try {
    await gotoWangpan(page);
    await renameDirAndCleanup(page, rowData, bangou);
  } catch (error) {
    console.error(`重命名过程出错: ${error.message}`);
  }

  console.log('\n操作完毕。浏览器实例将在 10 秒后自动关闭。');
  await sleep(10000);
  await browser.close();
}

/** 处理参数或交互输入，并组织执行完整的云下载自动化流程。 */
async function main() {
  let args;
  try {
    args = parseArguments();
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const prompt = createPrompt();
  let cookieFile;
  let cloudLoadUrl;
  let bangou;

  try {
    if (process.argv.length === 2) {
      console.log('未提供任何参数，将逐个提示输入（可直接回车跳过）\n');
      if (fs.existsSync(DEFAULT_COOKIE_FILE)) {
        cookieFile = DEFAULT_COOKIE_FILE;
      } else {
        const cookieInput = await prompt.ask('Cookie 文件路径 [cookies_115.json 不存在]: ');
        cookieFile = cookieInput || DEFAULT_COOKIE_FILE;
      }

      const cloudLoadInput = await prompt.ask('离线下载链接 [默认: 不添加]: ');
      cloudLoadUrl = cloudLoadInput || null;
      const bangouInput = await prompt.ask('番号 [默认: 不添加]: ');
      bangou = bangouInput || null;
    } else {
      cookieFile = args.cookieFile || DEFAULT_COOKIE_FILE;
      cloudLoadUrl = args.cloudLoadUrl;
      bangou = args.bangou;
    }

    if (cloudLoadUrl && !cloudLoadUrl.trim().startsWith('magnet:?')) {
      console.error("错误: 离线下载链接必须以 'magnet:?' 开头");
      process.exitCode = 1;
      return;
    }

    const bangouResult = await readBangouRow(bangou, cloudLoadUrl, prompt);
    await check115Login(
      cookieFile,
      bangouResult.cloudLoadUrl,
      bangouResult.bangou,
      bangouResult.rowData,
    );
  } finally {
    prompt.close();
  }
}

main().catch((error) => {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
});
