'use strict';
const $ = (s) => document.querySelector(s);
const body = document.body;
let view = { prompts: [], skills: [] }, cfg = {}, meta = {};
let tab = 'all', sub = '', sort = 'default', query = '';
let expanded = false, sticky = false, dragging = null, handleHover = false;
let collapseTimer, hoverTimer, toastTimer, searchTimer;
let previewId = null, previewEditingId = null, closing = false, automaticClosing = false, closeSequence = null;
let hoverCard = null, hoverPoint = null, previewRequest = 0, hoverFrame;
let composerBusy = false, composerReady = false, composerRequestId = null;
let suppressHandleUntilLeave = false;
let renderState = { items: [], rendered: 0 };
let promptSelection;
const CHUNK = 30;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const basename = (s) => String(s || '').split(/[\\/]/).pop();
const svg = (paths) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>';
const icons = {
  all: svg('<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>'),
  text: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
  video: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>'),
  star: svg('<path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1Z"/>'),
  hot: svg('<path d="M5 20V10M12 20V4M19 20v-7"/>'),
  skills: svg('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z M4 7.5l8 5 8-5M12 12.5V21"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
};
const TABS = [
  { key: 'all', label: '全部', icon: 'all' }, { key: '常用词', label: '常用词', icon: 'text' },
  { key: '生图词', label: '生图词', icon: 'image' }, { key: '视频词', label: '视频词', icon: 'video' },
  { key: 'star', label: '已收藏', icon: 'star' }, { key: 'hot', label: '高频', icon: 'hot' },
  { key: 'skills', label: 'Skill', icon: 'skills' },
];
function currentPool(key = tab) {
  const all = [...view.prompts, ...(view.skills || [])];
  if (key === 'skills') return view.skills || [];
  if (key === 'hot') return all.filter((p) => p.copyCount > 0);
  if (key === 'star') return all.filter((p) => p.pinned);
  if (key === 'all') return all;
  return view.prompts.filter((p) => p.group === key);
}
function findItem(id) {
  return [...view.prompts, ...(view.skills || [])].find((p) => p.id === id);
}
function renderTabs() {
  $('#tabRow').innerHTML = TABS.map((t) => '<button class="tab ' + (tab === t.key ? 'on' : '') + '" data-tab="' + esc(t.key) + '" aria-label="' + t.label + '" aria-pressed="' + (tab === t.key) + '" title="' + t.label + ' · ' + currentPool(t.key).length + '">' + icons[t.icon] + '<span>' + t.label + '</span></button>').join('');
  $('#groupSelect').innerHTML = TABS.map((t) => '<option value="' + esc(t.key) + '">' + t.label + '</option>').join('');
  $('#groupSelect').value = tab;
}
function renderSubs() {
  const counts = new Map();
  for (const p of currentPool()) {
    const key = p.sub || (p.tags || [])[0] || '未分类';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (sub && !counts.has(sub)) sub = '';
  $('#subSelect').innerHTML = '<option value="">全部分类</option>' + [...counts].map(([s, n]) => '<option value="' + esc(s) + '">' + esc(s) + ' · ' + n + '</option>').join('');
  $('#subSelect').value = sub;
  $('#subSelect').disabled = !counts.size;
}
function renderSorts() {
  $('#sortRow').innerHTML = [['default', tab === 'skills' ? '名称' : '最新'], ['hot', '最热'], ['star', '已收藏']].map(([key, label]) => '<button class="sort-button ' + (sort === key ? 'on' : '') + '" data-sort="' + key + '" aria-pressed="' + (sort === key) + '"' + (key === 'default' && tab !== 'skills' ? ' title="按表格添加时间，从新到旧"' : '') + '>' + label + '</button>').join('');
}
function mediaHTML(p) {
  const hasImg = cfg.appearance?.cardImage !== false && p.image?.fileToken;
  const hasVid = !!p.video?.fileToken;
  const label = esc('预览：' + (p.title || p.name || '提示词'));
  if (!hasImg && !hasVid) {
    return '<button class="media nomedia" aria-label="' + label + '"><span class="text-label">' + icons.text + esc(p.sub || p.tags?.[0] || '文字提示词') + '</span><span class="text-sample">' + esc(p.content || '暂无正文') + '</span></button>';
  }
  const image = hasImg && p.image.localPath ? '<img alt="" loading="lazy" src="localimg:///' + encodeURIComponent(basename(p.image.localPath)) + '">' : '';
  return '<button class="media" aria-label="' + label + '" data-itoken="' + esc(hasImg ? p.image.fileToken : '') + '" ' + (image ? 'data-loaded="1"' : '') + '>' + (image || '<span class="ph">' + icons[hasVid ? 'video' : 'image'] + '</span>') + (hasVid ? '<span class="play">▶</span>' : '') + '</button>';
}
function cardHTML(p) {
  if (p.kind === 'skill') return '<article class="card skill-card' + (previewId === p.id ? ' previewing' : '') + '" data-id="' + esc(p.id) + '"><button class="skill-main" aria-label="查看技能：' + esc(p.title) + '"><strong>' + esc(p.title) + '</strong><span class="skill-summary">' + esc(p.note || p.description || '点击补充用途说明') + '</span><span class="skill-meta" title="' + esc(p.skillPath) + '">' + esc(p.sub) + ' · ' + (p.stale ? '暂无法读取' : '本机已发现') + ' · ' + esc(p.scanRoot.split(/[\\/]/).slice(-2).join('/')) + '</span></button><button class="bookmark ' + (p.pinned ? 'on' : '') + '" aria-label="' + (p.pinned ? '取消收藏' : '收藏') + '" aria-pressed="' + !!p.pinned + '">' + icons.star + '</button><button class="quick-copy" aria-label="复制调用提示词" title="复制调用提示词"' + (p.stale ? ' disabled' : '') + '>' + icons.copy + '</button></article>';
  return '<article class="card ' + (previewId === p.id ? ' previewing' : '') + '" data-id="' + esc(p.id) + '">' + mediaHTML(p) +
    '<div class="card-bottom"><button class="card-title" title="点击复制：' + esc(p.title || p.name) + '">' + esc(p.title || p.name || '未命名提示词') + '</button>' +
    '<button class="bookmark ' + (p.pinned ? 'on' : '') + '" aria-label="' + (p.pinned ? '取消收藏' : '收藏') + '" aria-pressed="' + !!p.pinned + '" title="' + (p.pinned ? '取消收藏' : '收藏到常用词') + '">' + icons.star + '</button></div>' +
    '<button class="quick-copy" aria-label="复制提示词" title="复制全文 · 已复制 ' + (p.copyCount || 0) + ' 次">' + icons.copy + '</button></article>';
}
function appendChunk(first) {
  const next = renderState.items.slice(renderState.rendered, renderState.rendered + CHUNK);
  renderState.rendered += next.length;
  const html = next.map(cardHTML).join('');
  if (first) $('#list').innerHTML = html + (renderState.rendered < renderState.items.length ? '<div id="moresent"></div>' : '');
  else {
    $('#moresent')?.insertAdjacentHTML('beforebegin', html);
    if (renderState.rendered >= renderState.items.length) $('#moresent')?.remove();
  }
  bindMediaLazy();
  promptSelection?.refresh();
}
function renderList(resetScroll = true) {
  cancelPreviewHover();
  let items = currentPool().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (tab === 'skills') items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  const q = query.trim().toLowerCase();
  if (sub) items = items.filter((p) => (p.sub || p.tags?.[0] || '未分类') === sub);
  if (sort === 'star') items = items.filter((p) => p.pinned);
  if (sort === 'hot' || tab === 'hot') items = items.slice().sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0));
  if (q) items = items.filter((p) => [p.title, p.name, p.content, p.description, p.note, ...(p.tags || [])].join(' ').toLowerCase().includes(q));
  const previous = $('#list').scrollTop;
  const visibleCount = renderState.rendered;
  renderState = { items, rendered: 0 };
  $('#resultCount').textContent = items.length + ' 条';
  if (!items.length) {
    mediaObserver?.disconnect();
    const first = tab !== 'skills' && !view.prompts.length && !(view.skills || []).length && !meta.lastSyncAt;
    $('#list').innerHTML = tab === 'skills' && !query && !sub && sort !== 'star' ? '<div class="empty">' + icons.skills + '<strong>' + (view.skillState?.scanning ? '正在发现本机 Skill…' : '暂未发现 Skill') + '</strong>可在设置的 Skill 页添加技能目录，再重新扫描。<div><button data-action="settings">设置扫描目录</button><button data-action="scan">重新扫描</button></div></div>' : '<div class="empty">' + icons[query ? 'text' : 'image'] + '<strong>' + (first ? '你的灵感，从这里开始' : '没有找到相关内容') + '</strong>' + (first ? '连接飞书多维表，随时取用你的提示词。' : '试试其他关键词或分类。') +
      (first ? '<div><button class="primary" data-action="settings">设置数据源</button><button data-action="sync">立即同步</button></div>' : '<div><button data-action="reset">清除筛选</button></div>') + '</div>';
  } else {
    appendChunk(true);
    if (!resetScroll) while (renderState.rendered < Math.min(visibleCount, items.length)) appendChunk(false);
  }
  $('#list').scrollTop = resetScroll ? 0 : previous;
  promptSelection?.refresh();
  // Sync replaces card nodes. Reconcile the current pointer against the new
  // nodes instead of relying on another pointerover from Chromium.
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    if (!expanded || !hoverPoint) return;
    queuePreview(document.elementFromPoint(hoverPoint.x, hoverPoint.y)?.closest('#list .card'));
  });
}
function renderFooter() {
  if (tab === 'skills') {
    const state = view.skillState || {};
    $('#syncInfo').textContent = state.scanning ? '正在扫描本机 Skill…' : '本机 Skill · ' + (view.skills || []).length + ' 个' + (state.errors?.length ? ' · 部分未读取' : '');
    $('#syncInfo').title = state.errors?.length ? state.errors.map(error => error.path + '：' + error.message).join('\n') : state.lastScanAt ? '最近扫描：' + new Date(state.lastScanAt).toLocaleString() : '添加目录后即可扫描';
    $('.statusbar').classList.remove('unsynced'); $('.statusbar').classList.toggle('error', !!state.errors?.length); $('.statusbar').classList.toggle('syncing', !!state.scanning);
    $('#btnSync').disabled = !!state.scanning; $('#btnSync').classList.toggle('spin', !!state.scanning);
    $('#btnSync').title = '重新扫描 Skill'; $('#btnSync').setAttribute('aria-label', '重新扫描 Skill'); $('#btnSync').setAttribute('aria-busy', String(!!state.scanning));
    return;
  }
  $('#btnSync').setAttribute('aria-label', '立即同步');
  $('#syncInfo').textContent = meta.syncing ? '正在同步…' : meta.lastSyncAt ? '已同步 · ' + view.prompts.length + ' 条' : '尚未同步';
  $('#syncInfo').title = meta.lastError || (meta.lastSyncAt ? '最近同步：' + new Date(meta.lastSyncAt).toLocaleString() : '点击右上角同步');
  $('.statusbar').classList.toggle('unsynced', !meta.lastSyncAt);
  $('.statusbar').classList.toggle('error', !!meta.lastError && !meta.syncing);
  $('.statusbar').classList.toggle('syncing', !!meta.syncing);
  $('#btnSync').classList.toggle('spin', !!meta.syncing);
  $('#btnSync').disabled = !!meta.syncing;
  $('#btnSync').setAttribute('aria-busy', String(!!meta.syncing));
  $('#btnSync').title = meta.syncing ? '正在同步…' : '立即同步';
}
function renderAll() { applyAppearance(); renderTabs(); renderSubs(); renderSorts(); renderList(false); renderFooter(); }

