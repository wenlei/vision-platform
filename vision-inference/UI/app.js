// ── 全局配置 ─────────────────────────────────────────────────
let API = localStorage.getItem('vision_api') || location.origin;

const UI_VERSION = "20260419";

// ── 版本检查：对比 UI 版本与服务器版本 ─────────────────────────
(async function checkVersion() {
  try {
    const r = await fetch(API + '/version', { signal: AbortSignal.timeout(3000) });
    const { version } = await r.json();
    const label = document.getElementById('ver-label');
    if (version !== UI_VERSION) {
      label.textContent = `UI ${UI_VERSION} / 服务 ${version}`;
      label.style.color = 'var(--amber)';
      label.title = '版本不一致：请在服务器 git pull 并重启 Docker';
    } else {
      label.textContent = `Platform ${UI_VERSION}`;
      label.style.color = '';
    }
  } catch { /* 离线时静默 */ }
})();

// ── 工具函数 ─────────────────────────────────────────────────
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ── 侧边栏折叠 ───────────────────────────────────────────────
(function() {
  if (localStorage.getItem('sidebar_collapsed') === '1') {
    document.getElementById('sidebar').classList.add('collapsed');
  }
})();

function toggleSidebar() {
  const nav = document.getElementById('sidebar');
  const collapsed = nav.classList.toggle('collapsed');
  localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0');
}

// ── 导航 ─────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const page = document.getElementById('page-' + item.dataset.page);
    if (page) {
      page.classList.add('active');
      onPageLoad(item.dataset.page);
    }
  });
});

function onPageLoad(name) {
  if (name === 'live')    loadCamBar();
  if (name === 'history') { loadHistory(); loadRuntimeConfig(); }
  if (name === 'items')   loadItems();
  if (name === 'faces')   loadFaces();
  if (name === 'devices') initDevices();
  if (name === 'listen')  loadListenDevices();
  if (name === 'api')     initApiPage();
}

