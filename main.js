'use strict';
// 主进程：托盘、右侧吸附面板窗口、设置窗口、飞书同步、IPC。
const { app, BrowserWindow, Tray, Menu, MenuItem, ipcMain, clipboard, screen, shell, nativeImage, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { Store } = require('./lib/store');
const feishu = require('./lib/feishu');

let store;
let tray = null;
let panelWin = null;
let settingsWin = null;
let syncTimer = null;
let syncing = false;
let panelExpanded = false;
let panelSticky = false; // 托盘左键打开时为“固定展开”，不随鼠标离开收回
let ctrlHover = false; // panel:ctrlHover 上报的 Ctrl 悬停状态（当前仅记录未消费；需先声明，strict 模式下直接赋值会抛错）
const procStartedAt = Date.now(); // 进程启动时刻：second-instance 据此区分“重复自启项”与“用户手动再开”

const isDev = !app.isPackaged;

// 开发预览模式（PREVIEW_SETTINGS=1 npm start）：用户数据改用独立目录，
// 与正式安装版互不干扰（单实例锁也按该目录区分，可与正式版并存）
if (process.env.PREVIEW_SETTINGS) {
  app.setPath('userData', path.join(app.getPath('appData'), 'prompt-assistant-preview'));
}

// 日志上限：超过就滚成 app.log.1，避免长期运行把日志写成一个巨大的文件。
// 记录累计大小比每次 statSync 便宜；进程重启后重新按实际文件大小初始化。
const LOG_MAX = 2 * 1024 * 1024;
let logBytes = null;
function logPath() { return path.join(app.getPath('userData'), 'app.log'); }
function rotateLogIfNeeded() {
  if (logBytes === null) {
    try { logBytes = fs.statSync(logPath()).size; } catch { logBytes = 0; }
  }
  if (logBytes <= LOG_MAX) return;
  try {
    fs.rmSync(logPath() + '.1', { force: true });
    fs.renameSync(logPath(), logPath() + '.1');
  } catch {}
  logBytes = 0;
}
function log(...a) {
  const line = '[prompt-assistant] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  // 日志写入用户数据目录（AppData），安装目录不留任何个人痕迹
  try {
    rotateLogIfNeeded();
    const text = new Date().toISOString() + ' ' + line + '\n';
    fs.appendFileSync(logPath(), text);
    logBytes += Buffer.byteLength(text);
  } catch {}
}

// ---------------- 面板窗口 ----------------
function panelBounds() {
  const cfg = store.config.panel;
  const wa = screen.getPrimaryDisplay().workArea;
  if (cfg.edge === 'top') {
    const w = Math.min(cfg.width + 140, wa.width);
    return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y, width: w, height: Math.round(wa.height * 0.86) };
  }
  return { x: wa.x + wa.width - cfg.width, y: wa.y, width: cfg.width, height: wa.height };
}

let panelEdgeCreated = null;
function createPanel() {
  panelEdgeCreated = store.config.panel.edge;
  panelWin = new BrowserWindow({
    ...panelBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver'); // 高于普通置顶窗口
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWin.loadFile(path.join(__dirname, 'src', 'panel.html'));
  panelWin.on('closed', () => (panelWin = null));
  // 收起态窗口缩为把手大小（真实接收鼠标事件）；展开/拖动态为面板全尺寸
  panelWin.once('ready-to-show', () => {
    panelWin.showInactive();
    setWinMode(panelExpanded ? 'expanded' : 'collapsed');
    setTimeout(() => {
      try {
        const pt = screen.getCursorScreenPoint();
        const hr = handleRect();
        if (pt.x >= hr.x && pt.x < hr.x + hr.width && pt.y >= hr.y && pt.y < hr.y + hr.height) {
          sendPanel('panel:handle-enter');
        }
      } catch {}
    }, 600);
  });
}

// ---------------- 窗口模式：无穿透架构 ----------------
// collapsed: 窗口=把手大小（天然不遮挡，真实鼠标事件）
// dragging:  窗口=全列（跟踪拖动），面板滑出态不接收点击
// expanded:  窗口=全列，面板滑入
// 全程不使用 setIgnoreMouseEvents（Windows 下其反向调用不可靠）
let panelMode = 'collapsed';
let handleDragging = false;
let dragFrac = null;
function setWinMode(m, force) {
  if (panelMode === m && !force) return;
  log('setWinMode', m, force ? '(forced)' : '');
  panelMode = m;
  if (!panelWin || panelWin.isDestroyed()) return;
  panelWin.setBounds(m === 'collapsed' ? handleRect() : panelBounds());
}

function sendPanel(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(channel, payload);
}

function setPanelInteractive(_on) { /* 不再需要 */ }

function repositionPanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  setWinMode(panelMode === 'expanded' || panelMode === 'dragging' ? panelMode : 'collapsed');
  sendPanel('panel:layout', { edge: store.config.panel.edge });
}

function recreatePanelWindow() {
  panelExpanded = false;
  panelSticky = false;
  handleDragging = false;
  if (panelWin && !panelWin.isDestroyed()) panelWin.destroy();
  panelWin = null;
  createPanel();
}

let collapseTimer = null;
function expandPanel(sticky) {
  if (!panelWin || panelWin.isDestroyed()) createPanel();
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  panelSticky = !!sticky;
  panelExpanded = true;
  setWinMode('expanded');
  sendPanel('panel:expand', { sticky: panelSticky });
  if (panelWin) panelWin.showInactive();
}

function collapsePanel() {
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  panelSticky = false;
  panelExpanded = false;
  sendPanel('panel:collapse', {}); // 渲染进程开始滑出（.22s）
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (panelExpanded || handleDragging) return;
    setWinMode('collapsed'); // 滑出完成后缩窗
    sendPanel('panel:handle-on');
  }, 240);
}

function togglePanel() {
  if (panelExpanded && panelSticky) collapsePanel();
  else expandPanel(true);
}

