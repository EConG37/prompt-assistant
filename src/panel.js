'use strict';
// 面板渲染进程（无穿透架构）：窗口尺寸由主进程管理，本进程只负责 UI 与事件。
// 收起态窗口=把手（真实事件）；展开/拖动时窗口=全列。
const $ = (s) => document.querySelector(s);
const body = document.body;

let view = { prompts: [], phrases: [], tags: [] };
let cfg = null;
let meta = { lastSyncAt: 0, syncing: false };
let tab = 'all';      // all | 常用词 | 生图词 | 视频词 | hot | phrase
let sub = '';
let sort = 'default'; // default | hot | star
let query = '';
let expanded = false;
let sticky = false;
let collapseTimer = null;
let dragging = null;
let handleHover = false;
let dwellTimer = null;
let hoverReopenAfter = 0; // 收起冷却：窗口刚缩回把手时若恰在鼠标下方， dwell 不得立即重新展开（否则“收起→又弹出”死循环）
let lbItem = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const basename = (p) => String(p || '').split(/[\\/]/).pop();

const PALETTE = [
  ['#ece9ff', '#6c5ce7'], ['#e9f8ef', '#1f9254'], ['#fff3e5', '#c26a10'],
  ['#f3eaff', '#7a3fd1'], ['#ffe9ee', '#cf3a63'], ['#e5f6f8', '#0f7f8c'],
  ['#f0f0f4', '#5a5f6e'], ['#fff8dc', '#9a7b00'],
];
function tagColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ---------------- 页签 / 筛选 / 排序 ----------------
const TABS = [
  { key: 'all', label: '全部', icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z"/></svg>' },
  { key: '常用词', label: '常用词', icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 4v12h10V6H7zm2 3h6v2H9V9zm0 4h6v2H9v-2z"/></svg>' },
  { key: '生图词', label: '生图词', icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 3v9.2l4-4 3 3 4-5 3 3.8V7H5zm3 1a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>' },
  { key: '视频词', label: '视频词', icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-2 6v8l7-4-7-4z"/></svg>' },
  { key: 'hot', label: '高频', icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13 2s1 3-1 6c-1.4 2.1-3 3-3 6a5 5 0 0 0 10 0c0-2-1-4-2-5 0 2-1 3-2 3 .5-2 0-6-2-10zM8.5 12.5C7 14 6 15.6 6 17.5A6.5 6.5 0 0 0 12.5 24h.2A7 7 0 0 1 10 18.7c0-2.4.9-4.3-1.5-6.2z"/></svg>' },
  { key: 'phrase', label: '常用句', icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4V5a2 2 0 0 1 2-2zm3 5h10v2H7V8zm0 4h7v2H7v-2z"/></svg>' },
];
const SORTS = [
  { key: 'default', label: '默认' },
  { key: 'hot', label: '最热' },
  { key: 'star', label: '已收藏' },
];

function currentPool() {
  if (tab === 'phrase') return view.phrases;
  let items = view.prompts;
  if (tab === 'hot') items = items.filter((p) => p.copyCount > 0);
  else if (tab !== 'all') items = items.filter((p) => p.group === tab);
  return items;
}

function renderTabs() {
  const counts = { all: view.prompts.length, hot: view.prompts.filter((p) => p.copyCount > 0).length, phrase: view.phrases.length };
  for (const g of ['常用词', '生图词', '视频词']) counts[g] = view.prompts.filter((p) => p.group === g).length;
  $('#tabRow').innerHTML = TABS.map((t) => {
    const c = counts[t.key] || 0;
    if (t.key !== 'all' && t.key !== 'phrase' && c === 0) return '';
    return `<button class="tab ${tab === t.key ? 'on' : ''}" data-tab="${esc(t.key)}" title="${esc(t.label)} ${c}">${t.icon}<span>${esc(t.label)}</span></button>`;
  }).join('');
}

function renderSubs() {
  const row = $('#subRow');
  if (tab === 'phrase' || tab === 'hot') { row.innerHTML = ''; return; }
  const pool = tab === 'all' ? view.prompts : view.prompts.filter((p) => p.group === tab);
  const order = [];
  const cnt = {};
  for (const p of pool) {
    if (!cnt[p.sub]) { cnt[p.sub] = 0; order.push(p.sub); }
    cnt[p.sub]++;
  }
  if (order.length <= 1) { row.innerHTML = ''; return; }
  row.innerHTML =
    `<button class="chip ${sub === '' ? 'on' : ''}" data-s="">全部<b>${pool.length}</b></button>` +
    order.map((s) => `<button class="chip ${sub === s ? 'on' : ''}" data-s="${esc(s)}">${esc(s)}<b>${cnt[s]}</b></button>`).join('');
}

function renderSorts() {
  $('#sortRow').innerHTML = SORTS.map((s) => `<button class="chip ${sort === s.key ? 'on' : ''}" data-sort="${s.key}">${s.label}</button>`).join('');
}

// ---------------- 卡片 ----------------
function mediaHTML(p) {
  const hasImg = cfg.appearance.cardImage !== false && p.image && p.image.fileToken;
  const hasVid = !!(p.video && p.video.fileToken);
  if (!hasImg && !hasVid) {
    return `<div class="media nomedia" title="点击预览全文"><span class="ph"></span>
      <span class="play" style="background:transparent;color:rgba(108,92,231,.55);font-size:18px">✦</span></div>`;
  }
  const imgTag = p.image && p.image.localPath
    ? `<img src="localimg:///${encodeURIComponent(basename(p.image.localPath))}" loading="lazy" />`
    : '';
  return `<div class="media${hasVid ? ' hasvid' : ''}" data-table="${esc(p.tableId)}" data-record="${esc(p.recordId)}"
      data-itoken="${esc(hasImg ? p.image.fileToken : '')}" data-iname="${esc(hasImg ? p.image.name : '')}"
      data-vtoken="${esc(hasVid ? p.video.fileToken : '')}" data-vname="${esc(hasVid ? p.video.name : '')}"
      ${imgTag ? 'data-loaded="1"' : ''} title="${hasVid ? '点击播放视频' : '点击放大预览'}">
    ${imgTag}
    ${!imgTag ? '<span class="ph"></span>' : ''}
    ${hasVid ? '<span class="play">▶</span>' : ''}
  </div>`;
}

const STAR = '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="m8 1.6 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.6Z"/></svg>';
const COPYIC = '<svg viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M5 2a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H5Zm0 1.4h6c.3 0 .6.3.6.6v7c0 .3-.3.6-.6.6H5a.6.6 0 0 1-.6-.6V4c0-.3.3-.6.6-.6ZM2.4 4H2a1 1 0 0 0-1 1v8a2 2 0 0 0 2 2h7a1 1 0 0 0 1-1v-.4H3A.6.6 0 0 1 2.4 13V4Z"/></svg>';
const LINKIC = '<svg viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M6.2 9.8a3.4 3.4 0 0 1 0-4.8l2.4-2.4a3.4 3.4 0 0 1 4.8 4.8l-1.2 1.2-1-1 1.2-1.2a2 2 0 0 0-2.8-2.8L7.2 6a2 2 0 0 0 0 2.8l-1 1Zm3.6-3.6a3.4 3.4 0 0 1 0 4.8l-2.4 2.4a3.4 3.4 0 0 1-4.8-4.8l1.2-1.2 1 1-1.2 1.2a2 2 0 0 0 2.8 2.8L8.8 10a2 2 0 0 0 0-2.8l1-1Z"/></svg>';

function tagsHTML(p, max) {
  return (p.tags || []).slice(0, max || 3).map((t, i) => {
    if (i === 0) {
      const [bg, fg] = tagColor(t);
      return `<span class="tchip" style="background:${bg};color:${fg}">${esc(t)}</span>`;
    }
    return `<span class="tchip plain">${esc(t)}</span>`;
  }).join('');
}

function statsHTML(p) {
  return `<div class="stats">
    <span class="st" title="复制次数">${COPYIC}${p.copyCount || 0}</span>
    ${p.link ? `<span class="st lnk" title="打开来源链接" style="cursor:pointer">${LINKIC}</span>` : ''}
    <span class="sp"></span>
    <button class="cbtn pin${p.pinned ? ' on' : ''}" title="${p.pinned ? '移出常用词' : '加入常用词（托盘右键可见）'}">${STAR}</button>
  </div>`;
}

function cardHTML(p) {
  return `<div class="card" data-id="${esc(p.id)}">
    ${mediaHTML(p)}
    <div class="info">
      <div class="tags">${tagsHTML(p, 3)}</div>
      <div class="title" title="${esc(p.title)}">${esc(p.title)}</div>
      <div class="prev">${esc(p.content)}</div>
      ${statsHTML(p)}
    </div>
  </div>`;
}

function phraseHTML(p) {
  return `<div class="card" data-id="${esc(p.id)}" data-kind="phrase">
    <div class="info">
      <div class="tags">${p.fromPrompt ? '<span class="tchip" style="background:#ece9ff;color:#6c5ce7">提示词</span>' : ''}${tagsHTML(p, 2)}</div>
      <div class="title" title="${esc(p.name || p.title)}">${esc(p.name || p.title)}</div>
      <div class="prev" style="-webkit-line-clamp:1">${esc(p.content)}</div>
      ${statsHTML(p)}
    </div>
  </div>`;
}

let renderState = { items: [], rendered: 0, kind: 'prompt' };
const CHUNK = 30;
function cardMapper() { return renderState.kind === 'phrase' ? phraseHTML : cardHTML; }
function appendChunk(first) {
  const list = $('#list');
  const { items } = renderState;
  const next = items.slice(renderState.rendered, renderState.rendered + CHUNK);
  renderState.rendered += next.length;
  const html = next.map(cardMapper()).join('');
  if (first) {
    list.innerHTML = html + (renderState.rendered < items.length ? '<div id="moresent" style="height:1px"></div>' : '');
  } else {
    const sent = $('#moresent');
    if (sent) {
      sent.insertAdjacentHTML('beforebegin', html);
      if (renderState.rendered >= items.length) sent.remove();
    }
  }
  bindMediaLazy();
}
function renderList() {
  const list = $('#list');
  const q = query.trim().toLowerCase();
  let items = currentPool();
  if (tab !== 'phrase') {
    if (sub) items = items.filter((p) => p.sub === sub);
    if (sort === 'hot') items = items.slice().sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0));
    else if (sort === 'star') items = items.filter((p) => p.pinned);
  } else if (sort === 'hot') {
    items = items.slice().sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0));
  }
  if (q) items = items.filter((p) => ((p.title || p.name || '') + ' ' + (p.tags || []).join(' ') + ' ' + p.content).toLowerCase().includes(q));
  renderState = { items, rendered: 0, kind: tab === 'phrase' ? 'phrase' : 'prompt' };
  if (!items.length) {
    const first = !meta.lastSyncAt;
    list.innerHTML = `<div class="empty">暂无内容<br>${first ? '首次使用请先配置多维表链接<br>（设置 → 数据源 → 环境自检可一键补齐依赖）' : '换个分类或关键词试试'}<br><button id="btnSyncNow">立即同步</button>${first ? ' <button id="btnGoCfg">去设置数据源</button>' : ''}</div>`;
    const b = $('#btnSyncNow');
    if (b) b.onclick = () => window.api.syncNow();
    const g = $('#btnGoCfg');
    if (g) g.onclick = () => window.api.openSettings();
    return;
  }
  appendChunk(true);
}

function renderFooter() {
  const t = meta.lastSyncAt ? new Date(meta.lastSyncAt) : null;
  $('#syncInfo').textContent = (meta.version ? `v${meta.version} · ` : '') + (meta.syncing ? '同步中…' : t ? `同步于 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} · ${view.prompts.length} 条` : '未同步');
}

function renderAll() {
  applyAppearance();
  renderTabs();
  renderSubs();
  renderSorts();
  renderList();
  renderFooter();
}

// 封面图进入可视区时按需下载
let mediaObserver = null;
function bindMediaLazy() {
  if (mediaObserver) mediaObserver.disconnect();
  mediaObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      mediaObserver.unobserve(el);
      if (!el.dataset.itoken || el.dataset.loaded || el.querySelector('img')) continue;
      window.api.mediaEnsure({
        tableId: el.dataset.table, recordId: el.dataset.record,
        fileToken: el.dataset.itoken, name: el.dataset.iname, role: 'image',
      }).then((r) => {
        if (r && r.localPath) {
          el.dataset.loaded = '1';
          const ph = el.querySelector('.ph');
          if (ph) ph.remove();
          const im = document.createElement('img');
          im.src = 'localimg:///' + encodeURIComponent(basename(r.localPath));
          im.loading = 'lazy';
          el.prepend(im);
        }
      });
    }
  }, { root: $('#list'), rootMargin: '140px' });
  document.querySelectorAll('#list .media[data-itoken]:not([data-loaded="1"])').forEach((el) => {
    if (!el.querySelector('img')) mediaObserver.observe(el);
  });
}