// ── Toast ────────────────────────────────────────���───────────
function toast(msg, type = 'ok', ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ── 健康检查 ─────────────────────────────────────────────────
async function checkHealth() {
  try {
    const r = await fetch(API + '/health', { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    const dot = document.getElementById('health-dot');
    const lbl = document.getElementById('health-label');
    dot.className = 'status-dot online';
    lbl.textContent = d.cuda ? 'GPU ' + (d.device || '').split(' ').pop() : 'CPU';
    return d;
  } catch {
    document.getElementById('health-dot').className = 'status-dot offline';
    document.getElementById('health-label').textContent = '离线';
    return null;
  }
}
setInterval(checkHealth, 10000);
checkHealth();

// ── Stream health poll ────────────────────────────────────────
async function pollStreamHealth() {
  if (!streaming) {
    document.getElementById('live-dot').classList.remove('active');
    return;
  }
  if (_multiStreamMode) {
    // In multi-stream mode, show LIVE if MJPEG tiles are present
    const hasGrid = !!document.getElementById('multi-grid');
    document.getElementById('live-dot').classList.toggle('active', hasGrid);
    return;
  }
  try {
    const r = await fetch(API + '/stream/health', { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    const dot = document.getElementById('live-dot');
    if (d.online) {
      dot.classList.add('active');
      document.getElementById('stream-offline').style.display = 'none';
      document.getElementById('stream-img').style.display = '';
    } else {
      dot.classList.remove('active');
      document.getElementById('stream-offline-msg').textContent = '摄像头离线';
      document.getElementById('stream-offline').style.display = 'flex';
    }
  } catch {
    document.getElementById('live-dot').classList.remove('active');
    document.getElementById('stream-offline-msg').textContent = '摄像头离线';
    document.getElementById('stream-offline').style.display = 'flex';
  }
}
setInterval(pollStreamHealth, 2000);

// ══════════════════════════════════════════════════════════════
// LIVE 页
// ══════════════════════════════════════════════════════════════
let rotate  = 0;
let hmirror = 0;
let vflip   = 0;
let streaming = false;
let _currentCamIp  = 'unknown';
let _currentCamMac = '';
let _devices = [];  // cache for scope highlighting

// Multi-stream state
let _multiStreamMode = false;

function _getActiveScopeDevices() {
  /** Return device objects visible in current scope. */
  const active = document.querySelector('.scope-btn.active');
  const scope = active?.dataset.scope || 'current';
  if (scope === 'current') {
    // Just the active device
    const card = document.querySelector('#cam-bar .cam-card.active');
    const mac = card?.dataset.mac || '';
    return mac ? _devices.filter(d => d.mac === mac) : [];
  } else if (scope === 'all') {
    return _devices.filter(d => d.stream_url);
  } else {
    const tag = scope.replace(/^group:/, '');
    return _devices.filter(d => {
      if (!d.stream_url) return false;
      const tags = (d.tag || '').split(/[,;]/).map(t => t.trim());
      return tags.includes(tag);
    });
  }
}

function _makeTransform(d) {
  let t = '';
  if (d.hmirror) t += ' scaleX(-1)';
  if (d.vflip)   t += ' scaleY(-1)';
  if (d.rotate)  t += ` rotate(${d.rotate}deg)`;
  return t.trim() || 'none';
}

function _startMultiStream(devs) {
  _multiStreamMode = true;
  const area = document.getElementById('stream-area');
  // Hide single-stream img and offline msg
  const singleImg = document.getElementById('stream-img');
  singleImg.src = '';
  singleImg.style.display = 'none';
  document.getElementById('stream-offline').style.display = 'none';

  // Clear any existing multi-grid
  const existing = document.getElementById('multi-grid');
  if (existing) {
    existing.querySelectorAll('img[data-mjpeg]').forEach(i => { i.src = ''; });
    existing.remove();
  }

  if (!devs.length) {
    document.getElementById('stream-offline-msg').textContent = '该范围内无设备';
    document.getElementById('stream-offline').style.display = 'flex';
    return;
  }

  // Calculate grid columns/rows to evenly divide the display area
  const n = devs.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  const grid = document.createElement('div');
  grid.id = 'multi-grid';
  grid.style.cssText = [
    'position:absolute;top:0;left:0;right:0;bottom:0',
    'display:grid',
    `grid-template-columns:repeat(${cols},1fr)`,
    `grid-template-rows:repeat(${rows},1fr)`,
    'gap:2px',
    'background:#111',
    'overflow:hidden',
  ].join(';');
  area.appendChild(grid);

  devs.forEach(d => {
    const tile = document.createElement('div');
    tile.style.cssText = 'position:relative;background:#1a1a1a;overflow:hidden;border:2px solid transparent;cursor:pointer;transition:border-color 0.12s';
    tile.dataset.mac = d.mac || '';
    tile.onclick = () => { if (d.stream_url) switchDevice(d.stream_url); };
    tile.onmouseenter = () => { tile.style.borderColor = 'var(--accent)'; };
    tile.onmouseleave = () => { tile.style.borderColor = 'transparent'; };

    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;bottom:0;left:0;right:0;padding:4px 8px;background:rgba(0,0,0,0.55);font-size:11px;color:#ddd;font-weight:600;pointer-events:none;z-index:1';
    label.textContent = d.name || d.mac || '';

    // Use direct MJPEG stream — browser handles fan-out via broadcaster
    const identifier = encodeURIComponent(d.name || d.mac || '');
    const img = document.createElement('img');
    img.dataset.mjpeg = '1';
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
    img.style.transform = _makeTransform(d);
    img.alt = d.name || d.mac;
    img.src = `${API}/stream/${identifier}?t=${Date.now()}`;

    tile.appendChild(img);
    tile.appendChild(label);
    grid.appendChild(tile);
  });
}

function _stopMultiStream() {
  _multiStreamMode = false;
  const grid = document.getElementById('multi-grid');
  if (grid) {
    // Set src='' to disconnect MJPEG streams before removing
    grid.querySelectorAll('img[data-mjpeg]').forEach(i => { i.src = ''; });
    grid.remove();
  }
}

function initStream() {
  streaming = true;
  document.getElementById('btn-stream').textContent = '⏹ 断开';
  document.getElementById('btn-stream').className = 'btn connected';
  document.getElementById('stream-offline').style.display = 'none';

  const scope = document.querySelector('.scope-btn.active')?.dataset.scope || 'current';
  if (scope === 'current') {
    _startSingleStream();
  } else {
    // Multi-stream — need devices loaded
    const devs = _getActiveScopeDevices();
    if (devs.length) {
      _startMultiStream(devs);
    } else {
      // Devices not loaded yet — load then start
      loadCamBar().then(() => {
        const d2 = _getActiveScopeDevices();
        _startMultiStream(d2);
      });
    }
  }
}

function _startSingleStream() {
  _stopMultiStream();
  const img = document.getElementById('stream-img');
  img.src = API + '/stream?' + Date.now();
  img.style.display = '';
  document.getElementById('live-dot').classList.add('active');
  loadOrientConfig();
  loadCamBar();
}

function stopStream() {
  const img = document.getElementById('stream-img');
  img.src = '';
  img.style.display = 'none';
  _stopMultiStream();
  streaming = false;
  document.getElementById('stream-offline-msg').textContent = '已断开';
  document.getElementById('stream-offline').style.display = 'flex';
  document.getElementById('live-dot').classList.remove('active');
  document.getElementById('btn-stream').textContent = '▶ 连接';
  document.getElementById('btn-stream').className = 'btn disconnected';
}

function toggleStream() {
  streaming ? stopStream() : initStream();
}

// ── 心跳检测 ─────────────────────────────────────────────────
const _camPingTimers = {};

function _stopCamPings() {
  Object.values(_camPingTimers).forEach(clearInterval);
  Object.keys(_camPingTimers).forEach(k => delete _camPingTimers[k]);
}

async function _pingCam(ip, onResult) {
  try {
    const r = await fetch(API + '/devices/ping?ip=' + encodeURIComponent(ip),
                          { signal: AbortSignal.timeout(3500) });
    onResult(await r.json());
  } catch { onResult({ online: false, ip }); }
}

// ── Cam Bar（Live 页设备切换条）───────────────────────────────
async function loadCamBar() {
  const bar = document.getElementById('cam-bar');
  if (!bar) return;
  _stopCamPings();
  try {
    const [devR, cfgR] = await Promise.all([
      fetch(API + '/devices'),
      fetch(API + '/stream/config'),
    ]);
    const { devices = [] } = await devR.json();
    const { source = '' } = await cfgR.json();

    if (!devices.length) {
      bar.innerHTML = '<span style="color:var(--text3);font-size:11px">无注册设备 — 前往 Devices 页注册摄像头</span>';
      return;
    }
    // 只显示有 video_in 能力的设备
    const videoDevices = devices.filter(d => {
      const caps = Array.isArray(d.capability) ? d.capability : (d.capability || 'video_in').split(',');
      return caps.includes('video_in');
    });
    if (!videoDevices.length) {
      bar.innerHTML = '<span style="color:var(--text3);font-size:11px">无视频设备 — 仅 audio 设备不支持 Live 预览</span>';
      return;
    }
    _devices = videoDevices;
    bar.innerHTML = '';
    videoDevices.forEach(d => {
      const key = (d.mac || d.ip || '').replace(/[^a-z0-9]/gi, '');
      const dotId = 'cbdot-' + key;
      const isActive = d.stream_url && d.stream_url === source;
      const card = document.createElement('div');
      card.className = 'cam-card' + (isActive ? ' active' : '');
      card.dataset.url = d.stream_url || '';
      card.dataset.mac = d.mac || '';
      card.dataset.tag = d.tag || '';
      card.innerHTML =
        `<span class="status-dot checking" id="${dotId}" title="检测中..."></span>` +
        `<div><div class="cam-card-name">${esc(d.name)}${d.is_default ? ' <span style="color:var(--amber);font-size:10px">★</span>' : ''}</div>` +
        `<div class="cam-card-meta">${esc(d.ip || '-')}</div></div>`;
      card.onclick = () => {
        if (!d.stream_url) return;
        switchDevice(d.stream_url);
      };
      bar.appendChild(card);
      // Update globals for active device
      if (isActive) {
        _currentCamIp  = d.ip || 'unknown';
        _currentCamMac = d.mac || '';
      }

      if (d.ip) {
        const update = info => {
          const dot = document.getElementById(dotId);
          if (!dot) return;
          if (info.online) {
            dot.className = 'status-dot online pulse';
            dot.title = `在线 · RSSI ${info.rssi ?? '-'} dBm · 运行 ${info.uptime_sec ?? '-'}s`;
          } else {
            dot.className = 'status-dot offline';
            dot.title = '离线';
          }
        };
        _pingCam(d.ip, update);
        _camPingTimers[key] = setInterval(() => _pingCam(d.ip, update), 8000);
      }
    });
  } catch {
    bar.innerHTML = '<span style="color:var(--red);font-size:11px">设备加载失败</span>';
  }
  await populateDetectScope();
  // Re-apply scope dim state after cam-bar re-render
  const activeScope = document.querySelector('.scope-btn.active');
  if (activeScope) setScopeBtn(activeScope);
}

async function switchDevice(streamUrl) {
  if (!streamUrl) return;
  try {
    const r = await fetch(API + '/stream/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: streamUrl }),
    });
    if (!r.ok) { toast('切换设备失败', 'err'); return; }
    toast('切换设备，重新连接...', 'ok');
    stopStream();
    setTimeout(() => { initStream(); loadCamBar(); }, 300);
  } catch { toast('切换设备失败', 'err'); }
}

function loadOrientConfig() {
  fetch(API + '/stream/config').then(r => r.json()).then(d => {
    rotate  = d.rotate  || 0;
    hmirror = d.hmirror || 0;
    vflip   = d.vflip   || 0;
    applyCSSTransform();
    updateOrientBtns();
  }).catch(() => {});
}

function applyCSSTransform() {
  const img = document.getElementById('stream-img');
  let t = '';
  if (hmirror) t += ' scaleX(-1)';
  if (vflip)   t += ' scaleY(-1)';
  if (rotate)  t += ` rotate(${rotate}deg)`;
  img.style.transform = t.trim() || 'none';
}

function onStreamError() {
  document.getElementById('stream-img').style.display = 'none';
  document.getElementById('stream-offline').style.display = 'flex';
}

function updateOrientBtns() {
  document.getElementById('btn-mirror').classList.toggle('primary', hmirror === 1);
  document.getElementById('btn-vflip').classList.toggle('primary', vflip === 1);
}

async function sendOrientConfig(update) {
  // 即时 CSS 预览
  if (update.rotate  !== undefined) rotate  = update.rotate;
  if (update.hmirror !== undefined) hmirror = update.hmirror;
  if (update.vflip   !== undefined) vflip   = update.vflip;
  applyCSSTransform();
  updateOrientBtns();
  // 持久化到 yaml
  try {
    const r = await fetch(API + '/stream/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    const d = await r.json();
    rotate  = d.rotate;
    hmirror = d.hmirror;
    vflip   = d.vflip;
    applyCSSTransform();
    updateOrientBtns();
    toast('方向已保存', 'ok');
  } catch { toast('服务未连接', 'err'); }
}

function rotateCW()  { sendOrientConfig({ rotate: (rotate + 90) % 360 }); }
function rotateCCW() { sendOrientConfig({ rotate: (rotate - 90 + 360) % 360 }); }
function toggleMirror() { sendOrientConfig({ hmirror: hmirror ? 0 : 1 }); }
function toggleVFlip()  { sendOrientConfig({ vflip: vflip ? 0 : 1 }); }

// 检测范围选择器
// ── 检测范围选择器 ────────────────────────────────────────────

function setScopeBtn(btn, fromUser = false) {
  document.querySelectorAll('.scope-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const scope = btn.dataset.scope || 'current';
  const cards = document.querySelectorAll('#cam-bar .cam-card');

  if (scope === 'current') {
    // 全部显示，非活跃灰显可点击
    cards.forEach(card => {
      card.style.display = '';
      card.classList.toggle('scope-dim', !card.classList.contains('active'));
    });
    // Switch from multi to single stream only on user action
    if (fromUser && streaming && _multiStreamMode) {
      _stopMultiStream();
      _startSingleStream();
    }
  } else if (scope === 'all') {
    // 全部显示，全部可点击
    cards.forEach(card => {
      card.style.display = '';
      card.classList.remove('scope-dim');
    });
    // Switch to multi-stream only on user action
    if (fromUser && streaming) _applyMultiStreamForScope();
  } else {
    // tag 分组：只显示该 tag 的设备
    const tag = scope.replace(/^group:/, '');
    cards.forEach(card => {
      const cardTags = (card.dataset.tag || '').split(/[,;]/).map(t => t.trim());
      const inGroup = cardTags.includes(tag);
      card.style.display = inGroup ? '' : 'none';
      card.classList.remove('scope-dim');
    });
    // Switch to multi-stream tag-filtered only on user action
    if (fromUser && streaming) _applyMultiStreamForScope();
  }
}

function _applyMultiStreamForScope() {
  // Stop old multi-stream (or single stream)
  if (_multiStreamMode) _stopMultiStream();
  else {
    const img = document.getElementById('stream-img');
    img.src = '';
    img.style.display = 'none';
  }
  const devs = _getActiveScopeDevices();
  if (devs.length) {
    _startMultiStream(devs);
  } else {
    // Devices not loaded yet — fetch first, then start
    loadCamBar().then(() => {
      const d2 = _getActiveScopeDevices();
      _startMultiStream(d2);
    });
  }
}

let _scopePopulating = false;
async function populateDetectScope() {
  if (_scopePopulating) return;
  _scopePopulating = true;
  const bar = document.getElementById('scope-bar');
  if (!bar) { _scopePopulating = false; return; }
  // Remove previously injected tag buttons
  [...bar.querySelectorAll('[data-scope^="group:"]')].forEach(b => b.remove());
  try {
    const r = await fetch(API + '/devices');
    const { devices = [] } = await r.json();
    const tagSet = new Set();
    devices.forEach(d => {
      if (!d.tag) return;
      d.tag.split(/[,;]/).map(t => t.trim()).filter(t => t).forEach(t => tagSet.add(t));
    });
    [...tagSet].sort().forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'scope-btn';
      btn.dataset.scope = 'group:' + tag;
      btn.textContent = '🏷 ' + tag;
      btn.onclick = () => setScopeBtn(btn, true);
      bar.appendChild(btn);
    });
  } catch {}
  _scopePopulating = false;
}

async function triggerScopedDetect() {
  const active = document.querySelector('.scope-btn.active');
  const scope = active?.dataset.scope || 'current';
  if (scope === 'current') {
    triggerDetect();
  } else if (scope === 'all') {
    triggerDetectAll();
  } else if (scope.startsWith('group:')) {
    const tag = scope.slice(6);
    await _triggerMultiDetect('/detect/group/' + encodeURIComponent(tag), `🏷 ${tag}`);
  }
}

async function _triggerMultiDetect(url, label) {
  const result = document.getElementById('detect-result');
  result.innerHTML = `<span style="color:var(--text3)">${esc(label)} 识别中...</span>`;
  try {
    const r = await fetch(API + url, { method: 'POST' });
    const data = await r.json();
    result.innerHTML = '';
    if (!data.results || !data.results.length) {
      result.innerHTML = '<span style="color:var(--text3)">该范围内无设备或无流地址</span>';
      return;
    }
    data.results.forEach(item => {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:10px;color:var(--text3);margin-top:8px;margin-bottom:3px';
      header.textContent = (item.device_name || item.device_mac || '未知') + (item.location ? ' · ' + item.location : '');
      result.appendChild(header);
      if (item.error) {
        const err = document.createElement('span');
        err.className = 'detect-tag';
        err.style.color = 'var(--red)';
        err.textContent = item.error;
        result.appendChild(err);
        return;
      }
      if (item.description && item.description !== 'No objects detected') {
        item.description.replace('Detected: ', '').split(', ').forEach(t => {
          const span = document.createElement('span');
          span.className = 'detect-tag';
          span.textContent = t.trim();
          result.appendChild(span);
        });
      } else {
        const empty = document.createElement('span');
        empty.style.cssText = 'font-size:11px;color:var(--text3)';
        empty.textContent = '未检测到物体';
        result.appendChild(empty);
      }
    });
  } catch(e) {
    result.textContent = '检测失败：' + e.message;
    result.style.color = 'var(--red)';
  }
}

// 检测（服务端抓帧 → YOLO + CLIP + 人脸识别，全部入库）
async function triggerDetect() {
  const result = document.getElementById('detect-result');
  const faceResult = document.getElementById('face-result');
  result.innerHTML = '<span style="color:var(--text3)">识别中...</span>';
  try {
    // 使用服务端抓帧接口，人脸识别已在服务端完成并写入 DB
    const mac = _currentCamMac;
    if (!mac) { result.textContent = '未选择设备'; result.style.color = 'var(--red)'; return; }
    const detectR = await fetch(API + '/detect/' + encodeURIComponent(mac), { method: 'POST' });
    if (!detectR.ok) { result.textContent = '检测失败：' + detectR.status; result.style.color = 'var(--red)'; return; }
    const data = await detectR.json();

    result.innerHTML = '';
    let hasContent = false;

    // 人脸识别结果（来自服务端，已入库）
    const matched = (data.face_results || []);
    const faceQueue = [...matched]; // 依次消费，支持多人

    // YOLO 标签（person → 替换为识别到的人名）
    if (data.description && data.description !== 'No objects detected') {
      const tags = (data.description.replace('Detected: ', '')).split(', ');
      tags.forEach(t => {
        const tag = t.trim();
        const span = document.createElement('span');
        span.className = 'detect-tag';
        // 遇到 person/Nx person，尝试用人脸结果替换
        const isPerson = /^(\d+x)?person$/i.test(tag);
        if (isPerson && faceQueue.length) {
          const f = faceQueue.shift();
          const prefix = tag.match(/^(\d+x)/)?.[1] || '';
          span.textContent = `${prefix}${f.name}`;
          span.style.borderColor = f.confidence === 'high' ? 'var(--green)' : 'var(--amber)';
          span.style.color      = f.confidence === 'high' ? 'var(--green)' : 'var(--amber)';
          span.title = `person · ${(f.similarity*100).toFixed(0)}% ${f.confidence}`;
        } else {
          span.textContent = tag;
        }
        result.appendChild(span);
      });
      hasContent = true;
    }

    // 剩余未消费的人脸（YOLO 没检出 person 但人脸识别有结果）
    faceQueue.forEach(f => {
      const span = document.createElement('span');
      span.className = 'detect-tag';
      span.style.borderColor = f.confidence === 'high' ? 'var(--green)' : 'var(--amber)';
      span.style.color      = f.confidence === 'high' ? 'var(--green)' : 'var(--amber)';
      span.textContent = f.name;
      span.title = `face · ${(f.similarity*100).toFixed(0)}% ${f.confidence}`;
      result.appendChild(span);
      hasContent = true;
    });

    // 同步更新 face-result div
    if (matched.length) {
      faceResult.innerHTML = matched.map(f => {
        const col = f.confidence === 'high' ? 'green' : 'amber';
        return `<div style="color:var(--${esc(col)})">${esc(f.name)} ${(f.similarity*100).toFixed(0)}%</div>`;
      }).join('');
    } else if (data.detections && data.detections.some(d => d.label === 'person')) {
      faceResult.innerHTML = '<span style="color:var(--text3)">未识别到已注册人脸</span>';
    }

    if (!hasContent) {
      result.innerHTML = '<span style="color:var(--text3)">未检测到物体</span>';
    }
  } catch(e) {
    result.textContent = '检测失败：' + e.message;
    result.style.color = 'var(--red)';
  }
}

// 全部设备检测
async function triggerDetectAll() {
  await _triggerMultiDetect('/detect/all', '全部设备');
}

// 人脸识别
async function triggerFaceIdentify() {
  const result = document.getElementById('face-result');
  result.textContent = '识别中...';
  try {
    const capR = await fetch(API + '/stream/capture');
    if (!capR.ok) { result.textContent = '拍照失败：摄像头离线'; return; }
    const blob = await capR.blob();
    const fd = new FormData();
    fd.append('file', blob, 'capture.jpg');
    const r = await fetch(API + '/face/identify', { method: 'POST', body: fd });
    const data = await r.json();
    if (!data.results || data.results.length === 0) {
      result.textContent = '未检测到人脸';
    } else {
      result.innerHTML = data.results.map(f => {
        const conf = f.confidence === 'high' ? 'green' : f.matched ? 'amber' : 'text3';
        const learned = f.learned ? ' <span style="color:var(--amber)">&#8593;学习</span>' : '';
        return `<div style="color:var(--${esc(conf)})">${esc(f.name)} ${(f.similarity*100).toFixed(0)}%${learned}</div>`;
      }).join('');
    }
  } catch(e) { result.textContent = '识别失败: ' + e.message; }
}

// 截屏（后台已应用 rotate/hmirror/vflip，直接保存）
async function screenshot() {
  try {
    const r = await fetch(API + '/stream/snapshot');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.download = `desk-${Date.now()}.jpg`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
    toast('截图已保存', 'ok');
  } catch { toast('截屏失败，请检查摄像头', 'err'); }
}

initStream();

// ══════════════════════════════════════════════════════════════
// HISTORY 页
// ══════════════════════════════════════════════════════════════
async function loadHistory() {
  const c = document.getElementById('history-container');
  c.innerHTML = '<span style="color:var(--text3)">加载中...</span>';
  try {
    const r = await fetch(API + '/search?limit=50');
    const data = await r.json();
    renderHistoryTable(data.results || []);
  } catch { c.innerHTML = '<span style="color:var(--red)">加载失败</span>'; }
}

async function searchHistory() {
  const label = document.getElementById('search-label').value.trim();
  if (!label) return loadHistory();
  const c = document.getElementById('history-container');
  c.innerHTML = '<span style="color:var(--text3)">搜索中...</span>';
  try {
    const r = await fetch(`${API}/search?label=${encodeURIComponent(label)}&limit=50`);
    const data = await r.json();
    renderHistoryTable(data.results || []);
  } catch { c.innerHTML = '<span style="color:var(--red)">搜索失败</span>'; }
}

function clearSearch() {
  document.getElementById('search-label').value = '';
  loadHistory();
}

// ── Runtime config (存储/清理配置) ──────────────────────────
async function loadRuntimeConfig() {
  try {
    const r = await fetch('/config/runtime');
    if (!r.ok) return;
    const d = await r.json();
    document.getElementById('cfg-storage-mode').value   = d.storage_mode       ?? 'retention';
    document.getElementById('cfg-retention-hours').value = d.retention_hours    ?? 72;
    document.getElementById('cfg-interval-hours').value  = d.cleanup_interval_hours ?? 6;
    document.getElementById('cfg-status').textContent = '';
  } catch { /* ignore */ }
}

async function saveRuntimeConfig() {
  const btn = document.querySelector('#storage-settings-card .btn.primary');
  const status = document.getElementById('cfg-status');
  btn.disabled = true;
  status.textContent = '保存中...';
  status.style.color = 'var(--text3)';
  try {
    const body = {
      storage_mode:            document.getElementById('cfg-storage-mode').value,
      retention_hours:         parseInt(document.getElementById('cfg-retention-hours').value) || 72,
      cleanup_interval_hours:  parseInt(document.getElementById('cfg-interval-hours').value)  || 6,
    };
    const r = await fetch('/config/runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail ?? r.statusText);
    status.textContent = '✓ 已保存并生效';
    status.style.color = 'var(--green)';
    // 回填服务器返回的实际值
    document.getElementById('cfg-storage-mode').value    = d.storage_mode       ?? body.storage_mode;
    document.getElementById('cfg-retention-hours').value  = d.retention_hours    ?? body.retention_hours;
    document.getElementById('cfg-interval-hours').value   = d.cleanup_interval_hours ?? body.cleanup_interval_hours;
  } catch (e) {
    status.textContent = '✗ 保存失败: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

function renderHistoryTable(results) {
  const c = document.getElementById('history-container');
  if (!results.length) {
    c.innerHTML = '<span style="color:var(--text3)">暂无记录</span>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'list-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:72px">缩略图</th>
        <th style="width:140px">时间</th>
        <th style="width:120px">设备</th>
        <th>标签</th>
        <th>描述</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  results.forEach(r => {
    const tr = document.createElement('tr');
    const time = r.captured_at
      ? new Date(r.captured_at).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    const device = esc(r.device_name || r.camera_ip || r.device_mac || '—');
    const labels = (r.labels || []);
    const tagHtml = labels.length
      ? labels.map(t => `<span class="detect-tag">${esc(t)}</span>`).join('')
      : '<span style="color:var(--text3)">—</span>';
    const desc = r.description ? esc(r.description) : '<span style="color:var(--text3)">—</span>';
    const thumb = r.image_url
      ? `<img src="${esc(r.image_url)}" style="width:64px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border);display:block" loading="lazy" onclick="window.open('${esc(r.image_url)}','_blank')" title="点击查看原图" class="history-thumb-sm">`
      : `<div style="width:64px;height:48px;background:var(--bg3);border-radius:4px;border:1px solid var(--border)"></div>`;

    tr.innerHTML = `
      <td style="padding:8px 10px">${thumb}</td>
      <td style="white-space:nowrap;color:var(--text3);font-size:11px">${esc(time)}</td>
      <td style="font-size:11px;font-weight:600">${device}</td>
      <td style="line-height:2">${tagHtml}</td>
      <td style="font-size:11px;color:var(--text2);max-width:340px;word-break:break-word">${desc}</td>
    `;
    tbody.appendChild(tr);
  });

  c.innerHTML = '';
  c.appendChild(table);
}

// ══════════════════════════════════════════════════════════════
// ITEMS 页
// ══════════════════════════════════════════════════════════════
let _itemFiles = [];  // accumulated File objects for multi-angle registration

async function loadItems() {
  try {
    const r = await fetch(API + '/items');
    const data = await r.json();
    const items = data.items || [];
    document.getElementById('items-count').textContent = `(${items.length})`;
    const tbody = document.getElementById('items-tbody');
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text3)">暂无注册物品</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    items.forEach(it => {
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.style.fontWeight = '700';
      tdLabel.textContent = it.label;
      const tdDesc = document.createElement('td');
      tdDesc.style.cssText = 'font-size:11px;color:var(--text3)';
      tdDesc.textContent = it.description || '—';
      const tdCount = document.createElement('td');
      tdCount.innerHTML = `<span class="badge blue">${esc(String(it.sample_count))} 张</span>`;
      const tdTime = document.createElement('td');
      tdTime.style.cssText = 'font-size:11px;color:var(--text3)';
      tdTime.textContent = new Date(it.registered_at).toLocaleDateString('zh-CN');
      const tdAction = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn';
      delBtn.style.cssText = 'padding:2px 8px;font-size:10px;color:var(--red);border-color:var(--red)';
      delBtn.textContent = '删除';
      delBtn.onclick = () => deleteItem(it.label);
      tdAction.appendChild(delBtn);
      tr.append(tdLabel, tdDesc, tdCount, tdTime, tdAction);
      tbody.appendChild(tr);
    });
  } catch {
    document.getElementById('items-tbody').innerHTML = '<tr><td colspan="5" style="color:var(--red)">加载失败</td></tr>';
  }
}

function addItemFiles(fileList) {
  const newFiles = Array.from(fileList);
  _itemFiles = _itemFiles.concat(newFiles);
  renderItemThumbs();
}

function renderItemThumbs() {
  const grid = document.getElementById('item-preview-grid');
  const thumbs = document.getElementById('item-thumbs');
  const count = document.getElementById('item-file-count');
  if (!_itemFiles.length) { grid.style.display = 'none'; return; }
  grid.style.display = '';
  count.textContent = _itemFiles.length;
  thumbs.innerHTML = '';
  _itemFiles.forEach((f, i) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:72px;height:72px;flex-shrink:0';
    const img = document.createElement('img');
    if (img._objUrl) URL.revokeObjectURL(img._objUrl);
    img._objUrl = URL.createObjectURL(f);
    img.src = img._objUrl;
    img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--border)';
    const del = document.createElement('span');
    del.textContent = '✕';
    del.style.cssText = 'position:absolute;top:2px;right:4px;font-size:11px;color:#fff;cursor:pointer;text-shadow:0 0 3px rgba(0,0,0,0.8);line-height:1';
    del.onclick = () => { _itemFiles.splice(i, 1); renderItemThumbs(); };
    wrap.appendChild(img);
    wrap.appendChild(del);
    thumbs.appendChild(wrap);
  });
}

function clearItemFiles() {
  _itemFiles = [];
  document.getElementById('item-file').value = '';
  renderItemThumbs();
}

async function registerItem() {
  const label = document.getElementById('item-label').value.trim();
  const desc  = document.getElementById('item-desc').value.trim();
  const result = document.getElementById('item-result');
  if (!label) { toast('请填写物品名称', 'err'); return; }
  if (!_itemFiles.length) { toast('请至少选择一张图片', 'err'); return; }

  const total = _itemFiles.length;
  const progressWrap = document.getElementById('item-progress');
  const progressText = document.getElementById('item-progress-text');
  const progressBar  = document.getElementById('item-progress-bar');
  progressWrap.style.display = '';
  result.innerHTML = '';
  result.style.color = '';

  let succeeded = 0;
  const errors = [];
  for (let i = 0; i < total; i++) {
    progressText.textContent = `${i} / ${total}`;
    progressBar.style.width = `${Math.round(i / total * 100)}%`;
    const fd = new FormData();
    fd.append('file', _itemFiles[i]);
    fd.append('label', label);
    if (desc && i === 0) fd.append('description', desc);
    try {
      const r = await fetch(API + '/register', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.status === 'ok') succeeded++;
      else errors.push(`第 ${i+1} 张: ${d.error || JSON.stringify(d)}`);
    } catch (e) {
      errors.push(`第 ${i+1} 张请求失败: ${e.message}`);
    }
  }

  progressText.textContent = `${total} / ${total}`;
  progressBar.style.width = '100%';

  const lines = [];
  if (succeeded > 0) lines.push(`✓ ${label} 注册 ${succeeded}/${total} 张成功`);
  errors.forEach(e => lines.push(`✕ ${e}`));
  result.innerHTML = lines.join('<br>');
  result.style.color = errors.length === 0 ? 'var(--green)' : (succeeded > 0 ? 'var(--amber)' : 'var(--red)');

  if (errors.length === 0) {
    toast(`✓ ${label} 注册完成 (${total} 张)`, 'ok');
    clearItemFiles();
    document.getElementById('item-label').value = '';
    document.getElementById('item-desc').value = '';
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
  } else {
    toast(`注册部分失败 (${succeeded}/${total})`, 'err');
  }
  loadItems();
}

async function deleteItem(label) {
  if (!confirm(`确认删除物品「${label}」？该物品的所有样本将被清除，无法恢复。`)) return;
  try {
    const r = await fetch(`${API}/items/${encodeURIComponent(label)}`, { method: 'DELETE' });
    if (r.ok) {
      toast(`已删除「${label}」`, 'ok');
      loadItems();
    } else {
      const d = await r.json();
      toast(`删除失败: ${d.detail || '未知错误'}`, 'err');
    }
  } catch { toast('删除失败', 'err'); }
}

function previewFile(input, previewId) {
  const preview = document.getElementById(previewId);
  if (input.files[0]) {
    if (preview._objectUrl) URL.revokeObjectURL(preview._objectUrl);
    preview._objectUrl = URL.createObjectURL(input.files[0]);
    preview.src = preview._objectUrl;
    preview.style.display = 'block';
  }
}

// ══════════════════════════════════════════════════════════════
// FACES 页
// ══════════════════════════════════════════════════════════════
let _faceFiles = [];  // accumulated File objects for multi-angle registration

async function loadFaces() {
  try {
    const r = await fetch(API + '/faces');
    const data = await r.json();
    const faces = data.faces || [];
    document.getElementById('faces-count').textContent = `(${faces.length})`;
    const tbody = document.getElementById('faces-tbody');
    if (!faces.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text3)">暂无注册人脸</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    faces.forEach(f => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.style.fontWeight = '700';
      tdName.textContent = f.name;
      const tdCount = document.createElement('td');
      tdCount.innerHTML = `<span class="badge blue">${f.sample_count || 1} 张</span>`;
      const tdScore = document.createElement('td');
      tdScore.textContent = f.det_score ? (f.det_score * 100).toFixed(0) + '%' : '-';
      const tdTime = document.createElement('td');
      tdTime.style.cssText = 'font-size:11px;color:var(--text3)';
      tdTime.textContent = new Date(f.registered_at).toLocaleDateString('zh-CN');
      const tdAction = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn';
      delBtn.style.cssText = 'padding:2px 8px;font-size:10px;color:var(--red);border-color:var(--red)';
      delBtn.textContent = '删除';
      delBtn.onclick = () => deleteFace(f.name);
      tdAction.appendChild(delBtn);
      tr.append(tdName, tdCount, tdScore, tdTime, tdAction);
      tbody.appendChild(tr);
    });
  } catch {
    document.getElementById('faces-tbody').innerHTML = '<tr><td colspan="5" style="color:var(--red)">加载失败</td></tr>';
  }
}

function addFaceFiles(fileList) {
  const newFiles = Array.from(fileList);
  _faceFiles = _faceFiles.concat(newFiles);
  renderFaceThumbs();
}

function renderFaceThumbs() {
  const grid = document.getElementById('face-preview-grid');
  const thumbs = document.getElementById('face-thumbs');
  const count = document.getElementById('face-file-count');
  if (!_faceFiles.length) { grid.style.display = 'none'; return; }
  grid.style.display = '';
  count.textContent = _faceFiles.length;
  thumbs.innerHTML = '';
  _faceFiles.forEach((f, i) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:72px;height:72px;flex-shrink:0';
    const img = document.createElement('img');
    if (img._objUrl) URL.revokeObjectURL(img._objUrl);
    img._objUrl = URL.createObjectURL(f);
    img.src = img._objUrl;
    img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--border)';
    const del = document.createElement('span');
    del.textContent = '✕';
    del.style.cssText = 'position:absolute;top:2px;right:4px;font-size:11px;color:#fff;cursor:pointer;text-shadow:0 0 3px rgba(0,0,0,0.8);line-height:1';
    del.onclick = () => { _faceFiles.splice(i, 1); renderFaceThumbs(); };
    wrap.appendChild(img);
    wrap.appendChild(del);
    thumbs.appendChild(wrap);
  });
}

