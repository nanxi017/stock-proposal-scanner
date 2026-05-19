/**
 * 【目的】
 * - 核心理由：需求提案單系統前端入口，負責 UI 狀態、主檔同步、掃碼、草稿、歷史查詢與 API 通訊。
 * - 權責邊界：[負責]前端 UI 渲染、掃碼控制、狀態管理、API 請求 [不負責]後端資料寫入、Sheet schema、後端日期查詢邏輯。
 * - MWE：開啟 index.html 後呼叫 syncMasterData(false, true)，同步成功隱藏遮罩；失敗維持遮罩。
 * - 致命錯誤邊界：掃碼 callback 具防抖；送出與同步具狀態鎖；初始化遮罩避免半初始化操作；風險受控。
 */

// --- 1. 配置與全域狀態 ---
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxw9Y1y3A7N5CUhgp0ACezB12JXqNPXcssvMTwwWk5C2QeMCvn97UdrueSQ6_Jx0rJG/exec',
  APP_KEY: 'public-mvp-key',
  CACHE_KEY_VERSION: 'proposal_sys_version',
  CACHE_KEY_DATA: 'proposal_sys_master_data',
  API_TIMEOUT_MS: 15000,
  SCAN_DEBOUNCE_MS: 1500
};

const S = {
  masterData: {},       // 主檔快取
  draftItems: [],       // 草稿清單
  scanner: null,        // 掃描器實例
  lastScanText: '',     // 防抖重複碼
  lastScanAt: 0,
  choices: [],          // 搜尋多筆時的選項
  pendingQty: 1,        // 待加入數量
  submitting: false,    // 提交狀態
  syncing: false,       // 同步狀態
  historyItems: [],     // 歷史清單
  historyLoading: false,
  detailLoading: false,
  cameras: [],          // 相機列表
  currentCameraIndex: -1, // 目前鏡頭索引；-1 代表使用 facingMode fallback 或尚未啟動
  cameraBusy: false      // 相機生命週期鎖：防止 start/stop/switch 交錯造成鏡頭鎖死
};

// --- 2. 核心工具函式 ---
const $ = (id) => document.getElementById(id);

const nt = (v) => (v == null ? '' : String(v).trim()); // Normal Text

const pos = (v, f = 1) => {
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0 ? f : Math.floor(n);
};

function setText(id, t) {
  const e = $(id);
  if (e) e.textContent = t == null ? '' : String(t);
}

function setStatus(id, m, type) {
  const e = $(id);
  if (!e) return;

  e.textContent = m || '';
  e.className = 'status';

  if (type === 'error') e.classList.add('error');
  if (type === 'warn') e.classList.add('warn');
  if (type === 'ok') e.style.color = 'var(--green)';
}

/**
 * 【目的】
 * - 核心理由：集中控制初始化遮罩，避免主檔未同步完成時操作者誤觸任何功能。
 * - 權責邊界：[負責]顯示/隱藏全頁遮罩 [不負責]主檔同步與後端 API。
 * - MWE：showAppOverlay('loading') 顯示同步中；showAppOverlay('error') 顯示失敗；hideAppOverlay() 隱藏。
 * - 致命錯誤邊界：純 DOM 狀態切換，無共享資料寫入；風險受控。
 */
function showAppOverlay(mode, message) {
  const overlay = $('app-overlay');
  if (!overlay) return;

  overlay.classList.remove('hidden', 'error');

  if (mode === 'error') {
    overlay.classList.add('error');
    setText('app-overlay-title', '同步失敗');
    setText('app-overlay-message', message || '主檔同步失敗，請重新整理。');
    return;
  }

  setText('app-overlay-title', '系統初始化中');
  setText('app-overlay-message', message || '主檔同步中，請稍候...');
}

