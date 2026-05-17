/**
 * GAS 掃碼提案系統 v2.1 - 前端核心邏輯 (最終強化版)
 */

const CONFIG = {
    // ⚠️ 重要：請將此處替換為您部署後的 GAS Web App URL (必須包含 /exec)
    API_URL: 'https://script.google.com/macros/s/AKfycbxw9Y1y3A7N5CUhgp0ACezB12JXqNPXcssvMTwwWk5C2QeMCvn97UdrueSQ6_Jx0rJG/exec', // 部署後請替換此 ID
    APP_KEY: 'public-mvp-key',
    CACHE_KEY_VERSION: 'proposal_sys_version',
    CACHE_KEY_DATA: 'proposal_sys_master_data'
};

// 全域狀態管理
let state = {
    masterData: {}, // { barcode: { itemId, name } }
    currentVersion: '',
    draftItems: [], // [ { itemId, name, barcode, qty } ]
    scanner: null
};

/**
 * 系統初始化
 */
async function init() {
    showToast('系統啟動中...');
    try {
        await syncMasterData();
        setupScanner();
        updateProposalList();
    } catch (e) {
        console.error('初始化崩潰:', e);
        showToast(`初始化失敗: ${e.message}`);
    }
}

/**
 * 主檔同步邏輯：版本檢查 -> 必要時下載快照
 * 強化版：增加嚴格的 response 檢查，防止 TypeError
 */
async function syncMasterData() {
    try {
        // 1. 獲取遠端最新版本
        const response = await apiRequest('getMasterVersion');
        
        if (!response || response.success === false) {
            throw new Error(response ? response.message : '後端無回應');
        }

        // 【修正點 1】現在 response.data 直接就是版本字串，不再是物件
        if (!response.data) {
            throw new Error('後端回傳格式異常 (缺少版本資訊)');
        }

        const remoteVersion = response.data; // 直接賦值，不再讀取 .version
        const localVersion = localStorage.getItem(CONFIG.CACHE_KEY_VERSION);
        
        if (remoteVersion !== localVersion) {
            console.log('偵測到主檔更新，開始同步...');
            const snapshotResponse = await apiRequest('getMasterSnapshot');
            
            if (!snapshotResponse || snapshotResponse.success === false) {
                throw new Error('獲取快照失敗: ' + (snapshotResponse ? snapshotResponse.message : '未知錯誤'));
            }

            // 【修正點 2】現在 snapshotResponse.data 直接就是項目陣列 [ ... ]
            const itemsArray = snapshotResponse.data; 
            if (!Array.isArray(itemsArray)) {
                throw new Error('主檔快照資料格式錯誤 (預期為陣列)');
            }

            // 將陣列轉換為 Map
            const dataMap = {};
            itemsArray.forEach(item => {
                dataMap[item.barcode] = { itemId: item.itemId, name: item.name };
            });

            localStorage.setItem(CONFIG.CACHE_KEY_DATA, JSON.stringify(dataMap));
            localStorage.setItem(CONFIG.CACHE_KEY_VERSION, remoteVersion);
            state.masterData = dataMap;
            state.currentVersion = remoteVersion;
            showToast('主檔同步完成');
        } else {
            state.masterData = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY_DATA) || '{}');
            state.currentVersion = localVersion;
            console.log('主檔已是最新版本');
        }
    } catch (e) {
        console.error('同步流程失敗:', e);
        showToast(`❌ ${e.message}`); 
    }
}

/**
 * 相機掃描設定
 */
function setupScanner() {
    state.scanner = new Html5QrcodeScanner(
        "reader", { fps: 10, qrbox: { width: 250, height: 250 } }, false
    );

    state.scanner.render(onScanSuccess, onScanFailure);
    document.getElementById('scan-status').innerText = '相機已就緒，請掃描條碼';
}

function onScanSuccess(decodedText) {
    const item = state.masterData[decodedText];
    if (!item) {
        showToast(`❌ 未知條碼: ${decodedText}`);
        return;
    }

    const existingIdx = state.draftItems.findIndex(i => i.itemId === item.itemId);
    if (existingIdx > -1) {
        state.draftItems[existingIdx].qty += 1;
    } else {
        state.draftItems.push({
            itemId: item.itemId,
            name: item.name,
            barcode: decodedText,
            qty: 1
        });
    }

    updateProposalList();
    showToast(`✅ 已加入: ${item.name}`);
}

function onScanFailure(error) {
    // 掃描中持續失敗不彈出通知，避免干擾
}

/**
 * 更新 UI 草稿清單
 */
function updateProposalList() {
    const listEl = document.getElementById('proposal-list');
    const totalEl = document.getElementById('total-qty');
    
    if (state.draftItems.length === 0) {
        listEl.innerHTML = '<p class="text-center text-gray-400 py-4 text-sm">尚未掃描任何項目</p>';
        totalEl.innerText = '總數: 0';
        return;
    }

    let html = '';
    let totalQty = 0;
    
    state.draftItems.forEach((item, index) => {
        totalQty += item.qty;
        html += `
            <div class="flex justify-between items-center p-3 bg-gray-50 rounded-lg border border-gray-100">
                <div class="flex-1">
                    <div class="text-sm font-medium text-gray-700">${item.name}</div>
                    <div class="text-xs text-gray-400 font-mono">${item.barcode}</div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="font-bold text-blue-600">${item.qty}</span>
                    <button onclick="removeItem(${index})" class="text-red-400 hover:text-red-600 text-xl">&times;</button>
                </div>
            </div>
        `;
    });

    listEl.innerHTML = html;
    totalEl.innerText = `總數: ${totalQty}`;
}