function handleRect() {
  const wa = screen.getPrimaryDisplay().workArea;
  const cfg = store.config.panel;
  const pos = cfg.handlePos || {};
  if (cfg.edge === 'top') {
    const f = typeof pos.top === 'number' ? pos.top : 0.5;
    const b = panelBounds();
    return { x: b.x + Math.round(b.width * f) - 42, y: wa.y, width: 84, height: 24 };
  }
  const f = typeof pos.right === 'number' ? pos.right : 0.5;
  return { x: wa.x + wa.width - 24, y: wa.y + Math.round(wa.height * f) - 42, width: 24, height: 84 };
}

// ---------------- 托盘 ----------------
function buildTrayMenu() {
  const menu = new Menu();
  const { prompts, phrases } = store.getTrayItems();

  menu.append(new MenuItem({ label: panelExpanded ? '收起面板' : '打开面板', click: () => togglePanel() }));
  menu.append(new MenuItem({ label: '设置…', click: () => openSettings() }));
  menu.append(new MenuItem({ label: '立即同步', enabled: !syncing, click: () => { syncAll().catch(() => {}); } }));
  menu.append(new MenuItem({ type: 'separator' }));

  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // 常用句（平铺，短文本）
  if (phrases.length) {
    const sub = new Menu();
    for (const p of phrases) {
      sub.append(new MenuItem({ label: trunc(p.name || p.title || '常用句', 22), click: () => copyText(p.content, p.name, p.id) }));
    }
    menu.append(new MenuItem({ label: `常用句 (${phrases.length})`, submenu: sub }));
  }

  // 提示词：条目少时平铺，多时按标签分组，控制菜单密度
  if (prompts.length) {
    if (prompts.length <= 9) {
      for (const p of prompts) {
        menu.append(new MenuItem({ label: trunc(p.title, 22), click: () => copyText(p.content, p.title, p.id) }));
      }
    } else {
      const groups = new Map();
      for (const p of prompts) {
        const key = (p.tags && p.tags[0]) || '未分类';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      for (const [tag, list] of groups) {
        const sub = new Menu();
        for (const p of list) sub.append(new MenuItem({ label: trunc(p.title, 20), click: () => copyText(p.content, p.title, p.id) }));
        menu.append(new MenuItem({ label: `${tag} (${list.length})`, submenu: sub }));
      }
    }
  }

  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: '退出', click: () => app.quit() }));
  return menu;
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(`提示词助手 v${app.getVersion()}`);
  tray.on('click', (e) => {
    log('tray click button=', e.button);
    // 左键：打开/收起面板（Windows 下部分版本 button 为 undefined，仅排除右键）
    if (e.button === 2) return;
    togglePanel();
  });
  tray.on('right-click', () => {
    if (tray) tray.popUpContextMenu(buildTrayMenu());
  });
  tray.on('mouse-move', () => {}); // keep event loop warm on some platforms
}

function refreshTray() {
  if (tray) tray.setContextMenu(null); // 使用动态 popUp，避免静态菜单抢占右键事件
}

// ---------------- 设置窗口 ----------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 760,
    minHeight: 520,
    title: '提示词助手 · 设置',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'src', 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

// ---------------- 复制 ----------------
function copyText(text, label, id) {
  clipboard.writeText(String(text == null ? '' : text));
  if (id) {
    // 复制统计：只推增量。
    // 这里以前还调了 broadcastData()，等于把整表重新下发、渲染进程整列表重渲染，
    // 结果就是每点一下复制，列表滚动位置被重置回顶部。
    store.recordCopy(id);
    const payload = { id, count: store.copyCountOf(id) };
    sendPanel('stats:updated', payload);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('stats:updated', payload);
  }
  if (store.config.behavior.copyToast !== false) {
    sendPanel('panel:toast', { text: `已复制：${(label || '').slice(0, 18) || '内容'}` });
  }
  return true;
}

// 开机自启：路径/参数必须自带引号（Electron 写注册表不加引号，含空格路径会被截断导致开机启动失败）
function applyLoginItem() {
  // 开发模式绝不碰注册表自启：dev 写的是 node_modules 里的 electron.exe（值名 electron.app.Electron），
  // 与安装版条目（electron.app.提示词助手）并存时开机起两个实例——单实例锁按 userData 区分，
  // 拦不住不同形态，两个把手叠在屏幕边缘互相“复活”面板，表现成永远关不掉。
  if (isDev) return;
  const on = !!(store.config.behavior && store.config.behavior.launchAtLogin);
  const q = (p) => `"${p}"`;
  app.setLoginItemSettings({
    openAtLogin: on,
    path: q(process.execPath),
    args: [],
  });
  cleanupDuplicateLoginItems();
}