function hideAppOverlay() {
  const overlay = $('app-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// --- 3. API 通訊層 ---
async function apiRequest(action, payload = {}) {
  const body = {
    action,
    appKey: CONFIG.APP_KEY,
    payload
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

  try {
    const r = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await r.text();

    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
    }

    const j = JSON.parse(text);

    if (!j || j.success === false) {
      throw new Error(j?.message || 'API 請求失敗');
    }

    return j.data;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('連線逾時，請檢查網路');
    }

    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- 4. 業務邏輯：主檔同步 ---
/**
 * 【目的】
 * - 核心理由：同步主檔資料；首次載入時以全頁遮罩防止半初始化操作。
 * - 權責邊界：[負責]主檔版本檢查、快取更新、初始化鎖定 [不負責]後端資料正確性。
 * - MWE：syncMasterData(false, true) 首次載入鎖定；成功隱藏；失敗保留遮罩提示重新整理。
 * - 致命錯誤邊界：同步中以 S.syncing 防重入；無多寫入競態；風險受控。
 */
async function syncMasterData(force = false, blockUi = false) {
  if (S.syncing) return;

  S.syncing = true;

  if (blockUi) {
    showAppOverlay('loading', '主檔同步中，請稍候...');
  }

  const btn = $('btn-sync');
  if (btn) btn.disabled = true;

  try {
    setStatus('system-status', '同步主檔中...', 'warn');

    const rv = await apiRequest('getMasterVersion');
    const lv = localStorage.getItem(CONFIG.CACHE_KEY_VERSION);

    if (force || rv !== lv) {
      const arr = await apiRequest('getMasterSnapshot');

      if (!Array.isArray(arr)) {
        throw new Error('主檔格式錯誤');
      }

      const map = {};

      arr.forEach(i => {
        const barcode = nt(i.barcode);
        const itemId = nt(i.itemId);
        const name = nt(i.name);

        if (barcode && itemId && name) {
          map[barcode] = {
            barcode,
            itemId,
            name
          };
        }
      });

      S.masterData = map;

      localStorage.setItem(CONFIG.CACHE_KEY_DATA, JSON.stringify(map));
      localStorage.setItem(CONFIG.CACHE_KEY_VERSION, String(rv || ''));

      setStatus('system-status', `主檔同步完成：${Object.keys(map).length} 筆`, 'ok');

      if (blockUi) {
        hideAppOverlay();
      }
    } else {
      S.masterData = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY_DATA) || '{}');

      setStatus('system-status', `主檔已使用快取：${Object.keys(S.masterData).length} 筆`, 'ok');

      if (blockUi) {
        hideAppOverlay();
      }
    }
  } catch (e) {
    console.error(e);

    setStatus('system-status', `主檔同步失敗：${e.message}`, 'error');

    if (blockUi) {
      showAppOverlay('error', '主檔同步失敗，請重新整理。');
    }
  } finally {
    S.syncing = false;

    if (btn) {
      btn.disabled = false;
    }
  }
}

// --- 5. 業務邏輯：草稿管理 ---
function resolveFromMaster(q0) {
  const q = nt(q0).toLowerCase();
  const rows = Object.values(S.masterData || {});
  const seen = new Set();
  const items = [];

  rows
    .filter(i =>
      nt(i.barcode).toLowerCase() === q ||
      nt(i.itemId).toLowerCase() === q ||
      nt(i.barcode).toLowerCase().includes(q) ||
      nt(i.itemId).toLowerCase().includes(q) ||
      nt(i.name).toLowerCase().includes(q)
    )
    .forEach(i => {
      const k = i.itemId + '|' + i.barcode;

      if (!seen.has(k)) {
        seen.add(k);
        items.push(i);
      }
    });

  if (items.length === 0) return { type: 'NONE' };
  if (items.length === 1) return { type: 'ONE', item: items[0] };

  return {
    type: 'MULTI',
    items: items.slice(0, 30)
  };
}

function addDraftItem(item, qty) {
  const n = pos(qty, 1);
  const found = S.draftItems.find(x => x.itemId === item.itemId);

  if (found) {
    found.qty += n;
  } else {
    S.draftItems.push({
      itemId: nt(item.itemId),
      name: nt(item.name),
      barcode: nt(item.barcode),
      qty: n
    });
  }

  renderDraft();
}

async function handleInput(q, qty, source = 'manual') {
  q = nt(q);

  const statusId = source === 'scanner' ? 'scanner-status' : 'manual-status';

  if (!q) {
    setStatus(statusId, '請輸入條碼/品名', 'error');
    return;
  }

  const r = resolveFromMaster(q);

  if (r.type === 'NONE') {
    setStatus(statusId, `找不到品項：${q}`, 'error');
    return;
  }

  if (r.type === 'ONE') {
    addDraftItem(r.item, qty);
    setStatus(statusId, `已加入：${r.item.name}`, 'ok');

    if (source === 'manual' && $('manual-query')) {
      $('manual-query').value = '';
    }

    return;
  }

  S.pendingQty = pos(qty, 1);
  S.choices = r.items;

  renderChoices();

  if ($('picker')) {
    $('picker').classList.remove('hidden');
  }

  setStatus(statusId, `找到 ${r.items.length} 筆相似品項`, 'warn');
}

// --- 6. UI 渲染 ---
function updateSubmitHint() {
  const title = nt($('proposal-title')?.value);

  setText(
    'submit-hint',
    title
      ? `提案標題：${title}`
      : '單號將自動產生；標題可選填。'
  );
}

function renderDraft() {
  updateSubmitHint();

  const root = $('draft-list');
  if (!root) return;

  root.innerHTML = '';

  if (S.draftItems.length === 0) {
    root.innerHTML = '<p class="muted">草稿清單為空</p>';
    setText('total-badge', '品項 0｜總數 0');
    return;
  }

  let total = 0;

  S.draftItems.forEach(i => {
    total += i.qty;

    const c = document.createElement('article');
    c.className = 'item-card';

    const info = document.createElement('div');
    info.innerHTML = `
      <div class="item-name">${i.name}</div>
      <div class="muted">${i.itemId}｜${i.barcode}</div>
    `;

    const lab = document.createElement('label');
    lab.textContent = '數量';

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.value = i.qty;

    qtyInput.onchange = () => {
      i.qty = pos(qtyInput.value, 1);
      renderDraft();
    };

    lab.appendChild(qtyInput);

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '刪除';

    del.onclick = () => {
      S.draftItems = S.draftItems.filter(x => x.itemId !== i.itemId);
      renderDraft();
    };

    c.append(info, lab, del);
    root.appendChild(c);
  });

  setText('total-badge', `品項 ${S.draftItems.length}｜總數 ${total}`);
}

function renderChoices() {
  const root = $('choice-list');
  if (!root) return;

  root.innerHTML = '';

  S.choices.forEach(i => {
    const c = document.createElement('article');
    c.className = 'choice-card';

    c.innerHTML = `
      <div class="item-name">${i.name}</div>
      <div class="muted">${i.itemId}｜${i.barcode}</div>
    `;

    c.onclick = () => {
      addDraftItem(i, S.pendingQty);

      if ($('picker')) {
        $('picker').classList.add('hidden');
      }

      setStatus('manual-status', `已加入：${i.name}`, 'ok');
    };

    root.appendChild(c);
  });
}

// --- 7. 歷史查詢 ---
function switchPage(p) {
  const isHistory = p === 'history';

  if ($('page-proposal')) {
    $('page-proposal').classList.toggle('hidden', isHistory);
  }

  if ($('page-history')) {
    $('page-history').classList.toggle('hidden', !isHistory);
  }

  if ($('tab-proposal')) {
    $('tab-proposal').classList.toggle('active', !isHistory);
  }

  if ($('tab-history')) {
    $('tab-history').classList.toggle('active', isHistory);
  }
}

async function searchHistory(q) {
  q = nt(q);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    setStatus('history-message', '日期格式錯誤', 'error');
    return;
  }

  if (S.historyLoading) return;

  S.historyLoading = true;

  const btn = $('btn-history-search');
  if (btn) btn.disabled = true;

  try {
    setStatus('history-message', '搜尋中...', 'warn');

    const data = await apiRequest('searchHistory', { q });

    S.historyItems = Array.isArray(data) ? data : [];

    renderHistoryResults();

    setStatus(
      'history-message',
      `搜尋完成：${S.historyItems.length} 筆`,
      S.historyItems.length ? 'ok' : 'warn'
    );
  } catch (e) {
    setStatus('history-message', `搜尋失敗：${e.message}`, 'error');
  } finally {
    S.historyLoading = false;

    if (btn) btn.disabled = false;
  }
}