let mediaObserver = null;
function bindMediaLazy() {
  mediaObserver?.disconnect();
  mediaObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target, item = findItem(el.closest('.card').dataset.id);
      mediaObserver.unobserve(el);
      if (!item || !el.dataset.itoken || el.dataset.loaded) continue;
      el.dataset.loaded = 'pending';
      window.api.mediaEnsure({ tableId: item.tableId, recordId: item.recordId, fileToken: item.image.fileToken, name: item.image.name, role: 'image' }).then((r) => {
        if (!r?.localPath) { delete el.dataset.loaded; return; }
        item.image.localPath = r.localPath;
        if (!el.isConnected) return;
        const im = new Image(); im.alt = ''; im.src = 'localimg:///' + encodeURIComponent(basename(r.localPath));
        im.onerror = () => { im.remove(); delete el.dataset.loaded; };
        el.querySelector('img')?.remove(); el.prepend(im); el.querySelector('.ph')?.remove(); el.dataset.loaded = '1';
      }).catch(() => { delete el.dataset.loaded; });
    }
  }, { root: $('#list'), rootMargin: '140px' });
  document.querySelectorAll('.media[data-itoken]:not([data-loaded])').forEach((el) => mediaObserver.observe(el));
}
function markPreview(id) {
  previewId = id;
  document.querySelectorAll('.card').forEach((el) => el.classList.toggle('previewing', el.dataset.id === id));
}
function cancelPreviewHover() { clearTimeout(hoverTimer); hoverTimer = null; hoverCard = null; }
function queuePreview(card) {
  if ($('#promptComposer').open || window.PromptDeleteUI.isOpen() || promptSelection?.isActive() || !expanded || !card?.isConnected || (previewEditingId && previewEditingId !== card.dataset.id)) { cancelPreviewHover(); return; }
  if (hoverCard === card) return;
  cancelPreviewHover(); hoverCard = card;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (hoverCard === card) showPreview(card);
  }, 320);
}
function showPreview(card, play = false, focus = false) {
  clearTimeout(hoverTimer); cancelCollapse();
  if ($('#promptComposer').open || !expanded || !card?.isConnected || (previewEditingId && previewEditingId !== card.dataset.id)) return;
  const item = findItem(card.dataset.id);
  if (!item) return;
  const request = ++previewRequest;
  markPreview(item.id);
  window.api.showPreview({ id: item.id, top: Math.round(card.getBoundingClientRect().top), play, focus }).then((shown) => {
    if (!shown && request === previewRequest) { markPreview(null); hoverCard = null; }
  }).catch(() => { if (request === previewRequest) { markPreview(null); hoverCard = null; showToast('预览暂时不可用'); } });
}
function hidePreview() { cancelPreviewHover(); ++previewRequest; markPreview(null); window.api.hidePreview(); }