// 清理历史 dev 调试留下的自启残留（值名固定，指向 node_modules 里的 electron.exe）。
// 逐值名校验数据指向本项目的 dev 形态后才删，避免误伤其他 Electron 应用的同名条目。
function cleanupDuplicateLoginItems() {
  if (process.platform !== 'win32') return;
  const { execFile } = require('child_process');
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  for (const name of ['electron.app.Electron', 'electron.app.prompt-assistant']) {
    const read = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty -Path '${RUN_KEY}' -Name '${name}' -ErrorAction SilentlyContinue).'${name}'`;
    execFile('powershell.exe', ['-NoProfile', '-Command', read], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      const data = String(stdout || '').trim();
      if (err || !data) return; // 条目不存在
      if (!/node_modules/i.test(data) || !/提示词助手|prompt-assistant/i.test(data)) return; // 不是本项目的 dev 残留
      log('remove stale dev login item:', name, '=>', data.slice(0, 140));
      execFile('powershell.exe', ['-NoProfile', '-Command', `Remove-ItemProperty -Path '${RUN_KEY}' -Name '${name}' -Force`], { windowsHide: true, timeout: 15000 }, () => {});
    });
  }
}

// ---------------- 同步 ----------------
// ---------------- 同步结果合并 ----------------
// 把「本轮各源的新结果」与「上一轮缓存」合并，返回最终要落盘的 prompts / phrases。
// 规则：
//   · 本轮成功的源  → 用新数据（即使新数据是 0 条，也尊重这个事实）
//   · 本轮失败的源  → 沿用上一轮旧数据，绝不能被空数组覆盖
//   · 未启用 / 已从配置移除的源 → 不再收录
// prompts 的 sourceId 可靠（mapRecord 写入，且 id 前缀就是源 id，可兜底）。
function prevSourceIdOf(item) {
  if (item && item.sourceId) return item.sourceId;
  const m = /^([^:]+):/.exec(String((item && item.id) || ''));
  return m ? m[1] : '';
}
// 参数全部显式传入，不读闭包：这段合并逻辑要能脱离 syncAll 单独验证。
function mergeSyncResult({ sources, syncedSourceIds, prevPrompts, prevPhrases, freshFor }) {
  const okPrompts = [];
  const okPhrases = [];
  for (const src of sources || []) {
    if (!src.enabled || !syncedSourceIds.has(src.id)) continue; // 本轮失败的源在这里被跳过
    const fresh = freshFor(src);
    if (src.kind === 'phrase') okPhrases.push(...fresh);
    else okPrompts.push(...fresh);
  }

  // 两套缓存用同一条规则：本轮成功的源换成新数据，失败的源沿用旧数据。
  // 归属优先看 sourceId，老数据没有就退回 id 前缀（id 形如 `${sourceId}:${recordId}`）。
  // 归属不明的条目一律保留 —— 宁可多留一条，也不误删用户的数据。
  const staleOf = (prevList) => prevList.filter((it) => {
    const sid = prevSourceIdOf(it);
    if (!sid) return true;
    const cfgSrc = (sources || []).find((s) => s.id === sid);
    if (!cfgSrc || !cfgSrc.enabled) return false; // 源已移除或停用
    return !syncedSourceIds.has(sid);             // 只保留本轮失败的源
  });

  return {
    prompts: [...okPrompts, ...staleOf(prevPrompts)],
    phrases: [...okPhrases, ...staleOf(prevPhrases)],
    carriedOver: staleOf(prevPrompts).length + staleOf(prevPhrases).length,
  };
}

async function syncAll() {
  if (syncing) return { ok: false, error: '正在同步中' };
  log('syncAll start, sources =', (store.config.sources || []).length);
  syncing = true;
  notifySyncState();
  const cfg = store.config;
  const errors = [];
  const prevPrompts = store.cache.prompts || [];
  const prevPhrases = store.cache.phrases || [];
  // 本轮成功同步的源 id 集合：mergeSyncResult 据此决定哪些源沿用旧数据
  const syncedSourceIds = new Set();
  try {
    const prompts = [];
    const phrases = [];
    if (!cfg.baseToken) throw new Error('尚未配置多维表：设置 → 数据源 → 粘贴多维表链接并解析');
    const tables = await feishu.listTables(cfg);
    store.cache.tables = tables;
    // 按表名自动接入数据源（表名含「提示词」），不内置任何个人表 ID；用户手动移除过的不再加回
    const removed = new Set(cfg.removedTableIds || []);
    const have = new Set((cfg.sources || []).map((s) => s.tableId));
    let addedSrc = false;
    for (const t of tables) {
      if (/提示词/.test(t.name) && !have.has(t.id) && !removed.has(t.id)) {
        cfg.sources.push({ id: 'src_' + t.id, kind: 'prompt', name: t.name, tableId: t.id, enabled: true, mapping: {}, downloadImages: false });
        have.add(t.id);
        addedSrc = true;
      }
    }
    if (addedSrc) {
      store.saveConfig();
      log('auto-added sources by table name:', cfg.sources.length);
    }
    for (const src of cfg.sources || []) {
      if (!src.enabled) continue;
      try {
        const items = await feishu.syncSource(cfg, src, mediaBaseDir(), () => {});
        log('sync source', src.name, '->', items.length, 'items');
        // 磁盘已有的媒体直接挂本地路径：重启后首屏即显，不必重新解析
        for (const it of items) {
          for (const [role, key] of [['img', 'image'], ['vid', 'video']]) {
            const m = it[key];
            if (m && m.fileToken && !m.localPath) {
              const ext = path.extname(m.name || '') || (role === 'vid' ? '.mp4' : '.png');
              const f = resolveMediaFile(`${it.tableId}_${it.recordId}_${role}${ext}`);
              if (f && fs.statSync(f).size > 0) m.localPath = f;
            }
          }
        }
        if (src.kind === 'phrase') {
          // 带上 sourceId：合并时要能逐条归属到源，否则 phrase 源一失败就无从区分
          for (const it of items) phrases.push({ id: it.id, sourceId: prevSourceIdOf(it), name: it.title, content: it.content || it.title, origin: 'feishu' });
        } else {
          prompts.push(...items);
        }
        syncedSourceIds.add(src.id); // 只有真正跑完的源才记成功
      } catch (e) {
        log('sync source FAILED', src.name, ':', e.message);
        errors.push(`${src.name}: ${e.message}`);
      }
    }
    // 逐源合并：成功的源用新数据，失败的源沿用上一轮缓存。
    // freshFor 按 src.kind 取对应的新数据数组（上面循环已按 kind 分桶），
    // 再按条目 sourceId 过滤出属于该源的部分。
    const merged = mergeSyncResult({
      sources: cfg.sources,
      syncedSourceIds,
      prevPrompts,
      prevPhrases,
      freshFor: (src) => (src.kind === 'phrase' ? phrases : prompts).filter((p) => prevSourceIdOf(p) === src.id),
    });
    store.cache.prompts = merged.prompts;
    store.cache.phrases = merged.phrases;
    store.cache.lastSyncAt = Date.now();
    store.config.sync.lastSyncAt = Date.now();
    store.config.sync.lastError = errors.join(' | ');
    store.saveCache();
    store.saveConfig();
  } catch (e) {
    store.config.sync.lastError = String(e.message || e);
    store.saveConfig();
    errors.push(String(e.message || e));
  } finally {
    syncing = false;
    notifySyncState();
  }
  broadcastData();
  return { ok: errors.length === 0, errors };
}

function notifySyncState() {
  sendPanel('sync:state', { syncing });
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('sync:state', { syncing });
}

function broadcastData() {
  const view = store.getView();
  const meta = {
    lastSyncAt: store.cache.lastSyncAt,
    lastError: store.config.sync.lastError,
    syncing,
  };
  sendPanel('data:updated', { view, meta });
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('data:updated', { view, meta });
}

function scheduleAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  const m = store.config.sync.autoMinutes || 0;
  if (m > 0) {
    syncTimer = setInterval(() => { syncAll().catch(() => {}); }, m * 60 * 1000);
  }
}

// ---------------- 本地媒体协议（支持 Range，视频可拖动进度） ----------------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
// 媒体文件名白名单：形如 tblXXX_recYYY_img.jpg / ..._vid.mp4。
// resolveMediaFile 内部用 path.basename 已经挡住了目录穿越，但那是副作用、不明显；
// 这里显式拒绝任何含路径分隔符、上跳或特殊字符的请求，把安全边界写死。
const MEDIA_NAME_RE = /^[A-Za-z0-9_\-.]+\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i;
function registerLocalProtocol() {
  protocol.handle('localimg', (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!MEDIA_NAME_RE.test(rel)) return new Response('', { status: 404 });
      const file = resolveMediaFile(rel);
      if (!file) return new Response('', { status: 404 });
      const stat = fs.statSync(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const baseHeaders = { 'X-Content-Type-Options': 'nosniff' };
      const range = req.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (!m || start > end || start >= stat.size) {
          return new Response('', { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` } });
        }
        return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': type,
          },
        });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), {
        headers: { ...baseHeaders, 'Content-Length': String(stat.size), 'Content-Type': type, 'Accept-Ranges': 'bytes' },
      });
    } catch {
      return new Response('', { status: 500 });
    }
  });
}