function renderHistoryResults() {
  const root = $('history-results');
  if (!root) return;

  root.innerHTML = '';

  if (S.historyItems.length === 0) {
    root.innerHTML = '<p class="muted">查無歷史資料</p>';
    return;
  }

  S.historyItems.forEach(d => {
    const card = document.createElement('article');
    card.className = 'doc-card';

    const main = document.createElement('div');
    main.className = 'doc-main';

    const left = document.createElement('div');
    left.innerHTML = `
      <div class="muted">${nt(d.docId)}</div>
      <div class="doc-title">${nt(d.title) || '未命名提案'}</div>
      <div class="muted" style="margin-top:4px; color:var(--amber)">
        ${d.note ? '備註：' + d.note : ''}
      </div>
    `;

    const right = document.createElement('div');
    right.className = 'muted';
    right.style.textAlign = 'right';
    right.textContent = `${fmt(d.createdAt)}\n${nt(d.status) || 'ACTIVE'}`;

    main.append(left, right);

    const badges = document.createElement('div');
    badges.className = 'badge-row';

    [`品項 ${d.itemCount ?? 0}`, `總數 ${d.totalQty ?? 0}`].forEach(t => {
      const s = document.createElement('span');
      s.className = 'badge';
      s.textContent = t;
      badges.appendChild(s);
    });

    card.append(main, badges);

    card.onclick = () => loadHistoryDetail(d.docId);

    root.appendChild(card);
  });
}

