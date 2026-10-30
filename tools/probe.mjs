// ============================================================================
// tools/probe.mjs —— 用 Chrome DevTools Protocol 打开本页做一次真实体检
//
// 无头截图只能看到像素，看不到“为什么”。这个脚本直接问浏览器：
//   · 三种视图是否真的切换（点击、键盘）
//   · 5 列封面墙是否等宽、标题区是否贴到全宽安全边距
//   · 大标题和右侧读数是否相撞、窄屏有没有横向溢出
//   · 表格列宽、封面加载、控制台错误
//
// 用法：
//   node tools/probe.mjs
//   PROBE_QUERY="?view=index" node tools/probe.mjs
//   PROBE_QUERY="?view=wall" PROBE_W=430 PROBE_H=1200 node tools/probe.mjs
//
// 参数走环境变量而不是命令行开关：Node 的启动包装器有时会把 --w 这类开关
// 当成自己的参数吃掉。PROBE_QUERY 里的 & 在 Windows 上用 %26 代替。
// 只依赖 Node 内置模块，不装任何包。
// ============================================================================
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, '.shots');
mkdirSync(shots, { recursive: true });

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Edge / Chrome，无法体检。');
  process.exit(1);
}

const query = (process.env.PROBE_QUERY || '?view=wall&motion=off').replace(/%26/g, '&');
const viewW = Number(process.env.PROBE_W || '1600');
const viewH = Number(process.env.PROBE_H || '1200');
console.error(`[probe] ${viewW}x${viewH} ${query}`);

const fileUrl = pathToFileURL(resolve(root, 'index.html')).href;
const pageUrl = `${fileUrl}${query.startsWith('?') ? query : `?${query}`}`;
const port = 9300 + Math.floor(Math.random() * 200);
const profile = resolve(shots, `probe-profile-${viewW}x${viewH}-${process.pid}`);

const child = spawn(browser, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1600,1200',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 浏览器还没起来，继续等 */ }
    await sleep(250);
  }
  throw new Error('浏览器调试端口没有就绪');
}

