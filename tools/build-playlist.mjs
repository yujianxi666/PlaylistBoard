// ============================================================================
// PlaylistBoard 数据构建脚本
//
//   1. 读取 playlist.config.json（歌单 ID 可换成任意公开歌单）
//   2. 读取网易云歌单元信息与全部曲目 ID
//        · “我喜欢的音乐”这类歌单，详情接口只内联 6 首，
//          所以曲目资料统一走 v3/song/detail 分批补齐
//   3. 下载歌单封面与专辑封面到 assets/covers/
//        · 走网易云图片 CDN 的 ?param= 缩放，不下载原图
//        · 已存在的封面直接复用；失败则生成同尺寸 SVG 占位图
//   4. 写出 js/playlist.js（window.PLAYLIST / window.TRACKS / window.ARTISTS）
//
// 运行：
//   node tools/build-playlist.mjs
//   node tools/build-playlist.mjs --force       # 忽略已有封面，全部重下
//   node tools/build-playlist.mjs --limit 40    # 只取前 40 首，快速预览
//
// 关于证书：部分机器（装有抓包 / 安全软件证书链）会让 Node 默认不信任
// HTTPS 证书。脚本检测到这类错误时会自动带 --use-system-ca 重新执行一次。
// ============================================================================
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coversDir = resolve(root, 'assets/covers');
const dataFile = resolve(root, 'js/playlist.js');

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Accept: '*/*',
};

mkdirSync(coversDir, { recursive: true });
mkdirSync(resolve(root, 'js'), { recursive: true });

/* ---------------------------------------------------------------- 命令行 */

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (hasFlag('help')) {
  console.log(`用法：node tools/build-playlist.mjs [选项]

  --force        忽略已下载的封面，全部重新抓取
  --limit N      只取歌单前 N 首（快速预览用）
  --help         显示这份说明`);
  process.exit(0);
}

/* ---------------------------------------------------------------- 小工具 */

// Windows PowerShell 写出的 JSON 可能带 UTF-8 BOM
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pad = (n) => String(n).padStart(2, '0');

const kb = (n) => `${Math.round(n / 1024)}KB`;

const stripHtml = (html) =>
  String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/[—–]/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeXml = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));

/* ---------------------------------------------------------------- 证书兼容 */

const isCertError = (err) => {
  const text = `${err?.message || ''} ${err?.cause?.message || ''}`;
  return /certificate|UNABLE_TO_VERIFY|self.signed|CERT_|ERR_TLS/i.test(text);
};
const hasSystemCaFlag =
  process.execArgv.includes('--use-system-ca') ||
  /--use-system-ca/.test(process.env.NODE_OPTIONS || '');
const netState = { certFailure: false };

/* ---------------------------------------------------------------- 网络请求 */

async function request(url, { method = 'GET', form, timeout = 30000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method,
        headers: form
          ? { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }
          : UA,
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 78)}`);
      return res;
    } catch (err) {
      lastError = err;
      if (isCertError(err)) netState.certFailure = true;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    }
  }
  throw lastError;
}

async function getJson(url, options) {
  const res = await request(url, options);
  return res.json();
}

async function getImage(url) {
  const res = await request(url, { timeout: 35000, retries: 2 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!validImage(buf)) {
    throw new Error(`返回的不是有效图片（${buf.length} 字节）`);
  }
  return buf;
}

/* ------------------------------------------------- 图片校验（避免坏封面） */

function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'GIF') {
    return { type: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { type: 'webp', w: 0, h: 0 };
  }
  return null;
}

function validImage(buf) {
  const size = imageSize(buf);
  if (!size) return false;
  if (buf.length < 512) return false;               // 明显是错误页 / 空图
  if (size.w === 1 && size.h === 1) return false;   // 常见的 1x1 占位像素
  if (size.w && size.w < 96) return false;          // 缩略图太小，放大后糊
  return true;
}

function existingImage(path) {
  if (!existsSync(path)) return false;
  try {
    if (statSync(path).size < 512) return false;
    return validImage(readFileSync(path));
  } catch (e) {
    return false;
  }
}

/* --------------------------------------------- 占位封面（抓不到时兜底） */

function placeholderSvg({ name, subtitle, size = 400, accent = '#d9903a' }) {
  const title = String(name || '未命名');
  const shown = title.length > 26 ? `${title.slice(0, 25)}…` : title;
  const sub = String(subtitle || 'COVER PENDING');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#191b20"/>
      <stop offset="1" stop-color="#0a0b0e"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#g)"/>
  <g stroke="#ffffff" stroke-opacity="0.045">
    ${Array.from({ length: 7 }, (_, i) => `<line x1="${Math.round((i + 1) * size / 8)}" y1="0" x2="${Math.round((i + 1) * size / 8)}" y2="${size}"/>`).join('\n    ')}
    ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${Math.round((i + 1) * size / 8)}" x2="${size}" y2="${Math.round((i + 1) * size / 8)}"/>`).join('\n    ')}
  </g>
  <rect x="0" y="0" width="${Math.round(size * 0.018)}" height="${size}" fill="${accent}" fill-opacity="0.9"/>
  <text x="${Math.round(size * 0.09)}" y="${Math.round(size * 0.62)}" fill="#f2f1ee" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="${Math.round(size * 0.075)}" font-weight="600">${escapeXml(shown)}</text>
  <text x="${Math.round(size * 0.09)}" y="${Math.round(size * 0.72)}" fill="#8d919a" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="${Math.round(size * 0.035)}" letter-spacing="${Math.round(size * 0.006)}">${escapeXml(sub)}</text>
  <text x="${Math.round(size * 0.09)}" y="${Math.round(size * 0.88)}" fill="#5a5f67" font-family="Consolas, monospace" font-size="${Math.round(size * 0.028)}" letter-spacing="${Math.round(size * 0.006)}">PLAYLISTBOARD · NO COVER</text>
