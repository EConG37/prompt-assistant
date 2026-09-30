'use strict';
// 设置页渲染进程
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let cfg = null;
let view = { prompts: [], phrases: [], tags: [] };
let meta = {};
let tables = [];            // [{id,name,count}]
const fieldsCache = {};     // tableId -> [{id,name,type}]
let editing = null;         // {kind, id} | null
let pQuery = '';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PALETTE = [
  ['#e8efff', '#3565d8'], ['#e9f8ef', '#1f9254'], ['#fff3e5', '#c26a10'],
  ['#f3eaff', '#7a3fd1'], ['#ffe9ee', '#cf3a63'], ['#e5f6f8', '#0f7f8c'],
  ['#f0f0f4', '#5a5f6e'], ['#fff8dc', '#9a7b00'],
];
function tagColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

async function loadAll() {
  const d = await window.api.getData();
  cfg = d.config; view = d.view; meta = d.meta;
  tables = (await window.api.listTables().catch(() => [])) || [];
  renderAll();
}

function renderAll() {
  document.body.dataset.theme = cfg.appearance.theme === 'dark' ? 'dark' : 'light';
  renderSource();
  renderPrompts();
  renderPhrases();
  renderLook();
  renderSyncInfo();
}

function renderSyncInfo() {
  const t = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '从未同步';
  $('#syncInfo').innerHTML = `上次同步<br><b>${esc(t)}</b><br>${view.prompts.length} 条提示词 · ${view.phrases.length} 条常用句`;
}

// ---------------- 数据源 ----------------
function renderSource() {
  $('#baseUrl').value = cfg.baseUrl || '';
  $('#larkCliPath').value = cfg.larkCliPath || '';
  $('#identity').value = cfg.identity || 'user';
  $('#autoMinutes').value = String(cfg.sync.autoMinutes || 0);

  const wrap = $('#srcList');
  wrap.innerHTML = '';
  (cfg.sources || []).forEach((src, idx) => {
    const card = document.createElement('div');
    card.className = 'srccard';
    card.innerHTML = `
      <div class="srchead">
        <input type="checkbox" data-k="enabled" ${src.enabled ? 'checked' : ''} title="启用" />
        <span class="nm">${esc(src.name || '未命名')}</span>
        <span class="badge">${src.kind === 'phrase' ? '常用句源' : '提示词源'}</span>
        <button class="btn sm" data-act="guess">自动识别字段</button>
        <button class="btn sm" data-act="del">移除</button>
      </div>
      <div class="mapgrid">
        <label>数据表</label>
        <select data-k="tableId">${tableOptions(src.tableId)}</select>
        <label>类型</label>
        <select data-k="kind"><option value="prompt" ${src.kind !== 'phrase' ? 'selected' : ''}>提示词</option><option value="phrase" ${src.kind === 'phrase' ? 'selected' : ''}>常用句</option></select>
        <label>标题字段</label><select data-k="title" data-map="1"></select>
        <label>正文字段</label><select data-k="content" data-map="1"></select>
        <label>标签字段</label><div class="tagpicks" data-k="tags"></div>
        <label>预览图字段</label><select data-k="image" data-map="1"></select>
        <label>备注字段</label><select data-k="note" data-map="1"></select>
        <label>视频字段</label><select data-k="video" data-map="1"></select>
      </div>
      <label class="ck" style="margin-top:10px"><input type="checkbox" data-k="downloadImages" ${src.downloadImages ? 'checked' : ''} /> 同步时下载预览图到本地</label>
    `;
    wrap.appendChild(card);
    bindSourceCard(card, idx);
  });
}

function tableOptions(sel) {
  const opts = [`<option value="">（未选择）</option>`];
  for (const t of tables) opts.push(`<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)} (${t.count})</option>`);
  if (sel && !tables.find((t) => t.id === sel)) opts.push(`<option value="${esc(sel)}" selected>${esc(sel)}</option>`);
  return opts.join('');
}