function connect(url) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => ok({
      send(method, params) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => fail(new Error('WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  });
}

/* 体检脚本：只读，不改页面。 */
const probe = `(() => {
  const out = { viewport: { w: innerWidth, h: innerHeight }, docH: document.documentElement.scrollHeight };
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; };
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];

  out.title = document.title;
  out.url = location.href;
  out.search = location.search;
  out.theme = document.documentElement.dataset.theme;
  out.view = document.getElementById('stage').dataset.view;
  out.tabs = qa('#views button').map(b => ({ view: b.dataset.view, selected: b.getAttribute('aria-selected') }));
  out.counts = {
    tiles: qa('#wall .tile').length,
    rows: qa('#inventory tr').length,
    artists: qa('#artists .artist').length,
    shown: q('#shownCount').textContent.replace(/\\s+/g, ' ').trim(),
  };

  // 大标题与右侧读数是否相撞，以及全宽贴边是否真的贴到安全边距
  const title = q('.hero__title');
  const aside = q('.hero__aside');
  out.hero = {
    title: box(title), aside: box(aside),
    titleFont: title ? getComputedStyle(title).fontSize : null,
    titleRight: title ? Math.round(title.getBoundingClientRect().right) : null,
    asideLeft: aside ? Math.round(aside.getBoundingClientRect().left) : null,
    asideRight: aside ? Math.round(aside.getBoundingClientRect().right) : null,
    overlap: title && aside ? Math.round(title.getBoundingClientRect().right - aside.getBoundingClientRect().left) : null,
  };
  out.layout = {
    nav: box(q('.nav')),
    hero: box(q('.hero')),
    shell: box(q('.shell')),
    heroTitleLeft: title ? Math.round(title.getBoundingClientRect().left) : null,
    asideRight: aside ? Math.round(aside.getBoundingClientRect().right) : null,
    innerW: innerWidth,
  };

  // 横向溢出：找出到底是谁把页面撑宽了
  out.overflow = {
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: innerWidth,
    offenders: qa('body *').filter(n => {
      const r = n.getBoundingClientRect();
      return r.width > innerWidth + 1 || r.right > innerWidth + 1;
    }).slice(0, 8).map(n => ({ tag: n.tagName + '.' + String(n.className || '').split(' ')[0], right: Math.round(n.getBoundingClientRect().right), w: Math.round(n.getBoundingClientRect().width) })),
  };

  // 5 列封面墙：第一行五块砖应当等宽、同顶
  const wall = q('#wall');
  if (wall) {
    const firstFive = qa('#wall .tile').slice(0, 5).map(n => ({
      name: n.querySelector('.tile__name') ? n.querySelector('.tile__name').textContent.trim() : null,
      tile: box(n),
      frame: box(n.querySelector('.tile__frame')),
    }));
    out.wall = {
      cols: getComputedStyle(wall).gridTemplateColumns,
      box: box(wall),
      firstFive,
      widths: [...new Set(firstFive.map(x => x.tile.w))],
      tops: [...new Set(firstFive.map(x => x.tile.top))],
    };
  }

  // 清单表格的列宽与窄屏折叠
  const table = q('.inventory');
  if (table) {
    out.table = {
      cols: [...table.querySelectorAll('col')].map(c => Math.round(c.getBoundingClientRect().width)),
      hiddenCells: qa('#inventory tr:first-child .c-hide-sm').map(td => getComputedStyle(td).display),
      firstRow: box(q('#inventory tr')),
      nameW: Math.round(q('#inventory .c-name').getBoundingClientRect().width),
    };
  }

  // 展开视图
  const sp = q('#spread .spread');
  if (sp) {
    out.spread = {
      box: box(sp),
      title: q('.spread__title') ? q('.spread__title').textContent.trim() : null,
      art: box(q('.spread__art')),
      pane: box(q('.spread__pane')),
      specs: qa('.specs dt').map(n => n.textContent.trim()),
      pager: q('.pager__pos') ? q('.pager__pos').textContent.trim() : null,
      related: qa('.related__item').length,
    };
  }

  // 图片加载情况（区分“还没懒加载”和“真的坏了”）
  const imgs = [...document.images];
  out.images = {
    total: imgs.length,
    loaded: imgs.filter(i => i.naturalWidth > 0).length,
    broken: imgs.filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')),
  };

  out.emptyHidden = document.getElementById('emptyState').hidden;
  out.errorHidden = document.getElementById('errorState').hidden;

  // 导航条与读数条：窄屏最容易挤坏的两处
  const nav = q('.nav');
  out.nav = nav ? {
    box: box(nav), scrollW: nav.scrollWidth, clientW: nav.clientWidth,
    mark: box(q('.nav__mark')), tools: box(q('.nav__tools')),
    keymap: box(q('#keymapToggle')),
  } : null;
  const readout = q('.readout');
  out.readout = readout ? [...readout.children].map(n => ({
    tag: n.tagName, text: n.textContent.trim(), box: box(n),
  })) : null;

  out.fonts = {
    title: q('.hero__title') ? getComputedStyle(q('.hero__title')).fontFamily : null,
    mono: q('.tile__no') ? getComputedStyle(q('.tile__no')).fontFamily : null,
  };
  return out;
})()`;

let client;
async function evalJS(expression, awaitPromise) {
  const r = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: !!awaitPromise,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  }
  return r.result.value;
}

try {
  const wsUrl = await findTarget();
  client = await connect(wsUrl);

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewW, height: viewH, deviceScaleFactor: 1, mobile: viewW < 700,
  });
  await client.send('Page.navigate', { url: pageUrl });
  await sleep(2600);

  const result = await evalJS(probe);
  console.log(JSON.stringify(result, null, 2));

  // ------------------------------------------------------------ 悬浮反馈
  const hover = {};
  const points = await evalJS(`(() => {
    const tile = document.querySelectorAll('#wall .tile')[1];
    const rail = document.querySelector('.artists');
    const tr = tile ? tile.getBoundingClientRect() : null;
    const rr = rail ? rail.getBoundingClientRect() : null;
    return {
      tile: tr && tr.width ? { x: Math.round(tr.x + tr.width / 2), y: Math.round(tr.y + tr.height / 2) } : null,
      rail: rr && rr.width ? { x: Math.round(rr.x + Math.min(300, rr.width / 2)), y: Math.round(rr.y + rr.height / 2) } : null,
    };
  })()`);
  if (points.tile) {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.tile.x, y: points.tile.y, button: 'none' });
    await sleep(350);
    hover.tile = await evalJS(`(() => { const t = document.querySelectorAll('#wall .tile')[1]; const f = t.querySelector('.tile__frame'); return { hovered: t.matches(':hover'), overlay: getComputedStyle(f, '::after').opacity, overlayBg: getComputedStyle(f, '::after').backgroundColor }; })()`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    writeFileSync(resolve(shots, 'hover-tile.png'), Buffer.from(shot.data, 'base64'));
  }
  if (points.rail) {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.rail.x, y: points.rail.y, button: 'none' });
    await sleep(350);
    hover.rail = await evalJS(`(() => { const n = document.querySelector('.artists'); return { hovered: n.matches(':hover'), bg: getComputedStyle(n).backgroundColor }; })()`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    writeFileSync(resolve(shots, 'hover-rail.png'), Buffer.from(shot.data, 'base64'));
  }
  console.log('\n悬浮检查：');
  console.log(JSON.stringify(hover, null, 2));

  // ------------------------------------------------------------ 交互断言
  const tests = {};
  const click = async (sel) => {
    const ok = await evalJS(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.click(); return true; })()`);
    await sleep(350);
    return ok;
  };

  await click('#views button[data-view="index"]');
  tests.indexTab = await evalJS(`({ view: document.querySelector('#stage').dataset.view, display: getComputedStyle(document.querySelector('#indexView')).display, rows: document.querySelectorAll('#inventory tr').length })`);

  await click('#views button[data-view="spread"]');
  tests.spreadTab = await evalJS(`({ view: document.querySelector('#stage').dataset.view, display: getComputedStyle(document.querySelector('#spreadView')).display, title: document.querySelector('.spread__title') ? document.querySelector('.spread__title').textContent.trim() : null })`);

  await click('#views button[data-view="wall"]');
  const secondTile = await evalJS(`(() => { const n = document.querySelectorAll('#wall .tile')[2]; if (!n) return null; const name = n.querySelector('.tile__name').textContent.trim(); n.click(); return { name }; })()`);
  await sleep(350);
  tests.tileClick = await evalJS(`({ view: document.querySelector('#stage').dataset.view, title: document.querySelector('.spread__title') ? document.querySelector('.spread__title').textContent.trim() : null })`);
  tests.tileClick.expected = secondTile ? secondTile.name : null;

  // 键盘：2 切到清单，J 移动，Enter 展开
  const key = async (key, code, vk, modifiers) => {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: modifiers || 0 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: modifiers || 0 });
    await sleep(300);
  };
  await key('2', 'Digit2', 50);
  tests.key2 = await evalJS(`document.querySelector('#stage').dataset.view`);
  await key('j', 'KeyJ', 74);
  tests.keyJ = await evalJS(`(() => { const cur = document.querySelector('#inventory tr.is-open'); return { row: cur ? cur.dataset.i : null, aria: cur ? cur.getAttribute('aria-current') : null }; })()`);
  await key('Enter', 'Enter', 13);
  tests.keyEnter = await evalJS(`document.querySelector('#stage').dataset.view`);

  // 搜索：输入“星尘”，防抖后应只剩 19 首
  await evalJS(`(() => { const i = document.querySelector('#search'); i.value = '星尘'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(500);
  tests.search = await evalJS(`({ shown: document.querySelector('#shownCount').textContent.replace(/\\s+/g, ' ').trim(), tiles: document.querySelectorAll('#wall .tile').length, emptyHidden: document.querySelector('#emptyState').hidden })`);
  await click('#searchClear');
  tests.searchClear = await evalJS(`({ shown: document.querySelector('#shownCount').textContent.replace(/\\s+/g, ' ').trim(), value: document.querySelector('#search').value })`);

  // 主题与快捷键面板
  await click('#themeToggle');
  tests.theme = await evalJS(`document.documentElement.dataset.theme`);
  await click('#themeToggle');
  await click('#keymapToggle');
  tests.keymap = await evalJS(`document.querySelector('#keymap').dataset.open`);
  await click('#keymapClose');

  console.log('\n交互断言：');
  console.log(JSON.stringify(tests, null, 2));

  const dom = await evalJS('document.documentElement.outerHTML');
  const hash = createHash('sha1').update(dom).digest('hex').slice(0, 8);
  writeFileSync(resolve(shots, 'dom-snapshot.html'), dom, 'utf8');
  console.log(`\nDOM 快照（${hash}）→ .shots/dom-snapshot.html`);
} catch (err) {
  console.error('体检失败：' + err.message);
  process.exitCode = 1;
} finally {
  if (client) client.close();
  child.kill();
}