</svg>
`;
}

/* --------------------------------------------------------- 网易云 API */

const api = {
  playlist(id) {
    return getJson(
      `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=1000&s=0`,
    );
  },
  songs(ids) {
    return getJson('https://music.163.com/api/v3/song/detail', {
      method: 'POST',
      form: { c: JSON.stringify(ids.map((id) => ({ id }))) },
    });
  },
};

async function fetchPlaylist(id) {
  const res = await api.playlist(id);
  if (res.code !== 200 || !res.playlist) {
    throw new Error(`歌单读取失败（code ${res.code}${res.msg ? ` · ${res.msg}` : ''}）`);
  }
  return res.playlist;
}

async function fetchTracks(ids, limit) {
  const picked = limit > 0 ? ids.slice(0, limit) : ids;
  const details = new Map();

  for (let i = 0; i < picked.length; i += 50) {
    const batch = picked.slice(i, i + 50);
    process.stdout.write(
      `  曲目资料 ${String(Math.min(i + 50, picked.length)).padStart(3)} / ${picked.length}  `,
    );
    let res;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        res = await api.songs(batch);
        if (res && res.code === 200 && Array.isArray(res.songs)) break;
        lastError = new Error(`接口返回 code ${res?.code}`);
      } catch (err) {
        lastError = err;
        if (isCertError(err)) netState.certFailure = true;
      }
      await sleep(900 * (attempt + 1));
    }
    if (!res || res.code !== 200 || !Array.isArray(res.songs)) {
      throw new Error(`曲目批次 ${i} - ${i + batch.length} 读取失败：${lastError?.message || '未知错误'}`);
    }
    for (const song of res.songs) {
      if (song && song.id) details.set(song.id, song);
    }
    console.log(details.size >= Math.min(i + 50, picked.length) ? '✓' : `补到 ${details.size} 首`);
    await sleep(260);
  }

  return { picked, details };
}

/* ------------------------------------------------------------- 封面下载 */

function imageUrl(raw, size) {
  const url = String(raw || '').trim();
  if (!url) return '';
  const clean = url.replace(/^http:/i, 'https:').split('?')[0];
  return `${clean}?param=${size}y${size}`;
}

const albumCoverPath = (albumId) => `assets/covers/al-${albumId}.jpg`;
const albumPlaceholderPath = (albumId) => `assets/covers/al-${albumId}.svg`;

async function buildPlaylistCover(playlist, size, force) {
  const jpg = resolve(coversDir, 'playlist.jpg');
  const svg = resolve(coversDir, 'playlist.svg');
  const local = 'assets/covers/playlist.jpg';

  if (!force && existingImage(jpg)) {
    console.log('  歌单封面  使用已下载的 assets/covers/playlist.jpg');
    return local;
  }

  const url = imageUrl(playlist.coverImgUrl, size);
  if (url) {
    try {
      const buf = await getImage(url);
      writeFileSync(jpg, buf);
      console.log(`  歌单封面  ${size}×${size} · ${kb(buf.length)}`);
      return local;
    } catch (err) {
      console.warn(`  ! 歌单封面下载失败：${err.message}`);
    }
  }

  if (existingImage(jpg) && !force) return local;
  writeFileSync(svg, placeholderSvg({
    name: playlist.name,
    subtitle: 'PLAYLIST COVER PENDING',
    size,
  }), 'utf8');
  console.log(`  歌单封面  使用占位图 assets/covers/playlist.svg`);
  return 'assets/covers/playlist.svg';
}

async function buildAlbumCovers(tracks, size, force) {
  const albums = new Map();
  for (const track of tracks) {
    const album = track.album;
    if (!album || !album.id) continue;
    if (!albums.has(album.id)) albums.set(album.id, album);
  }

  const list = [...albums.values()];
  const coverById = new Map();
  let done = 0;
  let reused = 0;
  let failed = 0;

  console.log(`  专辑封面  ${list.length} 张，并发 5，已存在的直接复用`);

  const worker = async (album) => {
    const jpg = resolve(coversDir, `al-${album.id}.jpg`);
    const svg = resolve(coversDir, `al-${album.id}.svg`);
    const local = albumCoverPath(album.id);

    if (!force && existingImage(jpg)) {
      album.cover = local;
      coverById.set(album.id, local);
      reused += 1;
      done += 1;
      if (done % 40 === 0) console.log(`    ${done} / ${list.length}（复用 ${reused}，失败 ${failed}）`);
      return;
    }

    const url = imageUrl(album.picUrl, size);
    try {
      if (!url) throw new Error('缺少封面地址');
      const buf = await getImage(url);
      writeFileSync(jpg, buf);
      album.cover = local;
      coverById.set(album.id, local);
    } catch (err) {
      failed += 1;
      writeFileSync(svg, placeholderSvg({
        name: album.name || '未知专辑',
        subtitle: 'ALBUM COVER PENDING',
        size,
      }), 'utf8');
      album.cover = albumPlaceholderPath(album.id);
      coverById.set(album.id, album.cover);
      console.warn(`    ! 《${album.name || album.id}》封面失败：${err.message}`);
    }

    done += 1;
    if (done % 20 === 0 || done === list.length) {
      console.log(`    ${done} / ${list.length}（复用 ${reused}，失败 ${failed}）`);
    }
    await sleep(50);
  };

  // 固定并发的小型工作池：不引依赖，也不一次性打满 CDN
  let cursor = 0;
  const runners = Array.from({ length: 5 }, async () => {
    while (cursor < list.length) {
      const album = list[cursor];
      cursor += 1;
      await worker(album);
    }
  });
  await Promise.all(runners);

  return { total: list.length, reused, failed, coverById };
}

/* ------------------------------------------------------------- 主流程 */

async function main() {
  const configPath = resolve(root, 'playlist.config.json');
  if (!existsSync(configPath)) {
    throw new Error('找不到 playlist.config.json');
  }
  const config = readJson(configPath);

  // 允许直接粘贴歌单链接：https://music.163.com/#/playlist?id=8765669532
  const idMatch = String(config.playlistId || '').match(/(\d{3,})/);
  if (!idMatch) throw new Error('playlist.config.json 里的 playlistId 不是有效的歌单 ID');
  const playlistId = idMatch[1];

  const limit = Math.max(0, Number(argOf('limit', config.maxTracks || 0)) || 0);
  const force = hasFlag('force');
  const albumSize = Math.min(1000, Math.max(160, Number(config.coverSize) || 400));
  const playlistSize = Math.min(1080, Math.max(320, Number(config.playlistCoverSize) || 640));

  console.log(`PlaylistBoard 数据构建`);
  console.log(`歌单 ID  ${playlistId}${limit ? ` · 只取前 ${limit} 首` : ''}\n`);

  console.log('[1/3] 读取歌单元信息…');
  const playlist = await fetchPlaylist(playlistId);
  const rawIds = (playlist.trackIds || []).map((x) => x.id);
  const inlineIds = (playlist.tracks || []).map((x) => x.id);
  const seen = new Set();
  const ids = (rawIds.length ? rawIds : inlineIds).filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!ids.length) throw new Error('这个歌单没有可读取的曲目');

  const atMap = new Map((playlist.trackIds || []).map((x) => [x.id, x.at || 0]));
  console.log(`  《${playlist.name}》 · ${playlist.trackIds?.length || ids.length} 首 · ${playlist.creator?.nickname || '未知创建者'}`);
  if (playlist.coverImgUrl) console.log(`  封面  ${playlist.coverImgUrl.split('?')[0]}`);

  console.log('\n[2/3] 读取全部曲目资料…');
  const { picked, details } = await fetchTracks(ids, limit);
  const missing = picked.filter((id) => !details.has(id));
  if (missing.length) {
    console.warn(`  ! ${missing.length} 首曲目资料缺失，已跳过：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
  }

  const tracks = [];
  for (const id of picked) {
    const song = details.get(id);
    if (!song) continue;
    const aliases = (song.alia || [])
      .map((x) => String(x || '').trim())
      .filter((x) => x && x !== song.name);
    tracks.push({
      id: song.id,
      name: song.name || song.mainTitle || '未命名曲目',
      alias: [...new Set(aliases)],
      artists: (song.ar || [])
        .filter((a) => a && a.name)
        .map((a) => ({ id: a.id || 0, name: a.name })),
      album: {
        id: song.al?.id || 0,
        name: song.al?.name || '',
        cover: '',
        picUrl: song.al?.picUrl || '',
      },
      duration: song.dt || 0,
      popularity: typeof song.pop === 'number' ? song.pop : 0,
      releasedAt: song.publishTime || 0,
      addedAt: atMap.get(song.id) || 0,
      mv: song.mv || 0,
    });
  }
  if (!tracks.length) throw new Error('曲目资料为空，无法生成页面数据');

  console.log('\n[3/3] 下载封面…');
  const playlistCover = await buildPlaylistCover(playlist, playlistSize, force);
  const coverStats = await buildAlbumCovers(tracks, albumSize, force);

  // buildAlbumCovers 以专辑 ID 为键返回最终文件；同一张专辑可能对应多首曲目，
  // 必须逐首按 ID 回填，不能只依赖 Map 里保留的第一个对象引用。
  for (const track of tracks) {
    delete track.album.picUrl;
    track.album.cover = track.album.id
      ? (coverStats.coverById.get(track.album.id) || playlistCover)
      : playlistCover;
  }

  const artistCounts = new Map();
  for (const track of tracks) {
    for (const artist of track.artists) {
      artistCounts.set(artist.name, (artistCounts.get(artist.name) || 0) + 1);
    }
  }
  const artists = [...artistCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const totalMs = tracks.reduce((sum, track) => sum + (track.duration || 0), 0);

  const playlistData = {
    id: Number(playlist.id || playlistId),
    name: playlist.name || '未命名歌单',
    creator: {
      name: playlist.creator?.nickname || '未知创建者',
      id: playlist.creator?.userId || 0,
      avatar: (playlist.creator?.avatarUrl || '').replace(/^http:/i, 'https:'),
    },
    cover: playlistCover,
    description: stripHtml(playlist.description || ''),
    tags: (playlist.tags || []).map(String).filter(Boolean),
    trackCount: tracks.length,
    listedTrackCount: playlist.trackCount || tracks.length,
    playCount: playlist.playCount || 0,
    subscribedCount: playlist.subscribedCount || 0,
    shareCount: playlist.shareCount || 0,
    commentCount: playlist.commentCount || 0,
    createdAt: playlist.createTime || 0,
    updatedAt: playlist.updateTime || 0,
    totalDuration: totalMs,
    artistCount: artists.length,
    albumCount: new Set(tracks.map((t) => t.album.id).filter(Boolean)).size,
    sourceUrl: `https://music.163.com/#/playlist?id=${playlistId}`,
    fetchedAt: new Date().toISOString(),
  };

  const banner = `// 由 tools/build-playlist.mjs 依据 playlist.config.json 自动生成 —— 请勿手改。
// 想换歌单请编辑 playlist.config.json，然后运行：node tools/build-playlist.mjs
//
// 普通脚本（非 ES Module）：这样 index.html 直接双击以 file:// 打开也能工作，
// 数据通过 window.PLAYLIST / window.TRACKS / window.ARTISTS 暴露给 js/app.js。
`;

  writeFileSync(dataFile, `${banner}
window.PLAYLIST = ${JSON.stringify(playlistData, null, 2)};

window.ARTISTS = ${JSON.stringify(artists, null, 2)};

window.TRACKS = ${JSON.stringify(tracks, null, 2)};
`, 'utf8');

  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  console.log(`\n完成：${tracks.length} 首 · ${artists.length} 位歌手 · ${playlistData.albumCount} 张专辑 · ${hours}h ${minutes}m`);
  console.log(`封面：${coverStats.total} 张专辑封面（复用 ${coverStats.reused}，占位 ${coverStats.failed}）`);
  console.log(`输出：js/playlist.js  ${kb(statSync(dataFile).size)}`);
  if (tracks.length !== playlistData.listedTrackCount) {
    console.log(`注意：歌单标注 ${playlistData.listedTrackCount} 首，实际可读取 ${tracks.length} 首。`);
  }
}

/* ------------------------------------------------ 证书错误时自动重试 */

function rerunWithSystemCa() {
  console.log('\n检测到 Node 不信任本机 HTTPS 证书链，正在用 --use-system-ca 重新执行…\n');
  const res = spawnSync(
    process.execPath,
    ['--use-system-ca', fileURLToPath(import.meta.url), ...argv],
    { stdio: 'inherit', cwd: root },
  );
  process.exit(res.status ?? 1);
}

main()
  .then(() => {
    if (netState.certFailure && !hasSystemCaFlag) rerunWithSystemCa();
  })
  .catch((err) => {
    if (isCertError(err) && !hasSystemCaFlag) rerunWithSystemCa();
    console.error(`\n构建失败：${err.message}`);
    process.exit(1);
  });
