// ── 全局配置 ─────────────────────────────────────────────────
let API = localStorage.getItem('vision_api') || location.origin;

// ── 工具函数 ─────────────────────────────────────────────────
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
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
  if (name === 'history') loadHistory();
  if (name === 'items')   loadItems();
  if (name === 'faces')   loadFaces();
  if (name === 'devices') initDevices();
  if (name === 'system')  loadHealth();
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

// ══════════════════════════════════════════════════════════════
// LIVE 页
// ══════════════════════════════════════════════════════════════
let rotate  = 0;
let hmirror = 0;
let vflip   = 0;
let streaming = false;

function initStream() {
  const img = document.getElementById('stream-img');
  img.src = API + '/stream?' + Date.now();
  img.style.display = '';
  streaming = true;
  img.onload = () => {
    document.getElementById('stream-offline').style.display = 'none';
    document.getElementById('live-status').textContent = 'LIVE';
    document.getElementById('live-status').className = 'badge green';
    document.getElementById('btn-stream').textContent = '⏹ 断开';
    document.getElementById('btn-stream').classList.add('danger');
  };
  loadOrientConfig();
}

function stopStream() {
  const img = document.getElementById('stream-img');
  img.src = '';
  img.style.display = 'none';
  streaming = false;
  document.getElementById('stream-offline').style.display = 'flex';
  document.getElementById('live-status').textContent = '已断开';
  document.getElementById('live-status').className = 'badge amber';
  document.getElementById('btn-stream').textContent = '▶ 连接';
  document.getElementById('btn-stream').classList.remove('danger');
}