// ---------------- 媒体按需下载（封面图 / 视频），并发 2 ----------------
// 缓存目录：默认在安装目录 cache/media（不占 C 盘）；可自定义；无痕模式用系统临时目录且退出清空
function mediaTmpDir() {
  return path.join(os.tmpdir(), 'prompt-assistant-media');
}
function defaultMediaDir() {
  if (process.platform === 'win32') {
    // Windows：安装目录\cache\media（exe 所在目录）；打包后 __dirname 在 asar 内不可写
    const base = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    return path.join(base, 'cache', 'media');
  }
  // mac/Linux：.app 包体只读且写入会破坏签名，放应用数据目录
  return path.join(app.getPath('userData'), 'media');
}
function mediaBaseDir() {
  const custom = store && store.config.storage && store.config.storage.mediaDir;
  return custom && custom.trim() ? custom.trim() : defaultMediaDir();
}
function mediaDirs() {
  const dirs = [];
  if (store && store.config.behavior.mediaPersist === false) dirs.push(mediaTmpDir());
  dirs.push(mediaBaseDir());
  if (store) {
    dirs.push(store.imgDir); // 兼容旧缓存位置
    // 渲染进程只按 basename 请求 localimg://，由 resolveMediaFile 在这些目录里找。
    // 历史 localPath 可能落在默认搜索范围之外（开发期写在源码目录 cache/media、
    // 或旧安装目录），不纳入就会 404 裂图——文件明明在，只是不在被搜的目录里。
    for (const it of store.cache.prompts || []) {
      for (const key of ['image', 'video']) {
        const lp = it[key] && it[key].localPath;
        if (lp) dirs.push(path.dirname(lp));
      }
    }
  }
  return Array.from(new Set(dirs));
}
function resolveMediaFile(name) {
  for (const d of mediaDirs()) {
    const f = path.join(d, path.basename(name));
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function ensureMediaDir() {
  const d = store.config.behavior.mediaPersist === false ? mediaTmpDir() : mediaBaseDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const mediaQueue = [];
let mediaActive = 0;
let cacheSaveTimer = null;
// 把“文件已在磁盘”的信息写进 cache.json：重启后无需重新解析/下载，直接秒显
function rememberMediaPath(tableId, recordId, role, localPath) {
  const list = store.cache.prompts || [];
  const it = list.find((x) => x.tableId === tableId && x.recordId === recordId);
  if (!it) return;
  if (role === 'video') { it.video = it.video || {}; it.video.localPath = localPath; }
  else { it.image = it.image || {}; it.image.localPath = localPath; }
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => { cacheSaveTimer = null; try { store.saveCache(); } catch {} }, 1500);
}
function pumpMedia() {
  while (mediaActive < 2 && mediaQueue.length) {
    const job = mediaQueue.shift();
    mediaActive++;
    job.run()
      .then(() => { log('media ok ->', path.basename(job.dest)); rememberMediaPath(job.tableId, job.recordId, job.role, job.dest); job.res({ localPath: job.dest }); })
      .catch((e) => { log('media FAIL', path.basename(job.dest), ':', String(e.message || e).slice(0, 200)); job.res({ error: String(e.message || e) }); })
      .finally(() => { mediaActive--; pumpMedia(); });
  }
}
function ensureMedia({ tableId, recordId, fileToken, name, role }) {
  const ext = path.extname(name || '') || (role === 'video' ? '.mp4' : '.png');
  const fname = `${tableId}_${recordId}_${role === 'video' ? 'vid' : 'img'}${ext}`;
  const existing = resolveMediaFile(fname);
  if (existing && fs.statSync(existing).size > 0) {
    rememberMediaPath(tableId, recordId, role === 'video' ? 'video' : 'image', existing);
    return Promise.resolve({ localPath: existing });
  }
  const dest = path.join(ensureMediaDir(), fname);
  log('media ensure queued:', role, path.basename(dest));
  return new Promise((res) => {
    mediaQueue.push({
      dest,
      tableId,
      recordId,
      role: role === 'video' ? 'video' : 'image',
      res,
      run: () => feishu.downloadAttachment(store.config, { tableId, recordId, fileToken, destPath: dest }),
    });
    pumpMedia();
  });
}

// ---------------- lark-cli 便携安装（免 npm / 免系统 Node） ----------------
// lark-cli 的真身是官方发布的单文件原生程序（npmmirror / GitHub Releases 均有），
// npm 包只是个下载器。因此一键配置直接下载 exe 即可运行，
// 用户的电脑不需要装 Node、不需要 npm，也不依赖 GitHub 连通性（优先走 npmmirror）。
const LARKCLI_MIRROR = 'https://registry.npmmirror.com';
const LARKCLI_FALLBACK_VERSION = '1.0.96';

function cliRuntimeDir() { return path.join(app.getPath('userData'), 'runtime', 'lark-cli'); }

async function latestCliVersion() {
  try {
    const res = await fetch(`${LARKCLI_MIRROR}/@larksuite/cli/latest`);
    const j = await res.json();
    if (j && /^\d+\.\d+\.\d+$/.test(j.version || '')) return j.version;
  } catch {}
  return LARKCLI_FALLBACK_VERSION;
}

function cliArchiveName(ver) {
  const p = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const a = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!p || !a) throw new Error(`当前平台 ${process.platform}/${process.arch} 暂不支持自动安装`);
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `lark-cli-${ver}-${p}-${a}.${ext}`;
}

async function downloadWithProgress(url, dest, onPct) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const out = fs.createWriteStream(dest);
  const streamError = new Promise((_, j) => out.once('error', j));
  let got = 0;
  try {
    // 与写流错误赛跑：磁盘满/权限等错误要能终止等待，否则 promise 悬挂
    await Promise.race([
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
          got += value.length;
          if (total && onPct) onPct(Math.min(99, Math.round((got / total) * 100)));
        }
        await new Promise((r) => out.end(r));
      })(),
      streamError,
    ]);
  } finally {
    out.destroy();
  }
}