async function fillFieldSelects(card, idx) {
  const src = cfg.sources[idx];
  if (!src || !src.tableId) return;
  if (!fieldsCache[src.tableId]) {
    try {
      fieldsCache[src.tableId] = await window.api.listFields(src.tableId);
    } catch (e) {
      console.error('[settings] listFields failed:', e);
      fieldsCache[src.tableId] = [];
    }
  }
  const fs = fieldsCache[src.tableId] || [];
  console.log('[settings] fillFieldSelects', src.tableId, 'fields=', fs.length);
  const opt = (v, allowEmpty = true) =>
    (allowEmpty ? `<option value="">（无）</option>` : '') +
    fs.map((f) => `<option value="${esc(f.name)}" ${f.name === v ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const m = src.mapping || {};
  card.querySelector('[data-k="title"]').innerHTML = opt(m.title);
  card.querySelector('[data-k="content"]').innerHTML = opt(m.content);
  card.querySelector('[data-k="image"]').innerHTML = opt(m.image);
  card.querySelector('[data-k="note"]').innerHTML = opt(m.note);
  card.querySelector('[data-k="video"]').innerHTML = opt(m.video);
  const tags = Array.isArray(m.tags) ? m.tags : m.tags ? [m.tags] : [];
  card.querySelector('[data-k="tags"]').innerHTML = fs
    .filter((f) => f.type === 'select' || f.type === 'text')
    .map((f) => `<button class="tagpick ${tags.includes(f.name) ? 'on' : ''}" data-tag="${esc(f.name)}">${esc(f.name)}</button>`)
    .join('') || '<span class="msg">该表无可选字段</span>';
}

function bindSourceCard(card, idx) {
  fillFieldSelects(card, idx);
  const patchSrc = (fn) => {
    const src = cfg.sources[idx];
    fn(src);
    window.api.setConfig({ sources: cfg.sources });
  };
  card.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (k === 'tags') {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('.tagpick');
        if (!b) return;
        patchSrc((src) => {
          src.mapping = src.mapping || {};
          let tags = Array.isArray(src.mapping.tags) ? src.mapping.tags : src.mapping.tags ? [src.mapping.tags] : [];
          tags = tags.includes(b.dataset.tag) ? tags.filter((t) => t !== b.dataset.tag) : [...tags, b.dataset.tag];
          src.mapping.tags = tags;
        });
        b.classList.toggle('on');
      });
      return;
    }
    const ev = el.type === 'checkbox' ? 'change' : el.tagName === 'SELECT' ? 'change' : 'change';
    el.addEventListener(ev, () => {
      const val = el.type === 'checkbox' ? el.checked : el.value;
      patchSrc((src) => {
        if (el.dataset.map) { src.mapping = src.mapping || {}; src.mapping[k] = val; }
        else src[k] = val;
        if (k === 'tableId') {
          const t = tables.find((x) => x.id === val);
          if (t) src.name = t.name;
          card.querySelector('.nm').textContent = src.name;
          fillFieldSelects(card, idx);
        }
      });
    });
  });
  card.querySelector('[data-act="guess"]').addEventListener('click', async () => {
    const src = cfg.sources[idx];
    if (!src.tableId) return flash($('#testMsg'), '请先选择数据表', 'err');
    const g = await window.api.guessMapping(src.tableId).catch((e) => { flash($('#testMsg'), e.message, 'err'); return null; });
    if (!g) return;
    cfg.sources[idx].mapping = { title: g.title, content: g.content, tags: g.tags, image: g.image, note: g.note, link: g.link };
    await window.api.setConfig({ sources: cfg.sources });
    fillFieldSelects(card, idx);
    flash($('#testMsg'), '已按字段名自动识别', 'ok');
  });
  card.querySelector('[data-act="del"]').addEventListener('click', () => {
    const removed = cfg.sources[idx];
    cfg.sources.splice(idx, 1);
    if (removed && removed.tableId) {
      cfg.removedTableIds = Array.from(new Set([...(cfg.removedTableIds || []), removed.tableId]));
    }
    window.api.setConfig({ sources: cfg.sources, removedTableIds: cfg.removedTableIds });
    renderSource();
  });
}

function flash(el, msg, cls) {
  el.textContent = msg;
  el.className = 'msg ' + (cls || '');
  setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, 4000);
}

// ---------------- 提示词 / 常用句列表 ----------------
function rowHTML(p, kind) {
  const tags = (p.tags || []).slice(0, 3).map((t) => {
    const [bg, fg] = tagColor(t);
    return `<span class="tchip" style="background:${bg};color:${fg}">${esc(t)}</span>`;
  }).join('');
  const isLocal = p.origin === 'local';
  return `<div class="lrow" data-id="${esc(p.id)}">
    <div class="main">
      <div class="t">${esc(p.title || p.name)}</div>
      <div class="s">${esc((p.content || '').slice(0, 80))}</div>
    </div>
    <div class="tags">${tags}</div>
    <span class="origin">${isLocal ? '本地' : esc(p.tableName || '飞书')}</span>
    <div class="acts">
      <button class="iconbtn pin ${p.pinned ? 'on' : ''}" title="加入常用词（托盘右键可见）">★</button>
      <button class="iconbtn copy" title="复制内容">⧉</button>
      ${isLocal ? `<button class="iconbtn edit" title="编辑">✎</button><button class="iconbtn del" title="删除">✕</button>` : ''}
    </div>
  </div>`;
}

function bindRows(container, kind) {
  container.onclick = async (e) => {
    const row = e.target.closest('.lrow');
    if (!row) return;
    const id = row.dataset.id;
    const list = kind === 'prompt' ? view.prompts : view.phrases;
    const item = list.find((x) => x.id === id);
    if (!item) return;
    if (e.target.closest('.pin')) { await window.api.togglePin(id); return; }
    if (e.target.closest('.copy')) { window.api.copy(item.content, item.title || item.name); return; }
    if (e.target.closest('.del')) { await window.api.deleteLocal(id); return; }
    if (e.target.closest('.edit')) { openDlg(kind, item); return; }
  };
}

function renderPrompts() {
  const total = [...view.prompts, ...view.phrases].reduce((s, p) => s + (p.copyCount || 0), 0);
  const used = [...view.prompts, ...view.phrases].filter((p) => (p.copyCount || 0) > 0).length;
  $('#statsInfo').textContent = total ? `累计复制 ${total} 次 · ${used} 条` : '';
  const q = pQuery.trim().toLowerCase();
  let items = view.prompts;
  if (q) items = items.filter((p) => (p.title + ' ' + (p.tags || []).join(' ') + ' ' + p.content).toLowerCase().includes(q));
  $('#promptList').innerHTML = items.slice(0, 300).map((p) => rowHTML(p, 'prompt')).join('') || '<p class="hint">暂无提示词，请先在「数据源」同步。</p>';
}
function renderPhrases() {
  $('#phraseList').innerHTML = view.phrases.map((p) => rowHTML(p, 'phrase')).join('') || '<p class="hint">还没有常用句，点右上角新建。</p>';
}

// ---------------- 环境自检弹窗 ----------------
const ENV_LABELS = {
  cli: 'lark-cli（飞书命令行）',
  auth: '飞书登录态',
  base: '多维表数据源',
  mediaDir: '媒体缓存目录',
};
let lastEnvCheck = null; // 最近一次自检结果，供「复制给 AI 助手排查」使用
async function runEnvCheck() {
  const rows = $('#envRows');
  rows.innerHTML = '<p class="hint">检测中…</p>';
  const r = await window.api.envCheck();
  lastEnvCheck = r;
  const row = (key, item) => {
    const act = item.action
      ? `<button class="btn sm" data-act="${item.action}" data-key="${key}">${item.action === 'install' ? '一键安装' : item.action === 'login' ? '去登录' : '去配置'}</button>`
      : '';
    return `<div class="envrow ${item.ok ? 'ok' : 'bad'}">
      <span class="dot">${item.ok ? '✓' : '!'}</span>
      <span class="nm">${ENV_LABELS[key]}</span>
      <span class="dt">${esc(item.detail || '')}</span>
      ${act}
    </div>`;
  };
  rows.innerHTML = ['cli', 'auth', 'base', 'mediaDir'].map((k) => row(k, r[k])).join('');
  rows.onclick = async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'install') {
      b.textContent = '安装中…'; b.disabled = true;
      try {
        const r2 = await window.api.envInstallCli();
        setEnvMsg(r2.ok ? '安装完成，正在重新检查…' : '安装失败：' + r2.detail.slice(-160) + '。可点下方「复制给 AI 助手排查」，发给你电脑上的 AI 编程助手处理。', r2.ok ? 'ok' : 'err');
      } catch (e2) {
        setEnvMsg('安装出错：' + String(e2.message || e2).slice(0, 140) + '。可点「复制给 AI 助手排查」。', 'err');
      }
      runEnvCheck();
    } else if (act === 'login') {
      try {
        const r2 = await window.api.envLogin();
        setEnvMsg(r2.detail + (r2.ok ? '' : '（若反复失败，点下方「复制给 AI 助手排查」）'), r2.ok ? 'ok' : 'err');
      } catch (e2) {
        setEnvMsg('发起登录失败：' + String(e2.message || e2).slice(0, 140) + '。可点「复制给 AI 助手排查」。', 'err');
      }
    } else if (act === 'config') {
      $('#envDlg').classList.add('hidden');
      $$('.nav').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'source'));
      $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-source'));
      $('#baseUrl').focus();
    }
  };
  return r;
}

// 自动配置期间的状态提示不走 flash（4 秒自动清空会打断下载进度显示）
function setEnvMsg(text, cls) {
  const el = $('#envMsg');
  el.textContent = text;
  el.className = 'msg ' + (cls || '');
}

// 一键自动配置：装 lark-cli → 引导飞书登录 → 引导粘贴多维表链接
let autoSetupRunning = false;
async function runAutoSetup() {
  if (autoSetupRunning) return;
  autoSetupRunning = true;
  const btn = $('#btnEnvAuto');
  btn.disabled = true;
  try {
    setEnvMsg('正在检查环境…');
    let r = await runEnvCheck();

    // 1) lark-cli 缺失 → 便携安装（免 Node/npm，下载官方单文件 exe）
    if (!r.cli.ok) {
      setEnvMsg('开始自动安装 lark-cli…');
      const ir = await window.api.envInstallCli();
      if (!ir.ok) {
        setEnvMsg('自动安装失败：' + ir.detail.slice(-160) + '。可检查网络后重试。', 'err');
        return;
      }
      r = await runEnvCheck();
      if (!r.cli.ok) { setEnvMsg('安装后仍未检测到 lark-cli，请点「重新检查」或重启应用。', 'err'); return; }
    }

    // 2) 未登录飞书 → 自动打开浏览器授权页（授权动作只能用户本人完成；
    //    完成后主进程会通过 env:loginDone 通知这里自动确认，无需手动重新检查）
    if (!r.auth.ok) {
      const lr = await window.api.envLogin();
      setEnvMsg(
        lr.ok ? '已在浏览器打开飞书授权页，完成授权后会自动确认…'
              : lr.detail + '。可点「复制给 AI 助手排查」，发给你电脑上的 AI 编程助手处理。',
        lr.ok ? 'ok' : 'err'
      );
      return;
    }

    // 3) 未配置多维表 → 跳到数据源页让用户粘贴自己的链接（数据只有用户自己有）
    if (!r.base.ok) {
      $('#envDlg').classList.add('hidden');
      $$('.nav').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'source'));
      $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-source'));
      $('#baseUrl').focus();
      flash($('#testMsg'), '最后一步：粘贴你的多维表链接 → 点「解析」→「立即同步」', 'ok');
      return;
    }

    setEnvMsg('环境已就绪，可以使用了。', 'ok');
  } catch (e) {
    // 任何意外都不能静默吞掉——用户对着没反应的按钮是最差的体验
    setEnvMsg('自动配置出错：' + String(e.message || e).slice(0, 140) + '。可点「复制给 AI 助手排查」。', 'err');
  } finally {
    autoSetupRunning = false;
    btn.disabled = false;
  }
}

// ---------------- 弹窗 ----------------
function openDlg(kind, item) {
  editing = { kind, id: item ? item.id : null };
  $('#dlgTitle').textContent = item ? '编辑' : kind === 'phrase' ? '新建常用句' : '新建本地提示词';
  $('#fTitle').value = item ? item.title || item.name || '' : '';
  $('#fTags').value = item ? (item.tags || []).join(', ') : '';
  $('#fContent').value = item ? item.content || '' : '';
  $('#fPinned').checked = item ? !!item.pinned : false;
  $('#btnDel').classList.toggle('hidden', !item);
  $('#dlg').classList.remove('hidden');
}
function closeDlg() { $('#dlg').classList.add('hidden'); editing = null; }

// ---------------- 外观 ----------------
function renderLook() {
  const a = cfg.appearance, p = cfg.panel, b = cfg.behavior;
  $('#theme').value = a.theme;
  $('#accent').value = a.accent || '#4f7cff';
  $('#edge').value = p.edge;
  $('#width').value = p.width; $('#widthVal').textContent = p.width + ' px';
  $('#previewLines').value = String(a.previewLines || 2);
  $('#collapseMs').value = p.autoCollapseMs; $('#collapseVal').textContent = p.autoCollapseMs + ' ms';
  $('#cardImage').checked = !!a.cardImage;
  $('#copyToast').checked = b.copyToast !== false;
  $('#mediaPersist').checked = b.mediaPersist !== false;
  $('#mediaDir').value = (cfg.storage && cfg.storage.mediaDir) || '';
  $('#launchAtLogin').checked = !!b.launchAtLogin;
}

// ---------------- 绑定 ----------------
function bind() {
  $$('.nav').forEach((n) => n.addEventListener('click', () => {
    $$('.nav').forEach((x) => x.classList.toggle('on', x === n));
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + n.dataset.tab));
  }));

  $('#btnParse').addEventListener('click', () => {
    const u = $('#baseUrl').value.trim();
    const m = u.match(/\/base\/([A-Za-z0-9]+)/);
    if (!m) return flash($('#testMsg'), '链接格式不正确', 'err');
    cfg.baseToken = m[1]; cfg.baseUrl = u;
    window.api.setConfig({ baseToken: m[1], baseUrl: u });
    tables = [];
    window.api.listTables().then((t) => { tables = t || []; renderSource(); flash($('#testMsg'), `解析成功，共 ${tables.length} 张表`, 'ok'); }).catch((e) => flash($('#testMsg'), e.message, 'err'));
  });

  $('#larkCliPath').addEventListener('change', (e) => { cfg.larkCliPath = e.target.value; window.api.setConfig({ larkCliPath: e.target.value }); });
  $('#identity').addEventListener('change', (e) => { cfg.identity = e.target.value; window.api.setConfig({ identity: e.target.value }); });

  $('#btnTest').addEventListener('click', async () => {
    flash($('#testMsg'), '连接中…', '');
    try {
      const t = await window.api.listTables();
      tables = t || [];
      renderSource();
      flash($('#testMsg'), `连接成功，共 ${tables.length} 张表`, 'ok');
    } catch (e) { flash($('#testMsg'), '失败: ' + e.message, 'err'); }
  });

  $('#btnAddSrc').addEventListener('click', () => {
    cfg.sources.push({ id: 'src_' + Date.now().toString(36), kind: 'prompt', name: '新数据表', tableId: '', enabled: true, mapping: {}, downloadImages: false });
    window.api.setConfig({ sources: cfg.sources });
    renderSource();
  });

  $('#autoMinutes').addEventListener('change', (e) => { cfg.sync.autoMinutes = +e.target.value; window.api.setConfig({ sync: { autoMinutes: +e.target.value } }); });
  $('#btnSync').addEventListener('click', async () => {
    flash($('#syncMsg'), '同步中…', '');
    const r = await window.api.syncNow();
    flash($('#syncMsg'), r.ok ? '同步完成' : '同步出错: ' + (r.errors || []).join('; '), r.ok ? 'ok' : 'err');
  });

  $('#pSearch').addEventListener('input', (e) => { pQuery = e.target.value; renderPrompts(); });
  $('#btnAddPrompt').addEventListener('click', () => openDlg('prompt', null));
  $('#btnAddPhrase').addEventListener('click', () => openDlg('phrase', null));
  bindRows($('#promptList'), 'prompt');
  bindRows($('#phraseList'), 'phrase');

  $('#btnCancel').addEventListener('click', closeDlg);
  $('#btnDel').addEventListener('click', async () => { if (editing) { await window.api.deleteLocal(editing.id); closeDlg(); } });
  $('#btnSave').addEventListener('click', async () => {
    if (!editing) return;
    if (!$('#fTitle').value.trim() && !$('#fContent').value.trim()) return; // 拒绝空条目
    await window.api.saveLocal({
      id: editing.id, kind: editing.kind,
      title: $('#fTitle').value, tags: $('#fTags').value,
      content: $('#fContent').value, pinned: $('#fPinned').checked,
    });
    closeDlg();
  });

  // 外观
  const look = (patch) => window.api.setConfig(patch);
  $('#theme').addEventListener('change', (e) => look({ appearance: { ...cfg.appearance, theme: e.target.value } }));
  $('#accent').addEventListener('input', (e) => look({ appearance: { ...cfg.appearance, accent: e.target.value } }));
  $('#edge').addEventListener('change', (e) => look({ panel: { ...cfg.panel, edge: e.target.value } }));
  $('#width').addEventListener('input', (e) => { $('#widthVal').textContent = e.target.value + ' px'; look({ panel: { ...cfg.panel, width: +e.target.value } }); });
  $('#previewLines').addEventListener('change', (e) => look({ appearance: { ...cfg.appearance, previewLines: +e.target.value } }));
  $('#collapseMs').addEventListener('input', (e) => { $('#collapseVal').textContent = e.target.value + ' ms'; look({ panel: { ...cfg.panel, autoCollapseMs: +e.target.value } }); });
  $('#cardImage').addEventListener('change', (e) => look({ appearance: { ...cfg.appearance, cardImage: e.target.checked } }));
  $('#copyToast').addEventListener('change', (e) => look({ behavior: { ...cfg.behavior, copyToast: e.target.checked } }));
  $('#mediaPersist').addEventListener('change', (e) => look({ behavior: { ...cfg.behavior, mediaPersist: e.target.checked } }));
  $('#btnPickDir').addEventListener('click', async () => {
    const d = await window.api.pickDir();
    if (!d) return;
    cfg.storage = { ...(cfg.storage || {}), mediaDir: d };
    await window.api.setConfig({ storage: cfg.storage });
    $('#mediaDir').value = d;
  });
  $('#mediaDir').addEventListener('change', (e) => {
    cfg.storage = { ...(cfg.storage || {}), mediaDir: e.target.value.trim() };
    window.api.setConfig({ storage: cfg.storage });
  });
  $('#btnClearStats').addEventListener('click', async () => {
    await window.api.clearStats();
  });
  $('#btnClearCache').addEventListener('click', async () => {
    const r = await window.api.clearMediaCache();
    flash($('#cacheMsg'), `已清空 ${r.count} 个缓存文件`, 'ok');
  });
  $('#btnEnv').addEventListener('click', () => {
    $('#envDlg').classList.remove('hidden');
    runEnvCheck();
  });
  $('#btnEnvAuto').addEventListener('click', runAutoSetup);
  $('#btnEnvAgent').addEventListener('click', async () => {
    const btn = $('#btnEnvAgent');
    btn.disabled = true;
    try {
      if (!lastEnvCheck) await runEnvCheck();
      const r = await window.api.copyAgentPrompt(lastEnvCheck);
      setEnvMsg(
        r.ok ? `已复制（${r.len} 字）。打开你电脑上的 AI 编程助手（ZCode / Cursor 等），粘贴发送——它会按你机器的实际缺失自动修复环境并引导你登录。`
             : '复制失败，请重试',
        r.ok ? 'ok' : 'err'
      );
    } catch (e) {
      setEnvMsg('生成失败：' + String(e.message || e).slice(0, 120), 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('#btnGuideDoc').addEventListener('click', () => {
    window.api.openExternal('https://zk5ckzju3h.feishu.cn/docx/BIxhdJC0GoOvr3xHtDlcztIqnRd?from=from_copylink');
  });
  $('#btnEnvClose').addEventListener('click', () => $('#envDlg').classList.add('hidden'));
  $('#btnEnvRe').addEventListener('click', () => runEnvCheck());
  $('#launchAtLogin').addEventListener('change', (e) => look({ behavior: { ...cfg.behavior, launchAtLogin: e.target.checked } }));

  window.api.on('data:updated', (p) => { view = p.view; meta = p.meta; renderPrompts(); renderPhrases(); renderSyncInfo(); });
  window.api.on('env:setupProgress', (p) => setEnvMsg(p.msg || ''));
  window.api.on('env:loginDone', async (p) => {
    if (p.ok) {
      setEnvMsg('授权完成，正在确认登录态…', 'ok');
      await runEnvCheck();
      setEnvMsg('飞书登录成功。', 'ok');
    } else {
      setEnvMsg('登录未完成：' + (p.detail || '已取消或超时，可重新点击去登录'), 'err');
    }
  });
  window.api.on('stats:updated', async () => {
    const d = await window.api.getData();
    view = d.view; meta = d.meta;
    renderPrompts(); renderPhrases(); renderSyncInfo();
  });
  window.api.on('sync:state', (p) => { meta.syncing = p.syncing; if (p.syncing) flash($('#syncMsg'), '同步中…', ''); });
}

window.addEventListener('unhandledrejection', (e) => console.error('[settings] UNHANDLED:', e.reason));
window.addEventListener('DOMContentLoaded', async () => { bind(); await loadAll(); });