function toggleStream() {
  streaming ? stopStream() : initStream();
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
  const dm = document.getElementById('dev-mirror-btn');
  const dv = document.getElementById('dev-vflip-btn');
  if (dm) dm.classList.toggle('primary', hmirror === 1);
  if (dv) dv.classList.toggle('primary', vflip === 1);
  const ds = document.getElementById('dev-orient-status');
  if (ds) {
    const parts = [];
    if (hmirror) parts.push('水平镜像');
    if (vflip)   parts.push('上下翻转');
    if (rotate)  parts.push(`旋转${rotate}°`);
    ds.textContent = parts.length ? parts.join(' · ') : '默认方向';
  }
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

// 检测
async function triggerDetect() {
  const result = document.getElementById('detect-result');
  result.innerHTML = '<span style="color:var(--text3)">拍照中...</span>';
  try {
    const capR = await fetch(API + '/stream/capture');
    const blob = await capR.blob();
    const fd = new FormData();
    fd.append('file', blob, 'capture.jpg');
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

// 人脸识别
async function triggerFaceIdentify() {
  const result = document.getElementById('face-result');
  result.textContent = '识别中...';
  try {
    const capR = await fetch(API + '/stream/capture');
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
  const grid = document.getElementById('history-grid');
  grid.innerHTML = '<span style="color:var(--text3)">加载中...</span>';
  try {
    const r = await fetch(API + '/search?limit=50');
    const data = await r.json();
    renderHistoryGrid(data.results || []);
  } catch { grid.innerHTML = '<span style="color:var(--red)">加载失败</span>'; }
}

async function searchHistory() {
  const label = document.getElementById('search-label').value.trim();
  if (!label) return loadHistory();
  const grid = document.getElementById('history-grid');
  grid.innerHTML = '<span style="color:var(--text3)">搜索中...</span>';
  try {
    const r = await fetch(`${API}/search?label=${encodeURIComponent(label)}&limit=50`);
    const data = await r.json();
    renderHistoryGrid(data.results || []);
  } catch { grid.innerHTML = '<span style="color:var(--red)">搜索失败</span>'; }
}

function renderHistoryGrid(results) {
  const grid = document.getElementById('history-grid');
  if (!results.length) {
    grid.innerHTML = '<span style="color:var(--text3)">暂无记录</span>';
    return;
  }
  grid.innerHTML = '';
  results.forEach(r => {
    const card = document.createElement('div');
    card.className = 'history-card';
    const time = new Date(r.captured_at).toLocaleString('zh-CN', { hour12: false });
    const tags = (r.labels || []).slice(0, 4);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'history-info';

    const timeDiv = document.createElement('div');
    timeDiv.className = 'history-time';
    timeDiv.textContent = time;
    infoDiv.appendChild(timeDiv);

    const deviceDiv = document.createElement('div');
    deviceDiv.style.cssText = 'font-size:11px;color:var(--text2);margin-bottom:4px';
    deviceDiv.textContent = r.device_name || r.camera_ip || '未知设备';
    infoDiv.appendChild(deviceDiv);

    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'history-tags';
    tags.forEach(t => {
      const span = document.createElement('span');
      span.className = 'history-tag';
      span.textContent = t;
      tagsDiv.appendChild(span);
    });
    infoDiv.appendChild(tagsDiv);

    if (r.description) {
      const descDiv = document.createElement('div');
      descDiv.style.cssText = 'font-size:10px;color:var(--text3);margin-top:4px';
      descDiv.textContent = r.description;
      infoDiv.appendChild(descDiv);
    }

    card.appendChild(infoDiv);
    grid.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════════════
// ITEMS 页
// ══════════════════════════════════════════════════════════════
async function loadItems() {
  try {
    const r = await fetch(API + '/items');
    const data = await r.json();
    const items = data.items || [];
    document.getElementById('items-count').textContent = `(${items.length})`;
    const tbody = document.getElementById('items-tbody');
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text3)">暂无注册物品</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    items.forEach(it => {
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.textContent = it.label;
      const tdCount = document.createElement('td');
      tdCount.innerHTML = `<span class="badge blue">${esc(String(it.sample_count))}</span>`;
      const tdTime = document.createElement('td');
      tdTime.textContent = new Date(it.registered_at).toLocaleDateString('zh-CN');
      tr.append(tdLabel, tdCount, tdTime);
      tbody.appendChild(tr);
    });
  } catch {
    document.getElementById('items-tbody').innerHTML = '<tr><td colspan="3" style="color:var(--red)">加载失败</td></tr>';
  }
}

async function registerItem() {
  const file  = document.getElementById('item-file').files[0];
  const label = document.getElementById('item-label').value.trim();
  const desc  = document.getElementById('item-desc').value.trim();
  if (!file || !label) { toast('请选择图片并填写物品名称', 'err'); return; }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('label', label);
  if (desc) fd.append('description', desc);
  try {
    const r = await fetch(API + '/register', { method: 'POST', body: fd });
    const data = await r.json();
    toast(data.message || '注册成功', 'ok');
    loadItems();
  } catch { toast('注册失败', 'err'); }
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
async function loadFaces() {
  try {
    const r = await fetch(API + '/faces');
    const data = await r.json();
    const faces = data.faces || [];
    document.getElementById('faces-count').textContent = `(${faces.length})`;
    const tbody = document.getElementById('faces-tbody');
    if (!faces.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text3)">暂无注册人脸</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    faces.forEach(f => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.style.fontWeight = '700';
      tdName.textContent = f.name;
      const tdCount = document.createElement('td');
      tdCount.innerHTML = `<span class="badge blue">${f.sample_count || 1}</span>`;
      const tdScore = document.createElement('td');
      tdScore.textContent = f.det_score ? (f.det_score * 100).toFixed(0) + '%' : '-';
      const tdTime = document.createElement('td');
      tdTime.textContent = new Date(f.registered_at).toLocaleDateString('zh-CN');
      tr.append(tdName, tdCount, tdScore, tdTime);
      tbody.appendChild(tr);
    });
  } catch {
    document.getElementById('faces-tbody').innerHTML = '<tr><td colspan="4" style="color:var(--red)">加载失败</td></tr>';
  }
}

async function registerFace() {
  const file = document.getElementById('face-file').files[0];
  const name = document.getElementById('face-name').value.trim();
  const result = document.getElementById('face-register-result');
  if (!file || !name) { toast('请选择图片并填写姓名', 'err'); return; }
  result.textContent = '注册中...';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('name', name);
  try {
    const r = await fetch(API + '/face/register', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.status === 'ok') {
      toast(data.message, 'ok');
      result.textContent = '\u2713 ' + data.message;
      result.style.color = 'var(--green)';
      loadFaces();
    } else {
      result.textContent = '\u2717 ' + data.error;
      result.style.color = 'var(--red)';
    }
  } catch(e) {
    result.textContent = '\u2717 ' + e.message;
    result.style.color = 'var(--red)';
  }
}

// ══════════════════════════════════════════════════════════════
// DEVICES 页
// ══════════════════════════════════════════════════════════════
async function initDevices() {
  const list = document.getElementById('devices-list');
  let dbHost = '-';
  try {
    const r = await fetch(API + '/health', { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    dbHost = d.db_host || '-';
  } catch {}
  const apiUrl = new URL(API);
  let camSource = '-';
  try {
    const sc = await fetch(API + '/stream/config', { signal: AbortSignal.timeout(3000) });
    const sd = await sc.json();
    if (sd.source) camSource = new URL(sd.source).hostname;
  } catch {}
  const devices = [
    { name: 'desk-cam-01', ip: camSource, role: '摄像头端点', icon: '📷', type: 'esp32' },
    { name: 'Alchemy Furnace', ip: apiUrl.hostname, role: 'GPU 推理服务', icon: '🖥️', type: 'furnace' },
    { name: 'PostgreSQL LXC', ip: dbHost, role: '数据库', icon: '🗄️', type: 'db' },
  ];
  list.innerHTML = '';
  devices.forEach(d => {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.id = 'dcard-' + d.type;
    card.innerHTML = `
      <div class="device-icon">${d.icon}</div>
      <div>
        <div class="device-name">${esc(d.name)}</div>
        <div class="device-meta">${esc(d.ip)} · ${esc(d.role)}</div>
      </div>
      <span class="badge amber" id="dstatus-${esc(d.type)}">检测中</span>`;
    list.appendChild(card);
  });
  pingDevices();
  updateOrientBtns();
}

async function pingDevices() {
  // Ping 推理服务
  try {
    await fetch(API + '/health', { signal: AbortSignal.timeout(3000) });
    setDevStatus('furnace', 'online');
  } catch { setDevStatus('furnace', 'offline'); }
  // Ping ESP32 (通过后台代理)
  try {
    await fetch(API + '/stream/status', { signal: AbortSignal.timeout(3000) });
    setDevStatus('esp32', 'online');
  } catch { setDevStatus('esp32', 'offline'); }
  // DB 通过推理服务 health 间接判断（若推理服务在线则 DB 可达）
  try {
    const r = await fetch(API + '/health', { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    setDevStatus('db', d.status === 'ok' ? 'online' : 'offline');
  } catch { setDevStatus('db', 'offline'); }
}

function setDevStatus(type, status) {
  const el = document.getElementById('dstatus-' + type);
  if (!el) return;
  if (status === 'online') { el.textContent = '在线'; el.className = 'badge green'; }
  else { el.textContent = '离线'; el.className = 'badge red'; }
}

// ══════════════════════════════════════════════════════════════
// SYSTEM 页
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
setupDropZone('face-drop-zone', 'face-file', 'face-preview');

// ── 同步 System 页的 API 地址输入框 ─────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const apiInput = document.getElementById('cfg-api');
  if (apiInput) apiInput.value = API;
});