/*
【目的】
- 核心理由：歷史單據明細提供即時讀取反饋，避免操作者以為點擊無效。
- 權責邊界：[負責]載入中狀態與結果渲染 [不負責]後端逾時或資料一致性。
- MWE：點擊歷史卡片後立即開啟明細視窗並顯示載入中，成功後換成明細。
- 致命錯誤邊界：以 detailLoading 防重入；讀取操作無共享寫入；風險受控。
*/
async function loadHistoryDetail(docId) {
  if (S.detailLoading) return;

  S.detailLoading = true;

  setStatus('history-message', `正在讀取單據 ${docId}...`, 'warn');

  renderDetailLoadingState(docId);

  if ($('detail-modal')) {
    $('detail-modal').classList.remove('hidden');
  }

  try {
    const d = await apiRequest('getProposalDetail', { docId });

    renderHistoryDetail(d);

    setStatus('history-message', `單據 ${docId} 讀取完成`, 'ok');
  } catch (e) {
    setStatus('history-message', `讀取失敗：${e.message}`, 'error');

    if ($('detail-modal')) {
      $('detail-modal').classList.add('hidden');
    }
  } finally {
    S.detailLoading = false;
  }
}

function renderDetailLoadingState(docId) {
  setText('detail-doc-id', docId);
  setText('detail-summary', '資料連線中，請稍候...');

  if ($('detail-items')) {
    $('detail-items').innerHTML = `
      <div style="padding: 40px 0; text-align: center; color: var(--muted);">
        <div class="loading-spinner"></div>
        <p>正在從雲端抓取明細...</p>
      </div>
    `;
  }
}

function renderHistoryDetail(d) {
  setText('detail-doc-id', d?.docId || '提案詳情');

  const summary = [
    d?.title || '未命名提案',
    fmt(d?.createdAt),
    d?.status,
    d?.note ? `(備註：${d.note})` : ''
  ]
    .filter(Boolean)
    .join(' ｜ ');

  setText('detail-summary', summary);

  const root = $('detail-items');
  if (!root) return;

  root.innerHTML = '';

  (d?.items || []).forEach(i => {
    const row = document.createElement('div');
    row.className = 'detail-item';

    row.innerHTML = `
      <div>
        <strong>${nt(i.name)}</strong>
        <div class="muted">${nt(i.itemId)}｜${nt(i.barcode)}</div>
      </div>
      <span class="badge">x ${i.qty ?? 0}</span>
    `;

    root.appendChild(row);
  });
}

// --- 8. 掃描器控制 ---
/**
 * 【目的】
 * - 核心理由：提供手機掃碼必要的鏡頭逃生機制，避免瀏覽器預設鎖在前鏡頭導致無法掃碼。
 * - 權責邊界：[負責]相機偵測、啟動、停止、循環切換與 scanner instance 生命週期 [不負責]後端資料寫入、主檔解析、Sheet schema。
 * - MWE：啟動相機後連按「切換鏡頭」只會序列化執行 stop -> start(nextCameraId)，不會產生多個 scanner instance。
 * - 致命錯誤邊界：已用 cameraBusy 作為前端互斥鎖防止 Race Condition；單執行緒 async interleave 風險受控。
 */
