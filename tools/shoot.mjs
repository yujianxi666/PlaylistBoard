// ============================================================================
// tools/shoot.mjs —— 批量截图，用来核对三种视图 × 两种主题 × 窄屏的真实排版
//
// 用 CDP 的 Emulation.setDeviceMetricsOverride 精确设置视口：
// 无头浏览器的窗口有最小宽度限制（约 500px），只靠 --window-size=430
// 会把 500px 的布局裁成 430px；这里改走设备度量，窄屏才是真的窄屏。
//
// 用法：
//   node tools/shoot.mjs              # 全部组合
//   node tools/shoot.mjs --only wall  # 只拍名字里含 wall 的那几张
//   node tools/shoot.mjs --dpr 2      # 2 倍像素密度（更清楚、文件更大）
//
// 产出放在 .shots/ 下，不参与页面运行，也不进版本库。
// 只依赖 Node 内置模块，不需要 puppeteer。
// ============================================================================
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, '.shots');
mkdirSync(shots, { recursive: true });

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const dpr = Number(argOf('dpr', '1'));
const only = argOf('only', '');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Edge / Chrome，无法截图。');
  process.exit(1);
}

const fileUrl = pathToFileURL(resolve(root, 'index.html')).href;

/* 每一张：文件名、查询参数、视口尺寸。
   统一带上 motion=off：截图要的是“最终状态”，
   否则入场动画还没跑到就截了，会拍到半透明的中间帧。
   每张都显式带 theme，避免同一个浏览器 profile 里上一次的主题残留。 */
const SHOTS = [
  { name: 'wall-dark', q: '?view=wall&theme=dark&motion=off', h: 2400 },
  { name: 'wall-light', q: '?view=wall&theme=light&motion=off', h: 2400 },
  { name: 'index-dark', q: '?view=index&theme=dark&motion=off', h: 1600 },
  { name: 'index-light', q: '?view=index&theme=light&motion=off', h: 1600 },
  { name: 'spread-dark', q: '?view=spread&theme=dark&motion=off', h: 1250 },
  { name: 'spread-light', q: '?view=spread&theme=light&motion=off', h: 1250 },
  { name: 'related-dark', q: '?view=spread&track=3390600616&theme=dark&motion=off', h: 1900 },
  { name: 'search-dark', q: '?q=%E6%98%9F%E5%B0%98&theme=dark&motion=off', h: 1500 },
  { name: 'empty-dark', q: '?q=zzzzzz&theme=dark&motion=off', h: 1200 },
  { name: 'narrow-wall', q: '?view=wall&theme=dark&motion=off', h: 1600, w: 430 },
  { name: 'narrow-index', q: '?view=index&theme=dark&motion=off', h: 1400, w: 430 },
  { name: 'narrow-spread', q: '?view=spread&theme=dark&motion=off', h: 1600, w: 430 },
  { name: 'keymap', q: '?view=wall&theme=dark&kbd=1&motion=off', h: 950 },
];

const port = 9500 + Math.floor(Math.random() * 100);
const profile = resolve(shots, `shoot-profile-${process.pid}`);

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

const list = SHOTS.filter((s) => !only || s.name.includes(only));
if (!list.length) {
  console.error('没有匹配的截图名。');
  process.exit(1);
}

let client;
try {
  client = await connect(await findTarget());
  await client.send('Page.enable');

  for (const shot of list) {
    const width = shot.w || 1600;
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height: shot.h, deviceScaleFactor: dpr, mobile: width < 700,
    });
    await client.send('Page.navigate', { url: `${fileUrl}${shot.q}` });
    await sleep(1800);

    const png = await client.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    writeFileSync(resolve(shots, `${shot.name}.png`), Buffer.from(png.data, 'base64'));
    console.log(`✓ ${shot.name}.png  (${width}×${shot.h} @${dpr}x)`);
  }
  console.log(`\n共 ${list.length} 张 → ${shots}`);
} catch (err) {
  console.error(`截图失败：${err.message}`);
  process.exitCode = 1;
} finally {
  if (client) client.close();
  child.kill();
}