function setExpandedLocal(v, st) {
  expanded = v;
  if (st !== undefined) sticky = st;
  body.classList.toggle('expanded', expanded);
  $('#btnPin').classList.toggle('on', sticky);
  $('#btnPin').setAttribute('aria-pressed', String(sticky));
  $('#btnPin').title = sticky ? '取消固定' : '固定展开';
  $('#btnPin').setAttribute('aria-label', sticky ? '取消固定' : '固定展开');
}
function requestExpand(st) { body.classList.add('preexpand'); window.api.requestExpand(!!st); }
function requestCollapse() { cancelCollapse(); hidePreview(); body.classList.add('handle-hide'); window.api.requestCollapse(); }
function cancelCollapse() { clearTimeout(collapseTimer); collapseTimer = null; }
function scheduleCollapse() {
  cancelCollapse();
  if (!expanded || sticky || dragging || $('#promptComposer').open || window.PromptDeleteUI.isOpen() || previewEditingId) return;
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (!expanded || sticky || dragging) return;
    // Native select popups can briefly sit outside the main window.
    if (document.hasFocus() && document.activeElement?.tagName === 'SELECT') return;
    window.api.autoCollapse();
  }, Math.min(60, Math.max(0, cfg.panel?.autoCollapseMs ?? 40)));
}
function applyPanelLayout(layout) {
  if (!layout) return;
  body.style.setProperty('--panel-width', layout.width + 'px');
  body.style.setProperty('--panel-height', layout.height + 'px');
}
function acknowledgeCollapse() {
  if (closing && !expanded && closeSequence !== null) window.api.collapseComplete(closeSequence);
}
function edgeKey() { return body.dataset.edge === 'top' ? 'top' : 'right'; }
function currentFrac() { return cfg.panel?.handlePos?.[edgeKey()] ?? 0.5; }
function setHandleVisual(mode, frac = currentFrac()) {
  const h = $('#handle');
  h.style.cssText = 'position:fixed;transform:none;margin:0;';
  if (mode === 'fill') Object.assign(h.style, { inset: '0', width: 'auto', height: 'auto' });
  else if (edgeKey() === 'top') Object.assign(h.style, { width: '76px', height: '36px', top: '0', left: 'calc(' + (frac * 100) + '% - 38px)', right: 'auto', bottom: 'auto' });
  else Object.assign(h.style, { width: '36px', height: '76px', right: '0', top: 'calc(' + (frac * 100) + '% - 38px)', left: 'auto', bottom: 'auto' });
}
function applyAppearance() {
  body.dataset.theme = cfg.appearance?.theme === 'dark' ? 'dark' : 'light';
  body.dataset.edge = cfg.panel?.edge || 'right';
  const opacity = cfg.appearance?.handleOpacity;
  body.style.setProperty('--handle-opacity', String(Number.isFinite(opacity) ? Math.max(.1, Math.min(1, opacity)) : .8));
  body.style.setProperty('--acc', cfg.appearance?.accent || '#ed7059');
  body.style.setProperty('--lines', String(cfg.appearance?.previewLines || 2));
  setHandleVisual(expanded || dragging ? 'pos' : 'fill');
}
function bindHandleDrag() {
  $('#handle').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = { moved: false, sx: e.screenX, sy: e.screenY };
    window.api.setDragging(true);
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (!dragging.moved && Math.abs(e.screenX - dragging.sx) + Math.abs(e.screenY - dragging.sy) < 5) return;
    dragging.moved = true; window.api.dragMove(e.screenX, e.screenY);
  });
  window.addEventListener('mouseup', async () => {
    if (!dragging) return;
    const moved = dragging.moved;
    dragging = null;
    await window.api.dragEnd(moved);
    if (!moved) requestExpand(true);
  });
  $('#handle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); requestExpand(true); }
  });
}
function selectTab(key) {
  clearTimeout(searchTimer); query = $('#search').value;
  hidePreview(); tab = key; sub = ''; sort = 'default';
  renderTabs(); renderSubs(); renderSorts(); renderList();
  $('#search').placeholder = key === 'skills' ? '搜索 Skill 名称、用途、分类' : '搜索提示词、风格、标签';
  $('#search').setAttribute('aria-label', key === 'skills' ? '搜索 Skill' : '搜索提示词');
  renderFooter();
}