// ---------------- 放大预览（图片 / 视频 / 纯文本 + 全文 + 操作） ----------------
function openLightbox(src, title, opts) {
  const o = opts || {};
  lbItem = o.item || null;
  $('#lbText').textContent = (o.item && o.item.content) || '';
  $('#lbLink').classList.toggle('hidden', !(o.item && o.item.link));
  const img = $('#lbImg');
  const vid = $('#lbVideo');
  const textOnly = !o.video && !src; // 无图提示词：只显示全文，不占媒体区
  $('#lightbox').classList.toggle('textonly', textOnly);
  if (o.video) {
    img.classList.add('lbmedia-hidden');
    vid.classList.remove('lbmedia-hidden');
    if (o.poster) vid.poster = o.poster;
    vid.src = src;
    vid.muted = true;
    vid.play().catch(() => {});
  } else {
    vid.pause();
    vid.removeAttribute('src');
    vid.classList.add('lbmedia-hidden');
    img.classList.toggle('lbmedia-hidden', textOnly);
    if (textOnly) img.removeAttribute('src');
    else img.src = src;
  }
  $('#lbTitle').textContent = title || '';
  $('#lightbox').classList.remove('hidden');
}
function closeLightbox() {
  const vid = $('#lbVideo');
  vid.pause();
  vid.removeAttribute('src');
  $('#lightbox').classList.add('hidden');
  $('#lbImg').removeAttribute('src');
}
function lightboxOpen() {
  return !$('#lightbox').classList.contains('hidden');
}

