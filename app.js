/*
【目的】
- 核心理由：GitHub Pages 前端穩定對接 GAS API，並以 cameraId fallback 修復黑框/找不到相機/不能停止問題。
- 權責邊界：[負責]前端輸入管線、MasterData 快取、Scanner 裝置選擇與生命週期；[不負責]後端 GAS 與實體相機/瀏覽器權限。
- MWE：設定 CONFIG.API_URL / APP_KEY 後部署；按「檢查相機」可列出設備；按「啟動相機」會依 cameraId → facingMode fallback 啟動。
- 致命錯誤邊界：相機啟動 race、stop cleanup、API timeout、Null DOM、重複掃描已防護；風險受控。
*/

const CONFIG = {
  // TODO: 部署後請替換成你的 GAS Web App /exec URL。
  API_URL: 'https://script.google.com/macros/s/AKfycbxw9Y1y3A7N5CUhgp0ACezB12JXqNPXcssvMTwwWk5C2QeMCvn97UdrueSQ6_Jx0rJG/exec', // 部署後請替換此 ID
  APP_KEY: 'public-mvp-key',
  CACHE_KEY_VERSION: 'proposal_sys_version',
  CACHE_KEY_DATA: 'proposal_sys_master_data',
  API_TIMEOUT_MS: 15000,
  SCAN_DEBOUNCE_MS: 1500
};

const ScannerState = Object.freeze({ IDLE:'IDLE', STARTING:'STARTING', RUNNING:'RUNNING', STOPPING:'STOPPING', ERROR:'ERROR' });

const state = {
  masterData: {}, currentVersion: '', draftItems: [],
  scanner: null, scannerState: ScannerState.IDLE,
  lastScanText: '', lastScanAt: 0,
  choices: [], pendingQty: 1,
  submitting: false, syncing: false,
  cameras: [], selectedCameraId: ''
};

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text == null ? '' : String(text); };

function setStatus(id, message, type) {
  const el = $(id); if (!el) return;
  el.textContent = message == null ? '' : String(message);
  el.className = 'status';
  if (type === 'error') el.classList.add('error');
  if (type === 'warn') el.classList.add('warn');
}
function normalizeText(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function parsePositiveInt(value, fallback = 1) { const n = Number(value); return (!Number.isFinite(n) || n <= 0) ? fallback : Math.floor(n); }

function apiRequest(action, payload = {}) {
  const body = { action, appKey: CONFIG.APP_KEY, payload };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);
  return fetch(CONFIG.API_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body), signal: controller.signal
  })
    .then(async (res) => {
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      try { return JSON.parse(text); } catch (_) { throw new Error(`API 回傳不是 JSON：${text.slice(0, 160)}`); }
    })
    .then((json) => {
      if (!json || json.success === false) throw new Error(json && json.message ? json.message : 'API 失敗');
      return json.data;
    })
    .catch((error) => {
      if (error && error.name === 'AbortError') throw new Error('API 逾時，請檢查 GAS 部署與網路');
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

async function syncMasterData(force = false) {
  if (state.syncing) return;
  state.syncing = true;
  const btn = $('btn-sync'); if (btn) btn.disabled = true;
  try {
    setStatus('message', '同步主檔中...', 'warn');
    const remoteVersion = await apiRequest('getMasterVersion');
    const localVersion = localStorage.getItem(CONFIG.CACHE_KEY_VERSION);
    if (force || remoteVersion !== localVersion) {
      const items = await apiRequest('getMasterSnapshot');
      if (!Array.isArray(items)) throw new Error('主檔快照格式錯誤，預期為陣列');
      const dataMap = {};
      items.forEach((item) => {
        const barcode = normalizeText(item.barcode), itemId = normalizeText(item.itemId), name = normalizeText(item.name);
        if (barcode && itemId && name) dataMap[barcode] = { itemId, name, barcode };
      });
      state.masterData = dataMap;
      state.currentVersion = String(remoteVersion || '');
      localStorage.setItem(CONFIG.CACHE_KEY_DATA, JSON.stringify(dataMap));
      localStorage.setItem(CONFIG.CACHE_KEY_VERSION, state.currentVersion);
      setStatus('message', `主檔同步完成：${Object.keys(dataMap).length} 筆`, 'ok');
      return;
    }
    state.masterData = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY_DATA) || '{}');
    state.currentVersion = String(localVersion || '');
    setStatus('message', `主檔已使用快取：${Object.keys(state.masterData).length} 筆`, 'ok');
  } catch (error) {
    console.error('[SYNC_MASTER_ERROR]', error);
    setStatus('message', `主檔同步失敗：${error.message}`, 'error');
  } finally {
    state.syncing = false;
    if (btn) btn.disabled = false;
  }
}