function clearFaceFiles() {
  _faceFiles = [];
  document.getElementById('face-file').value = '';
  renderFaceThumbs();
}

async function registerFace() {
  const name = document.getElementById('face-name').value.trim();
  const result = document.getElementById('face-register-result');
  if (!name) { toast('请填写姓名', 'err'); return; }
  if (!_faceFiles.length) { toast('请至少选择一张图片', 'err'); return; }

  const total = _faceFiles.length;
  const progressWrap = document.getElementById('face-progress');
  const progressText = document.getElementById('face-progress-text');
  const progressBar  = document.getElementById('face-progress-bar');
  progressWrap.style.display = '';
  result.innerHTML = '';
  result.style.color = '';

  let succeeded = 0;
  const errors = [];
  const crops = [];  // face crop URLs to display
  for (let i = 0; i < total; i++) {
    progressText.textContent = `${i} / ${total}`;
    progressBar.style.width = `${Math.round(i / total * 100)}%`;
    const fd = new FormData();
    fd.append('file', _faceFiles[i]);
    fd.append('name', name);
    try {
      const r = await fetch(API + '/face/register', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.status === 'ok') {
        succeeded++;
        if (d.face_crop_url) crops.push({ url: d.face_crop_url, det: d.det_score });
      } else {
        errors.push(`第 ${i+1} 张: ${d.error || JSON.stringify(d)}`);
      }
    } catch (e) {
      errors.push(`第 ${i+1} 张请求失败: ${e.message}`);
    }
  }

  progressText.textContent = `${total} / ${total}`;
  progressBar.style.width = '100%';

  // Build persistent result message
  const lines = [];
  if (succeeded > 0) lines.push(`✓ ${name} 注册 ${succeeded}/${total} 张成功`);
  errors.forEach(e => lines.push(`✕ ${e}`));
  result.innerHTML = lines.join('<br>');
  result.style.color = errors.length === 0 ? 'var(--green)' : (succeeded > 0 ? 'var(--amber)' : 'var(--red)');

  // Show face crops so user can verify the right face was selected
  if (crops.length) {
    const cropRow = document.createElement('div');
    cropRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';
    crops.forEach(({ url, det }) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;display:inline-block';
      const img = document.createElement('img');
      const filename = url.split('/').pop();
      img.src = `${API}/images/${filename}`;
      img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:6px;border:2px solid var(--green)';
      img.title = `det_score: ${det}`;
      const score = document.createElement('div');
      score.style.cssText = 'position:absolute;bottom:2px;left:0;right:0;text-align:center;font-size:9px;color:#fff;text-shadow:0 0 3px rgba(0,0,0,0.9);line-height:1.2';
      score.textContent = det;
      wrap.appendChild(img);
      wrap.appendChild(score);
      cropRow.appendChild(wrap);
    });
    result.appendChild(cropRow);
  }

  if (errors.length === 0) {
    toast(`✓ ${name} 注册完成 (${total} 张)`, 'ok');
    clearFaceFiles();
    document.getElementById('face-name').value = '';
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
  } else {
    toast(`注册部分失败 (${succeeded}/${total})`, 'err');
  }
  loadFaces();
}