// ---------------- 展开 / 收回 ----------------
function setExpandedLocal(v, st) {
  expanded = v;
  if (st !== undefined) sticky = st;
  body.classList.toggle('expanded', expanded);
  $('#btnPin').classList.toggle('on', sticky);
}
function requestExpand(stickyV) {
  body.classList.add('preexpand'); // 同帧隐去把手：缩放的透明帧不可见
  window.api.requestExpand(!!stickyV);
}
function requestCollapse() {
  body.classList.add('handle-hide'); // 滑出期间隐藏把手（面板本身滑出屏幕外）
  window.api.requestCollapse();
}
function cancelCollapse() { if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; } }
function scheduleCollapse() {
  cancelCollapse();
  const delay = (cfg && cfg.panel && cfg.panel.autoCollapseMs) || 550;
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (document.activeElement === $('#search')) return;
    if (lightboxOpen() || dragging) return;
    requestCollapse();
  }, delay);
}

// ---------------- 把手位置视觉 ----------------
function edgeKey() { return body.dataset.edge === 'top' ? 'top' : 'right'; }
function currentFrac() {
  const pos = (cfg && cfg.panel && cfg.panel.handlePos) || {};
  const f = pos[edgeKey()];
  return typeof f === 'number' ? f : 0.5;
}
function setHandleVisual(mode, frac) {
  const h = $('#handle');
  h.style.position = 'fixed';
  h.style.transform = 'none';
  h.style.margin = '0';
  if (mode === 'fill') {
    h.style.left = '0'; h.style.top = '0'; h.style.right = '0'; h.style.bottom = '0';
    h.style.width = 'auto'; h.style.height = 'auto';
  } else {
    const f = (frac == null ? currentFrac() : frac) * 100;
    if (edgeKey() === 'top') {
      h.style.width = '84px'; h.style.height = '24px';
      h.style.top = '0'; h.style.bottom = 'auto'; h.style.right = 'auto';
      h.style.left = 'calc(' + f + '% - 42px)';
    } else {
      h.style.width = '24px'; h.style.height = '84px';
      h.style.right = '0'; h.style.left = 'auto'; h.style.bottom = 'auto';
      h.style.top = 'calc(' + f + '% - 42px)';
    }
  }
}
function applyAppearance() {
  const ap = (cfg && cfg.appearance) || {};
  body.dataset.theme = ap.theme === 'dark' ? 'dark' : 'light';
  body.style.setProperty('--lines', String(ap.previewLines || 2));
  body.dataset.edge = (cfg && cfg.panel && cfg.panel.edge) || 'right';
  setHandleVisual('pos');
}