function resolveFromMaster(query) {
  const q = normalizeText(query).toLowerCase();
  if (!q) return { type:'EMPTY', items:[] };
  const rows = Object.values(state.masterData || {});
  const exact = rows.filter((item) => normalizeText(item.barcode).toLowerCase() === q || normalizeText(item.itemId).toLowerCase() === q);
  const fuzzy = rows.filter((item) => {
    const barcode = normalizeText(item.barcode).toLowerCase();
    const itemId = normalizeText(item.itemId).toLowerCase();
    const name = normalizeText(item.name).toLowerCase();
    return barcode.includes(q) || itemId.includes(q) || name.includes(q);
  });
  const seen = new Set(), items = [];
  exact.concat(fuzzy).forEach((item) => {
    const key = `${item.itemId}|${item.barcode}`;
    if (!seen.has(key)) { seen.add(key); items.push(item); }
  });
  if (items.length === 0) return { type:'NONE', items:[] };
  if (items.length === 1) return { type:'ONE', item:items[0], items };
  return { type:'MULTI', items:items.slice(0, 30) };
}

function addDraftItem(item, qty) {
  const n = parsePositiveInt(qty, 1);
  const itemId = normalizeText(item.itemId), name = normalizeText(item.name), barcode = normalizeText(item.barcode);
  if (!itemId || !name || !barcode) throw new Error('品項資料不完整');
  const found = state.draftItems.find((x) => x.itemId === itemId);
  if (found) found.qty += n;
  else state.draftItems.push({ itemId, name, barcode, qty:n });
  renderDraft();
}

async function handleInput(query, qty) {
  const q = normalizeText(query), n = parsePositiveInt(qty, 1);
  if (!q) { setStatus('message', '請輸入條碼 / 品名 / 品項ID', 'error'); resumeScanner(); return; }
  if (Object.keys(state.masterData || {}).length === 0) await syncMasterData(false);
  const result = resolveFromMaster(q);
  if (result.type === 'NONE') { setStatus('message', `找不到品項：${q}`, 'error'); resumeScanner(); return; }
  if (result.type === 'ONE') {
    addDraftItem(result.item, n);
    setStatus('message', `已加入：${result.item.name}`, 'ok');
    const input = $('manual-query'); if (input) input.value = '';
    resumeScanner(); return;
  }
  state.pendingQty = n; state.choices = result.items;
  renderChoices(); showPicker(true); pauseScanner();
  setStatus('message', `找到 ${result.items.length} 筆，請選擇品項`, 'warn');
}

function renderDraft() {
  const list = $('draft-list'); if (!list) return;
  if (state.draftItems.length === 0) { list.innerHTML = '<p class="muted">尚無品項</p>'; setText('total-badge', '品項 0｜總數 0'); return; }
  let totalQty = 0; list.innerHTML = '';
  state.draftItems.forEach((item) => {
    totalQty += Number(item.qty || 0);
    const card = document.createElement('article'); card.className = 'item-card';
    const info = document.createElement('div');
    const name = document.createElement('div'); name.className = 'item-name'; name.textContent = item.name;
    const meta = document.createElement('div'); meta.className = 'muted'; meta.textContent = `${item.itemId}｜${item.barcode}`;
    info.append(name, meta);
    const qtyLabel = document.createElement('label'); qtyLabel.textContent = '數量';
    const qty = document.createElement('input'); qty.type = 'number'; qty.min = '1'; qty.step = '1'; qty.value = String(item.qty);
    qty.addEventListener('change', () => { item.qty = parsePositiveInt(qty.value, 1); qty.value = String(item.qty); renderDraft(); });
    qtyLabel.appendChild(qty);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = '刪除';
    remove.addEventListener('click', () => { state.draftItems = state.draftItems.filter((x) => x.itemId !== item.itemId); renderDraft(); });
    card.append(info, qtyLabel, remove); list.appendChild(card);
  });
  setText('total-badge', `品項 ${state.draftItems.length}｜總數 ${totalQty}`);
}