async function expectedSha256(binBase, archiveName) {
  try {
    const res = await fetch(`${binBase}/checksums.txt`);
    if (!res.ok) return null;
    const line = (await res.text()).split(/\r?\n/).find((l) => l.includes(archiveName));
    return line ? line.trim().split(/\s+/)[0].replace(/[^a-f0-9]/gi, '') : null;
  } catch { return null; }
}

function extractArchive(archive, destDir) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const done = (err, _so, se) => (err ? reject(new Error(String(se || err.message).slice(0, 200))) : resolve());
    if (process.platform === 'win32') {
      // Win10+ 自带 bsdtar（可直接解 zip）；老系统兜底 PowerShell Expand-Archive
      const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      if (fs.existsSync(tarExe)) return void execFile(tarExe, ['-xf', archive, '-C', destDir], { windowsHide: true, timeout: 120000 }, done);
      return void execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(destDir)} -Force`],
        { windowsHide: true, timeout: 180000 },
        done
      );
    }
    execFile('tar', ['-xf', archive, '-C', destDir], { timeout: 120000 }, done);
  });
}

// 下载 → sha256 校验 → 解压 → 写入 larkCliPath → 验证可执行
async function installCliPortable(onProgress) {
  const say = (pct, msg) => { try { onProgress && onProgress(pct, msg); } catch {} };
  say(0, '查询 lark-cli 最新版本…');
  const ver = await latestCliVersion();
  const archive = cliArchiveName(ver);
  const dir = cliRuntimeDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, archive);
  const sources = [
    `${LARKCLI_MIRROR}/-/binary/lark-cli/v${ver}`,
    `https://github.com/larksuite/cli/releases/download/v${ver}`,
  ];
  let lastErr = null;
  for (const base of sources) {
    try {
      say(1, `下载 lark-cli v${ver}（约 15MB）…`);
      await downloadWithProgress(`${base}/${archive}`, tmp, (pct) => say(pct, `下载 lark-cli v${ver}… ${pct}%`));
      const want = await expectedSha256(base, archive);
      if (want) {
        say(0, '校验文件完整性…');
        const got = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
        if (got !== want.toLowerCase()) throw new Error('下载文件校验不一致，已中止');
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }
  if (lastErr) throw new Error('下载失败：' + String(lastErr.message || lastErr).slice(0, 200));
  say(0, '解压安装…');
  await extractArchive(tmp, dir);
  try { fs.rmSync(tmp, { force: true }); } catch {}
  const exe = path.join(dir, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
  if (!fs.existsSync(exe)) throw new Error('解压后未找到 lark-cli 可执行文件');
  if (process.platform !== 'win32') { try { fs.chmodSync(exe, 0o755); } catch {} }
  say(0, '验证运行…');
  await new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(exe, ['--version'], { windowsHide: true, timeout: 20000 }, (err, _so, se) =>
      err ? reject(new Error(String(se || err.message).slice(0, 200))) : resolve());
  });
  store.updateConfig({ larkCliPath: exe });
  feishu.invalidateCliCache();
  log('lark-cli portable installed:', exe);
  return { ok: true, detail: `已安装 lark-cli v${ver}（免 Node 环境）` };
}