function removeItem(index) {
    state.draftItems.splice(index, 1);
    updateProposalList();
}

/**
 * 提交提案單
 */
async function submitProposal() {
    const title = document.getElementById('proposal-title').value.trim();
    if (!title) return showToast('請輸入提案單標題');
    if (state.draftItems.length === 0) return showToast('請先掃描項目');

    const btn = document.getElementById('btn-submit');
    btn.disabled = true;
    btn.innerText = '提交中...';

    const payload = {
        action: 'submitProposal',
        appKey: CONFIG.APP_KEY,
        payload: {
            title: title,
            source: 'GitHub Pages',
            clientRequestId: 'uid-' + Date.now(),
            items: state.draftItems
        }
    };

    try {
        const response = await apiRequest('submitProposal', payload);
        if (response && response.success) {
            showToast(`提交成功！單號: ${response.data.docId}`);
            state.draftItems = [];
            document.getElementById('proposal-title').value = '';
            updateProposalList();
        } else {
            throw new Error(response ? response.message : '未知錯誤');
        }
    } catch (e) {
        showToast('提交失敗: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerText = '提交提案單';
    }
}

/**
 * 歷史查詢
 */
async function searchHistory() {
    const query = document.getElementById('search-query').value.trim();
    if (!query) return showToast('請輸入查詢日期');

    const resultsEl = document.getElementById('history-results');
    resultsEl.innerHTML = '<p class="text-center py-4 text-sm">查詢中...</p>';

    try {
        const response = await apiRequest('searchHistory', {
            action: 'searchHistory',
            appKey: CONFIG.APP_KEY,
            payload: { q: query }
        });

        if (!response || response.success === false) {
            throw new Error(response ? response.message : '查詢失敗');
        }

        if (response.data.items.length === 0) {
            resultsEl.innerHTML = '<p class="text-center py-4 text-sm text-gray-400">查無紀錄</p>';
            return;
        }

        resultsEl.innerHTML = response.data.items.map(doc => `
            <div onclick="viewDetail('${doc.docId}')" class="p-3 bg-white border rounded-lg shadow-sm cursor-pointer hover:border-blue-500 transition-all">
                <div class="flex justify-between items-center">
                    <span class="text-xs font-mono text-gray-500">${doc.docId}</span>
                    <span class="text-xs px-2 py-1 rounded ${doc.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}">${doc.status}</span>
                </div>
                <div class="font-bold text-gray-700 mt-1">${doc.title}</div>
                <div class="text-xs text-gray-400 mt-1">項目數: ${doc.itemCount} | 總量: ${doc.totalQty}</div>
            </div>
        `).join('');
    } catch (e) {
        resultsEl.innerHTML = `<p class="text-center py-4 text-sm text-red-500">${e.message}</p>`;
    }
}

async function viewDetail(docId) {
    try {
        const response = await apiRequest('getProposalDetail', {
            action: 'getProposalDetail',
            appKey: CONFIG.APP_KEY,
            payload: { docId: docId }
        });
        
        if (!response || response.success === false) {
            throw new Error(response ? response.message : '獲取詳情失敗');
        }

        const d = response.data;
        let itemsHtml = d.items.map(i => `<li class="text-sm py-1 border-b">${i.name} x ${i.qty}</li>`).join('');
        
        alert(`提案單詳情\n單號: ${d.docId}\n標題: ${d.title}\n項目:\n${itemsHtml}`);
    } catch (e) {
        showToast(e.message);
    }
}

/**
 * 統一 API 通訊層
 * 實作 text/plain 避開 CORS Preflight 預檢
 */
async function apiRequest(action, body = null) {
    if (!body) {
        body = { action, appKey: CONFIG.APP_KEY, payload: {} };
    }

    try {
        const res = await fetch(CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            throw new Error(`HTTP 錯誤! 狀態碼: ${res.status}`);
        }

        return await res.json(); 
    } catch (e) {
        console.error('API 通訊層崩潰:', e);
        return { success: false, message: '網路通訊失敗: ' + e.message, data: null };
    }
}

/**
 * UI 輔助函數
 */
function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('nav button').forEach(el => el.classList.add('opacity-70'));
    
    document.getElementById(`content-${tab}`).classList.add('active');
    document.getElementById(`tab-${tab}`).classList.remove('opacity-70');
    document.getElementById(`tab-${tab}`).classList.add('font-semibold', 'border-b-2', 'border-white');
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerText = msg;
    toast.classList.remove('opacity-0');
    setTimeout(() => toast.classList.add('opacity-0'), 3000);
}

// 啟動
window.onload = init;