function showPicker(on) { const picker = $('picker'); if (picker) picker.classList.toggle('hidden', !on); }
function closePicker() { showPicker(false); state.choices = []; renderChoices(); resumeScanner(); }
function renderChoices() {
  const list = $('choice-list'); if (!list) return;
  list.innerHTML = '';
  state.choices.forEach((item) => {
    const card = document.createElement('article'); card.className = 'choice-card';
    const name = document.createElement('div'); name.className = 'item-name'; name.textContent = item.name;
    const meta = document.createElement('div'); meta.className = 'muted'; meta.textContent = `${item.itemId}｜${item.barcode}`;
    card.append(name, meta);
    card.addEventListener('click', () => { addDraftItem(item, state.pendingQty || 1); closePicker(); setStatus('message', `已加入：${item.name}`, 'ok'); });
    list.appendChild(card);
  });
}

function setScannerState(next, message, type) {
  state.scannerState = next;
  const startBtn = $('btn-start'), stopBtn = $('btn-stop'), wrap = $('reader-wrap');
  const busy = next === ScannerState.STARTING || next === ScannerState.STOPPING;
  const running = next === ScannerState.RUNNING;
  if (startBtn) startBtn.disabled = busy || running;
  if (stopBtn) stopBtn.disabled = !(state.scanner || busy || running || next === ScannerState.ERROR);
  if (wrap) wrap.classList.toggle('active', Boolean(state.scanner));
  setStatus('scanner-status', message || next, type || (next === ScannerState.ERROR ? 'error' : next === ScannerState.IDLE ? 'warn' : 'ok'));
}

function getFormatsToSupport() {
  if (typeof Html5QrcodeSupportedFormats === 'undefined') return undefined;
  const f = Html5QrcodeSupportedFormats;
  return [f.QR_CODE, f.CODE_128, f.CODE_39, f.EAN_13, f.EAN_8, f.UPC_A, f.UPC_E].filter((x) => x !== undefined);
}

async function detectCameras() {
  if (typeof Html5Qrcode === 'undefined') throw new Error('html5-qrcode 尚未載入');
  const cameras = await Html5Qrcode.getCameras();
  state.cameras = Array.isArray(cameras) ? cameras : [];
  state.selectedCameraId = chooseCameraId(state.cameras);
  renderCameraDiagnostic();
  return state.cameras;
}

function chooseCameraId(cameras) {
  if (!Array.isArray(cameras) || cameras.length === 0) return '';
  const rear = cameras.find((c) => /back|rear|environment|後|背/i.test(normalizeText(c.label)));
  return (rear || cameras[0]).id || '';
}

function renderCameraDiagnostic(extra) {
  const lines = [];
  lines.push(`secureContext=${String(window.isSecureContext)}`);
  lines.push(`mediaDevices=${String(Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia))}`);
  lines.push(`Html5Qrcode=${String(typeof Html5Qrcode !== 'undefined')}`);
  lines.push(`cameraCount=${state.cameras.length}`);
  state.cameras.forEach((c, i) => lines.push(`${i+1}. ${c.label || '(未授權前可能無名稱)'} | ${c.id ? c.id.slice(0, 12) + '...' : '(no id)'}`));
  if (state.selectedCameraId) lines.push(`selected=${state.selectedCameraId.slice(0, 12)}...`);
  if (extra) lines.push(extra);
  setText('camera-diagnostic', lines.join('\n'));
}

