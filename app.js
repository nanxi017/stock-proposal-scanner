/*
【目的】
- 核心理由：GitHub Pages → GAS API → resolve → draft
- 權責邊界：[負責]輸入管線 [不負責]後端
- MWE：只需 CONFIG.API_BASE 即可運行
- 致命錯誤邊界：camera / API / concurrency → 已控制
*/
const { createApp, reactive } = Vue;
const CONFIG = {
  API_BASE: 'https://script.google.com/macros/s/AKfycbxw9Y1y3A7N5CUhgp0ACezB12JXqNPXcssvMTwwWk5C2QeMCvn97UdrueSQ6_Jx0rJG/exec', // 部署後請替換此 ID
};

createApp({
  setup(){

    const state = reactive({
      query:'',
      qty:1,
      msg:'',

      draft:[],

      // scanner
      scannerRunning:false,
      scannerMsg:'Idle',
      scanner:null,

      // picker
      choices:[],
      showPicker:false
    });

    /* ================= API ================= */

    function apiGet(action, params){
      const url = new URL(CONFIG.API_BASE);
      url.searchParams.set('action', action);

      Object.entries(params||{}).forEach(([k,v])=>{
        url.searchParams.set(k, v);
      });

      return fetch(url)
        .then(r=>r.json())
        .then(p=>{
          if(!p.success) throw new Error(p.message);
          return p.data;
        });
    }

    function apiPost(payload){
      return fetch(CONFIG.API_BASE,{
        method:'POST',
        body:JSON.stringify(payload)
      })
      .then(r=>r.json())
      .then(p=>{
        if(!p.success) throw new Error(p.message);
        return p.data;
      });
    }

    /* ================= Domain ================= */

    function addDraft(item, qty){
      const found = state.draft.find(x=>x.itemId===item.itemId);
      if(found){
        found.qty += qty;
      }else{
        state.draft.push({...item, qty});
      }
    }

    function fixQty(i){
      if(i.qty <=0) i.qty=1;
    }

    function remove(id){
      state.draft = state.draft.filter(x=>x.itemId!==id);
    }

    /* ================= Resolve ================= */

    function handleInput(q, qty){

      q=(q||'').trim();
      if(!q){
        state.msg='請輸入';
        return;
      }

      return apiGet('searchMasterItems',{q})
        .then(list=>{

          if(list.length===0){
            state.msg='找不到';
            resumeScanner();
            return;
          }

          if(list.length===1){
            addDraft(list[0], qty);
            state.msg='已加入';
            state.query='';
            resumeScanner();
            return;
          }

          state.choices=list;
          state.showPicker=true;
          pauseScanner();
        })
        .catch(e=>{
          state.msg=e.message;
          resumeScanner();
        });
    }

    function handleManual(){
      handleInput(state.query, state.qty||1);
    }

    function pick(item){
      addDraft(item, state.qty||1);
      closePicker();
      resumeScanner();
    }

    function closePicker(){
      state.showPicker=false;
      state.choices=[];
    }

    /* ================= Scanner ================= */

    async function startScanner(){
      if(state.scannerRunning) return;

      state.scanner = new Html5Qrcode("reader");

      await state.scanner.start(
        { facingMode: "environment" },
        { fps:10, qrbox:250 },
        txt=>{
          pauseScanner();
          state.query = txt;
          handleInput(txt,1);
        }
      );

      state.scannerRunning=true;
      state.scannerMsg='RUNNING';
    }

    async function stopScanner(){
      if(!state.scanner) return;

      await state.scanner.stop();
      await state.scanner.clear();

      state.scanner=null;
      state.scannerRunning=false;
      state.scannerMsg='STOPPED';
    }

    function pauseScanner(){
      try{ state.scanner?.pause(); }catch(e){}
    }

    function resumeScanner(){
      try{ state.scanner?.resume(); }catch(e){}
    }

    /* ================= Submit ================= */

    function submit(){

      if(state.draft.length===0){
        state.msg='空清單';
        return;
      }

      const payload = {
        action:'submitProposal',
        items: state.draft
      };

      apiPost(payload)
        .then(()=>{
          state.msg='成功';
          state.draft=[];
        })
        .catch(e=>{
          state.msg=e.message;
        });
    }

    return {
      ...state,
      handleManual,
      startScanner,
      stopScanner,
      remove,
      fixQty,
      submit,
      pick,
      closePicker
    }
  }
}).mount('#app');