async function detectCameras() {
  try {
    const cams = await Html5Qrcode.getCameras();
    S.cameras = Array.isArray(cams) ? cams : [];
    return S.cameras;
  } catch (e) {
    S.cameras = [];
    return [];
  }
}

function cameraLabel(index) {
  if (index < 0 || !S.cameras[index]) return '系統預設鏡頭';

  const cam = S.cameras[index];
  const label = nt(cam.label) || `鏡頭 ${index + 1}`;
  return `${label}（${index + 1}/${S.cameras.length}）`;
}

function setCameraButtons() {
  const active = !!S.scanner;
  const busy = !!S.cameraBusy;

  const startBtn = $('btn-start');
  const stopBtn = $('btn-stop');
  const switchBtn = $('btn-switch-camera');

  if (startBtn) startBtn.disabled = busy || active;
  if (stopBtn) stopBtn.disabled = busy || !active;

  if (switchBtn) {
    switchBtn.disabled = busy || !active;
    switchBtn.textContent = busy ? '切換中...' : '切換鏡頭';
  }
}

function pickInitialCameraIndex(cams) {
  if (!Array.isArray(cams) || cams.length === 0) return -1;

  if (S.currentCameraIndex >= 0 && S.currentCameraIndex < cams.length) {
    return S.currentCameraIndex;
  }

  const rearIndex = cams.findIndex(c => /back|rear|environment/i.test(nt(c.label)));
  return rearIndex >= 0 ? rearIndex : 0;
}

async function startScannerInternal(cameraId) {
  if (typeof Html5Qrcode === 'undefined') {
    throw new Error('掃描模組未載入');
  }

  const cams = await detectCameras();
  let target = null;
  let targetIndex = -1;

  if (cameraId) {
    targetIndex = cams.findIndex(c => c.id === cameraId);
    target = cameraId;
  } else {
    targetIndex = pickInitialCameraIndex(cams);
    target = targetIndex >= 0 ? cams[targetIndex].id : { facingMode: 'environment' };
  }

  if ($('reader-wrap')) {
    $('reader-wrap').classList.add('active');
  }

  S.scanner = new Html5Qrcode('reader');

  await S.scanner.start(
    target,
    {
      fps: 10,
      qrbox: 250
    },
    (txt) => {
      const code = nt(txt);
      const now = Date.now();

      if (
        !code ||
        (code === S.lastScanText && now - S.lastScanAt < CONFIG.SCAN_DEBOUNCE_MS)
      ) {
        return;
      }

      S.lastScanText = code;
      S.lastScanAt = now;

      if ($('manual-query')) {
        $('manual-query').value = code;
      }

      setStatus('scanner-status', `掃描成功：${code}`, 'ok');

      handleInput(code, 1, 'scanner');
    },
    () => {}
  );

  S.currentCameraIndex = targetIndex;
  setStatus('scanner-status', `相機運作中：${cameraLabel(S.currentCameraIndex)}`, 'ok');
}

async function stopScannerInternal() {
  if (S.scanner) {
    try {
      await S.scanner.stop();
      await S.scanner.clear();
    } catch (e) {}
  }

  S.scanner = null;

  if ($('reader-wrap')) {
    $('reader-wrap').classList.remove('active');
  }
}

async function startScanner() {
  if (S.scanner || S.cameraBusy) return;

  S.cameraBusy = true;
  setCameraButtons();

  try {
    await startScannerInternal();
  } catch (e) {
    await stopScannerInternal();
    setStatus('scanner-status', `啟動失敗：${e.message}`, 'error');
  } finally {
    S.cameraBusy = false;
    setCameraButtons();
  }
}

async function stopScanner() {
  if (S.cameraBusy) return;

  S.cameraBusy = true;
  setCameraButtons();

  try {
    await stopScannerInternal();
    setStatus('scanner-status', '相機已關閉', 'warn');
  } finally {
    S.cameraBusy = false;
    setCameraButtons();
  }
}