async function cleanupScanner() {
  if (!state.scanner) return;
  try { await state.scanner.stop(); } catch (error) { console.warn('[SCANNER_STOP_WARN]', error); }
  try { await state.scanner.clear(); } catch (error) { console.warn('[SCANNER_CLEAR_WARN]', error); }
  state.scanner = null;
}

function scannerConfig() {
  const formatsToSupport = getFormatsToSupport();
  const config = {
    fps: 10,
    qrbox: (w, h) => {
      const edge = Math.max(180, Math.floor(Math.min(w, h) * 0.72));
      return { width: edge, height: edge };
    },
    aspectRatio: 1.0,
    disableFlip: false
  };
  if (formatsToSupport && formatsToSupport.length > 0) config.formatsToSupport = formatsToSupport;
  return config;
}

function onScanSuccess(decodedText) {
  const code = normalizeText(decodedText);
  const now = Date.now();
  if (!code) return;
  if (code === state.lastScanText && now - state.lastScanAt < CONFIG.SCAN_DEBOUNCE_MS) return;
  state.lastScanText = code; state.lastScanAt = now;
  if (navigator.vibrate) navigator.vibrate(50);
  pauseScanner();
  const query = $('manual-query'); if (query) query.value = code;
  setStatus('scanner-status', `已掃描：${code}，解析中...`, 'ok');
  handleInput(code, 1);
}

async function tryStartWithCameraConfig(cameraConfig, label) {
  state.scanner = new Html5Qrcode('reader');
  await state.scanner.start(cameraConfig, scannerConfig(), onScanSuccess, () => {});
  setScannerState(ScannerState.RUNNING, `相機已啟動：${label}`, 'ok');
}

