// ── 全局配置 ─────────────────────────────────────────────────
let API = localStorage.getItem('vision_api') || location.origin;

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
  if (name === 'history') loadHistory();
  if (name === 'items')   loadItems();
  if (name === 'faces')   loadFaces();
  if (name === 'devices') initDevices();
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

function initStream() {
  const img = document.getElementById('stream-img');
  img.src = API + '/stream?' + Date.now();
  img.style.display = '';
  streaming = true;
  document.getElementById('btn-stream').textContent = '⏹ 断开';
  document.getElementById('btn-stream').className = 'btn connected';
  loadOrientConfig();
  loadCamBar();
}

function stopStream() {
  const img = document.getElementById('stream-img');
  img.src = '';
  img.style.display = 'none';
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
    _devices = devices;
    bar.innerHTML = '';
    devices.forEach(d => {
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
  populateDetectScope();
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
  document.getElementById('live-status').textContent = '离线';
  document.getElementById('live-status').className = 'badge red';
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
function setScopeBtn(btn) {
  document.querySelectorAll('.scope-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const scope = btn.dataset.scope || 'current';
  const cards = document.querySelectorAll('#cam-bar .cam-card');
  cards.forEach(card => {
    if (scope === 'current' || scope === 'all') {
      card.classList.remove('scope-dim');
    } else {
      // scope === 'group:tagname'
      const tag = scope.replace(/^group:/, '');
      const cardTags = (card.dataset.tag || '').split(/[,;]/).map(t => t.trim());
      if (cardTags.includes(tag)) {
        card.classList.remove('scope-dim');
      } else {
        card.classList.add('scope-dim');
      }
    }
  });
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
      btn.onclick = () => setScopeBtn(btn);
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

// 检测
async function triggerDetect() {
  const result = document.getElementById('detect-result');
  result.innerHTML = '<span style="color:var(--text3)">拍照中...</span>';
  try {
    const capR = await fetch(API + '/stream/capture');
    if (!capR.ok) { result.textContent = '拍照失败：摄像头离线'; result.style.color = 'var(--red)'; return; }
    const blob = await capR.blob();
    result.innerHTML = '<span style="color:var(--text3)">识别中...</span>';
    const fd = new FormData();
    fd.append('file', blob, 'capture.jpg');
    fd.append('camera_ip', _currentCamIp);
    if (_currentCamMac) fd.append('device_mac', _currentCamMac);
    const detectR = await fetch(API + '/describe', { method: 'POST', body: fd });
    const data = await detectR.json();
    result.innerHTML = '';
    if (data.description && data.description !== 'No objects detected') {
      const tags = (data.description.replace('Detected: ', '')).split(', ');
      tags.forEach(t => {
        const span = document.createElement('span');
        span.className = 'detect-tag';
        span.textContent = t.trim();
        result.appendChild(span);
      });
    } else {
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
  for (let i = 0; i < total; i++) {
    progressText.textContent = `${i} / ${total}`;
    progressBar.style.width = `${Math.round(i / total * 100)}%`;
    const fd = new FormData();
    fd.append('file', _faceFiles[i]);
    fd.append('name', name);
    try {
      const r = await fetch(API + '/face/register', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.status === 'ok') succeeded++;
      else errors.push(`第 ${i+1} 张: ${d.error || JSON.stringify(d)}`);
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
  tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text3)">加载中...</td></tr>';
  try {
    const r = await fetch(API + '/devices');
    const data = await r.json();
    const devices = data.devices || [];
    document.getElementById('devices-count').textContent = `(${devices.length})`;
    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text3)">暂无注册设备</td></tr>';
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
      tr.append(tdName, tdMac, tdIp, tdLoc, tdTag, tdOta);
      tbody.appendChild(tr);
    });
  } catch {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--red)">加载失败</td></tr>';
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
    document.getElementById('dev-register-result').textContent = '';
    // Show cam control panel and fetch live status
    document.getElementById('dev-cam-ctrl').style.display = '';
    fetchCamStatus();
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

async function scanByIP() {
  const ip = document.getElementById('scan-ip').value.trim();
  const resultEl = document.getElementById('scan-result');
  if (!ip) { resultEl.textContent = '请输入 IP 地址'; return; }
  resultEl.style.color = 'var(--text3)';
  resultEl.textContent = '扫描中...';
  try {
    const r = await fetch(API + '/devices/scan?ip=' + encodeURIComponent(ip));
    if (!r.ok) {
      const e = await r.json();
      resultEl.style.color = 'var(--red)';
      resultEl.textContent = e.detail || '扫描失败';
      return;
    }
    const d = await r.json();
    // Pre-fill the form
    clearDevForm();
    document.getElementById('dev-mac').value  = d.mac || '';
    document.getElementById('dev-ip').value   = d.ip  || ip;
    document.getElementById('dev-name').value = d.name || '';
    document.getElementById('dev-loc').value  = d.location || '';
    document.getElementById('dev-url').value  = d.stream_url || '';
    resultEl.style.color = d.registered ? 'var(--green)' : 'var(--text3)';
    resultEl.textContent = d.registered
      ? `已注册设备，MAC: ${d.mac}`
      : `发现 ${d.name || '未命名设备'}，MAC: ${d.mac} — 请填写设备名后保存`;
    if (d.registered) loadDeviceList();
  } catch {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = '无法连接，请确认 IP 地址和网络';
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
  const result = document.getElementById('dev-register-result');
  if (!name) { toast('设备名为必填项', 'err'); return; }
  result.textContent = '保存中...';

  let r;
  if (_editingMac) {
    r = await fetch(API + '/devices/' + encodeURIComponent(_editingMac), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip: ip||null, location: loc||null, stream_url: url||null, description: desc||null, tag: tag||null }),
    });
  } else {
    if (!mac) { toast('MAC 地址为必填项', 'err'); return; }
    r = await fetch(API + '/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, name, ip: ip||null, location: loc||null, stream_url: url||null, description: desc||null, tag: tag||null }),
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

async function pingDevices() { initDevices(); }
function setDevStatus() {}

// ══════════════════════════════════════════════════════════════
// API 页
// ══════════════════════════════════════════════════════════════
async function initApiPage() {
  loadApiBindings();
  // populate API address input
  const inp = document.getElementById('cfg-api');
  if (inp) inp.value = API;
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
});