async function switchCamera() {
  if (S.cameraBusy) return;

  if (!S.scanner) {
    setStatus('scanner-status', '請先啟動相機後再切換鏡頭', 'warn');
    setCameraButtons();
    return;
  }

  S.cameraBusy = true;
  setCameraButtons();

  try {
    const cams = await detectCameras();

    if (cams.length === 0) {
      throw new Error('找不到可切換的相機');
    }

    const baseIndex = S.currentCameraIndex >= 0 ? S.currentCameraIndex : 0;
    const nextIndex = (baseIndex + 1) % cams.length;
    const nextCameraId = cams[nextIndex].id;

    setStatus('scanner-status', `切換鏡頭中：${cameraLabel(nextIndex)}`, 'warn');

    await stopScannerInternal();
    S.currentCameraIndex = nextIndex;
    await startScannerInternal(nextCameraId);
  } catch (e) {
    await stopScannerInternal();
    setStatus('scanner-status', `切換失敗：${e.message}`, 'error');
  } finally {
    S.cameraBusy = false;
    setCameraButtons();
  }
}

// --- 9. 提交提案 ---
async function submitProposal() {
  if (S.submitting) return;

  const title = nt($('proposal-title')?.value);
  const note = nt($('proposal-note')?.value) || '';

  if (S.draftItems.length === 0) {
    setStatus('submit-status', '草稿中無品項', 'error');
    return;
  }

  S.submitting = true;

  const btn = $('btn-submit');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '提交中...';
  }

  try {
    const data = await apiRequest('submitProposal', {
      title,
      note,
      clientRequestId: 'uid-' + Date.now(),
      items: S.draftItems
    });

    setStatus(
      'submit-status',
      `提交成功：${data?.docId || '單據已建立'}`,
      'ok'
    );

    S.draftItems = [];
    renderDraft();

    if ($('proposal-title')) {
      $('proposal-title').value = '';
    }

    if ($('proposal-note')) {
      $('proposal-note').value = '';
    }
  } catch (e) {
    setStatus('submit-status', `提交失敗：${e.message}`, 'error');
  } finally {
    S.submitting = false;

    if (btn) {
      btn.disabled = false;
      btn.textContent = '送出提案';
    }
  }
}

// --- 10. 事件綁定與初始化 ---
function bind() {
  const saferBind = (id, event, fn) => {
    const el = $(id);

    if (el) {
      el[event] = fn;
    }
  };

  saferBind('tab-proposal', 'onclick', () => switchPage('proposal'));
  saferBind('tab-history', 'onclick', () => switchPage('history'));

  saferBind('btn-history-search', 'onclick', () => {
    const dateInput = $('history-date');
    searchHistory(dateInput ? dateInput.value : '');
  });

  saferBind('btn-history-today', 'onclick', () => {
    const d = new Date();

    const q = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if ($('history-date')) {
      $('history-date').value = q;
    }

    searchHistory(q);
  });

  saferBind('btn-close-detail', 'onclick', () => {
    if ($('detail-modal')) {
      $('detail-modal').classList.add('hidden');
    }
  });

  saferBind('btn-sync', 'onclick', () => syncMasterData(true, false));

  saferBind('btn-add', 'onclick', () => {
    const q = $('manual-query') ? $('manual-query').value : '';
    const qty = $('manual-qty') ? $('manual-qty').value : 1;

    handleInput(q, qty);
  });

  saferBind('btn-submit', 'onclick', submitProposal);

  saferBind('btn-clear', 'onclick', () => {
    S.draftItems = [];
    renderDraft();
  });

  saferBind('btn-start', 'onclick', startScanner);
  saferBind('btn-stop', 'onclick', stopScanner);
  saferBind('btn-switch-camera', 'onclick', switchCamera);

  saferBind('btn-close-picker', 'onclick', () => {
    if ($('picker')) {
      $('picker').classList.add('hidden');
    }
  });

  if ($('proposal-title')) {
    $('proposal-title').oninput = updateSubmitHint;
  }

  if ($('manual-query')) {
    $('manual-query').onkeydown = (e) => {
      if (e.key === 'Enter') {
        const q = $('manual-query') ? $('manual-query').value : '';
        const qty = $('manual-qty') ? $('manual-qty').value : 1;

        handleInput(q, qty);
      }
    };
  }
}

function fmt(v) {
  if (!v) return '';

  const d = new Date(v);

  return isNaN(d.getTime())
    ? String(v)
    : d.toLocaleString('zh-TW', { hour12: false });
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  renderDraft();
  switchPage('proposal');

  // 首次初始化：全頁遮罩鎖定；成功隱藏；失敗維持遮罩。
  syncMasterData(false, true);
});