function composerMessage(text, error = false) {
  $('#composerMessage').textContent = text || '';
  $('#composerMessage').classList.toggle('error', error);
}
function setComposerBusy(busy, label = '正在保存…') {
  composerBusy = busy;
  $('#promptForm').setAttribute('aria-busy', String(busy));
  $('#composerFields').disabled = busy;
  $('#composerClose').disabled = busy;
  $('#composerCancel').disabled = busy;
  $('#saveCloudPrompt').disabled = busy || !composerReady;
  $('#saveCloudPrompt').textContent = busy ? label : '保存到飞书';
}
async function loadPromptTargets() {
  composerReady = false; setComposerBusy(false);
  const targets = await window.api.getPromptTargets();
  const previous = $('#promptSource').value;
  $('#promptSource').replaceChildren(...targets.sources.map(source => new Option(source.name, source.id)));
  $('#promptSource').value = targets.sources.some(source => source.id === previous) ? previous : targets.preferredSourceId;
  composerReady = targets.connected && targets.sources.length > 0;
  $('#composerSettings').classList.toggle('hidden', !!composerReady);
  $('#legacyPrompts').classList.toggle('hidden', !targets.legacyCount);
  $('#legacyPromptCount').textContent = targets.legacyCount + ' 条旧条目待同步';
  $('#migratePrompts').disabled = !composerReady;
  setComposerBusy(false);
  if (!composerReady) composerMessage('先接入常用提示词数据表，即可在这里直接保存到飞书。');
}
async function openPromptComposer() {
  const dialog = $('#promptComposer');
  if (dialog.open) return;
  hidePreview(); cancelCollapse(); composerMessage('正在读取数据表…');
  await window.api.setComposing(true);
  dialog.showModal();
  try {
    await loadPromptTargets();
    if (composerReady) { composerMessage(''); ($('#promptTitle').value ? $('#promptContent') : $('#promptTitle')).focus(); }
  } catch {
    composerMessage('无法读取数据表，请检查连接后重新打开表单。', true);
  }
}
function bindPromptComposer() {
  const dialog = $('#promptComposer'), form = $('#promptForm');
  $('#btnNewPrompt').addEventListener('click', openPromptComposer);
  for (const id of ['composerClose', 'composerCancel']) $('#' + id).addEventListener('click', () => { if (!composerBusy) dialog.close(); });
  dialog.addEventListener('cancel', (e) => { if (composerBusy) e.preventDefault(); });
  dialog.addEventListener('close', () => { if (!dialog.open) { cancelPreviewHover(); window.api.setComposing(false); } });
  $('#composerSettings').addEventListener('click', () => { dialog.close(); window.api.openSettings(); });
  form.addEventListener('input', () => { if (!composerBusy) { composerRequestId = null; composerMessage(''); } });
  form.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (composerBusy || !composerReady || !form.reportValidity()) return;
    const title = $('#promptTitle').value.trim(), content = $('#promptContent').value.trim();
    if (!title || !content) { composerMessage('请填写标题和提示词正文。', true); (!title ? $('#promptTitle') : $('#promptContent')).focus(); return; }
    composerRequestId ||= crypto.randomUUID();
    setComposerBusy(true); composerMessage('正在保存到飞书…');
    try {
      const result = await window.api.createCloudPrompt({ requestId: composerRequestId, sourceId: $('#promptSource').value, title, content, pinned: $('#promptPinned').checked });
      if (!result.ok) {
        composerMessage(result.error || '保存失败，输入已保留，请重试。', true);
        if (result.created) composerReady = false;
        return;
      }
      form.reset(); composerRequestId = null; dialog.close();
      query = ''; $('#search').value = ''; selectTab('常用词');
      showToast(result.warning || '已保存到飞书');
    } catch { composerMessage('保存结果未确认，输入已保留。请先同步检查后再重试。', true); }
    finally { setComposerBusy(false); }
  });
  $('#migratePrompts').addEventListener('click', async () => {
    if (composerBusy || !composerReady) return;
    setComposerBusy(true, '正在迁移…'); composerMessage('正在将旧条目保存到飞书，请稍候…');
    try {
      const result = await window.api.migrateLegacyPrompts({ sourceId: $('#promptSource').value });
      await loadPromptTargets();
      composerMessage(result.ok ? '旧条目已同步到飞书。' : `已保存 ${result.saved || 0} 条；${result.error || '其余条目仍保留，可以稍后重试。'}`, !result.ok);
    } catch { composerMessage('迁移未完成，尚未成功的条目仍会保留，请稍后重试。', true); }
    finally { setComposerBusy(false); }
  });
}
function bind() {
  window.PromptDeleteUI.bind(() => view, {
    beforeOpen: () => { hidePreview(); return window.api.setComposing(true); },
    onClose: () => window.api.setComposing(false),
    onResult: result => { if (result.deletedIds?.length) showToast('已删除 ' + result.deletedIds.length + ' 条提示词'); },
  });
  promptSelection = window.createPromptSelection({ button: $('#btnManagePrompts'), toolbar: $('#promptSelection'), container: $('#list'), getItems: () => renderState.items });
  bindPromptComposer();
  document.addEventListener('mouseenter', () => {
    cancelCollapse();
    if (closing && automaticClosing && !dragging) requestExpand(false);
  });
  document.addEventListener('mouseleave', () => { suppressHandleUntilLeave = false; hoverPoint = null; cancelPreviewHover(); scheduleCollapse(); });
  document.addEventListener('pointermove', (e) => {
    hoverPoint = { x: e.clientX, y: e.clientY };
    queuePreview(e.target.closest('#list .card'));
  });
  document.addEventListener('focusout', () => { if (!document.hasFocus()) scheduleCollapse(); });
  // 悬停展开抑制键：Windows 认 Ctrl，mac 认 Cmd（按住移过把手不弹面板，方便抄屏幕右侧内容）
  const isMac = /Mac/i.test(navigator.platform);
  const suppressKey = (e) => !!(e.ctrlKey || (isMac && e.metaKey));
  let ctrlDown = false;
  const openFromHandle = () => {
    handleHover = true;
    if (ctrlDown || expanded || dragging || suppressHandleUntilLeave || body.classList.contains('preexpand')) return;
    if (cfg.panel?.hoverExpand !== false) requestExpand(false);
  };
  window.addEventListener('mousemove', (e) => {
    const down = suppressKey(e);
    if (ctrlDown === down) return;
    ctrlDown = down;
    if (!ctrlDown && handleHover) openFromHandle();
  });
  $('#handle').addEventListener('mouseenter', (e) => { ctrlDown = suppressKey(e); openFromHandle(); });
  $('#handle').addEventListener('mouseleave', () => { handleHover = false; suppressHandleUntilLeave = false; });
  window.api.on('panel:handle-enter', openFromHandle);
  $('#btnSync').addEventListener('click', () => (tab === 'skills' ? window.api.scanSkills() : window.api.syncNow()).then((r) => { if (r?.ok === false) showToast(tab === 'skills' ? '部分 Skill 未读取，请在设置中查看' : r.error || '同步失败，请检查数据源'); }).catch(() => showToast(tab === 'skills' ? '扫描失败，请检查技能目录' : '同步失败，请检查数据源')));
  $('#btnPin').addEventListener('click', () => { window.api.requestExpand(!sticky); });
  $('#btnSettings').addEventListener('click', () => { hidePreview(); window.api.openSettings(); });
  $('#btnCollapse').addEventListener('click', requestCollapse);
  $('#tabRow').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) selectTab(t.dataset.tab); });
  $('#groupSelect').addEventListener('change', (e) => selectTab(e.target.value));
  $('#subSelect').addEventListener('change', (e) => { hidePreview(); sub = e.target.value; renderList(); });
  $('#sortRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    hidePreview(); sort = b.dataset.sort; renderSorts(); renderList();
  });
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer); hidePreview();
    const value = e.target.value;
    searchTimer = setTimeout(() => { query = value; renderList(); }, 140);
  });
  $('#list').addEventListener('scroll', () => {
    hidePreview();
    const el = $('#list');
    if (renderState.rendered < renderState.items.length && el.scrollTop + el.clientHeight > el.scrollHeight - 400) appendChunk(false);
  });
  $('#list').addEventListener('pointerover', (e) => {
    const card = e.target.closest('.card');
    if (!card || card.contains(e.relatedTarget)) return;
    hoverPoint = { x: e.clientX, y: e.clientY };
    queuePreview(card);
  });
  $('#list').addEventListener('pointerout', (e) => {
    const card = e.target.closest('.card');
    if (card && !card.contains(e.relatedTarget)) cancelPreviewHover();
  });
  $('#list').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'settings') { window.api.openSettings(); return; }
    if (action === 'sync') { $('#btnSync').click(); return; }
    if (action === 'scan') { window.api.scanSkills().catch(() => showToast('扫描失败，请重试')); return; }
    if (action === 'reset') {
      clearTimeout(searchTimer); query = ''; $('#search').value = ''; sub = ''; sort = 'default'; renderAll(); return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const item = findItem(card.dataset.id);
    if (!item) return;
    try {
      if (e.target.closest('.bookmark')) { await window.api.togglePin(item.id); return; }
      if (item.kind === 'skill') {
        if (e.target.closest('.quick-copy')) { await window.api.copySkill(item.id); return; }
        showPreview(card, false, true); return;
      }
      if (e.target.closest('.media')) { showPreview(card, !!item.video?.fileToken); return; }
      await window.api.copy(item.content, item.title || item.name, item.id);
    } catch (error) { showToast(item.kind === 'skill' ? error.message : '操作失败，请重试'); }
  });
  document.addEventListener('keydown', (e) => {
    if ($('#promptComposer').open || window.PromptDeleteUI.isOpen()) return;
    if (e.key === 'Escape') { if (previewId) hidePreview(); else requestCollapse(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); }
  });
  bindHandleDrag();
  $('#panel').addEventListener('transitionend', (e) => {
    if (e.target === $('#panel') && e.propertyName === 'opacity') acknowledgeCollapse();
  });
  window.api.on('panel:expand', (p) => {
    closing = false; closeSequence = null; automaticClosing = false;
    applyPanelLayout(p?.layout);
    body.classList.remove('preexpand', 'handle-hide'); setExpandedLocal(true, !!p?.sticky);
  });
  window.api.on('panel:collapse', (p) => {
    cancelPreviewHover(); ++previewRequest; cancelCollapse(); markPreview(null); document.activeElement?.blur();
    closing = true; automaticClosing = !!p?.automatic; closeSequence = p?.sequence ?? null;
    suppressHandleUntilLeave = !automaticClosing;
    body.classList.add('handle-hide');
    setExpandedLocal(false, false); setHandleVisual('pos');
    // Reduced-motion and a close before the first entrance frame have no
    // transitionend. Acknowledge these immediately rather than waiting 200ms.
    requestAnimationFrame(() => {
      if (!closing) return;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || !$('#panel').getAnimations().length) acknowledgeCollapse();
    });
  });
  window.api.on('panel:handle-on', () => { closing = false; closeSequence = null; body.classList.remove('handle-hide', 'preexpand'); setHandleVisual('fill'); });
  window.api.on('panel:drag-on', () => setHandleVisual('pos'));
  window.api.on('panel:drag-pos', (p) => setHandleVisual('pos', p?.frac ?? currentFrac()));
  window.api.on('panel:drag-off', () => setHandleVisual('fill'));
  window.api.on('panel:force-collapsed', () => {
    body.classList.add('noanim'); body.classList.remove('preexpand', 'handle-hide');
    setExpandedLocal(false, false); setHandleVisual('fill'); markPreview(null);
    closing = false; closeSequence = null; suppressHandleUntilLeave = true;
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('noanim')));
  });
  window.api.on('panel:handle-pos', (p) => { cfg.panel.handlePos = { ...cfg.panel.handlePos, [edgeKey()]: p.frac }; setHandleVisual(expanded ? 'pos' : 'fill'); });
  window.api.on('panel:layout', (p) => { applyPanelLayout(p); body.dataset.edge = p.edge; setHandleVisual(expanded ? 'pos' : 'fill'); });
  window.api.on('panel:preview-active', (state) => { cancelCollapse(); if (state?.id) markPreview(state.id); });
  window.api.on('panel:delete-request', state => window.PromptDeleteUI.open([state.id]));
  window.api.on('panel:preview-editing', (state) => { previewEditingId = state?.active ? state.id : null; if (previewEditingId) cancelCollapse(); });
  window.api.on('panel:preview-closed', () => { previewEditingId = null; markPreview(null); hoverCard = null; });
  window.api.on('panel:toast', (p) => showToast(p?.text));
  window.api.on('appearance:updated', async () => { cfg = await window.api.getConfig(); applyAppearance(); renderList(false); });
  window.api.on('data:updated', (p) => { view = p.view; meta = { ...meta, ...p.meta }; if (p.config) cfg = p.config; renderAll(); });
  window.api.on('stats:updated', (p) => {
    for (const item of [...view.prompts, ...(view.skills || [])]) if (item.id === p.id) item.copyCount = p.count;
    const card = [...document.querySelectorAll('.card')].find((el) => el.dataset.id === p.id);
    if (card) card.querySelector('.quick-copy').title = (findItem(p.id)?.kind === 'skill' ? '复制调用词' : '复制全文') + ' · 已复制 ' + p.count + ' 次';
    renderTabs();
  });
  window.api.on('sync:state', (p) => { meta.syncing = !!p?.syncing; renderFooter(); });
}
function showToast(text) {
  $('#toast').textContent = text || ''; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 1600);
}
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const d = await window.api.getData(); view = d.view; cfg = d.config; meta = d.meta;
    tab = cfg.panel?.defaultTab === 'skills' ? 'skills' : 'all';
    bind(); renderAll();
    const st = await window.api.getPanelState();
    applyPanelLayout(st?.layout);
    setExpandedLocal(!!st?.expanded, !!st?.sticky); setHandleVisual(expanded ? 'pos' : 'fill');
  } catch (err) { console.error('[panel] init:', err); }
});