// 生成给本机 AI 助手（ZCode / Cursor 等）的排查指令：
// 一键自动配置覆盖不了的机器（企业网、杀软、权限、损坏的安装…），
// 把机器现状 + 修复步骤 + 登录引导打包成一段话，用户复制发给自己的 agent 即可。
function buildAgentPrompt(check) {
  const cfg = store.config;
  const st = (k) => {
    const it = check && check[k];
    if (!it) return '（未检测）';
    return (it.ok ? '正常' : '异常') + '：' + (it.detail || '');
  };
  let logTail = '（读取不到日志）';
  try {
    logTail = fs.readFileSync(logPath(), 'utf8').split('\n').slice(-25).join('\n').trim() || '（日志为空）';
  } catch {}
  const portableExe = path.join(cliRuntimeDir(), process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
  const cfgFile = path.join(app.getPath('userData'), 'config.json');
  const bt = '`'; // 模板里要输出 markdown 行内代码的反引号
  return (
`你是本机的 AI 运维助手，可以直接执行命令。我在用 Windows 桌面应用「提示词助手」（Electron 托盘工具），
它通过本机的 lark-cli（飞书官方命令行）读取我自己的飞书多维表。现在它的环境自检没过，
请帮我排查修复，并引导我完成飞书登录授权。

【环境自检结果】（应用 v${app.getVersion()}，${os.type()} ${os.release()} ${process.arch}，身份 ${cfg.identity || 'user'}）
- lark-cli：${st('cli')}
- 飞书登录态：${st('auth')}
- 多维表数据源：${st('base')}
- 媒体缓存目录：${st('mediaDir')}

【本机关键路径】
- 应用目录：${app.getAppPath()}
- 用户数据目录：${app.getPath('userData')}（里面有配置 config.json 和日志 app.log）
- 当前 lark-cli 路径配置：${cfg.larkCliPath || '（默认：系统 PATH 里的 lark-cli.cmd）'}

【应用日志尾部（最近 25 行）】
${logTail}

【请按顺序执行，每步失败先把完整报错贴出来分析，不要盲目重试】
1. 诊断 lark-cli：运行 ${bt}lark-cli.cmd auth status${bt}（PATH 里没有就试上面配置的路径）。
   - 输出 JSON 且无报错 → 直接跳到第 4 步。
   - 提示"不是内部或外部命令"/"Failed to auto-install"/输出非 JSON 的错误堆栈 → 未安装或已损坏，走第 2 步。
2. 安装或修复 lark-cli（优先方案 A，免 Node 免 npm）：
   - 方案 A（官方单文件版，国内镜像）：
     先 GET https://registry.npmmirror.com/@larksuite/cli/latest 拿最新版本号 V；
     下载 https://registry.npmmirror.com/-/binary/lark-cli/v{V}/lark-cli-{V}-windows-amd64.zip；
     用同目录 checksums.txt 里的官方 sha256 校验下载文件一致；
     解压出 lark-cli.exe，放到 ${path.dirname(portableExe)} 目录下（不存在就新建）。
   - 方案 B（本机已有 Node/npm 时）：${bt}npm install -g @larksuite/cli${bt}。
3. 验证可用：运行 ${bt}<lark-cli路径> auth status${bt}，能输出 JSON 即修复成功。
4. 登录飞书（device flow，浏览器里需要我本人点授权）：
   a. 运行 ${bt}<lark-cli路径> auth login --no-wait --json --domain base,drive${bt}
   b. 从返回 JSON 的 verification_url 字段拿到授权链接，用 ${bt}start "" "<链接>"${bt} 帮我打开浏览器，提醒我去点授权
   c. 我完成授权后，运行 ${bt}<lark-cli路径> auth login --device-code <a 步返回里的 device_code> --json${bt} 完成登录
   （device_code 十分钟内有效，过期就从 a 重来；本应用用 user 身份登录）
5. 如果走的是方案 A，把 ${cfgFile} 里的 "larkCliPath" 改成 "${portableExe.split('\\').join('\\\\')}"
   （改前先备份原文件；JSON 字符串里的反斜杠要双写）。
6. 收尾：再运行一次 ${bt}<lark-cli路径> auth status${bt}，确认 identities.user.status 是 ready，
   然后告诉我：回到应用 → 设置 → 数据源 → 环境自检 → 点「重新检查」。

【约束】
- 不要删除或修改用户数据目录里的其他文件（cache.json 是我已同步的提示词数据）。
- 不要改应用目录下的任何程序文件。`
  );
}

// ---------------- IPC ----------------
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (ev, ...args) => fn(...args));

  h('data:get', () => ({ view: store.getView(), config: store.config, meta: { lastSyncAt: store.cache.lastSyncAt, lastError: store.config.sync.lastError, syncing, version: app.getVersion() } }));
  h('config:get', () => store.config);
  h('config:set', (patch) => {
    store.updateConfig(patch);
    applyConfigSideEffects(patch);
    return store.config;
  });
  h('sync:now', () => syncAll());
  h('copy:text', (text, label, id) => copyText(text, label, id));
  h('stats:clear', () => { store.clearStats(); broadcastData(); return true; });
  h('dialog:pickDir', async () => {
    const win = settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
    const r = await dialog.showOpenDialog(win, { title: '选择媒体缓存目录', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // ---------------- 环境自检 / 一键安装 ----------------
  h('env:check', async () => {
    const cfg = store.config;
    const out = {
      cli: { ok: false, detail: '检测中…' },
      auth: { ok: false, detail: '检测中…' },
      base: { ok: false, detail: '检测中…' },
      mediaDir: { ok: false, detail: '' },
    };
    // lark-cli + 登录态
    try {
      const st = await feishu.runCli(cfg, ['auth', 'status'], { timeout: 30000 });
      out.cli = { ok: true, detail: 'lark-cli 已安装' };
      const u = st && st.identities && st.identities[cfg.identity || 'user'];
      if (u && u.status === 'ready') out.auth = { ok: true, detail: `已登录：${u.userName || cfg.identity}` };
      else out.auth = { ok: false, detail: '未登录或登录已过期', action: 'login' };
    } catch (e) {
      const msg = String(e.message || e);
      if (/不是内部或外部命令|not recognized|ENOENT|找不到/i.test(msg)) {
        out.cli = { ok: false, detail: '未安装 lark-cli', action: 'install' };
        out.auth = { ok: false, detail: '需先安装 lark-cli' };
      } else if (/Failed to auto-install|输出无法解析|Cannot find module|MODULE_NOT_FOUND|SyntaxError/i.test(msg)) {
        // npm 包装上了但原生二进制缺失/损坏（常见于装的时候 GitHub 下不动）——
        // 此时「去登录」调的也是这个坏 CLI，必须重装而不是引导登录
        out.cli = { ok: false, detail: 'lark-cli 已损坏，需重装：' + msg.slice(0, 60), action: 'install' };
        out.auth = { ok: false, detail: '需先修复 lark-cli' };
      } else {
        out.cli = { ok: true, detail: 'lark-cli 已安装' };
        out.auth = { ok: false, detail: '登录态异常：' + msg.slice(0, 80), action: 'login' };
      }
    }
    // 多维表可达
    if (!cfg.baseToken) {
      out.base = { ok: false, detail: '未配置多维表链接', action: 'config' };
    } else {
      try {
        const ts = await feishu.listTables(cfg);
        out.base = { ok: true, detail: `多维表可读，共 ${ts.length} 张表` };
      } catch (e) {
        out.base = { ok: false, detail: '多维表读取失败：' + String(e.message || e).slice(0, 80) };
      }
    }
    // 缓存目录可写
    try {
      const d = ensureMediaDir();
      const probe = path.join(d, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      out.mediaDir = { ok: true, detail: d };
    } catch (e) {
      out.mediaDir = { ok: false, detail: '缓存目录不可写：' + String(e.message || e).slice(0, 60) };
    }
    return out;
  });

  let installPending = false;
  h('env:installCli', async () => {
    // 弹窗里「一键安装」和「一键自动配置」可能同时被点，两个下载写同一个临时文件会互踩
    if (installPending) return { ok: false, detail: '正在安装中，请勿重复点击' };
    installPending = true;
    try {
      return await installCliPortable((pct, msg) => {
        if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('env:setupProgress', { pct, msg });
      });
    } catch (e) {
      return { ok: false, detail: String(e.message || e).slice(-400) };
    } finally {
      installPending = false;
    }
  });

  // 飞书登录：device flow —— 先 --no-wait 拿授权链接并直接打开浏览器，
  // 再在后台用 --device-code 轮询完成；全程无需终端窗口（旧的 cmd 弹窗方式
  // 因引号二次转义根本起不来，且 lark-cli 新版要求显式指定权限域）
  // pendingLogin 记录进行中的授权：用户关掉授权页后再次点击时，
  // 设备码 10 分钟内仍有效，直接重开同一链接即可，不会卡死在“授权进行中”。
  let pendingLogin = null; // { id, url, startedAt }
  h('env:login', async () => {
    const cfg = store.config;
    if (pendingLogin && Date.now() - pendingLogin.startedAt < 9 * 60 * 1000) {
      shell.openExternal(pendingLogin.url);
      return { ok: true, detail: '授权链接 10 分钟内有效，已重新打开授权页，完成授权后会自动确认' };
    }
    pendingLogin = null; // 上次流程已过期，旧轮询返回时凭 id 忽略
    let d;
    try {
      d = await feishu.runCli(cfg, ['auth', 'login', '--no-wait', '--json', '--domain', 'base,drive'], { timeout: 30000 });
    } catch (e) {
      return { ok: false, detail: '发起登录失败：' + String(e.message || e).slice(0, 200) };
    }
    if (!d || !d.verification_url) return { ok: false, detail: '未拿到授权链接：' + JSON.stringify(d).slice(0, 160) };
    const myId = Date.now();
    pendingLogin = { id: myId, url: d.verification_url, startedAt: myId };
    shell.openExternal(d.verification_url);
    if (d.device_code) {
      feishu.runCli(cfg, ['auth', 'login', '--device-code', d.device_code, '--json'], { timeout: 620000 })
        .then(() => {
          // 成功即登录态已写入，无论哪个流程完成的都通知（用户可能在旧页面上完成了授权）
          pendingLogin = null;
          if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('env:loginDone', { ok: true });
        })
        .catch((e) => {
          // 失败只在仍是当前流程时才通知：旧流程过期返回时，用户可能正在新流程的授权页上，
          // 此时弹“登录未完成”是误报
          if (pendingLogin && pendingLogin.id === myId) {
            pendingLogin = null;
            if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('env:loginDone', { ok: false, detail: String(e.message || e).slice(0, 160) });
          }
        });
    }
    return { ok: true, detail: '已在浏览器打开飞书授权页，完成授权后会自动确认' };
  });

  h('env:agentPrompt', (checkResult) => {
    const text = buildAgentPrompt(checkResult);
    clipboard.writeText(text);
    log('agent prompt copied, length:', text.length);
    return { ok: true, len: text.length };
  });

  h('cache:clearMedia', () => {
    let n = 0;
    for (const d of new Set([mediaBaseDir(), store.imgDir])) {
      try {
        for (const f of fs.readdirSync(d)) {
          if (f === '.write-test') continue;
          fs.rmSync(path.join(d, f), { recursive: true, force: true });
          n++;
        }
      } catch {}
    }
    // 同步清掉 cache.json 里的 localPath 引用并广播：否则卡片仍按旧路径渲染，
    // 裂图且因 data-loaded 标记不再触发懒加载，要到下次同步才自愈
    let stripped = false;
    for (const it of store.cache.prompts || []) {
      if (it.image && it.image.localPath) { delete it.image.localPath; stripped = true; }
      if (it.video && it.video.localPath) { delete it.video.localPath; stripped = true; }
    }
    if (stripped) { try { store.saveCache(); } catch {} }
    broadcastData();
    return { ok: true, count: n };
  });
  h('pin:toggle', (id) => { const r = store.togglePin(id); broadcastData(); return r; });
  h('local:save', (item) => { const r = store.upsertLocal(item); broadcastData(); return r; });
  h('local:delete', (id) => { store.deleteLocal(id); broadcastData(); return true; });
  h('panel:interactive', (on) => setPanelInteractive(!!on));
  h('panel:state', (st) => {
    // 兼容恢复场景：路由到统一入口
    if (st && st.expanded) expandPanel(!!st.sticky);
    else collapsePanel();
  });
  h('panel:getstate', () => ({ expanded: panelExpanded, sticky: panelSticky }));
  h('panel:setHandlePos', (p) => {
    store.updateConfig({ panel: { handlePos: { ...(store.config.panel.handlePos || {}), ...(p || {}) } } });
    if (!panelExpanded && !handleDragging) setWinMode('collapsed');
    const pos = store.config.panel.handlePos || {};
    sendPanel('panel:handle-pos', { frac: typeof pos.right === 'number' ? pos.right : (typeof pos.top === 'number' ? pos.top : 0.5) });
    return store.config.panel.handlePos;
  });
  h('panel:requestExpand', (sticky) => { expandPanel(!!sticky); return true; });
  h('panel:requestCollapse', () => { collapsePanel(); return true; });
  h('panel:dragging', (on) => {
    handleDragging = !!on;
    if (on) {
      setWinMode('dragging');
      sendPanel('panel:drag-on');
    }
    return true;
  });
  h('panel:dragMove', (x, y) => {
    const wa = screen.getPrimaryDisplay().workArea;
    const cfgp = store.config.panel;
    const f = cfgp.edge === 'top' ? (x - wa.x) / wa.width : (y - wa.y) / wa.height;
    dragFrac = Math.min(0.94, Math.max(0.06, f));
    sendPanel('panel:drag-pos', { frac: dragFrac });
    return true;
  });
  h('panel:dragEnd', (moved) => {
    handleDragging = false;
    const key = store.config.panel.edge === 'top' ? 'top' : 'right';
    if (moved && dragFrac != null) {
      store.updateConfig({ panel: { handlePos: { ...(store.config.panel.handlePos || {}), [key]: dragFrac } } });
    }
    dragFrac = null;
    // 拖拽结束：强制回到收起态 + 通知渲染进程重置视觉，杜绝把手缺块/残留态
    panelExpanded = false;
    panelSticky = false;
    setWinMode('collapsed', true);
    sendPanel('panel:force-collapsed');
    return true;
  });
  h('panel:ctrlHover', (on) => { ctrlHover = !!on; return true; });
  h('settings:open', () => openSettings());
  h('app:quit', () => app.quit());
  h('shell:open', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  h('media:ensure', (req) => ensureMedia(req || {}));
  h('feishu:tables', () => feishu.listTables(store.config));
  h('feishu:fields', (tableId) => feishu.listFields(store.config, tableId));
  h('feishu:guess', (tableId) => feishu.listFields(store.config, tableId).then((f) => feishu.guessMapping(f)));
}

function applyConfigSideEffects(patch) {
  if (patch.larkCliPath !== undefined || patch.identity !== undefined) {
    feishu.invalidateCliCache(); // 路径/身份变了，重解析，不必重启
  }
  if (patch.panel) {
    if (patch.panel.edge !== undefined && patch.panel.edge !== panelEdgeCreated) recreatePanelWindow();
    else repositionPanel();
  }
  if (patch.sync && patch.sync.autoMinutes !== undefined) scheduleAutoSync();
  if (patch.behavior && patch.behavior.launchAtLogin !== undefined) applyLoginItem();
  if (patch.appearance) {
    sendPanel('appearance:updated', store.config.appearance);
  }
  broadcastData();
}

// ---------------- 启动 ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 启动初期收到的 second-instance 多半是重复的开机自启项（注册表 + 启动文件夹双写、
    // 历史残留），此时唤出面板 = 开机自弹，正是用户投诉的“开机就弹出来”。
    // 20s 窗口期过后才按“用户手动双击图标想唤出面板”处理。
    if (Date.now() - procStartedAt < 20000) {
      log('second-instance ignored (startup window) — 请检查是否存在重复的开机自启项');
      return;
    }
    togglePanel();
  });
  app.whenReady().then(async () => {
    log('app start, version', app.getVersion(), ', pid', process.pid, ', exe', process.execPath);
    store = new Store(app.getPath('userData'));
    registerLocalProtocol();
    registerIpc();
    feishu.probeSystemNode(); // 预热：后续 lark-cli 子进程优先用系统 node，避免任何弹窗
    // 启动预解析：磁盘已有媒体直接挂本地路径（修复重启后图片需重新加载）
    try {
      let n = 0, stale = 0;
      for (const it of (store.cache.prompts || [])) {
        for (const [role, key] of [['img', 'image'], ['vid', 'video']]) {
          const m = it[key];
          if (!m) continue;
          // localPath 已失效（清空媒体缓存 / 无痕模式退出时清空临时目录）：
          // 置空走按需重下，否则裂图会跨重启存活到下次同步
          if (m.localPath && !fs.existsSync(m.localPath)) { delete m.localPath; stale++; }
          if (m.fileToken && !m.localPath) {
            const ext = path.extname(m.name || '') || (role === 'vid' ? '.mp4' : '.png');
            const f = resolveMediaFile(`${it.tableId}_${it.recordId}_${role}${ext}`);
            if (f && fs.statSync(f).size > 0) { m.localPath = f; n++; }
          }
        }
      }
      if (n || stale) { store.saveCache(); log('startup media relink:', n, 'stale dropped:', stale); }
    } catch {}

    if (store.config.behavior && store.config.behavior.launchAtLogin) applyLoginItem(); // 自愈历史坏条目（未加引号）
    createTray();
    refreshTray();
    createPanel();
    scheduleAutoSync();
    screen.on('display-metrics-changed', repositionPanel);
    // 开发预览：PREVIEW_SETTINGS=1 npm start 启动后直接打开设置页
    if (process.env.PREVIEW_SETTINGS) openSettings();

    // 首次运行（无缓存）自动同步一次
    if (!store.cache.lastSyncAt) {
      setTimeout(() => syncAll().catch(() => {}), 800);
    } else {
      broadcastData();
    }
  });

  app.on('window-all-closed', (e) => {
    // 常驻托盘，不退出
  });
  app.on('before-quit', () => {
    if (tray) tray.destroy();
    // 无痕模式：退出时清空临时媒体目录，不留痕迹
    if (store && store.config.behavior.mediaPersist === false) {
      try { fs.rmSync(mediaTmpDir(), { recursive: true, force: true }); } catch {}
    }
  });
}