// ---------------- 拖动把手 ----------------
function bindHandleDrag() {
  $('#handle').addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = { frac: currentFrac(), moved: false, sx: e.screenX, sy: e.screenY };
    window.api.setDragging(true); // 主进程把窗口放大到全列以跟踪移动
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (!dragging.moved && Math.abs(e.screenX - dragging.sx) + Math.abs(e.screenY - dragging.sy) < 5) return;
    dragging.moved = true;
    window.api.dragMove(e.screenX, e.screenY); // 主进程按屏幕坐标算 frac
  });
  window.addEventListener('mouseup', async () => {
    if (!dragging) return;
    const moved = dragging.moved;
    dragging = null;
    await window.api.dragEnd(moved);
    if (!moved) {
      if (!expanded) requestExpand(true); // 单击把手=固定展开
      else if (!sticky) requestCollapse(); // 悬停展开态下单击=收回
    }
  });
}

// ---------------- 事件绑定 ----------------
function bind() {
  // 光标离开窗口：非固定展开态延时收回
  document.addEventListener('mouseleave', () => {
    if (expanded && !sticky && !lightboxOpen() && !dragging) scheduleCollapse();
  });

  // 把手悬停停留展开（Ctrl 抑制：以 mousemove 跟踪的 Ctrl 状态为准，enter 事件的 ctrlKey 不可靠）
  let ctrlDown = false;
  window.addEventListener('mousemove', (e) => {
    const c = !!e.ctrlKey;
    if (c !== ctrlDown) {
      ctrlDown = c;
      if (c && dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
    }
  });
  const startDwell = () => {
    handleHover = true;
    if (ctrlDown || expanded || dragging) return;
    if (dwellTimer) clearTimeout(dwellTimer);
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (Date.now() < hoverReopenAfter) return; // 收起冷却期内，窗口缩到鼠标下方不算悬停意图
      if (handleHover && !ctrlDown && !expanded && !dragging && cfg && cfg.panel && cfg.panel.hoverExpand !== false) requestExpand(false);
    }, 200);
  };
  $('#handle').addEventListener('mouseenter', () => startDwell());
  $('#handle').addEventListener('mouseleave', () => {
    handleHover = false;
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  });
  window.api.on('panel:handle-enter', () => startDwell(false));

  $('#btnSync').addEventListener('click', () => window.api.syncNow());
  $('#btnPin').addEventListener('click', () => {
    if (sticky) requestCollapse();
    else requestExpand(true);
  });
  $('#btnSettings').addEventListener('click', () => window.api.openSettings());
  $('#btnCollapse').addEventListener('click', () => requestCollapse());

  $('#list').addEventListener('scroll', () => {
    if (renderState.rendered >= renderState.items.length) return;
    const el = $('#list');
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) appendChunk(false);
  });
  // 搜索：debounce，避免每敲一个字就重建整列表 DOM（539 条时尤其明显）
  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    const v = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      query = v;
      renderList();
    }, 140);
  });
  $('#tabRow').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    tab = t.dataset.tab;
    sub = '';
    renderTabs(); renderSubs(); renderList();
  });
  $('#subRow').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    sub = c.dataset.s || '';
    renderSubs(); renderList();
  });
  $('#sortRow').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    sort = c.dataset.sort || 'default';
    renderSorts(); renderList();
  });

  // 放大预览操作
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbImg').addEventListener('click', closeLightbox);
  $('#lbCopy').addEventListener('click', () => {
    if (lbItem) window.api.copy(lbItem.content, lbItem.title || lbItem.name, lbItem.id);
  });
  $('#lbLink').addEventListener('click', () => {
    if (lbItem && lbItem.link) window.api.openExternal(lbItem.link);
  });
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });

  // 列表交互
  $('#list').addEventListener('click', (e) => {
    const media = e.target.closest('.media');
    if (media && media.classList.contains('nomedia')) {
      // 无图提示词：点 ✦ 占位块 = 预览全文（与有图卡片的“点封面图预览”同一心智；
      // 点卡片其余位置仍是复制，不受影响）
      const card0 = media.closest('.card');
      const item0 = view.prompts.find((p) => p.id === (card0 && card0.dataset.id));
      if (item0) openLightbox(null, item0.title || item0.name, { item: item0 });
      return;
    }
    if (media && !media.classList.contains('nomedia')) {
      const card0 = media.closest('.card');
      const item0 = (tab === 'phrase' ? view.phrases : view.prompts).find((p) => p.id === (card0 && card0.dataset.id));
      if (media.classList.contains('hasvid')) {
        const posterImg = media.querySelector('img');
        const openVid = (localPath) => openLightbox('localimg:///' + encodeURIComponent(basename(localPath)), (item0 && (item0.title || item0.name)) || '', { video: true, poster: posterImg ? posterImg.src : '', item: item0 });
        const cached = media.dataset.vloaded;
        if (cached) { openVid(cached); return; }
        media.classList.add('loading');
        window.api.mediaEnsure({
          tableId: media.dataset.table, recordId: media.dataset.record,
          fileToken: media.dataset.vtoken, name: media.dataset.vname, role: 'video',
        }).then((r) => {
          media.classList.remove('loading');
          if (r && r.localPath) {
            media.dataset.vloaded = r.localPath;
            openVid(r.localPath);
          } else {
            showToast('视频下载失败');
          }
        });
      } else if (media.dataset.itoken) {
        const img = media.querySelector('img');
        if (img) openLightbox(img.src, item0 && (item0.title || item0.name), { item: item0 });
        else {
          media.classList.add('loading');
          window.api.mediaEnsure({
            tableId: media.dataset.table, recordId: media.dataset.record,
            fileToken: media.dataset.itoken, name: media.dataset.iname, role: 'image',
          }).then((r) => {
            media.classList.remove('loading');
            if (r && r.localPath) openLightbox('localimg:///' + encodeURIComponent(basename(r.localPath)), item0 && (item0.title || item0.name), { item: item0 });
          });
        }
      }
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const all = tab === 'phrase' ? view.phrases : view.prompts;
    const item = all.find((p) => p.id === id);
    if (!item) return;
    if (e.target.closest('.pin')) { window.api.togglePin(id); return; }
    if (e.target.closest('.lnk')) { window.api.openExternal(item.link); return; }
    window.api.copy(item.content, item.title || item.name, item.id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (lightboxOpen()) closeLightbox();
      else requestCollapse();
    }
  });

  bindHandleDrag();

  // 主进程事件
  window.api.on('panel:expand', (p) => { body.classList.remove('preexpand'); setExpandedLocal(true, !!(p && p.sticky)); });
  window.api.on('panel:collapse', () => { body.classList.remove('panelhide'); setExpandedLocal(false, false); setHandleVisual('pos'); hoverReopenAfter = Date.now() + 700; });
  window.api.on('panel:handle-on', () => { body.classList.remove('handle-hide'); setHandleVisual('fill'); });
  window.api.on('panel:drag-on', () => setHandleVisual('pos', currentFrac()));
  window.api.on('panel:drag-pos', (p) => setHandleVisual('pos', p && typeof p.frac === 'number' ? p.frac : currentFrac()));
  window.api.on('panel:drag-off', () => setHandleVisual('fill'));
  window.api.on('panel:force-collapsed', () => {
    // 拖拽结束：禁动画立即归位，避免滑出残影
    body.classList.add('noanim');
    body.classList.remove('preexpand', 'panelhide', 'handle-hide');
    setExpandedLocal(false, false);
    setHandleVisual('fill');
    hoverReopenAfter = Date.now() + 700; // 拖拽落点即把手位置，松手瞬间不算悬停展开意图
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('noanim')));
  });
  window.api.on('panel:handle-pos', (p) => setHandleVisual('pos', p && typeof p.frac === 'number' ? p.frac : currentFrac()));
  window.api.on('panel:toast', (p) => showToast(p && p.text));
  window.api.on('panel:layout', (p) => { body.dataset.edge = (p && p.edge) || 'right'; setHandleVisual('pos'); });
  window.api.on('appearance:updated', () => { window.api.getConfig().then((c) => { cfg = c; applyAppearance(); }); });
  window.api.on('data:updated', (p) => { view = p.view; meta = p.meta; renderAll(); });
  window.api.on('stats:updated', (p) => {
    const item = view.prompts.find((x) => x.id === p.id) || view.phrases.find((x) => x.id === p.id);
    if (item) item.copyCount = p.count;
    const card = document.querySelector(`.card[data-id="${p.id}"]`);
    if (card) {
      const st = card.querySelector('.stats .st');
      if (st) st.innerHTML = `${COPYIC}${p.count}`;
    }
    view.todayCount = (view.todayCount || 0) + 1;
    renderFooter();
    renderTabs();
    if (tab === 'hot') renderList();
  });
  window.api.on('sync:state', (p) => {
    meta.syncing = !!(p && p.syncing);
    $('#btnSync').classList.toggle('spin', meta.syncing);
    renderFooter();
  });
}

let toastTimer = null;
function showToast(text) {
  const el = $('#toast');
  el.textContent = text || '';
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

window.addEventListener('unhandledrejection', (e) => console.error('[panel] UNHANDLED:', (e.reason && e.reason.stack) || e.reason));
window.addEventListener('error', (e) => console.error('[panel] ERROR:', e.message, e.filename, e.lineno));
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const d = await window.api.getData();
    view = d.view; cfg = d.config; meta = d.meta;
    bind();
    renderAll();
    const st = await window.api.getPanelState();
    if (st && st.expanded) setExpandedLocal(true, st.sticky);
    else setHandleVisual('fill'); // 收起态窗口即把手，把手填满窗口
  } catch (err) {
    console.error('[panel] INIT FAIL:', (err && err.stack) || err);
  }
});