async function deleteFace(name) {
  if (!confirm(`确认删除人脸「${name}」？该人脸的所有样本将被清除，无法恢复。`)) return;
  try {
    const r = await fetch(`${API}/faces/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (r.ok) {
      toast(`已删除「${name}」`, 'ok');
      loadFaces();
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.detail || '删除失败', 'err');
    }
  } catch { toast('删除失败', 'err'); }
}

// ══════════════════════════════════════════════════════════════
// DEVICES 页
// ══════════════════════════════════════════════════════════════
let _editingMac = null;  // null = new device, string = editing existing

async function initDevices() {
  pingInfra();
  loadDiscovered();
  loadDeviceList();
}

// ── 检测分组 CRUD ─────────────────────────────────────────────
let _editingGroup = null;   // null = new, string = editing existing group name

async function loadGroups() {
  const tbody = document.getElementById('groups-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text3)">加载中...</td></tr>';
  try {
    const r = await fetch(API + '/groups');
    const { groups = [] } = await r.json();
    document.getElementById('groups-count').textContent = `(${groups.length})`;
    if (!groups.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text3)">暂无分组</td></tr>';
    } else {
      tbody.innerHTML = '';
      groups.forEach(g => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.onclick = () => editGroup(g);
        const tdName = document.createElement('td');
        tdName.style.fontWeight = '700';
        tdName.textContent = g.name;
        const tdCount = document.createElement('td');
        tdCount.innerHTML = `<span class="badge blue">${g.device_count}</span>`;
        const tdDesc = document.createElement('td');
        tdDesc.style.cssText = 'font-size:11px;color:var(--text3)';
        tdDesc.textContent = g.description || '-';
        tr.append(tdName, tdCount, tdDesc);
        tbody.appendChild(tr);
      });
    }
    // Rebuild device checkboxes
    await _renderGroupDeviceList();
    // Refresh scope selector
    populateDetectScope();
  } catch {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--red)">加载失败</td></tr>';
  }
}

async function _renderGroupDeviceList(checkedMacs = []) {
  const container = document.getElementById('group-device-list');
  if (!container) return;
  try {
    const r = await fetch(API + '/devices');
    const { devices = [] } = await r.json();
    if (!devices.length) {
      container.innerHTML = '<span style="color:var(--text3);font-size:11px">暂无注册设备</span>';
      return;
    }
    container.innerHTML = '';
    devices.forEach(d => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = d.mac;
      cb.checked = checkedMacs.includes(d.mac);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(
        `${d.name}${d.location ? ' · ' + d.location : ''} (${d.ip || d.mac})`
      ));
      container.appendChild(label);
    });
  } catch {
    container.innerHTML = '<span style="color:var(--red);font-size:11px">加载失败</span>';
  }
}

function editGroup(g) {
  _editingGroup = g.name;
  document.getElementById('group-name').value = g.name;
  document.getElementById('group-desc').value = g.description || '';
  document.getElementById('group-delete-btn').style.display = '';
  document.getElementById('group-result').textContent = '';
  const macs = (g.devices || []).map(d => d.mac);
  _renderGroupDeviceList(macs);
}

function clearGroupForm() {
  _editingGroup = null;
  document.getElementById('group-name').value = '';
  document.getElementById('group-desc').value = '';
  document.getElementById('group-delete-btn').style.display = 'none';
  document.getElementById('group-result').textContent = '';
  _renderGroupDeviceList([]);
}

async function saveGroup() {
  const name = document.getElementById('group-name').value.trim();
  const desc = document.getElementById('group-desc').value.trim();
  const result = document.getElementById('group-result');
  if (!name) { toast('分组名称为必填项', 'err'); return; }

  const macs = [...document.querySelectorAll('#group-device-list input[type=checkbox]:checked')]
    .map(cb => cb.value);

  result.textContent = '保存中...';
  try {
    let r;
    if (_editingGroup) {
      r = await fetch(API + '/groups/' + encodeURIComponent(_editingGroup), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc || null, macs }),
      });
    } else {
      r = await fetch(API + '/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc || null, macs }),
      });
    }
    const d = await r.json();
    if (r.ok) {
      toast(_editingGroup ? '分组已更新' : '分组已创建', 'ok');
      result.style.color = 'var(--green)';
      result.textContent = '✓ ' + d.name;
      clearGroupForm();
      loadGroups();
    } else {
      result.style.color = 'var(--red)';
      result.textContent = '✗ ' + (d.detail || '失败');
    }
  } catch(e) {
    result.style.color = 'var(--red)';
    result.textContent = '✗ ' + e.message;
  }
}

async function deleteCurrentGroup() {
  if (!_editingGroup) return;
  if (!confirm(`确认删除分组 "${_editingGroup}"？`)) return;
  try {
    const r = await fetch(API + '/groups/' + encodeURIComponent(_editingGroup), { method: 'DELETE' });
    if (r.ok) { toast('分组已删除', 'ok'); clearGroupForm(); loadGroups(); }
    else toast('删除失败', 'err');
  } catch { toast('删除失败', 'err'); }
}

async function pingInfra() {
  // Furnace + DB
  try {
    const r = await fetch(API + '/health', { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    setInfraStatus('furnace', 'online', new URL(API).hostname);
    setInfraStatus('db', d.status === 'ok' ? 'online' : 'offline', d.db_host || '-');
  } catch {
    setInfraStatus('furnace', 'offline', new URL(API).hostname);
    setInfraStatus('db', 'offline', '-');
  }
  // Dynamic cam nodes from devices table
  try {
    const r = await fetch(API + '/devices', { signal: AbortSignal.timeout(3000) });
    const { devices = [] } = await r.json();
    renderCamTopology(devices);
  } catch {
    renderCamTopology([]);
  }
}

function renderCamTopology(devices) {
  const container = document.getElementById('infra-cams');
  const mainArrow  = document.getElementById('infra-arrow-to-furnace');
  if (!container) return;
  container.innerHTML = '';

  if (!devices.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'infra-node';
    placeholder.style.opacity = '0.4';
    placeholder.innerHTML = '<div class="infra-icon">📷</div><div class="infra-name">无摄像头</div><div class="infra-meta">前往 Devices 注册</div>';
    container.appendChild(placeholder);
    if (mainArrow) mainArrow.style.display = '';
    return;
  }

  devices.forEach((d, i) => {
    if (i > 0) {
      const sep = document.createElement('div');
      sep.className = 'infra-arrow';
      sep.textContent = '·';
      container.appendChild(sep);
    }
    const key   = (d.mac || d.ip || '').replace(/[^a-z0-9]/gi, '');
    const dotId = 'tdot-' + key;
    const node  = document.createElement('div');
    node.className = 'infra-node';
    node.style.cursor = d.stream_url ? 'pointer' : 'default';
    node.title = d.stream_url ? '点击切换到此摄像头' : '';
    node.innerHTML =
      `<div class="infra-icon">📷</div>` +
      `<div class="infra-name">${esc(d.name)}</div>` +
      `<div class="infra-meta">${esc(d.ip || '-')}</div>` +
      `<span class="badge amber" id="${dotId}"><span class="status-dot checking" style="margin-right:4px"></span>检测中</span>`;

    if (d.stream_url) {
      node.onclick = () => {
        // Navigate to Live and switch
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const liveNav = document.querySelector('[data-page="live"]');
        if (liveNav) liveNav.classList.add('active');
        document.getElementById('page-live').classList.add('active');
        onPageLoad('live');
        switchDevice(d.stream_url);
      };
    }
    container.appendChild(node);

    // Heartbeat ping
    if (d.ip) {
      _pingCam(d.ip, info => _updateTopoDot(dotId, info));
    }
  });

  if (mainArrow) mainArrow.style.display = '';
}

function _updateTopoDot(dotId, info) {
  const badge = document.getElementById(dotId);
  if (!badge) return;
  const dot = badge.querySelector('.status-dot');
  if (info.online) {
    badge.className = 'badge green';
    badge.innerHTML = `<span class="status-dot online pulse" style="margin-right:4px"></span>在线`;
    badge.title = `RSSI ${info.rssi ?? '-'} dBm · 运行 ${info.uptime_sec ?? '-'}s`;
  } else {
    badge.className = 'badge red';
    badge.innerHTML = `<span class="status-dot offline" style="margin-right:4px"></span>离线`;
    badge.title = '';
  }
}

function setInfraStatus(node, status, ip) {
  const s = document.getElementById('infra-' + node + '-status');
  const m = document.getElementById('infra-' + node + '-ip');
  if (s) {
    s.textContent = status === 'online' ? '在线' : '离线';
    s.className = 'badge ' + (status === 'online' ? 'green' : 'red');
  }
  if (m && ip) m.textContent = ip;
}

async function loadDiscovered() {
  const sel = document.getElementById('dev-discovered');
  if (!sel) return;
  try {
    const r = await fetch(API + '/devices/discovered');
    const data = await r.json();
    const items = data.discovered || [];
    sel.innerHTML = '<option value="">选择已发现设备...</option>';
    items.forEach(d => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(d);
      const label = (d.device_name || d.mac) + ' · ' + (d.ip || '-') +
                    (d.is_registered ? ' ✓' : ' 未注册');
      opt.textContent = label;
      sel.appendChild(opt);
    });
  } catch { sel.innerHTML = '<option value="">发现失败</option>'; }
}

function fillDiscovered(val) {
  if (!val) return;
  const d = JSON.parse(val);
  document.getElementById('dev-mac').value  = d.mac || '';
  document.getElementById('dev-ip').value   = d.ip  || '';
  // If already registered, switch to edit mode
  if (d.is_registered && d.device_name) {
    // Find in table and trigger edit
    editDevice(d.mac);
  }
}

async function loadDeviceList() {
  const tbody = document.getElementById('devices-tbody');
  tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text3)">加载中...</td></tr>';
  try {
    const r = await fetch(API + '/devices');
    const data = await r.json();
    const devices = data.devices || [];
    document.getElementById('devices-count').textContent = `(${devices.length})`;
    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text3)">暂无注册设备</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    devices.forEach(d => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.onclick = () => editDevice(d.mac);
      const tdName = document.createElement('td');
      tdName.style.fontWeight = '700';
      tdName.textContent = d.name;
      const tdMac = document.createElement('td');
      tdMac.style.cssText = 'font-size:11px;color:var(--text2)';
      tdMac.textContent = d.mac || '-';
      const tdIp = document.createElement('td');
      tdIp.textContent = d.ip || '-';
      const tdLoc = document.createElement('td');
      tdLoc.textContent = d.location || '-';
      const tdTag = document.createElement('td');
      tdTag.style.cssText = 'font-size:11px';
      if (d.tag) {
        const chips = d.tag.split(/[,;]/).map(t => t.trim()).filter(t => t);
        tdTag.innerHTML = chips.map(t =>
          `<span style="display:inline-block;background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin-right:3px;color:var(--text2)">${esc(t)}</span>`
        ).join('');
      } else {
        tdTag.style.color = 'var(--text3)';
        tdTag.textContent = '-';
      }
      // Capability column (multi-select, comma-separated)
      const tdCap = document.createElement('td');
      const capMap = {video_in:['视频','#3b82f6'], audio_in:['麦克风','#22c55e'], audio_out:['扬声器','#f59e0b'], sensor:['传感器','#f97316']};
      const caps = Array.isArray(d.capability) ? d.capability : (d.capability || 'video_in').split(',').map(s => s.trim()).filter(Boolean);
      tdCap.innerHTML = caps.map(c => {
        const [label, color] = capMap[c] || [c, '#6b7280'];
        return `<span style="display:inline-block;background:${color}22;border:1px solid ${color}44;border-radius:4px;padding:1px 6px;font-size:11px;color:${color};margin-right:3px">${label}</span>`;
      }).join('');
      // Resolution column (only for video capable devices)
      const tdRes = document.createElement('td');
      tdRes.style.cssText = 'font-size:11px';
      const isVideo = caps.includes('video_in');
      if (isVideo) {
        const resId = 'res-' + d.mac.replace(/:/g, '_');
        tdRes.innerHTML = `<div style="display:flex;gap:4px;align-items:center">
          <select id="${resId}" style="width:110px;height:24px;padding:0 4px;border-radius:4px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:10px">
            <option value="QQVGA">QQVGA 160×120</option>
            <option value="QVGA">QVGA 320×240</option>
            <option value="VGA">VGA 640×480</option>
            <option value="SVGA">SVGA 800×600</option>
            <option value="XGA">XGA 1024×768</option>
            <option value="HD">HD 1280×720</option>
            <option value="SXGA">SXGA 1280×960</option>
            <option value="UXGA">UXGA 1600×1200</option>
          </select>
          <button class="btn" onclick="applyInlineCamConfig('${d.mac.replace(/'/g, "\\'")}','${resId}')" style="padding:2px 6px;font-size:10px;white-space:nowrap">应用</button>
        </div>`;
        // Fetch current resolution for this device
        fetch(`${API}/devices/camstatus/${d.mac}`).then(r => r.json()).then(d2 => {
          const sel = document.getElementById(resId);
          if (sel && d2.resolution) {
            for (const o of sel.options) { if (o.value === d2.resolution) { sel.value = d2.resolution; break; } }
          }
        }).catch(() => {});
      } else {
        tdRes.style.color = 'var(--text3)';
        tdRes.textContent = '-';
      }
      // OTA button
      const tdOta = document.createElement('td');
      tdOta.onclick = e => e.stopPropagation();  // don't trigger row edit
      const otaBtn = document.createElement('button');
      otaBtn.className = 'btn';
      otaBtn.style.cssText = 'padding:2px 8px;font-size:10px';
      otaBtn.textContent = '⬆ OTA';
      otaBtn.title = '选择 .bin 固件文件推送到设备';
      otaBtn.onclick = () => {
        const inp = document.getElementById('ota-file-input');
        inp.dataset.mac = d.mac;
        inp.dataset.name = d.name;
        inp.value = '';
        inp.click();
      };
      tdOta.appendChild(otaBtn);
      tr.append(tdName, tdMac, tdIp, tdLoc, tdTag, tdCap, tdRes, tdOta);
      tbody.appendChild(tr);
    });
  } catch {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--red)">加载失败</td></tr>';
  }
}

let _otaMac = '';
async function handleOtaFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const inp = event.target;
  const mac = inp.dataset.mac;
  const name = inp.dataset.name || mac;
  if (!confirm(`推送固件 "${file.name}" (${(file.size/1024).toFixed(1)} KB) 到 ${name}？\n设备升级期间会短暂重启。`)) return;

  toast(`⬆ 正在推送固件到 ${name}...`, 'ok', 30000);
  const form = new FormData();
  form.append('firmware', file, file.name);
  try {
    const r = await fetch(`${API}/devices/${encodeURIComponent(mac)}/ota`, {
      method: 'POST',
      body: form,
    });
    const d = await r.json();
    if (r.ok && d.ok) {
      toast(`✓ ${name} OTA 成功 (${(d.bytes/1024).toFixed(1)} KB)，正在重启...`, 'ok', 5000);
    } else {
      toast(`✗ OTA 失败: ${d.detail || d.msg || '未知错误'}`, 'err', 6000);
    }
  } catch (e) {
    toast(`✗ OTA 请求失败: ${e.message}`, 'err', 5000);
  }
}

async function setDefaultDevice(mac) {
  try {
    const r = await fetch(API + '/devices/' + encodeURIComponent(mac) + '/set-default', { method: 'PUT' });
    if (r.ok) {
      toast('已设为默认设备', 'ok');
      loadDeviceList();
      loadCamBar();
    } else {
      toast('设置失败', 'err');
    }
  } catch { toast('设置失败', 'err'); }
}

async function editDevice(mac) {
  try {
    const r = await fetch(API + '/devices');
    const data = await r.json();
    const d = (data.devices || []).find(x => x.mac === mac);
    if (!d) return;
    _editingMac = mac;
    document.getElementById('dev-form-title').textContent = '编辑设备';
    document.getElementById('dev-delete-btn').style.display = '';
    document.getElementById('dev-mac').value  = d.mac || '';
    document.getElementById('dev-mac').readOnly = true;
    document.getElementById('dev-mac').style.color = 'var(--text3)';
    document.getElementById('dev-ip').value   = d.ip || '';
    document.getElementById('dev-ip').readOnly = true;
    document.getElementById('dev-ip').style.color = 'var(--text3)';
    document.getElementById('dev-name').value = d.name || '';
    document.getElementById('dev-loc').value  = d.location || '';
    document.getElementById('dev-url').value  = d.stream_url || '';
    document.getElementById('dev-desc').value = d.description || '';
    document.getElementById('dev-tag').value  = d.tag || '';
    // Restore capability checkboxes
    const caps = Array.isArray(d.capability) ? d.capability : (d.capability || 'video_in').split(',').map(s => s.trim());
    document.querySelectorAll('input[name="dev-capability"]').forEach(cb => {
      cb.checked = caps.includes(cb.value);
    });
    document.getElementById('dev-register-result').textContent = '';
    // Show cam control panel only for video-capable devices
    const showCam = (d.capability || '').includes('video_in');
    document.getElementById('dev-cam-ctrl').style.display = showCam ? '' : 'none';
    if (showCam) fetchCamStatus();
  } catch { toast('加载设备信息失败', 'err'); }
}

async function fetchCamStatus() {
  if (!_editingMac) return;
  const el = document.getElementById('dev-cam-status');
  el.textContent = '查询中...';
  try {
    const r = await fetch(API + '/devices/camstatus/' + encodeURIComponent(_editingMac));
    if (!r.ok) { el.textContent = '设备离线或无法连接'; return; }
    const d = await r.json();
    const res = d.resolution || '-';
    // Sync select to current value
    const sel = document.getElementById('dev-framesize');
    for (const opt of sel.options) {
      if (opt.value === res) { sel.value = res; break; }
    }
    el.style.color = 'var(--text3)';
    el.textContent = `当前：${res} · RSSI ${d.rssi ?? '-'} dBm · 运行 ${d.uptime_sec ?? '-'}s · 堆 ${d.free_heap ? (d.free_heap/1024).toFixed(0)+'KB' : '-'}`;
  } catch { el.textContent = '查询失败'; }
}

async function applyInlineCamConfig(mac, resId) {
  const sel = document.getElementById(resId);
  if (!sel) return;
  const framesize = sel.value;
  try {
    const r = await fetch(API + '/devices/camconfig/' + encodeURIComponent(mac) + '?framesize=' + framesize, { method: 'POST' });
    if (r.ok) { toast(`已切换 → ${framesize}`, 'ok'); }
    else { toast('下发失败', 'err'); }
  } catch { toast('下发失败', 'err'); }
}

async function applyCamConfig() {
  if (!_editingMac) return;
  const framesize = document.getElementById('dev-framesize').value;
  const el = document.getElementById('dev-cam-status');
  el.textContent = '下发中...';
  try {
    const r = await fetch(
      API + '/devices/camconfig/' + encodeURIComponent(_editingMac) + '?framesize=' + framesize,
      { method: 'POST' }
    );
    if (!r.ok) { el.style.color = 'var(--red)'; el.textContent = '下发失败'; return; }
    const d = await r.json();
    el.style.color = 'var(--green)';
    el.textContent = `已切换 → ${d.resolution || framesize}`;
    setTimeout(fetchCamStatus, 1000);
  } catch { el.style.color = 'var(--red)'; el.textContent = '下发失败'; }
}

function clearDevForm() {
  _editingMac = null;
  document.getElementById('dev-form-title').textContent = '注册设备';
  document.getElementById('dev-delete-btn').style.display = 'none';
  document.getElementById('dev-cam-ctrl').style.display = 'none';
  document.getElementById('dev-cam-status').textContent = '';
  ['dev-mac','dev-ip','dev-name','dev-loc','dev-url','dev-desc','dev-tag'].forEach(id => {
    const el = document.getElementById(id);
    el.value = '';
    el.readOnly = false;
    el.style.color = '';
  });
  // Reset capability checkboxes to default (video_in only)
  document.querySelectorAll('input[name="dev-capability"]').forEach(cb => {
    cb.checked = cb.value === 'video_in';
  });
  document.getElementById('dev-register-result').textContent = '';
  const discSel = document.getElementById('dev-discovered');
  if (discSel) discSel.value = '';
}

function autoFillStreamUrl(ip) {
  // Only auto-fill when creating a new device and URL is empty
  if (_editingMac) return;
  const urlEl = document.getElementById('dev-url');
  if (ip && !urlEl.value) {
    urlEl.value = 'http://' + ip + ':81/';
  }
}

async function registerDevice() {
  const mac  = document.getElementById('dev-mac').value.trim();
  const name = document.getElementById('dev-name').value.trim();
  const ip   = document.getElementById('dev-ip').value.trim();
  const loc  = document.getElementById('dev-loc').value.trim();
  const url  = document.getElementById('dev-url').value.trim();
  const desc = document.getElementById('dev-desc').value.trim();
  const tag  = document.getElementById('dev-tag').value.trim();
  const caps = Array.from(document.querySelectorAll('input[name="dev-capability"]:checked')).map(cb => cb.value);
  const cap  = caps.join(',') || 'video_in';
  const result = document.getElementById('dev-register-result');
  if (!name) { toast('设备名为必填项', 'err'); return; }
  result.textContent = '保存中...';

  let r;
  if (_editingMac) {
    r = await fetch(API + '/devices/' + encodeURIComponent(_editingMac), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip: ip||null, location: loc||null, stream_url: url||null, description: desc||null, tag: tag||null, capability: cap }),
    });
  } else {
    if (!mac) { toast('MAC 地址为必填项', 'err'); return; }
    r = await fetch(API + '/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, name, ip: ip||null, location: loc||null, stream_url: url||null, description: desc||null, tag: tag||null, capability: cap }),
    });
  }
  const d = await r.json();
  if (r.ok) {
    toast(_editingMac ? '设备已更新' : '设备已注册', 'ok');
    result.textContent = '✓ ' + (d.name || name);
    result.style.color = 'var(--green)';
    clearDevForm();
    loadDeviceList();
    loadDiscovered();
  } else {
    result.textContent = '✗ ' + (d.detail || '失败');
    result.style.color = 'var(--red)';
  }
}

async function deleteDevice(mac) {
  if (!confirm(`确认删除设备 ${mac}？删除后可通过发现记录重新注册。`)) return;
  try {
    const r = await fetch(API + '/devices/' + encodeURIComponent(mac), { method: 'DELETE' });
    if (r.ok) { toast('设备已删除', 'ok'); clearDevForm(); loadDeviceList(); }
    else toast('删除失败', 'err');
  } catch { toast('删除失败', 'err'); }
}

function deleteCurrentDevice() {
  if (_editingMac) deleteDevice(_editingMac);
}

async function scanSubnet() {
  const subnet = document.getElementById('subnet-prefix').value.trim() || '192.168.50';
  const start  = parseInt(document.getElementById('subnet-start').value) || 1;
  const end    = parseInt(document.getElementById('subnet-end').value) || 254;
  const statusEl  = document.getElementById('subnet-scan-status');
  const resultsEl = document.getElementById('subnet-scan-results');
  const btn = document.getElementById('subnet-scan-btn');

  btn.disabled = true;
  btn.textContent = '扫描中...';
  statusEl.style.color = 'var(--text3)';
  statusEl.textContent = `正在扫描 ${subnet}.${start}–${end}，约需 10 秒...`;
  resultsEl.innerHTML = '';

  try {
    const r = await fetch(
      `${API}/devices/scan-subnet?subnet=${encodeURIComponent(subnet)}&start=${start}&end=${end}`,
      { signal: AbortSignal.timeout(30000) }
    );
    const data = await r.json();
    const found = data.found || [];
    statusEl.style.color = found.length ? 'var(--green)' : 'var(--text3)';
    statusEl.textContent = found.length ? `发现 ${found.length} 台设备` : '未发现 ESP32 设备';

    if (found.length) {
      const table = document.createElement('table');
      table.className = 'list-table';
      table.innerHTML = '<thead><tr><th>IP</th><th>MAC</th><th>设备名</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody>';
      const tbody = table.querySelector('tbody');
      found.forEach(d => {
        const tr = document.createElement('tr');
        const badge = d.registered
          ? '<span class="badge green">已注册</span>'
          : '<span class="badge amber">未注册</span>';
        const fillBtn = d.registered ? '' :
          `<button class="btn" style="padding:2px 8px;font-size:10px" onclick='fillSubnetDevice(${JSON.stringify(d)})'>注册</button>`;
        tr.innerHTML =
          `<td style="font-family:monospace;font-size:11px">${esc(d.ip)}</td>` +
          `<td style="font-family:monospace;font-size:11px">${esc(d.mac)}</td>` +
          `<td style="font-size:11px">${esc(d.name || '-')}</td>` +
          `<td>${badge}</td><td>${fillBtn}</td>`;
        tbody.appendChild(tr);
      });
      resultsEl.appendChild(table);
    }
  } catch(e) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = '扫描失败：' + e.message;
  }
  btn.disabled = false;
  btn.textContent = '🔍 扫描';
}

function fillSubnetDevice(d) {
  clearDevForm();
  document.getElementById('dev-mac').value  = d.mac || '';
  document.getElementById('dev-ip').value   = d.ip  || '';
  document.getElementById('dev-name').value = d.name || '';
  document.getElementById('dev-url').value  = d.stream_url || '';
  // Scroll to form
  document.getElementById('dev-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function pingDevices() { initDevices(); }
function setDevStatus() {}

// ══════════════════════════════════════════════════════════════
// API 页
// ══════════════════════════════════════════════════════════════
async function initApiPage() {
  loadApiBindings();
  loadApiDeviceSelect();
}

async function loadApiDeviceSelect() {
  const sel = document.getElementById('api-device-select');
  if (!sel) return;
  try {
    const r = await fetch(API + '/devices');
    const data = await r.json();
    const devices = data.devices || [];
    sel.innerHTML = '<option value="">全部设备</option>';
    devices.forEach(d => {
      const caps = Array.isArray(d.capability) ? d.capability : (d.capability || 'video_in').split(',');
      const capStr = caps.join(',');
      const opt = document.createElement('option');
      opt.value = capStr;
      opt.textContent = `${d.name} (${capStr})`;
      sel.appendChild(opt);
    });
    onApiDeviceChange();
  } catch {}
}

function onApiDeviceChange() {
  const sel = document.getElementById('api-device-select');
  const display = document.getElementById('api-cap-display');
  if (!sel) return;
  const capStr = sel.value;
  const caps = capStr ? capStr.split(',') : [];

  if (display) {
    display.textContent = capStr ? `能力: ${caps.join(', ')}` : '显示全部端点';
  }

  // 筛选 API 文档行
  document.querySelectorAll('.api-doc-row').forEach(row => {
    const rowCap = row.dataset.cap || '';
    if (!capStr) {
      row.style.display = '';
    } else {
      const match = caps.some(c => rowCap.includes(c));
      row.style.display = match ? '' : 'none';
    }
  });
}

async function loadApiBindings() {
  try {
    const [devRes, bindRes] = await Promise.all([
      fetch(API + '/devices'),
      fetch(API + '/bindings'),
    ]);
    const { devices = [] } = await devRes.json();
    const bindData = bindRes.ok ? await bindRes.json() : { endpoints: [], bindings: [] };
    _renderApiTagsTable(devices, bindData);
    _renderApiDevicesTable(devices);
  } catch {
    document.getElementById('api-tags-tbody').innerHTML =
      '<tr><td colspan="6" style="color:var(--red)">加载失败</td></tr>';
  }
}

function _renderApiTagsTable(devices, bindData) {
  const tbody = document.getElementById('api-tags-tbody');
  const endpoints = bindData.endpoints || [];

  // Map tag → enabled endpoint keys from /bindings
  const bindMap = {};
  (bindData.bindings || []).forEach(b => { bindMap[b.tag] = new Set(b.enabled || []); });

  // Group devices by tag (split comma/semicolon)
  const tagMap = {};
  devices.forEach(d => {
    if (!d.tag) return;
    const tags = d.tag.split(/[,;]/).map(t => t.trim()).filter(t => t);
    tags.forEach(tag => {
      if (!tagMap[tag]) tagMap[tag] = [];
      tagMap[tag].push(d);
    });
  });
  const tags = Object.keys(tagMap).sort();
  document.getElementById('api-tags-count').textContent = tags.length ? `${tags.length} 个 Tag` : '';
  if (!tags.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text3);padding:20px 12px">暂无 Tag — 在 Devices 页为设备设置 Tag</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  tags.forEach(tag => {
    const devs = tagMap[tag];
    const enabled = bindMap[tag] || new Set();
    const tr = document.createElement('tr');

    // Tag cell
    const tdTag = document.createElement('td');
    tdTag.innerHTML = `<span style="background:var(--accent-bg);color:var(--accent);border:1px solid rgba(99,102,241,0.25);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:600">${esc(tag)}</span>`;

    // Devices cell
    const tdDevs = document.createElement('td');
    tdDevs.innerHTML = devs.map(d =>
      `<span style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:1px 7px;margin-right:4px;font-size:11px;color:var(--text2)">${esc(d.name)}</span>`
    ).join('');

    tr.append(tdTag, tdDevs);

    // One cell per endpoint — shows full path as clickable chip
    endpoints.forEach(ep => {
      const td = document.createElement('td');
      const path = ep.path.replace('{tag}', tag);
      const isOn = enabled.has(ep.key);

      const chip = document.createElement('div');
      chip.className = 'endpoint-chip' + (isOn ? ' enabled' : '');
      chip.title = isOn ? '点击禁用' : '点击启用';
      chip.style.cursor = 'pointer';
      chip.innerHTML =
        `<span class="method">${esc(ep.method)}</span>` +
        `<span>${esc(path)}</span>`;

      chip.onclick = async () => {
        const nowOn = chip.classList.contains('enabled');
        const newEnabled = nowOn
          ? [...enabled].filter(k => k !== ep.key)
          : [...enabled, ep.key];
        chip.style.opacity = '0.5';
        try {
          const r = await fetch(API + '/bindings/' + encodeURIComponent(tag), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: newEnabled }),
          });
          if (r.ok) {
            if (nowOn) { chip.classList.remove('enabled'); enabled.delete(ep.key); }
            else        { chip.classList.add('enabled');    enabled.add(ep.key); }
            toast(`${esc(tag)} · ${nowOn ? '已禁用' : '已启用'} ${ep.key}`, 'ok', 1500);
          } else toast('保存失败', 'err');
        } catch { toast('保存失败', 'err'); }
        chip.style.opacity = '';
      };

      td.appendChild(chip);
      tr.appendChild(td);
    });

    // Action cell
    const tdAction = document.createElement('td');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.style.cssText = 'padding:2px 8px;font-size:10px;margin-right:4px';
    copyBtn.textContent = '复制';
    copyBtn.onclick = () => { navigator.clipboard.writeText(`${API}/detect/group/${encodeURIComponent(tag)}`); toast('已复制 detect 路径', 'ok', 1200); };
    const testBtn = document.createElement('button');
    testBtn.className = 'btn';
    testBtn.style.cssText = 'padding:2px 8px;font-size:10px';
    testBtn.textContent = '测试';
    testBtn.onclick = async () => {
      testBtn.disabled = true; testBtn.textContent = '...';
      try {
        const res = await fetch(`${API}/detect/group/${encodeURIComponent(tag)}`, { method: 'POST' });
        const d = await res.json();
        toast(res.ok ? `✓ ${d.count || 0} 台设备` : `✗ ${d.detail || '失败'}`, res.ok ? 'ok' : 'err');
      } catch { toast('请求失败', 'err'); }
      testBtn.disabled = false; testBtn.textContent = '测试';
    };
    tdAction.append(copyBtn, testBtn);
    tr.appendChild(tdAction);
    tbody.appendChild(tr);
  });
}

