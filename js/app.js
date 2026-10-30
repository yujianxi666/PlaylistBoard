/* =========================================================================
   app.js / PlaylistBoard 交互层
   ---------------------------------------------------------------------
   三种“读法”：封面墙 / 清单 / 展开。全键盘可操作，不引任何依赖。

   刻意保持普通脚本（非 ES Module）：这样 index.html 直接以 file:// 双击
   打开也能工作。模块导入在 file:// 下会被 CORS 拦截。
   数据由 js/playlist.js 以 window.PLAYLIST / window.TRACKS / window.ARTISTS
   提供；那个文件由 tools/build-playlist.mjs 生成，不要手改。

   动效只用 transform / opacity；滚动显现走 IntersectionObserver，
   没有 window.addEventListener('scroll')。
   ========================================================================= */
(function () {
  'use strict';

  /* ============================================================ 数据 */
  const PLAYLIST =
    window.PLAYLIST && typeof window.PLAYLIST === 'object' ? window.PLAYLIST : null;
  const TRACKS = Array.isArray(window.TRACKS) ? window.TRACKS : [];
  const ARTISTS = Array.isArray(window.ARTISTS) ? window.ARTISTS : [];

  /* ============================================================ 工具 */
  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

  const escapeHtml = (v) =>
    String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');

  const MISSING = '未收录';

  /* 存储：file:// 下 localStorage 可能直接抛错，统一包一层 */
  const store = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
    },
  };

  /* URL 参数：?view=index&theme=light&q=关键词&track=123&motion=off&kbd=1 */
  const param = (name) => {
    try {
      return new URLSearchParams(window.location.search).get(name) || '';
    } catch (e) {
      return '';
    }
  };

  const readMore = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ============================================================ 状态
     注意：state 必须早于下面任何用到它的辅助函数。 */
  const state = {
    theme: 'dark',
    view: 'wall',
    lastList: 'wall',
    artist: '',
    query: '',
    cursor: 0,
    keymap: false,
  };

  /* ============================================================ 文案 */
  const UI = {
    all: '全部',
    searchPh: '搜索曲目、歌手、专辑…',
    clear: '清除',
    wall: '封面墙',
    index: '清单',
    spread: '展开',
    prev: '上一首',
    next: '下一首',
    pager: '第 {i} / {n} 首',
    related: '同一歌手的其他曲目',
    openSong: '在网易云打开',
    emptyLabel: '没有匹配项',
    emptyHead: '这批筛选下没有任何曲目',
    emptyBody: '当前条件把这份歌单的 {n} 首歌都排除了。放宽歌手，或换一个关键词。',
    tipArtist: '歌手：{v}',
    tipQuery: '关键词：{v}',
    tipNone: '目前没有启用任何筛选',
    resetAll: '清除全部筛选',
  };

  const fmt = (tpl, vars) =>
    tpl.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

  /* ============================================================ 格式化 */
  const fmtDuration = (ms) => {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
  };

  const fmtTotal = (ms) => {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    let hours = Math.floor(total / 3600);
    let minutes = Math.floor((total % 3600) / 60);
    if (minutes === 60) { hours += 1; minutes = 0; }
    return hours > 0 ? `${hours}h ${pad2(minutes)}m` : `${minutes}m`;
  };

  const fmtNumber = (n) => {
    const value = Number(n) || 0;
    try {
      return new Intl.NumberFormat('en-US').format(value);
    } catch (e) {
      return String(value);
    }
  };

  const dateObj = (value) => {
    // 0 / 空串在这份数据里表示“没有这个字段”，不是 1970 年
    if (value == null || value === '' || value === 0) return null;
    const d = value instanceof Date ? value : new Date(Number(value) || value);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const fmtMonth = (value) => {
    const d = dateObj(value);
    return d ? `${d.getFullYear()}.${pad2(d.getMonth() + 1)}` : '';
  };

  const fmtDate = (value) => {
    const d = dateObj(value);
    return d ? `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}` : '';
  };

  const fmtISOdate = (value) => {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? ''
      : `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  };

  /* ============================================================ 取值 */
  const trackArtists = (t) => (Array.isArray(t.artists) ? t.artists : []);
  const artistNames = (t) => trackArtists(t).map((a) => a.name).filter(Boolean);
  const displayArtists = (t) => artistNames(t).join(' / ') || '未知歌手';
  const albumOf = (t) => (t.album && typeof t.album === 'object' ? t.album : { id: 0, name: '', cover: '' });
  const albumName = (t) => albumOf(t).name || MISSING;
  const coverOf = (t) => albumOf(t).cover || (PLAYLIST && PLAYLIST.cover) || '';
  const aliasOf = (t) => (Array.isArray(t.alias) && t.alias[0]) || '';
  const releaseYear = (t) => {
    const d = dateObj(t.releasedAt);
    return d ? String(d.getFullYear()) : '';
  };
  const popularity = (t) => (typeof t.popularity === 'number' ? t.popularity : 0);

  const playlistName = () => (PLAYLIST && PLAYLIST.name) || '未命名歌单';
  const playlistCreator = () => (PLAYLIST && PLAYLIST.creator && PLAYLIST.creator.name) || '';

  /* ============================================================ DOM */
  const el = {
    html: document.documentElement,
    stage: $('#stage'),
    wall: $('#wall'),
    inventory: $('#inventory'),
    spread: $('#spread'),
    artists: $('#artists'),
    views: $('#views'),
    search: $('#search'),
    searchClear: $('#searchClear'),
    shownCount: $('#shownCount'),
    statTracks: $('#statTracks'),
    statArtists: $('#statArtists'),
    statDuration: $('#statDuration'),
    playlistCover: $('#playlistCover'),
    playlistName: $('#playlistName'),
    playlistBy: $('#playlistBy'),
    themeToggle: $('#themeToggle'),
    themeLabel: $('#themeLabel'),
    keymap: $('#keymap'),
    keymapToggle: $('#keymapToggle'),
    keymapClose: $('#keymapClose'),
    emptyState: $('#emptyState'),
    emptyLabel: $('#emptyLabel'),
    emptyHead: $('#emptyHead'),
    emptyBody: $('#emptyBody'),
    emptyTips: $('#emptyTips'),
    emptyReset: $('#emptyReset'),
    errorState: $('#errorState'),
    sourceLink: $('#sourceLink'),
    fetchedAt: $('#fetchedAt'),
  };

  /* ============================================================ 过滤 */
  const matches = (t) => {
    if (state.artist) {
      if (!artistNames(t).includes(state.artist)) return false;
    }
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      t.name,
      ...(Array.isArray(t.alias) ? t.alias : []),
      ...artistNames(t),
      albumName(t),
      releaseYear(t),
      String(t.id || ''),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  };

  const visible = () => TRACKS.filter(matches);

  /* ============================================================ 封面 */
  /* 封面加载完成后淡入；失败时换成文字兜底块，绝不留下碎图。 */
  function hydrateImages(scope) {
    $$('img', scope).forEach((img) => {
      const wrap = img.closest('[data-art]');
      const done = () => {
        img.classList.add('is-loaded');
        if (wrap) wrap.classList.remove('is-skeleton');
      };
      const fail = () => {
        img.remove();
        if (!wrap) return;
        wrap.classList.remove('is-skeleton');
        if ($('.art-fallback', wrap)) return;
        const fallback = document.createElement('span');
        fallback.className = 'art-fallback';
        const label = wrap.getAttribute('data-fallback');
        if (label) fallback.textContent = label;
        wrap.append(fallback);
      };
      if (img.complete) {
        if (img.naturalWidth > 0) done(); else fail();
      } else {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', fail, { once: true });
      }
    });
  }

  /* ============================================================ 封面墙 */
  function renderWall(list) {
    const frag = document.createDocumentFragment();
    const tpl = document.createElement('template');

    list.forEach((t, i) => {
      const open = i === state.cursor;
      const artists = displayArtists(t);
      const cover = coverOf(t);

      tpl.innerHTML = `
        <button class="tile reveal${open ? ' is-open is-cursor' : ''}" type="button"
                data-key="${escapeHtml(t.id)}" data-i="${i}"
                aria-current="${open ? 'true' : 'false'}"
                aria-label="${escapeHtml(t.name)} · ${escapeHtml(artists)}"
                style="--i:${i % 5}">
          <span class="tile__frame">
            <span class="tile__art is-skeleton" data-art data-fallback="封面待补">
              <img src="${escapeHtml(cover)}" alt="" loading="${i < 10 ? 'eager' : 'lazy'}"
                   decoding="async" draggable="false" width="400" height="400" />
            </span>
          </span>
          <span class="tile__body">
            <span class="tile__no">${pad3(i + 1)}</span>
            <span class="tile__name">${escapeHtml(t.name)}</span>
            <span class="tile__meta">${escapeHtml(artists)} · ${escapeHtml(fmtDuration(t.duration))}</span>
          </span>
        </button>`;
      frag.append(tpl.content.firstElementChild);
    });

    el.wall.textContent = '';
    el.wall.append(frag);
    hydrateImages(el.wall);
  }

  /* ============================================================ 清单 */
  function renderInventory(list) {
    const frag = document.createDocumentFragment();
    const tpl = document.createElement('template');

    list.forEach((t, i) => {
      const open = i === state.cursor;
      const alias = aliasOf(t);
      const artists = displayArtists(t);
      const album = albumName(t);

      tpl.innerHTML = `
        <tr class="${open ? 'is-open is-cursor' : ''}" data-key="${escapeHtml(t.id)}" data-i="${i}"
            tabindex="${open ? '0' : '-1'}" aria-current="${open ? 'true' : 'false'}"
            aria-label="${escapeHtml(t.name)} · ${escapeHtml(artists)}">
          <td class="c-no">${pad3(i + 1)}</td>
          <td class="c-thumb">
            <span class="thumb" data-art data-fallback="">
              <img src="${escapeHtml(coverOf(t))}" alt="" loading="lazy" decoding="async"
                   draggable="false" width="76" height="76" />
            </span>
          </td>
          <td class="c-name">${escapeHtml(t.name)}${alias ? `<small>${escapeHtml(alias)}</small>` : ''}</td>
          <td class="c-mono c-hide-sm" title="${escapeHtml(artists)}">${escapeHtml(artists)}</td>
          <td class="c-album c-hide-sm" title="${escapeHtml(album)}">${escapeHtml(album)}</td>
          <td class="c-time">${escapeHtml(fmtDuration(t.duration))}</td>
        </tr>`;
      frag.append(tpl.content.firstElementChild);
    });

    el.inventory.textContent = '';
    el.inventory.append(frag);
    hydrateImages(el.inventory);
  }

  /* ============================================================ 展开 */
  function renderSpread(list) {
    const t = list[state.cursor];
    if (!t) {
      el.spread.textContent = '';
      return;
    }

    const artists = displayArtists(t);
    const album = albumName(t);
    const cover = coverOf(t);
    const alias = aliasOf(t);
    const duration = fmtDuration(t.duration);
    const pop = popularity(t);
    const year = releaseYear(t);

    const related = list
      .filter((o) => String(o.id) !== String(t.id)
        && trackArtists(o).some((a) => artistNames(t).includes(a.name)))
      .slice(0, 6);

    const summaryParts = [`${artists} 的《${t.name}》`];
    if (album && album !== MISSING) {
      summaryParts.push(album === t.name ? '收录于同名专辑' : `收录于《${album}》`);
    }
    summaryParts.push(`时长 ${duration}`);
    const summary = `${summaryParts.join('，')}。`;

    // 年份只在抓到时展示；歌名与专辑同名时不再重复一遍专辑名
    const metaItems = [year, album && album !== t.name ? album : ''].filter(Boolean);

    const specRows = [
      ['歌手', artists, false, false],
      ['专辑', album, false, false],
      ['时长', duration, true, false],
      ['热度', `${pop} / 100`, true, false],
      ['加入歌单', t.addedAt ? fmtDate(t.addedAt) : MISSING, true, false],
      ['网易云 ID', String(t.id || ''), true, false],
    ];

    el.spread.innerHTML = `
      <article class="spread reveal">
        <figure class="spread__art">
          <span class="spread__artimg is-skeleton" data-art data-fallback="专辑封面待补">
            <img src="${escapeHtml(cover)}" alt="" loading="eager" decoding="async"
                 draggable="false" width="400" height="400" />
          </span>
          <figcaption>
            <span>专辑封面</span>
            <span>TRACK ${escapeHtml(String(t.id || ''))}</span>
          </figcaption>
        </figure>

        <div class="spread__pane">
          <p class="spread__no">${pad3(state.cursor + 1)} / ${pad3(list.length)} · ${escapeHtml(alias ? alias.toUpperCase() : '收录曲目')}</p>
          <h3 class="spread__title">${escapeHtml(t.name)}</h3>
          <p class="spread__sub">${escapeHtml(artists)}</p>
          ${metaItems.length ? `<p class="spread__genres">${metaItems.map((x) => `<span>${escapeHtml(x)}</span>`).join('')}</p>` : ''}
          <p class="spread__desc">${escapeHtml(summary)}</p>

          <dl class="specs">
            ${specRows.map(([k, v, mono]) => `
              <dt>${escapeHtml(k)}</dt>
              <dd class="${mono ? 'is-mono' : ''}">${escapeHtml(v)}</dd>
            `).join('')}
          </dl>

          <div class="spread__actions">
            <a class="btn btn--primary" href="https://music.163.com/#/song?id=${encodeURIComponent(String(t.id || ''))}"
               target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
              ${UI.openSong}
            </a>
          </div>
        </div>
      </article>

      <div class="pager reveal">
        <button class="btn btn--quiet" type="button" data-step="-1">${UI.prev}</button>
        <span class="pager__pos">${escapeHtml(fmt(UI.pager, { i: pad3(state.cursor + 1), n: pad3(list.length) }))}</span>
        <button class="btn btn--quiet" type="button" data-step="1">${UI.next}</button>
      </div>

      ${related.length ? `
      <section class="related reveal">
        <h3 class="related__label">${UI.related}</h3>
        <div class="related__strip">
          ${related.map((r) => `
            <button class="related__item" type="button" data-key="${escapeHtml(r.id)}">
              <span class="related__thumb" data-art data-fallback="">
                <img src="${escapeHtml(coverOf(r))}" alt="" loading="lazy" decoding="async"
                     draggable="false" width="300" height="300" />
              </span>
              <b>${escapeHtml(r.name)}</b>
              <span>${escapeHtml(albumName(r))}</span>
            </button>`).join('')}
        </div>
      </section>` : ''}
    `;

    hydrateImages(el.spread);
  }

  /* ============================================================ 歌手栏 */
  function railArtists() {
    let items = ARTISTS.filter((a) => a.count >= 4).slice(0, 18);
    if (items.length < 6) items = ARTISTS.slice(0, 18);

    // 通过 URL 预先指定了某个不常见歌手时，也把它带进筛选条，
    // 否则页面上会看不到“当前正在按谁筛选”。
    if (state.artist && !items.some((a) => a.name === state.artist)) {
      const found = ARTISTS.find((a) => a.name === state.artist);
      if (found) items = [found, ...items];
    }
    return items;
  }

  function renderArtists() {
    const items = railArtists();
    const total = TRACKS.length;
    const html = [
      `<button class="artist" type="button" data-artist="" aria-pressed="${state.artist === ''}">${UI.all}<sup>${total}</sup></button>`,
      ...items.map((a) => `
        <button class="artist" type="button" data-artist="${escapeHtml(a.name)}"
                aria-pressed="${a.name === state.artist}">
          ${escapeHtml(a.name)}<sup>${a.count}</sup>
        </button>`),
    ];
    el.artists.innerHTML = html.join('');
  }

  /* 歌手栏在窄屏是横向滚动条：键盘选中的那一项必须自己滚进视野，
     否则用户按了快捷键却看不到选中了什么。 */
  function keepActiveArtistInView() {
    const active = $('#artists .artist[aria-pressed="true"]');
    if (!active) return;
    const rail = el.artists;
    const box = active.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    if (box.left < railBox.left || box.right > railBox.right) {
      rail.scrollTo({
        left: rail.scrollLeft + (box.left - railBox.left) - 24,
        behavior: readMore.matches ? 'auto' : 'smooth',
      });
    }
  }

  /* ============================================================ 空状态 */
  function renderEmpty(total) {
    const tips = [];
    if (state.artist) tips.push(fmt(UI.tipArtist, { v: state.artist }));
    if (state.query.trim()) tips.push(fmt(UI.tipQuery, { v: state.query.trim() }));
    if (!tips.length) tips.push(UI.tipNone);

    el.emptyLabel.textContent = UI.emptyLabel;
    el.emptyHead.textContent = UI.emptyHead;
    el.emptyBody.textContent = fmt(UI.emptyBody, { n: total });
    el.emptyTips.innerHTML = tips.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
    el.emptyReset.textContent = UI.resetAll;
  }

  /* ============================================================ 滚动 */
  const stickyOffset = () => (window.matchMedia('(max-width: 768px)').matches ? 72 : 136);

  function scrollToStage() {
    const top = el.stage.getBoundingClientRect().top + window.scrollY - stickyOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: readMore.matches ? 'auto' : 'smooth' });
  }

  function ensureSpreadVisible() {
    const rect = el.stage.getBoundingClientRect();
    if (rect.top < stickyOffset() - 8) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + rect.top - stickyOffset()),
        behavior: readMore.matches ? 'auto' : 'smooth',
      });
    }
  }

  function scrollCursorIntoView() {
    const node = state.view === 'index'
      ? $(`#inventory tr[data-i="${state.cursor}"]`)
      : $(`#wall .tile[data-i="${state.cursor}"]`);
    if (!node) return;
    const box = node.getBoundingClientRect();
    const limit = stickyOffset();
    const offscreen = box.top < limit || box.bottom > window.innerHeight - 24;
    if (offscreen) {
      node.scrollIntoView({ block: 'nearest', behavior: readMore.matches ? 'auto' : 'smooth' });
    }
  }

  /* ============================================================ 选择态 */
  function syncCursorDom() {
    $$('#wall .tile').forEach((n) => {
      const on = Number(n.dataset.i) === state.cursor;
      n.classList.toggle('is-open', on);
      n.classList.toggle('is-cursor', on);
      n.setAttribute('aria-current', on ? 'true' : 'false');
    });
    $$('#inventory tr[data-key]').forEach((n) => {
      const on = Number(n.dataset.i) === state.cursor;
      n.classList.toggle('is-open', on);
      n.classList.toggle('is-cursor', on);
      n.setAttribute('aria-current', on ? 'true' : 'false');
      n.tabIndex = on ? 0 : -1;
    });
  }

  /* 换选中项：墙 / 清单只改类，展开视图重绘 */
  function moveCursor(delta, list) {
    if (!list.length) return;
    const next = ((state.cursor + delta) % list.length + list.length) % list.length;
    if (next === state.cursor) return;
    state.cursor = next;
    if (state.view === 'spread') {
      renderSpread(list);
      observeReveals(el.spread);
      ensureSpreadVisible();
    } else {
      syncCursorDom();
      scrollCursorIntoView();
    }
  }

  function setView(view, list) {
    if (!['wall', 'index', 'spread'].includes(view)) return;
    const prev = state.view;
    state.view = view;
    if (view !== 'spread') state.lastList = view;
    el.stage.dataset.view = view;
    $$('#views button').forEach((b) => {
      const on = b.dataset.view === view;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });

    if (view === 'spread') {
      renderSpread(list);
      observeReveals(el.spread);
      ensureSpreadVisible();
    } else {
      syncCursorDom();
      // 从展开视图回到列表时，把当前曲目带回视野；从工具栏主动切视图时不打扰。
      if (prev === 'spread') scrollCursorIntoView();
    }
    observeReveals(el.stage);
  }

  /* ============================================================ 主渲染 */
  function apply(options) {
    if (!PLAYLIST || !TRACKS.length) return;
    const opts = options || {};
    const list = visible();

    if (state.cursor > list.length - 1) state.cursor = Math.max(0, list.length - 1);
    if (state.cursor < 0) state.cursor = 0;

    const isEmpty = list.length === 0;
    el.emptyState.hidden = !isEmpty;

    // 重新渲染前断开旧观察者，避免反复筛选后攒下一堆已移除的节点
    if (revealObserver) revealObserver.disconnect();

    renderWall(list);
    renderInventory(list);
    renderSpread(list);

    el.shownCount.innerHTML = `<b>${list.length}</b> / ${TRACKS.length}`;

    renderEmpty(TRACKS.length);
    observeReveals(el.stage);

    if (opts.toTop) scrollToStage();
  }

  /* ============================================================ 主题 */
  function setTheme(theme, persist) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    el.html.dataset.theme = state.theme;
    el.themeToggle.setAttribute('aria-pressed', state.theme === 'light' ? 'true' : 'false');
    el.themeLabel.textContent = state.theme === 'dark' ? '暗色' : '亮色';
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#0d0e11' : '#f4f3f0');
    if (persist !== false) store.set('pb.theme', state.theme);
  }

  /* ============================================================ 快捷键面板 */
  function setKeymap(open) {
    state.keymap = !!open;
    el.keymap.dataset.open = state.keymap ? 'true' : 'false';
    el.keymapToggle.setAttribute('aria-expanded', state.keymap ? 'true' : 'false');
  }

  /* ============================================================ 筛选动作 */
  function clearFilters() {
    state.artist = '';
    state.query = '';
    state.cursor = 0;
    el.search.value = '';
    el.searchClear.hidden = true;
    renderArtists();
    keepActiveArtistInView();
    apply({ toTop: true });
    el.search.focus({ preventScroll: true });
  }

  /* ============================================================ 滚动显现 */
  const canReveal =
    'IntersectionObserver' in window && !readMore.matches && param('motion') !== 'off';

  let revealObserver = canReveal
    ? new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            revealObserver.unobserve(e.target);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 })
    : null;

  if (canReveal) document.documentElement.classList.add('is-motion');

  function observeReveals(scope) {
    const nodes = $$('.reveal:not(.is-in)', scope || document);
    if (!revealObserver) {
      nodes.forEach((n) => n.classList.add('is-in'));
      return;
    }
    nodes.forEach((n) => revealObserver.observe(n));
  }

  /* ============================================================ 事件 */
  function bind() {
    /* 封面墙：点击选中并展开 */
    el.wall.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      state.cursor = Number(tile.dataset.i);
      setView('spread', visible());
    });

    /* 清单：点击整行展开 */
    el.inventory.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-key]');
      if (!row) return;
      state.cursor = Number(row.dataset.i);
      setView('spread', visible());
    });
    el.inventory.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('tr[data-key]');
      if (!row) return;
      e.preventDefault();
      state.cursor = Number(row.dataset.i);
      setView('spread', visible());
    });

    /* 展开视图里的翻页与相关推荐 */
    el.spread.addEventListener('click', (e) => {
      const list = visible();
      const step = e.target.closest('[data-step]');
      if (step) {
        moveCursor(Number(step.dataset.step), list);
        return;
      }
      const rel = e.target.closest('.related__item');
      if (rel) {
        const i = list.findIndex((t) => String(t.id) === String(rel.dataset.key));
        if (i > -1) {
          state.cursor = i;
          renderSpread(list);
          observeReveals(el.spread);
          ensureSpreadVisible();
        }
      }
    });

    /* 歌手筛选 */
    el.artists.addEventListener('click', (e) => {
      const btn = e.target.closest('.artist');
      if (!btn) return;
      state.artist = btn.dataset.artist || '';
      state.cursor = 0;
      renderArtists();
      keepActiveArtistInView();
      apply({ toTop: true });
    });

    /* 搜索：防抖 120ms */
    let searchTimer;
    el.search.addEventListener('input', () => {
      el.searchClear.hidden = !el.search.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = el.search.value;
        state.cursor = 0;
        apply({ toTop: true });
      }, 120);
    });
    el.searchClear.addEventListener('click', () => {
      el.search.value = '';
      el.searchClear.hidden = true;
      state.query = '';
      state.cursor = 0;
      apply({ toTop: true });
      el.search.focus({ preventScroll: true });
    });

    /* 视图切换 */
    el.views.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (btn) setView(btn.dataset.view, visible());
    });
    el.views.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const order = ['wall', 'index', 'spread'];
      const i = order.indexOf(state.view);
      const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      e.preventDefault();
      setView(next, visible());
      $(`#views button[data-view="${next}"]`).focus();
    });

    /* 主题 / 快捷键 */
    el.themeToggle.addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
    el.keymapToggle.addEventListener('click', () => setKeymap(!state.keymap));
    el.keymapClose.addEventListener('click', () => {
      setKeymap(false);
      el.keymapToggle.focus({ preventScroll: true });
    });

    el.emptyReset.addEventListener('click', clearFilters);

    /* 点击面板外部收起 */
    document.addEventListener('pointerdown', (e) => {
      if (!state.keymap) return;
      if (e.target.closest('#keymap') || e.target.closest('#keymapToggle')) return;
      setKeymap(false);
    });

    /* 全局键盘 */
    document.addEventListener('keydown', (e) => {
      const active = document.activeElement;
      const tag = (active && active.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const onControl = tag === 'BUTTON' || tag === 'A';
      const list = visible();

      if (e.key === 'Escape') {
        if (state.keymap) {
          setKeymap(false);
          el.keymapToggle.focus({ preventScroll: true });
          return;
        }
        if (typing) {
          if (el.search.value) {
            el.search.value = '';
            el.searchClear.hidden = true;
            state.query = '';
            state.cursor = 0;
            apply({ toTop: true });
          } else {
            el.search.blur();
          }
          return;
        }
        if (state.view === 'spread') setView(state.lastList, list);
        return;
      }

      if (typing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case '/':
          e.preventDefault();
          el.search.focus({ preventScroll: true });
          break;
        case '1': setView('wall', list); break;
        case '2': setView('index', list); break;
        case '3': setView('spread', list); break;
        case 'j':
        case 'J':
        case 'ArrowDown':
          e.preventDefault();
          moveCursor(e.shiftKey ? 10 : 1, list);
          break;
        case 'k':
        case 'K':
        case 'ArrowUp':
          e.preventDefault();
          moveCursor(e.shiftKey ? -10 : -1, list);
          break;
        case 'Home':
          e.preventDefault();
          moveCursor(-state.cursor, list);
          break;
        case 'End':
          e.preventDefault();
          moveCursor(list.length - 1 - state.cursor, list);
          break;
        case 'Enter':
          if (!onControl) setView('spread', list);
          break;
        case 'l':
        case 'L':
          setTheme(state.theme === 'dark' ? 'light' : 'dark');
          break;
        case 'g':
        case 'G':
          window.scrollTo({ top: 0, behavior: readMore.matches ? 'auto' : 'smooth' });
          break;
        case '?':
          e.preventDefault();
          setKeymap(!state.keymap);
          break;
        default:
          break;
      }
    });
  }

  /* ============================================================ 初始化 */
  function showError() {
    el.errorState.hidden = false;
    el.emptyState.hidden = true;
    el.stage.dataset.view = 'wall';
    if (el.playlistName) el.playlistName.textContent = '歌单数据未就绪';
    if (el.playlistBy) el.playlistBy.textContent = '运行 node tools/build-playlist.mjs';
    if (el.statTracks) el.statTracks.textContent = '0';
    if (el.statArtists) el.statArtists.textContent = '0';
    if (el.statDuration) el.statDuration.textContent = '0h 00m';
    if (el.shownCount) el.shownCount.innerHTML = '<b>0</b> / 0';
    if (el.fetchedAt) el.fetchedAt.textContent = '未生成';
    el.wall.textContent = '';
    el.inventory.textContent = '';
    el.spread.textContent = '';
    el.artists.textContent = '';
    // 让首屏的歌单封面至少有一层底色，不留下一个永远在扫光的空框
    if (el.playlistCover) {
      el.playlistCover.classList.add('is-loaded');
      const wrap = el.playlistCover.closest('[data-art]');
      if (wrap) wrap.classList.remove('is-skeleton');
    }
  }

  function init() {
    if (!PLAYLIST || !TRACKS.length) {
      showError();
      bind();
      return;
    }

    // 内联脚本已经在首屏前定好主题，这里只同步状态与控件
    setTheme(el.html.dataset.theme === 'light' ? 'light' : 'dark', false);

    // 歌单头
    const name = playlistName();
    const creator = playlistCreator();
    const byline = [creator];
    const created = fmtMonth(PLAYLIST.createdAt);
    if (created) byline.push(`${created} 创建`);
    if (PLAYLIST.playCount) byline.push(`${fmtNumber(PLAYLIST.playCount)} 次播放`);
    el.playlistName.textContent = name;
    el.playlistBy.textContent = byline.join(' · ');
    el.playlistBy.title = byline.join(' · ');
    el.playlistCover.src = (PLAYLIST.cover || 'assets/covers/playlist.jpg');
    el.playlistCover.alt = `${name} 封面`;
    hydrateImages(el.playlistCover.closest('[data-art]') || el.playlistCover.parentElement);

    if (el.sourceLink && PLAYLIST.sourceUrl) {
      el.sourceLink.href = PLAYLIST.sourceUrl;
      el.sourceLink.title = `打开网易云原始歌单：${name}`;
    }

    el.statTracks.textContent = PLAYLIST.trackCount || TRACKS.length;
    el.statArtists.textContent = PLAYLIST.artistCount || ARTISTS.length;
    el.statDuration.textContent = fmtTotal(
      PLAYLIST.totalDuration || TRACKS.reduce((sum, t) => sum + (t.duration || 0), 0),
    );
    el.fetchedAt.textContent = fmtISOdate(PLAYLIST.fetchedAt) || '未知';

    // 歌单封面同时作为整页模糊背景：只换 CSS 变量，不额外请求一次图片
    const coverPath = String(PLAYLIST.cover || 'assets/covers/playlist.jpg')
      .replace(/\\/g, '/')
      .replace(/"/g, '%22');
    el.html.style.setProperty('--playlist-cover', `url("${coverPath}")`);

    document.title = `PlaylistBoard · ${name}`;

    // 初始筛选（可来自 URL）
    const q = param('q');
    if (q) {
      state.query = q;
      el.search.value = q;
      el.searchClear.hidden = false;
    }
    const artistParam = param('artist');
    if (artistParam) state.artist = artistParam;

    renderArtists();
    keepActiveArtistInView();

    // 视图：URL 明确指定优先；带 track 时默认直接展开那一首
    const wantedView = param('view');
    const trackParam = Number(param('track'));
    if (['wall', 'index', 'spread'].includes(wantedView)) {
      state.view = wantedView;
    } else if (trackParam) {
      state.view = 'spread';
    }

    if (trackParam) {
      const list = visible();
      const i = list.findIndex((t) => Number(t.id) === trackParam);
      if (i > -1) state.cursor = i;
    }

    apply();
    setView(['wall', 'index', 'spread'].includes(state.view) ? state.view : 'wall', visible());

    bind();
    setKeymap(param('kbd') === '1');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