async function startScanner() {
  if (state.scannerState === ScannerState.STARTING || state.scannerState === ScannerState.RUNNING) return;
  if (!window.isSecureContext) { setScannerState(ScannerState.ERROR, '目前不是安全環境，請使用 HTTPS 或 localhost', 'error'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setScannerState(ScannerState.ERROR, '此瀏覽器不支援相機 getUserMedia', 'error'); return; }
  if (typeof Html5Qrcode === 'undefined') { setScannerState(ScannerState.ERROR, 'html5-qrcode 尚未載入，請檢查 CDN', 'error'); return; }

  setScannerState(ScannerState.STARTING, '正在啟動相機...', 'warn');
  await cleanupScanner();

  const attempts = [];
  try {
    try { await detectCameras(); } catch (e) { renderCameraDiagnostic(`getCameras error=${e.message || e}`); }
    if (state.selectedCameraId) attempts.push({ config: state.selectedCameraId, label: 'cameraId' });
    attempts.push({ config: { facingMode: { exact: 'environment' } }, label: 'environment exact' });
    attempts.push({ config: { facingMode: 'environment' }, label: 'environment ideal' });
    attempts.push({ config: { facingMode: 'user' }, label: 'user camera' });

    let lastError = null;
    for (const attempt of attempts) {
      try {
        await cleanupScanner();
        setScannerState(ScannerState.STARTING, `嘗試啟動：${attempt.label}`, 'warn');
        await tryStartWithCameraConfig(attempt.config, attempt.label);
        renderCameraDiagnostic(`startMode=${attempt.label}`);
        return;
      } catch (error) {
        lastError = error;
        console.warn('[SCANNER_START_ATTEMPT_FAIL]', attempt.label, error);
        await cleanupScanner();
      }
    }
    throw lastError || new Error('沒有可用相機啟動方式');
  } catch (error) {
    console.error('[START_SCANNER_ERROR]', error);
    await cleanupScanner();
    setScannerState(ScannerState.ERROR, `相機啟動失敗：${normalizeCameraError(error)}`, 'error');
    renderCameraDiagnostic(`lastError=${error && error.message ? error.message : String(error)}`);
  }
}

async function stopScanner() {
  if (!state.scanner) { setScannerState(ScannerState.IDLE, '相機尚未啟動', 'warn'); return; }
  try {
    setScannerState(ScannerState.STOPPING, '正在停止相機...', 'warn');
    await cleanupScanner();
    setScannerState(ScannerState.IDLE, '相機已停止', 'ok');
  } catch (error) {
    console.error('[STOP_SCANNER_ERROR]', error);
    await cleanupScanner();
    setScannerState(ScannerState.ERROR, `停止相機失敗：${error.message || error}`, 'error');
  }
}

function pauseScanner() {
  try { if (state.scanner && state.scanner.getState && state.scanner.getState() === 2) state.scanner.pause(); } catch (_) {}
}
function resumeScanner() {
  try { if (state.scanner && state.scanner.getState && state.scanner.getState() === 3) state.scanner.resume(); } catch (_) {}
}
function normalizeCameraError(error) {
  const message = error && error.message ? error.message : String(error);
  if (message.includes('NotAllowedError')) return '使用者未允許相機權限，或瀏覽器封鎖相機';
  if (message.includes('NotFoundError')) return '找不到相機裝置';
  if (message.includes('NotReadableError')) return '相機被其他程式占用，或系統拒絕讀取';
  if (message.includes('SecurityError')) return '安全性限制，請確認 HTTPS 與非 iframe sandbox';
  if (message.includes('OverconstrainedError')) return '指定相機條件不支援，已嘗試 fallback 仍失敗';
  return message;
}

async function submitProposal() {
  if (state.submitting) return;
  const title = normalizeText($('proposal-title') && $('proposal-title').value);
  const source = normalizeText($('proposal-source') && $('proposal-source').value) || 'GitHub Pages';
  if (!title) { setStatus('message', '請輸入提案標題', 'error'); return; }
  if (state.draftItems.length === 0) { setStatus('message', '草稿沒有品項', 'error'); return; }
  const btn = $('btn-submit'); state.submitting = true;
  if (btn) { btn.disabled = true; btn.textContent = '送出中...'; }
  try {
    const data = await apiRequest('submitProposal', {
      title, source,
      clientRequestId: `uid-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      items: state.draftItems.map((item) => ({ itemId:item.itemId, name:item.name, barcode:item.barcode, qty:parsePositiveInt(item.qty, 1) }))
    });
    setStatus('message', `送出成功：${data && data.docId ? data.docId : ''}`, 'ok');
    state.draftItems = []; renderDraft();
    const titleEl = $('proposal-title'); if (titleEl) titleEl.value = '';
  } catch (error) {
    console.error('[SUBMIT_ERROR]', error);
    setStatus('message', `送出失敗：${error.message}`, 'error');
  } finally {
    state.submitting = false;
    if (btn) { btn.disabled = false; btn.textContent = '送出提案'; }
  }
}
function clearDraft() { state.draftItems = []; renderDraft(); setStatus('message', '草稿已清空', 'ok'); }

function bindEvents() {
  $('btn-start')?.addEventListener('click', startScanner);
  $('btn-stop')?.addEventListener('click', stopScanner);
  $('btn-cameras')?.addEventListener('click', async () => {
    try { await detectCameras(); setStatus('scanner-status', `相機檢查完成：${state.cameras.length} 個裝置`, state.cameras.length ? 'ok' : 'error'); }
    catch (e) { setStatus('scanner-status', `相機檢查失敗：${normalizeCameraError(e)}`, 'error'); renderCameraDiagnostic(`detectError=${e.message || e}`); }
  });
  $('btn-sync')?.addEventListener('click', () => syncMasterData(true));
  $('btn-add')?.addEventListener('click', () => handleInput($('manual-query')?.value, $('manual-qty')?.value));
  $('manual-query')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleInput($('manual-query')?.value, $('manual-qty')?.value); });
  $('btn-submit')?.addEventListener('click', submitProposal);
  $('btn-clear')?.addEventListener('click', clearDraft);
  $('btn-close-picker')?.addEventListener('click', closePicker);
  $('picker')?.addEventListener('click', (event) => { if (event.target && event.target.id === 'picker') closePicker(); });
}

function init() {
  bindEvents(); renderDraft();
  setScannerState(ScannerState.IDLE, '相機尚未啟動', 'warn');
  renderCameraDiagnostic();
  syncMasterData(false);
}

document.addEventListener('DOMContentLoaded', init);