function _renderApiDevicesTable(devices) {
  const tbody = document.getElementById('api-devices-tbody');
  if (!devices.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text3)">暂无注册设备</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  devices.forEach(d => {
    const endpoint = `POST /detect/${d.mac}`;
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.style.fontWeight = '700';
    tdName.textContent = d.name;
    const tdMac = document.createElement('td');
    tdMac.style.cssText = 'font-size:11px;color:var(--text2);font-family:monospace';
    tdMac.textContent = d.mac;

    // Editable tag cell
    const tdTag = document.createElement('td');
    tdTag.style.cssText = 'font-size:11px;cursor:pointer;min-width:80px';
    const renderTagDisplay = () => {
      if (d.tag) {
        tdTag.innerHTML = d.tag.split(',').map(t => t.trim()).filter(t => t).map(t =>
          `<span style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin-right:3px">${esc(t)}</span>`
        ).join('');
      } else {
        tdTag.innerHTML = '<span style="color:var(--text3);font-size:10px">+ 添加 tag</span>';
      }
    };
    renderTagDisplay();
    tdTag.onclick = e => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = d.tag || '';
      inp.placeholder = 'desk,kitchen';
      inp.style.cssText = 'width:100%;height:24px;font-size:11px;padding:0 4px;border:1px solid var(--accent);border-radius:4px;background:var(--bg2);color:var(--text)';
      tdTag.innerHTML = '';
      tdTag.appendChild(inp);
      inp.focus();
      const save = async () => {
        const newTag = inp.value.trim() || null;
        try {
          const r = await fetch(API + '/devices/' + encodeURIComponent(d.mac), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: newTag }),
          });
          if (r.ok) { d.tag = newTag; toast('Tag 已保存', 'ok', 1200); }
        } catch {}
        renderTagDisplay();
        loadApiBindings();
      };
      inp.onblur = save;
      inp.onkeydown = e2 => { if (e2.key === 'Enter') { e2.preventDefault(); inp.blur(); } if (e2.key === 'Escape') { renderTagDisplay(); } };
    };

    const tdEndpoint = document.createElement('td');
    tdEndpoint.style.cssText = 'line-height:1.8';
    tdEndpoint.innerHTML =
      `<span class="endpoint-chip enabled"><span class="method">POST</span>/detect/${esc(d.name)}</span>` +
      `<br><span style="font-size:10px;color:var(--text3);font-family:monospace;padding-left:2px">或 /detect/${esc(d.mac)}</span>`;
    const tdAction = document.createElement('td');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.style.cssText = 'padding:2px 8px;font-size:10px;margin-right:4px';
    copyBtn.textContent = '复制';
    copyBtn.onclick = () => { navigator.clipboard.writeText(`${API}/detect/${d.name}`); toast('已复制', 'ok', 1200); };
    const testBtn = document.createElement('button');
    testBtn.className = 'btn';
    testBtn.style.cssText = 'padding:2px 8px;font-size:10px';
    testBtn.textContent = '测试';
    testBtn.onclick = async () => {
      testBtn.disabled = true; testBtn.textContent = '...';
      try {
        const res = await fetch(`${API}/detect/${encodeURIComponent(d.name)}`, { method: 'POST' });
        const data = await res.json();
        toast(res.ok ? `✓ ${data.count ?? 0} 个检测结果` : `✗ ${data.detail || '失败'}`, res.ok ? 'ok' : 'err');
      } catch { toast('请求失败', 'err'); }
      testBtn.disabled = false; testBtn.textContent = '测试';
    };
    tdAction.append(copyBtn, testBtn);
    tr.append(tdName, tdMac, tdTag, tdEndpoint, tdAction);
    tbody.appendChild(tr);
  });
}

