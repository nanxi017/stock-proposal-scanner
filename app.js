/**
【目的】
- 核心理由：掃碼提案系統前端邏輯 v2.2 - 備註功能強化版
- 權責邊界：[負責] UI 渲染、掃描控制、狀態管理、API 請求 [不負責] 後端資料持久化
- MWE：需搭配 html5-qrcode 庫與 GAS 後端執行
- 致命錯誤邊界：已針對 DOM 缺失進行防護，防止因剔除診斷 UI 導致的 Null Pointer 崩潰。
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
  masterData: {},      // 主檔快取
  draftItems: [],      // 草稿清單
  scanner: null,       // 掃描器實例
  lastScanText: '',    // 防抖重複紀錄
  lastScanAt: 0,
  choices: [],         // 搜尋歧義時的選擇列表
  pendingQty: 1,       // 待加入數量
  submitting: false,   // 提交狀態
  syncing: false,      // 同步狀態
  historyItems: [],    // 歷史清單
  historyLoading: false,
  detailLoading: false,
  cameras: []          // 相機列表
};

// --- 2. 核心工具函數 ---
const $ = (id) => document.getElementById(id);
const nt = (v) => (v == null ? '' : String(v).trim()); // Normal Text
const pos = (v, f = 1) => { // Positive Integer Only
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

// --- 3. API 通訊層 ---
async function apiRequest(action, payload = {}) {
  const body = { action, appKey: CONFIG.APP_KEY, payload };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

  try {
    const r = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);

    const j = JSON.parse(text);
    if (!j || j.success === false) throw new Error(j?.message || 'API 請求失敗');
    return j.data;
  } catch (e) {
    if (e.name === 'AbortController') throw new Error('連線超時，請檢查網路');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- 4. 業務邏輯：主檔同步 ---
async function syncMasterData(force = false) {
  if (S.syncing) return;
  S.syncing = true;
  
  const btn = $('btn-sync');
  if (btn) btn.disabled = true;

  try {
    setStatus('system-status', '同步主檔中...', 'warn');
    const rv = await apiRequest('getMasterVersion');
    const lv = localStorage.getItem(CONFIG.CACHE_KEY_VERSION);

    if (force || rv !== lv) {
      const arr = await apiRequest('getMasterSnapshot');
      if (!Array.isArray(arr)) throw new Error('主檔格式錯誤');
      
      const map = {};
      arr.forEach(i => {
        const barcode = nt(i.barcode), itemId = nt(i.itemId), name = nt(i.name);
        if (barcode && itemId && name) map[barcode] = { barcode, itemId, name };
      });

      S.masterData = map;
      localStorage.setItem(CONFIG.CACHE_KEY_DATA, JSON.stringify(map));
      localStorage.setItem(CONFIG.CACHE_KEY_VERSION, String(rv || ''));
      setStatus('system-status', `主檔同步完成：${Object.keys(map).length} 筆`, 'ok');
    } else {
      S.masterData = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY_DATA) || '{}');
      setStatus('system-status', `主檔已使用快取：${Object.keys(S.masterData).length} 筆`, 'ok');
    }
  } catch (e) {
    console.error(e);
    setStatus('system-status', `主檔同步失敗：${e.message}`, 'error');
  } finally {
    S.syncing = false;
    if (btn) btn.disabled = false;
  }
}

// --- 5. 業務邏輯：草稿管理 ---
function resolveFromMaster(q0) {
  const q = nt(q0).toLowerCase();
  const rows = Object.values(S.masterData || {});
  const seen = new Set();
  const items = [];

  rows.filter(i => 
    nt(i.barcode).toLowerCase() === q || 
    nt(i.itemId).toLowerCase() === q ||
    nt(i.barcode).toLowerCase().includes(q) ||
    nt(i.itemId).toLowerCase().includes(q) ||
    nt(i.name).toLowerCase().includes(q)
  ).forEach(i => {
    const k = i.itemId + '|' + i.barcode;
    if (!seen.has(k)) { seen.add(k); items.push(i); }
  });

  if (items.length === 0) return { type: 'NONE' };
  if (items.length === 1) return { type: 'ONE', item: items[0] };
  return { type: 'MULTI', items: items.slice(0, 30) };
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
    if (source === 'manual') $('manual-query').value = '';
    return;
  }

  // 多筆模糊匹配時開啟選擇器
  S.pendingQty = pos(qty, 1);
  S.choices = r.items;
  renderChoices();
  $('picker').classList.remove('hidden');
  setStatus(statusId, `找到 ${r.items.length} 筆相似品項`, 'warn');
}

// --- 6. UI 渲染渲染 ---
function updateSubmitHint() {
  const title = nt($('proposal-title')?.value);
  setText('submit-hint', title ? `提案標題：${title}` : '單號將自動生成；標題為空時由系統預留。');
}

function renderDraft() {
  updateSubmitHint();
  const root = $('draft-list');
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
    info.innerHTML = `<div class="item-name">${i.name}</div><div class="muted">${i.itemId}｜${i.barcode}</div>`;

    const lab = document.createElement('label');
    lab.textContent = '數量';
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.value = i.qty;
    qtyInput.onchange = () => { i.qty = pos(qtyInput.value, 1); renderDraft(); };
    lab.appendChild(qtyInput);

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '刪除';
    del.onclick = () => { S.draftItems = S.draftItems.filter(x => x.itemId !== i.itemId); renderDraft(); };

    c.append(info, lab, del);
    root.appendChild(c);
  });
  setText('total-badge', `品項 ${S.draftItems.length}｜總數 ${total}`);
}

function renderChoices() {
  const root = $('choice-list');
  root.innerHTML = '';
  S.choices.forEach(i => {
    const c = document.createElement('article');
    c.className = 'choice-card';
    c.innerHTML = `<div class="item-name">${i.name}</div><div class="muted">${i.itemId}｜${i.barcode}</div>`;
    c.onclick = () => {
      addDraftItem(i, S.pendingQty);
      $('picker').classList.add('hidden');
      setStatus('manual-status', `已加入：${i.name}`, 'ok');
    };
    root.appendChild(c);
  });
}

// --- 7. 歷史紀錄與搜尋 ---
function switchPage(p) {
  const isHistory = p === 'history';
  $('page-proposal').classList.toggle('hidden', isHistory);
  $('page-history').classList.toggle('hidden', !isHistory);
  $('tab-proposal').classList.toggle('active', !isHistory);
  $('tab-history').classList.toggle('active', isHistory);
}

async function searchHistory(q) {
  q = nt(q);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    setStatus('history-message', '日期格式錯誤', 'error');
    return;
  }
  if (S.historyLoading) return;
  S.historyLoading = true;

  try {
    setStatus('history-message', '搜尋中...', 'warn');
    const data = await apiRequest('searchHistory', { q });
    S.historyItems = Array.isArray(data) ? data : [];
    renderHistoryResults();
    setStatus('history-message', `搜尋完成：${S.historyItems.length} 筆`, S.historyItems.length ? 'ok' : 'warn');
  } catch (e) {
    setStatus('history-message', `搜尋失敗：${e.message}`, 'error');
  } finally {
    S.historyLoading = false;
  }
}

function renderHistoryResults() {
  const root = $('history-results');
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

async function loadHistoryDetail(docId) {
  if (S.detailLoading) return;
  S.detailLoading = true;
  try {
    const d = await apiRequest('getProposalDetail', { docId });
    renderHistoryDetail(d);
    $('detail-modal').classList.remove('hidden');
  } catch (e) {
    setStatus('history-message', `載入細節失敗：${e.message}`, 'error');
  } finally {
    S.detailLoading = false;
  }
}

function renderHistoryDetail(d) {
  setText('detail-doc-id', d?.docId || '提案詳情');
  const summary = [
    d?.title || '未命名提案',
    fmt(d?.createdAt),
    d?.status,
    d?.note ? `(備註: ${d.note})` : ''
  ].filter(Boolean).join(' ｜ ');
  setText('detail-summary', summary);

  const root = $('detail-items');
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
async function detectCameras() {
  try {
    const cams = await Html5Qrcode.getCameras();
    S.cameras = Array.isArray(cams) ? cams : [];
    // 診斷框已剔除，故不再更新 UI，僅回傳結果
    return S.cameras;
  } catch (e) {
    return [];
  }
}

async function startScanner() {
  if (S.scanner) return;
  if (typeof Html5Qrcode === 'undefined') {
    setStatus('scanner-status', '掃描模組未載入', 'error');
    return;
  }

  $('reader-wrap').classList.add('active');
  $('btn-start').disabled = true;

  try {
    const cams = await detectCameras();
    const rear = cams.find(c => /back|rear|environment/i.test(nt(c.label)));
    const id = (rear || cams[0] || {}).id;

    S.scanner = new Html5Qrcode('reader');
    await S.scanner.start(
      id || { facingMode: 'environment' },
      { fps: 10, qrbox: 250 },
      (txt) => {
        const code = nt(txt), now = Date.now();
        if (!code || (code === S.lastScanText && now - S.lastScanAt < CONFIG.SCAN_DEBOUNCE_MS)) return;
        S.lastScanText = code; S.lastScanAt = now;
        $('manual-query').value = code;
        setStatus('scanner-status', `掃描成功：${code}`, 'ok');
        handleInput(code, 1, 'scanner');
      },
      () => {}
    );
    $('btn-stop').disabled = false;
    setStatus('scanner-status', '相機運作中', 'ok');
  } catch (e) {
    await stopScanner();
    setStatus('scanner-status', `啟動失敗：${e.message}`, 'error');
  }
}

async function stopScanner() {
  if (S.scanner) {
    try { await S.scanner.stop(); await S.scanner.clear(); } catch (e) {}
  }
  S.scanner = null;
  $('reader-wrap').classList.remove('active');
  $('btn-start').disabled = false;
  $('btn-stop').disabled = true;
  setStatus('scanner-status', '相機已關閉', 'warn');
}

// --- 9. 提交提案 ---
async function submitProposal() {
  if (S.submitting) return;

  const title = nt($('proposal-title').value);
  const note = nt($('proposal-note').value) || ''; // 原 source 欄位改為 note

  if (S.draftItems.length === 0) {
    setStatus('submit-status', '草稿中無品項', 'error');
    return;
  }

  S.submitting = true;
  const btn = $('btn-submit');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    const data = await apiRequest('submitProposal', {
      title,
      note,
      clientRequestId: 'uid-' + Date.now(),
      items: S.draftItems
    });
    setStatus('submit-status', `提交成功：${data?.docId || '單據已建立'}`, 'ok');
    S.draftItems = [];
    renderDraft();
    $('proposal-title').value = '';
    $('proposal-note').value = '';
  } catch (e) {
    setStatus('submit-status', `提交失敗：${e.message}`, 'error');
  } finally {
    S.submitting = false;
    btn.disabled = false;
    btn.textContent = '提交提案';
  }
}

// --- 10. 事件綁定與初始化 ---
function bind() {
  // 安全綁定（防止 HTML 元件被移除時報錯）
  const saferBind = (id, event, fn) => {
    const el = $(id);
    if (el) el[event] = fn;
  };

  saferBind('tab-proposal', 'onclick', () => switchPage('proposal'));
  saferBind('tab-history', 'onclick', () => switchPage('history'));
  saferBind('btn-history-search', 'onclick', () => searchHistory($('history-date').value));
  saferBind('btn-history-today', 'onclick', () => {
    const d = new Date();
    const q = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('history-date').value = q;
    searchHistory(q);
  });

  saferBind('btn-close-detail', 'onclick', () => $('detail-modal').classList.add('hidden'));
  saferBind('btn-sync', 'onclick', () => syncMasterData(true));
  saferBind('btn-add', 'onclick', () => handleInput($('manual-query').value, $('manual-qty').value));
  saferBind('btn-submit', 'onclick', submitProposal);
  saferBind('btn-clear', 'onclick', () => { S.draftItems = []; renderDraft(); });
  saferBind('btn-start', 'onclick', startScanner);
  saferBind('btn-stop', 'onclick', stopScanner);
  saferBind('btn-close-picker', 'onclick', () => $('picker').classList.add('hidden'));

  // 輸入防抖
  if ($('proposal-title')) $('proposal-title').oninput = updateSubmitHint;
  if ($('manual-query')) $('manual-query').onkeydown = (e) => {
    if (e.key === 'Enter') handleInput($('manual-query').value, $('manual-qty').value);
  };
}

function fmt(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-TW', { hour12: false });
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  renderDraft();
  switchPage('proposal');
  syncMasterData(false);
});
