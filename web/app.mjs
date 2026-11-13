const app = document.querySelector('#app');
let state = await fetch('/portal/state').then(response => response.json());
const action = async value => {
  const response = await fetch('/portal/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  document.querySelector('#feedback').textContent = JSON.stringify(result, null, 2);
  return { ok: response.ok, value: result };
};
const feedback = '<pre id="feedback" aria-live="polite"></pre>';
app.innerHTML = '<p>版本 <span id="version"></span></p><label>备注<input id="note"></label><label>采样方式<select id="method"><option value="manual">人工</option><option value="automatic">自动</option></select></label><label>容器<input id="container"></label><button id="save">保存本行</button><button id="refresh">刷新</button>' + feedback;
function render() { document.querySelector('#version').textContent = state.version; for (const key of ['note','method','container']) document.querySelector('#'+key).value = state.record[key]; document.querySelector('#feedback').textContent=JSON.stringify(state); }
render();
document.querySelector('#save').onclick = async () => {
  const record = Object.fromEntries(['note','method','container'].map(key=>[key,document.querySelector('#'+key).value]));
  const result = await action({action:'save',version:state.version,record});
  state=result.value.state??result.value;render();
};
document.querySelector('#refresh').onclick=async()=>{state=await fetch('/portal/state').then(response=>response.json());render();};