// ══════════════════════════════════════════════════════════════
// SYSTEM 页（保留旧函数避免报错）
// ══════════════════════════════════════════════════════════════
async function loadHealth() {
  const grid = document.getElementById('health-grid');
  const cfg  = document.getElementById('config-display');
  try {
    const r = await fetch(API + '/health');
    const d = await r.json();
    grid.innerHTML = [
      ['状态',    d.status === 'ok' ? '✓ 正常' : '✗ 异常'],
      ['设备',    d.device || 'CPU'],
      ['CUDA',    d.cuda ? '✓ 启用' : '✗ 关闭'],
      ['存储模式', d.image_storage || '-'],
      ['人脸阈值', `${d.face_threshold?.high || 0.75} / ${d.face_threshold?.low || 0.40}`],
    ].map(([k,v]) => `
      <div class="health-item">
        <div class="health-key">${esc(k)}</div>
        <div class="health-val" style="color:${String(v).startsWith('✓') ? 'var(--green)' : String(v).startsWith('✗') ? 'var(--red)' : 'var(--text)'}">${esc(String(v))}</div>
      </div>`).join('');

    cfg.innerHTML = [
      ['IMAGE_STORAGE',   d.image_storage],
      ['IMAGE_DIR',       d.image_dir],
      ['IMAGE_FLIP',      d.image_flip],
      ['FACE_HIGH',       d.face_threshold?.high],
      ['FACE_LOW',        d.face_threshold?.low],
    ].map(([k,v]) => `<div><span style="color:var(--green)">${esc(k)}</span>: <span style="color:var(--text2)">${esc(String(v || '-'))}</span></div>`).join('');
  } catch {
    grid.innerHTML = '<span style="color:var(--red)">推理服务离线</span>';
    cfg.innerHTML  = '<span style="color:var(--text3)">无法获取配置</span>';
  }
  // 同步加载方向配置到 System 页下拉框
  loadOrientConfigUI();
}

