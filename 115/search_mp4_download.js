const fs = require('fs');
const path = require('path');
const readline = require('readline');
let chromium;

try {
  ({ chromium } = require('playwright-core'));
} catch {
  ({ chromium } = require('playwright'));
}

const START_URL = 'https://115.com/?cid=3374099409331158534';
const PASTE_TARGET_CID = '3445595181372409406';
const PASTE_TARGET_URL = `https://115.com/?cid=${PASTE_TARGET_CID}&offset=0&tab=&mode=wangpan`;
const COOKIE_FILE = path.join(__dirname, 'cookies', 'cookies_115.json');
const MAX_DEBUG_ITEMS = 80;

function installClickListenerTracker(context) {
  return context.addInitScript(() => {
    const registrations = [];
    const originalAddEventListener = EventTarget.prototype.addEventListener;

    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (type === 'click') {
        registrations.push({
          target: this,
          listener,
          capture: typeof options === 'boolean' ? options : Boolean(options && options.capture),
        });
      }
      return originalAddEventListener.call(this, type, listener, options);
    };

    Object.defineProperty(window, '__clickListenerRegistrations', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: registrations,
    });
  });
}

function firstExistingPath(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

function getBrowserExecutablePath() {
  const envPath = firstExistingPath([
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.BROWSER_PATH,
  ]);
  if (envPath) {
    return envPath;
  }

  const programFiles = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);

  const candidates = [];
  for (const baseDir of programFiles) {
    candidates.push(
      path.join(baseDir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(baseDir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  }

  return firstExistingPath(candidates);
}

function getLaunchOptions() {
  const executablePath = getBrowserExecutablePath();
  if (!executablePath) {
    throw new Error('未找到 Chrome 或 Edge，请安装浏览器，或设置 CHROME_PATH / EDGE_PATH / BROWSER_PATH');
  }

  return {
    headless: false,
    executablePath,
  };
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getSearchKeyArgument(args = process.argv.slice(2)) {
  const prefix = '--searchKey=';
  const argument = args.find((value) => value.startsWith(prefix));

  return argument === undefined ? undefined : argument.slice(prefix.length).trim();
}

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

async function showToast(page, message) {
  await page.evaluate((text) => {
    const toast = document.createElement('div');
    toast.textContent = text;
    toast.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'left:50%',
      'top:24px',
      'transform:translateX(-50%)',
      'padding:10px 16px',
      'background:#d93025',
      'color:#fff',
      'font:14px/1.4 sans-serif',
      'border-radius:6px',
      'box-shadow:0 6px 18px rgba(0,0,0,.22)',
    ].join(';');
    document.body.appendChild(toast);
  }, message);
}

async function ensureLoggedIn(page) {
  try {
    await page.locator('div.user-avatar[style=""], div.user-avatar').first().waitFor({
      state: 'attached',
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

async function searchByKey(page, key) {
  const searchInput = page.locator('.search-box input#js-top_search_text').first();
  await searchInput.waitFor({ state: 'visible', timeout: 15000 });
  await searchInput.fill(`"${key}"`);
  await searchInput.press('Enter');

  await page.waitForURL(
    (url) => url.href.includes('submode=wangpan') && url.href.includes('mode=search'),
    { timeout: 30000 },
  );
  console.log(`[debug] 搜索跳转完成: ${page.url()}`);
  const searchFrame = getSearchFrameLocator(page);
  await searchFrame.locator('body').waitFor({ state: 'attached', timeout: 30000 });
  await logAllLiTitles(searchFrame, '搜索跳转完成后 iframe 内');
}

function getSearchFrameLocator(page) {
  return page.frameLocator('iframe[rel="other"]');
}

async function logAllLiTitles(scope, reason) {
  const liTitles = await scope.locator('li').evaluateAll((items) => items.map((element, index) => ({
    index,
    className: element.className,
    title: element.getAttribute('title'),
    text: (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  })));

  console.log(`[debug] ${reason} 页面 li 数量: ${liTitles.length}`);
  for (const item of liTitles) {
    console.log(
      [
        `[debug] li #${item.index}`,
        `class=${JSON.stringify(item.className)}`,
        `title=${JSON.stringify(item.title)}`,
        `text=${JSON.stringify(item.text)}`,
      ].join(' | '),
    );
  }
}

async function getDomState(scope) {
  return scope.locator('body').evaluate((body) => {
    const document = body.ownerDocument;
    const selectors = [
      'div.list-contents',
      'div.list-contents > ul',
      'div.list-contents > ul > li',
      '.list-contents',
      '.list',
      '.file-name',
      '[title]',
      'input[type="checkbox"]',
      '.empty',
      '.no-data',
      '.search-empty',
    ];

    const selectorCounts = Object.fromEntries(
      selectors.map((selector) => [selector, document.querySelectorAll(selector).length]),
    );

    const titledItems = Array.from(document.querySelectorAll('[title]'))
      .slice(0, 30)
      .map((element, index) => ({
        index,
        tagName: element.tagName,
        className: element.className,
        title: element.getAttribute('title'),
        text: (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      }));

    return {
      readyState: document.readyState,
      title: document.title,
      selectorCounts,
      bodyText: (document.body && document.body.innerText ? document.body.innerText : '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600),
      titledItems,
    };
  });
}

async function logDomState(scope, label) {
  const state = await getDomState(scope);

  console.log(`[debug] ${label} document.readyState=${state.readyState}`);
  console.log(`[debug] ${label} document.title=${JSON.stringify(state.title)}`);
  console.log(`[debug] ${label} 选择器数量: ${JSON.stringify(state.selectorCounts)}`);
  console.log(`[debug] ${label} 页面可见文本片段: ${JSON.stringify(state.bodyText)}`);
  for (const item of state.titledItems) {
    console.log(
      [
        `[debug] ${label} title item #${item.index}`,
        `tag=${item.tagName}`,
        `class=${JSON.stringify(item.className)}`,
        `title=${JSON.stringify(item.title)}`,
        `text=${JSON.stringify(item.text)}`,
      ].join(' | '),
    );
  }
}

async function logSearchPageState(page, reason) {
  console.log(`[debug] 页面状态诊断: ${reason}`);
  console.log(`[debug] 顶层当前 URL: ${page.url()}`);
  await logDomState(page, '顶层页面');
  await logAllLiTitles(page, '诊断时顶层页面');

  const iframeCount = await page.locator('iframe').count();
  console.log(`[debug] iframe 数量: ${iframeCount}`);
  const iframeInfo = await page.locator('iframe').evaluateAll((iframes) => iframes.map((iframe, index) => ({
    index,
    rel: iframe.getAttribute('rel'),
    src: iframe.getAttribute('src'),
    title: iframe.getAttribute('title'),
  })));
  for (const item of iframeInfo) {
    console.log(
      [
        `[debug] iframe #${item.index}`,
        `rel=${JSON.stringify(item.rel)}`,
        `src=${JSON.stringify(item.src)}`,
        `title=${JSON.stringify(item.title)}`,
      ].join(' | '),
    );
  }

  try {
    const searchFrame = getSearchFrameLocator(page);
    await logDomState(searchFrame, '搜索 iframe');
    await logAllLiTitles(searchFrame, '诊断时搜索 iframe');
  } catch (error) {
    console.log(`[debug] 搜索 iframe 诊断失败: ${error.message}`);
  }
}

async function selectMatchedFiles(page, key) {
  const expectedTitles = new Set([
    `${key}.mp4`,
    `${key}.jpeg`,
    `${key}.jpg`,
    `${key}.png`,
  ]);
  const expectedTitleList = Array.from(expectedTitles);
  console.log(`[debug] 期望匹配标题: ${expectedTitleList.map((title) => JSON.stringify(title)).join(', ')}`);
  const searchFrame = getSearchFrameLocator(page);

  try {
    await searchFrame.locator('div.list-contents > ul').first().waitFor({
      state: 'attached',
      timeout: 30000,
    });
  } catch (error) {
    await logSearchPageState(page, `等待搜索结果列表失败: ${error.message}`);
    throw error;
  }

  await logMatchedItemClickListeners(searchFrame, expectedTitleList);

  const resultItems = searchFrame.locator('div.list-contents > ul > li');
  const result = await resultItems.evaluateAll((items, options) => {
    const { titles, maxDebugItems } = options;
    const inspectedItems = [];

    for (const [index, li] of items.entries()) {
      const title = li.getAttribute('title');
      const matched = title !== null && titles.some((expectedTitle) => title.endsWith(expectedTitle));
      const checkbox = li.querySelector('input[type="checkbox"]');
      const text = (li.innerText || '').replace(/\s+/g, ' ').trim();

      if (inspectedItems.length < maxDebugItems) {
        inspectedItems.push({
          index,
          title,
          text: text.slice(0, 200),
          hasCheckbox: Boolean(checkbox),
          checkboxChecked: Boolean(checkbox && checkbox.checked),
          matched,
        });
      }

      if (!matched) {
        continue;
      }
    }

    return {
      totalCount: items.length,
      inspectedItems,
    };
  }, {
    titles: expectedTitleList,
    maxDebugItems: MAX_DEBUG_ITEMS,
  });

  let selectedCount = 0;
  for (let index = 0; index < result.totalCount; index += 1) {
    const li = resultItems.nth(index);
    const title = await li.getAttribute('title');
    const matched = title !== null
      && expectedTitleList.some((expectedTitle) => title.endsWith(expectedTitle));
    if (!matched) {
      continue;
    }

    const clickTarget = li.locator('[data-move="ico"], [menu="file_check_one"]').first();
    await clickTarget.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`[debug] 点击匹配项选择区域: index=${index} title=${JSON.stringify(title)}`);
    await clickTarget.click();
    selectedCount += 1;
  }

  console.log(`[debug] 搜索结果 li 数量: ${result.totalCount}`);
  for (const item of result.inspectedItems) {
    console.log(
      [
        `[debug] item #${item.index}`,
        `matched=${item.matched}`,
        `hasCheckbox=${item.hasCheckbox}`,
        `checkedBefore=${item.checkboxChecked}`,
        `title=${JSON.stringify(item.title)}`,
        `text=${JSON.stringify(item.text)}`,
      ].join(' | '),
    );
  }
  if (result.totalCount > result.inspectedItems.length) {
    console.log(`[debug] 仅打印前 ${result.inspectedItems.length} 条结果，剩余 ${result.totalCount - result.inspectedItems.length} 条未打印`);
  }

  return selectedCount;
}

async function logMatchedItemClickListeners(searchFrame, expectedTitles) {
  const reports = await searchFrame
    .locator('div.list-contents > ul > li')
    .evaluateAll((items, titles) => {
      const describeTarget = (target) => {
        if (target === window) {
          return 'window';
        }
        if (target === document) {
          return 'document';
        }
        if (!(target instanceof Element)) {
          return Object.prototype.toString.call(target);
        }

        const id = target.id ? `#${target.id}` : '';
        const classes = typeof target.className === 'string'
          ? target.className.trim().split(/\s+/).filter(Boolean).map((name) => `.${name}`).join('')
          : '';
        return `${target.tagName.toLowerCase()}${id}${classes}`;
      };

      const listenerSource = (listener) => {
        try {
          const source = typeof listener === 'function'
            ? Function.prototype.toString.call(listener)
            : Function.prototype.toString.call(listener.handleEvent);
          return source.replace(/\s+/g, ' ').slice(0, 300);
        } catch {
          return '[无法读取监听器源码]';
        }
      };

      const registrations = Array.isArray(window.__clickListenerRegistrations)
        ? window.__clickListenerRegistrations
        : [];

      return items
        .filter((li) => {
          const title = li.getAttribute('title');
          return title !== null && titles.some((expectedTitle) => title.endsWith(expectedTitle));
        })
        .map((li) => {
          const ancestors = [];
          for (let node = li; node; node = node.parentElement) {
            ancestors.push(node);
          }

          const relevantTargets = new Set([...ancestors, document, window]);
          const listeners = registrations
            .filter((registration) => relevantTargets.has(registration.target))
            .map((registration) => ({
              target: describeTarget(registration.target),
              capture: registration.capture,
              source: listenerSource(registration.listener),
            }));

          const inlineHandlers = ancestors
            .filter((element) => element.hasAttribute('onclick') || typeof element.onclick === 'function')
            .map((element) => ({
              target: describeTarget(element),
              attribute: element.getAttribute('onclick'),
              property: element.onclick ? listenerSource(element.onclick) : null,
            }));

          const jqueryListeners = [];
          const jquery = window.jQuery || window.$;
          if (jquery && typeof jquery._data === 'function') {
            for (const target of [...ancestors, document, window]) {
              const events = jquery._data(target, 'events');
              for (const handler of events && events.click ? events.click : []) {
                jqueryListeners.push({
                  target: describeTarget(target),
                  selector: handler.selector || null,
                  namespace: handler.namespace || null,
                  source: listenerSource(handler.handler),
                });
              }
            }
          }

          return {
            title: li.getAttribute('title'),
            className: li.className,
            listeners,
            inlineHandlers,
            jqueryListeners,
          };
        });
    }, expectedTitles);

  for (const report of reports) {
    console.log(`[debug] click 监听诊断: title=${JSON.stringify(report.title)} class=${JSON.stringify(report.className)}`);
    console.log(`[debug] addEventListener click 数量: ${report.listeners.length}`);
    for (const listener of report.listeners) {
      console.log(
        `[debug] click listener | target=${listener.target} | capture=${listener.capture} | source=${JSON.stringify(listener.source)}`,
      );
    }
    console.log(`[debug] inline onclick 数量: ${report.inlineHandlers.length}`);
    for (const handler of report.inlineHandlers) {
      console.log(
        `[debug] inline onclick | target=${handler.target} | attribute=${JSON.stringify(handler.attribute)} | property=${JSON.stringify(handler.property)}`,
      );
    }
    console.log(`[debug] jQuery click 数量: ${report.jqueryListeners.length}`);
    for (const listener of report.jqueryListeners) {
      console.log(
        `[debug] jQuery click | target=${listener.target} | selector=${JSON.stringify(listener.selector)} | namespace=${JSON.stringify(listener.namespace)} | source=${JSON.stringify(listener.source)}`,
      );
    }
  }
}

async function clickCopyMenu(page) {
  const searchFrame = getSearchFrameLocator(page);
  const moreMenu = searchFrame
    .locator('li[menu_btn="operate_more"][multi_more="1"]')
    .filter({ has: searchFrame.locator('span', { hasText: '更多' }) })
    .first();

  await moreMenu.waitFor({ state: 'visible', timeout: 15000 });
  await moreMenu.click();

  const operateBox = searchFrame.locator('#js_operate_box').first();
  await operateBox.waitFor({ state: 'visible', timeout: 15000 });

  const copyMenu = searchFrame
    .locator('li[menu="set_copy"][show_type="all"]')
    .filter({ has: searchFrame.locator('span', { hasText: '复制' }) })
    .first();

  await copyMenu.waitFor({ state: 'visible', timeout: 120000 });
  await copyMenu.locator('a[href="javascript:;"]').first().click();
}

function isTargetFileFrame(frame, cid) {
  try {
    const url = new URL(frame.url());
    return url.searchParams.get('ct') === 'file'
      && url.searchParams.get('ac') === 'userfile'
      && url.searchParams.get('cid') === cid;
  } catch {
    return false;
  }
}

async function logPasteFrameSummary(page, reason) {
  console.log(`[debug] 粘贴 frame 诊断: ${reason}`);

  for (const [index, frame] of page.frames().entries()) {
    try {
      const pasteButtonCount = await frame.locator('a[rel="copy_paste"]').count();
      const cancelButtonCount = await frame.locator('a[rel="copy_cancel"]').count();
      console.log(
        [
          `[debug] frame #${index}`,
          `url=${JSON.stringify(frame.url())}`,
          `copyPasteButtons=${pasteButtonCount}`,
          `copyCancelButtons=${cancelButtonCount}`,
        ].join(' | '),
      );
    } catch (error) {
      console.log(
        `[debug] frame #${index} | url=${JSON.stringify(frame.url())} | error=${error.message}`,
      );
    }
  }
}

async function waitForAndClickTargetButton(
  page,
  cid,
  { selector, label },
  timeout = 30000,
) {
  const startedAt = Date.now();
  let lastProgressLogAt = startedAt;

  while (Date.now() - startedAt < timeout) {
    const targetFrame = page.frames().find((frame) => isTargetFileFrame(frame, cid));

    if (targetFrame) {
      const button = targetFrame.locator(selector).first();
      const remainingTimeout = Math.max(1, timeout - (Date.now() - startedAt));

      try {
        await button.waitFor({
          state: 'visible',
          timeout: Math.min(2000, remainingTimeout),
        });
        await button.click();
        return targetFrame.url();
      } catch {
        // The target iframe may still be rendering or may have reloaded.
      }
    }

    if (Date.now() - lastProgressLogAt >= 5000) {
      const targetFrameUrl = targetFrame ? targetFrame.url() : '尚未加载';
      console.log(
        `[debug] 等待目标文件 iframe 和【${label}】按钮: targetFrame=${JSON.stringify(targetFrameUrl)}`,
      );
      lastProgressLogAt = Date.now();
    }

    await page.waitForTimeout(250);
  }

  await logPasteFrameSummary(page, `等待目标 CID ${cid} 的【${label}】按钮超时`);
  throw new Error(`等待目标目录【${label}】按钮超时 ${timeout}ms`);
}

async function navigateToTargetAndPaste(page) {
  console.log(`[debug] 准备跳转到粘贴目标目录: ${PASTE_TARGET_URL}`);
  const response = await page.goto(PASTE_TARGET_URL, { waitUntil: 'domcontentloaded' });
  console.log(
    `[debug] 目标目录跳转完成: url=${page.url()} status=${response ? response.status() : '无主文档响应'}`,
  );

  const targetFrameUrl = await waitForAndClickTargetButton(page, PASTE_TARGET_CID, {
    selector: '#js_paste_btn a[rel="copy_paste"]',
    label: '粘贴文件',
  });
  console.log(`[debug] 目标文件 iframe 已就绪: ${targetFrameUrl}`);
  console.log('[debug] 【粘贴文件】按钮点击完成');

  await waitForAndClickTargetButton(page, PASTE_TARGET_CID, {
    selector: '#js_paste_btn a[rel="copy_cancel"]',
    label: '取消',
  });
  console.log('[debug] 【取消】按钮点击完成');
}

async function main() {
  const searchKeyArgument = getSearchKeyArgument();
  const key = searchKeyArgument === undefined
    ? await ask('请输入搜索内容: ')
    : searchKeyArgument;
  if (!key) {
    console.error('错误: 搜索内容不能为空');
    process.exitCode = 1;
    return;
  }

  let browser;
  try {
    const cookies = loadCookiesFromFile(COOKIE_FILE);
    browser = await chromium.launch(getLaunchOptions());
    const context = await browser.newContext();
    await installClickListenerTracker(context);
    await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

    if (!(await ensureLoggedIn(page))) {
      const message = '请用户重新导出cookies';
      console.error(message);
      await showToast(page, message);
      await page.waitForTimeout(2000);
      await page.close();
      await browser.close();
      process.exitCode = 1;
      return;
    }

    await searchByKey(page, key);
    const selectedCount = await selectMatchedFiles(page, key);
    console.log(`已选中 ${selectedCount} 个匹配文件`);
    await clickCopyMenu(page);
    console.log('已点击【复制】');
    await navigateToTargetAndPaste(page);
    console.log('已跳转到目标目录，点击【粘贴文件】后已点击【取消】');
    await browser.close();
    console.log('所有任务已完成，浏览器已关闭，脚本退出。');
  } catch (error) {
    console.error(`错误: ${error.message}`);
    if (browser) {
      await browser.close();
    }
    process.exitCode = 1;
  }
}

main();