function loadOrientConfigUI() {
  fetch(API + '/stream/config').then(r => r.json()).then(d => {
    document.getElementById('cfg-rotate').value  = d.rotate  || 0;
    document.getElementById('cfg-hmirror').value = d.hmirror || 0;
    document.getElementById('cfg-vflip').value   = d.vflip   || 0;
  }).catch(() => {});
}

async function saveOrientConfig() {
  const body = {
    rotate:  parseInt(document.getElementById('cfg-rotate').value),
    hmirror: parseInt(document.getElementById('cfg-hmirror').value),
    vflip:   parseInt(document.getElementById('cfg-vflip').value),
  };
  try {
    const r = await fetch(API + '/stream/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    rotate  = d.rotate;
    hmirror = d.hmirror;
    vflip   = d.vflip;
    applyCSSTransform();
    updateOrientBtns();
    toast('方向已保存', 'ok');
  } catch { toast('保存失败', 'err'); }
}

async function triggerCleanup() {
  toast('Cleanup 功能需在服务端配置自动调度', 'ok', 3000);
}

function saveApiConfig() {
  API = document.getElementById('cfg-api').value.trim();
  localStorage.setItem('vision_api', API);
  toast('配置已保存，重新连接中...', 'ok');
  checkHealth();
  initStream();
}

function restartStream() {
  initStream();
  toast('重新连接视频流...', 'ok');
}

// ── 拖拽上传 ─────────────────────────────────────────────────
function setupDropZone(zoneId, fileInputId, previewId) {
  const el = document.getElementById(zoneId);
  if (!el) return;
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', e => {
    e.preventDefault(); el.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) {
      const input = document.getElementById(fileInputId);
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      previewFile(input, previewId);
    }
  });
}

setupDropZone('item-drop-zone', 'item-file', 'item-preview');

// ── 同步 System 页的 API 地址输入框 ─────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const apiInput = document.getElementById('cfg-api');
  if (apiInput) apiInput.value = API;
  initNavDrag();
});

// ── 侧边栏导航拖拽排序 ─────────────────────────────────────
function initNavDrag() {
  const container = document.querySelector('.nav-items');
  if (!container) return;
  const items = container.querySelectorAll('.nav-item');

  // 从 localStorage 恢复顺序
  const savedOrder = localStorage.getItem('nav_order');
  if (savedOrder) {
    const order = savedOrder.split(',');
    order.forEach(page => {
      const item = container.querySelector(`[data-page="${page}"]`);
      if (item) container.appendChild(item);
    });
  }

  items.forEach(item => {
    item.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.dataset.page);
      item.classList.add('dragging');
      item.style.opacity = '0.5';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      item.style.opacity = '';
      saveNavOrder(container);
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragging = container.querySelector('.dragging');
      if (!dragging || dragging === item) return;
      const rect = item.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        container.insertBefore(dragging, item);
      } else {
        container.insertBefore(dragging, item.nextSibling);
      }
    });
  });
}

function saveNavOrder(container) {
  const order = Array.from(container.querySelectorAll('.nav-item'))
    .map(el => el.dataset.page).join(',');
  localStorage.setItem('nav_order', order);
}

// ── Listen / Audio 页面 ─────────────────────────────────────
let listenDevice = '';

async function loadListenDevices() {
  // 加载设备列表（用于录音选择）
  const sel = document.getElementById('listen-device');
  if (sel) {
    try {
      const r = await fetch(API + '/devices');
      const data = await r.json();
      const devices = data.devices || [];
      const audioDevices = devices.filter(d => {
        const caps = Array.isArray(d.capability) ? d.capability : (d.capability || 'video_in').split(',');
        return caps.includes('audio_in') || caps.includes('audio_out');
      });
      sel.innerHTML = '';
      if (audioDevices.length === 0) {
        sel.innerHTML = '<option value="">无音频设备</option>';
      } else {
        audioDevices.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.ip;
          opt.textContent = `${d.name || d.ip} (${d.ip})`;
          sel.appendChild(opt);
        });
        listenDevice = audioDevices[0].ip;
      }
    } catch { sel.innerHTML = '<option value="">加载失败</option>'; }
  }

  // 加载设备能力配置
  const listEl = document.getElementById('audio-device-list');
  if (listEl) {
    try {
      const r = await fetch(API + '/devices');
      const data = await r.json();
      const devices = data.devices || [];
      if (!devices.length) {
        listEl.innerHTML = '<p style="color:var(--text3);font-size:12px">无注册设备</p>';
        return;
      }
      listEl.innerHTML = '';
      devices.forEach(d => {
        const caps = Array.isArray(d.capability) ? d.capability : (d.capability || 'video_in').split(',');
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px';
        row.innerHTML = `
          <div style="min-width:120px;font-weight:600">${esc(d.name)}</div>
          <div style="min-width:100px;color:var(--text3)">${esc(d.ip || '-')}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
              <input type="checkbox" name="cap-${d.mac.replace(/:/g,'_')}" value="video_in" ${caps.includes('video_in')?'checked':''} onchange="updateDeviceCapability('${d.mac}',this.value,this.checked)">
              视频
            </label>
            <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
              <input type="checkbox" name="cap-${d.mac.replace(/:/g,'_')}" value="audio_in" ${caps.includes('audio_in')?'checked':''} onchange="updateDeviceCapability('${d.mac}',this.value,this.checked)">
              麦克风
            </label>
            <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
              <input type="checkbox" name="cap-${d.mac.replace(/:/g,'_')}" value="audio_out" ${caps.includes('audio_out')?'checked':''} onchange="updateDeviceCapability('${d.mac}',this.value,this.checked)">
              扬声器
            </label>
            <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
              <input type="checkbox" name="cap-${d.mac.replace(/:/g,'_')}" value="sensor" ${caps.includes('sensor')?'checked':''} onchange="updateDeviceCapability('${d.mac}',this.value,this.checked)">
              传感器
            </label>
          </div>
        `;
        listEl.appendChild(row);
      });
    } catch { listEl.innerHTML = '<p style="color:var(--red);font-size:12px">加载失败</p>'; }
  }
}

async function updateDeviceCapability(mac, value, checked) {
  // 获取当前所有选中的能力
  const checkboxes = document.querySelectorAll(`input[name="cap-${mac.replace(/:/g,'_')}"]`);
  const caps = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
  const capStr = caps.join(',') || 'video_in';
  try {
    const r = await fetch(API + '/devices/' + encodeURIComponent(mac), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: capStr }),
    });
    if (r.ok) {
      toast(`${mac} 能力已更新: ${capStr}`, 'ok');
      loadListenDevices(); // 刷新列表
    } else {
      toast('更新失败', 'err');
    }
  } catch { toast('更新失败', 'err'); }
}

// ── 录音按钮切换 ─────────────────────────────────────
let _listenAbort = null;

function toggleListen() {
  const btn = document.getElementById('btn-record');
  if (_listenAbort) {
    // 停止录音
    _listenAbort.abort();
    _listenAbort = null;
    btn.textContent = '🎤 录音 5s';
    btn.style.background = '';
    document.getElementById('listen-status').textContent = '已停止';
    document.getElementById('listen-status').style.color = 'var(--text3)';
    return;
  }
  // 开始录音
  btn.textContent = '⏹ 停止';
  btn.style.background = 'var(--red)';
  startListen();
}

async function startListen() {
  const statusEl = document.getElementById('listen-status');
  const logEl = document.getElementById('listen-log');
  const playerContainer = document.getElementById('listen-player');
  const playerEmpty = document.getElementById('listen-player-empty');
  const btnPlay = document.getElementById('btn-play');
  const playInfo = document.getElementById('playback-info');
  const waveContainer = document.getElementById('waveform-container');
  const waveCanvas = document.getElementById('waveform-canvas');
  const waveLevel = document.getElementById('waveform-level');
  const waveInfo = document.getElementById('waveform-info');
  const deviceIp = document.getElementById('listen-device').value;
  if (!deviceIp) { toast('请先选择音频设备', 'err'); return; }

  _listenAbort = new AbortController();
  waveContainer.style.display = '';
  waveInfo.textContent = '🔴 录音中...';
  statusEl.textContent = '录音中... (5秒)';
  statusEl.style.color = 'var(--blue)';
  listenLog(logEl, `触发录音: ${deviceIp}`);

  try {
    // 查找设备 MAC
    const devices = (await (await fetch(API + '/devices')).json()).devices || [];
    const dev = devices.find(d => d.ip === deviceIp);
    if (!dev) { statusEl.textContent = '设备未注册'; statusEl.style.color = 'var(--red)'; return; }

    const r = await fetch(API + '/devices/' + encodeURIComponent(dev.mac) + '/record', {
      method: 'POST', signal: AbortSignal.timeout(40000),
    });
    const d = await r.json();
    if (d.status === 'recording_started') {
      listenLog(logEl, '录音已启动，等待5秒...');
      waveInfo.textContent = '🔴 录音中... (5秒)';
      waveContainer.style.display = '';

      // 录音倒计时 + 实时频率可视化（用电脑麦克风采集）
      let recSec = 5;
      waveInfo.textContent = `🔴 录音中... ${recSec}s`;
      const recTimer = setInterval(() => {
        recSec--;
        if (recSec <= 0) {
          clearInterval(recTimer);
          waveInfo.textContent = '📥 获取录音...';
          return;
        }
        waveInfo.textContent = `🔴 录音中... ${recSec}s`;
      }, 1000);

      // 用电脑麦克风实时显示频率柱状图
      let micStream = null;
      let audioCtx = null;
      let analyser = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new AudioContext({ sampleRate: 16000 });
        const source = audioCtx.createMediaStreamSource(micStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const ctx = waveCanvas.getContext('2d');
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        function drawMicBars() {
          if (recSec <= 0) return;
          analyser.getByteFrequencyData(dataArray);
          const width = waveCanvas.width;
          const height = waveCanvas.height;
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(0, 0, width, height);

          const barCount = 40;
          const barWidth = width / barCount;
          const step = Math.floor(bufferLength / barCount);

          for (let i = 0; i < barCount; i++) {
            const val = dataArray[i * step];
            const barHeight = (val / 255) * (height * 0.85);
            const hue = 200 + (i / barCount) * 160;
            ctx.fillStyle = `hsl(${hue}, 70%, ${40 + (val/255)*25}%)`;
            ctx.fillRect(i * barWidth + 0.5, height - barHeight - 2, barWidth - 1, barHeight);
          }
          waveLevel.textContent = `音量: ${Math.max(...dataArray)}`;
          requestAnimationFrame(drawMicBars);
        }
        drawMicBars();
      } catch (e) {
        // 麦克风不可用，显示等待状态
        waveInfo.textContent = '🔴 录音中... (无实时波形)';
      }

      // 等待录音+上传完成
      await new Promise(resolve => setTimeout(resolve, 8000));
      clearInterval(recTimer);
      if (micStream) micStream.getTracks().forEach(t => t.stop());
      if (audioCtx) audioCtx.close();

      // 从服务器获取 ESP32 的录音
      statusEl.textContent = '获取录音...';
      waveInfo.textContent = '📥 从服务器获取录音...';
      listenLog(logEl, '从服务器获取 ESP32 录音...');

      const audioR = await fetch(`${API}/audio/latest?device=${encodeURIComponent(dev.name)}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (audioR.ok) {
        const audioData = await audioR.arrayBuffer();
        const sampleRate = 16000;
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const blockAlign = numChannels * bitsPerSample / 8;
        const dataSize = audioData.byteLength;

        // 构建 WAV 文件头
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        // 合并 WAV 头 + PCM 数据
        const wavBlob = new Blob([header, audioData], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(wavBlob);

        // 绘制波形
        drawWaveform(waveCanvas, audioData, sampleRate);
        const duration = (dataSize / byteRate).toFixed(1);
        waveInfo.textContent = `✅ 音频就绪 · ${duration}s · ${(audioData.byteLength/1024).toFixed(1)}KB`;
        waveLevel.textContent = '音量: 已收到';

        // 根据输出设备选择播放方式
        const outputDevice = document.getElementById('output-device').value;
        if (outputDevice === 'esp32') {
          // 发送到 ESP32 扬声器播放
          statusEl.textContent = '发送到 ESP32...';
          listenLog(logEl, `发送 ${duration}s 音频到 ESP32 扬声器...`);
          try {
            const speakR = await fetch(API + '/speak', {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream', 'X-Device': dev.mac },
              body: audioData,
              signal: AbortSignal.timeout(10000),
            });
            if (speakR.ok) {
              statusEl.textContent = '已发送到 ESP32 ✅';
              statusEl.style.color = 'var(--green)';
              listenLog(logEl, 'ESP32 播放指令已发送');
            } else {
              statusEl.textContent = '发送失败';
              statusEl.style.color = 'var(--red)';
            }
          } catch (e) {
            statusEl.textContent = '发送失败: ' + e.message;
            statusEl.style.color = 'var(--red)';
          }
        } else {
          // 显示播放器
          const playerContainer = document.getElementById('listen-player');
          const playerEmpty = document.getElementById('listen-player-empty');
          const audio = document.getElementById('listen-audio');
          const btnPlay = document.getElementById('btn-play');
          const playInfo = document.getElementById('playback-info');

          playerContainer.style.display = '';
          playerEmpty.style.display = 'none';
          audio.src = audioUrl;
          audio.style.display = 'none';

          btnPlay.textContent = '▶ 播放';
          playInfo.textContent = `${duration}s · ${(audioData.byteLength/1024).toFixed(1)}KB`;

          // 播放/停止切换
          btnPlay.onclick = () => {
            if (audio.paused) {
              audio.play();
              btnPlay.textContent = '⏹ 停止';
              statusEl.textContent = '播放中...';
              statusEl.style.color = 'var(--green)';
              listenLog(logEl, `开始播放 ${duration}s 音频`);
            } else {
              audio.pause();
              audio.currentTime = 0;
              btnPlay.textContent = '▶ 播放';
              statusEl.textContent = '已暂停';
              statusEl.style.color = 'var(--text3)';
            }
          };

          audio.onended = () => {
            btnPlay.textContent = '▶ 播放';
            statusEl.textContent = '播放完成 ✅';
            statusEl.style.color = 'var(--green)';
            waveInfo.textContent = `✅ 播放完成 · ${duration}s`;
          };

          listenLog(logEl, `收到音频 ${(audioData.byteLength/1024).toFixed(1)}KB, ${duration}s`);
        }
      } else {
        statusEl.textContent = '获取失败';
        statusEl.style.color = 'var(--red)';
        waveInfo.textContent = '❌ 获取失败';
      }
    } else {
      statusEl.textContent = d.error || '录音失败';
      statusEl.style.color = 'var(--red)';
      waveInfo.textContent = '❌ 录音失败';
    }
  } catch (e) {
    statusEl.textContent = '请求失败: ' + e.message;
    statusEl.style.color = 'var(--red)';
    listenLog(logEl, '错误: ' + e.message);
    waveInfo.textContent = '❌ 错误: ' + e.message;
  }
}

// 绘制波形图
function drawWaveform(canvas, pcmData, sampleRate) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const data = new Int16Array(pcmData);

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);

  // 计算 FFT 频率响应
  const fftSize = 256;
  const freqBins = fftSize / 2;
  const fftData = new Float32Array(freqBins);

  // 分段计算频率响应
  const segSize = Math.floor(data.length / 4);
  for (let seg = 0; seg < 4; seg++) {
    const segStart = seg * segSize;
    for (let i = 0; i < freqBins && (segStart + i * 2) < data.length; i++) {
      const real = data[segStart + i * 2] || 0;
      const imag = data[segStart + i * 2 + 1] || 0;
      fftData[i] += Math.sqrt(real * real + imag * imag) / 4;
    }
  }

  // 绘制频率响应柱状图（从左到右 = 低频到高频）
  const barCount = 40;
  const barWidth = width / barCount;
  let maxVal = 0;
  for (let i = 0; i < freqBins; i++) {
    if (fftData[i] > maxVal) maxVal = fftData[i];
  }
  if (maxVal === 0) maxVal = 1;

  for (let i = 0; i < barCount; i++) {
    const binIdx = Math.floor(i * freqBins / barCount);
    const val = fftData[binIdx] / maxVal;
    const barHeight = val * (height * 0.85);
    // 颜色：低频蓝 → 中频绿 → 高频红
    const hue = 200 + (i / barCount) * 160;
    ctx.fillStyle = `hsl(${hue}, 70%, ${40 + val * 25}%)`;
    ctx.fillRect(i * barWidth + 0.5, height - barHeight - 2, barWidth - 1, barHeight);
  }
}

function listenLog(logEl, msg) {
  if (!logEl) return;
  if (logEl.querySelector('p')) logEl.innerHTML = '';
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.textContent = `[${time}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── 浏览器麦克风录音 ──────────────────────────────────────
async function startBrowserMic() {
  const statusEl = document.getElementById('listen-status');
  const logEl = document.getElementById('listen-log');
  const playerEl = document.getElementById('listen-player');
  const waveContainer = document.getElementById('waveform-container');
  const waveCanvas = document.getElementById('waveform-canvas');
  const waveLevel = document.getElementById('waveform-level');
  const waveInfo = document.getElementById('waveform-info');

  // 检查浏览器是否支持 getUserMedia
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = '浏览器不支持麦克风（需 HTTPS 或 localhost）';
    statusEl.style.color = 'var(--red)';
    listenLog(logEl, 'navigator.mediaDevices 不可用 — 请用 localhost 访问页面，或在 Chrome 中启用 insecure origin 白名单');
    return;
  }

  statusEl.textContent = '请求麦克风权限...';
  statusEl.style.color = 'var(--blue)';
  listenLog(logEl, '请求浏览器麦克风权限...');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    // 显示波形
    waveContainer.style.display = '';
    waveInfo.textContent = '🔴 浏览器录音中...';
    statusEl.textContent = '录音中... (5秒)';
    statusEl.style.color = 'var(--blue)';
    listenLog(logEl, '浏览器录音开始，5秒...');

    // 实时绘制波形
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = waveCanvas.getContext('2d');
    let animFrame;

    function drawWave() {
      analyser.getByteFrequencyData(dataArray);
      const width = waveCanvas.width;
      const height = waveCanvas.height;
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);

      const barCount = 64;
      const barWidth = width / barCount;
      const step = Math.floor(bufferLength / barCount);

      let maxVal = 0;
      for (let i = 0; i < bufferLength; i++) {
        if (dataArray[i] > maxVal) maxVal = dataArray[i];
      }
      waveLevel.textContent = `音量: ${maxVal}`;

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i * step];
        const barHeight = (val / 255) * (height - 10);
        const hue = 120 + (val / 255) * 120; // 绿到黄
        ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
        ctx.fillRect(i * barWidth + 1, height / 2 - barHeight / 2, barWidth - 2, barHeight);
      }

      animFrame = requestAnimationFrame(drawWave);
    }
    drawWave();

    // 录音 5 秒
    const sampleRate = 16000;
    const duration = 5;
    const recordingBuffer = audioContext.createBuffer(1, sampleRate * duration, sampleRate);
    const channelData = recordingBuffer.getChannelData(0);

    // 使用 ScriptProcessorNode 采集（兼容性更好）
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    let writeIndex = 0;
    source.connect(processor);
    processor.connect(audioContext.destination);

    await new Promise(resolve => {
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const remaining = channelData.length - writeIndex;
        const toCopy = Math.min(input.length, remaining);
        channelData.set(input.subarray(0, toCopy), writeIndex);
        writeIndex += toCopy;
      };
      setTimeout(() => {
        processor.disconnect();
        source.disconnect();
        cancelAnimationFrame(animFrame);
        resolve();
      }, duration * 1000);
    });

    stream.getTracks().forEach(t => t.stop());
    audioContext.close();

    waveInfo.textContent = '📥 处理音频...';
    waveLevel.textContent = '音量: 录音完成';

    // 转为 16-bit PCM
    const pcm16 = new Int16Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // 发送到服务器
    listenLog(logEl, `发送 ${pcm16.byteLength} 字节到服务器...`);
    statusEl.textContent = '发送到服务器...';

    const r = await fetch(`${API}/audio/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '16000', 'X-Device': 'browser-mic' },
      body: pcm16.buffer,
      signal: AbortSignal.timeout(10000),
    });

    if (r.ok) {
      const audioData = await r.arrayBuffer();
      const sampleRate = 16000;
      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * bitsPerSample / 8;
      const dataSize = audioData.byteLength;

      // 构建 WAV 文件头
      const header = new ArrayBuffer(44);
      const view = new DataView(header);
      const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, numChannels * bitsPerSample / 8, true);
      view.setUint16(34, bitsPerSample, true);
      writeString(36, 'data');
      view.setUint32(40, dataSize, true);

      const wavBlob = new Blob([header, audioData], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(wavBlob);

      // 绘制返回音频波形
      drawWaveform(waveCanvas, audioData, sampleRate);
      waveInfo.textContent = `✅ 收到回声 ${(dataSize/1024).toFixed(1)}KB`;

      const audio = new Audio(audioUrl);
      playerEl.innerHTML = '';
      playerEl.appendChild(audio);
      audio.controls = true;
      audio.style.width = '100%';
      audio.style.height = '40px';
      audio.play();

      statusEl.textContent = '回声播放中 ✅';
      statusEl.style.color = 'var(--green)';
      listenLog(logEl, `收到回声 ${(audioData.byteLength/1024).toFixed(1)}KB，应能听到自己说话`);

      audio.onended = () => {
        statusEl.textContent = '完成 ✅';
        waveInfo.textContent = '✅ 回声播放完成';
      };
    } else {
      statusEl.textContent = '服务器错误';
      statusEl.style.color = 'var(--red)';
    }
  } catch (e) {
    statusEl.textContent = '错误: ' + e.message;
    statusEl.style.color = 'var(--red)';
    listenLog(logEl, '错误: ' + e.message);
  }
}

// ── 语音识别（服务端 faster-whisper）─────────────────────
let _speechActive = false;

function toggleSpeech() {
  if (_speechActive) {
    stopSpeech();
  } else {
    startSpeech();
  }
}

async function startSpeech() {
  const btn = document.getElementById('btn-speech');
  const statusEl = document.getElementById('speech-status');
  const resultEl = document.getElementById('speech-result');
  const interimEl = document.getElementById('speech-interim');
  const finalEl = document.getElementById('speech-final');
  const emptyEl = document.getElementById('speech-empty');

  _speechActive = true;
  btn.textContent = '⏹ 停止识别';
  btn.style.background = 'var(--red)';
  statusEl.textContent = '🔴 识别中...';
  statusEl.style.color = 'var(--blue)';
  resultEl.style.display = '';
  emptyEl.style.display = 'none';
  finalEl.textContent = '';
  interimEl.textContent = '录音中，请说话...';

  // 使用电脑麦克风持续录音，每 3 秒发送一次识别
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const buffer = [];
    source.connect(processor);
    processor.connect(audioContext.destination);

    // 每 3 秒发送一次音频进行识别
    const sendInterval = setInterval(async () => {
      if (!_speechActive || buffer.length === 0) return;

      // 从 buffer 中取出音频数据
      const audioData = new Float32Array(buffer.splice(0));
      // 转为 16-bit PCM
      const pcm16 = new Int16Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        const s = Math.max(-1, Math.min(1, audioData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      try {
        const r = await fetch(`${API}/speech/recognize`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '16000', 'X-Device': 'browser' },
          body: pcm16.buffer,
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const result = await r.json();
          if (result.text) {
            finalEl.textContent += result.text + ' ';
            resultEl.scrollTop = resultEl.scrollHeight;
            statusEl.textContent = `识别中... (${finalEl.textContent.length}字)`;
          }
        }
      } catch (e) {
        // 网络错误，忽略继续
      }
    }, 3000);

    // 采集音频数据
    processor.onaudioprocess = (e) => {
      if (!_speechActive) return;
      const input = e.inputBuffer.getChannelData(0);
      buffer.push(...input);
      // 限制 buffer 大小（最多 10 秒）
      if (buffer.length > 160000) buffer.splice(0, 32000);
    };

    statusEl.textContent = '🔴 识别中...';

    // 保存引用以便停止
    window._speechStream = stream;
    window._speechProcessor = processor;
    window._speechAudioContext = audioContext;
    window._speechSendInterval = sendInterval;

  } catch (e) {
    statusEl.textContent = '错误: ' + e.message;
    statusEl.style.color = 'var(--red)';
    _speechActive = false;
    btn.textContent = '🎙️ 开始识别';
    btn.style.background = '';
  }
}

function stopSpeech() {
  const btn = document.getElementById('btn-speech');
  const statusEl = document.getElementById('speech-status');
  _speechActive = false;

  if (window._speechStream) {
    window._speechStream.getTracks().forEach(t => t.stop());
    window._speechStream = null;
  }
  if (window._speechProcessor) {
    window._speechProcessor.disconnect();
    window._speechProcessor = null;
  }
  if (window._speechAudioContext) {
    window._speechAudioContext.close();
    window._speechAudioContext = null;
  }
  if (window._speechSendInterval) {
    clearInterval(window._speechSendInterval);
    window._speechSendInterval = null;
  }

  btn.textContent = '🎙️ 开始识别';
  btn.style.background = '';
  statusEl.textContent = '已停止';
  statusEl.style.color = 'var(--text3)';
}
