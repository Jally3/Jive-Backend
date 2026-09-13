export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Jive 服务监控</title>
  <style>
    :root{color-scheme:dark;--bg:#0b1020;--panel:#151c31;--line:#2a3554;--text:#e8edf8;--muted:#95a2bd;--ok:#4ade80;--bad:#fb7185;--accent:#60a5fa}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}
    main{max-width:1280px;margin:auto;padding:28px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
    h1{font-size:25px;margin:0}h2{font-size:17px;margin:0 0 14px}.muted{color:var(--muted)}button{border:0;border-radius:8px;background:var(--accent);color:#07111f;padding:9px 16px;font-weight:700;cursor:pointer}button:disabled{opacity:.55}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto}.value{font-size:25px;font-weight:750;margin-top:5px}.hint{color:var(--muted);font-size:12px;margin-top:4px}.ok{color:var(--ok)}.bad{color:var(--bad)}
    table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;border-bottom:1px solid var(--line);padding:9px 10px}th{color:var(--muted);font-weight:600}.section{margin-top:18px}.empty{padding:15px 0;color:var(--muted)}
    .controls{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}select,input{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px}pre{margin:0;max-height:520px;overflow:auto;background:var(--bg);padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-word}
    @media(max-width:640px){main{padding:18px}header{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body><main>
  <header><div><h1>Jive 服务监控</h1><div id="updated" class="muted">尚未读取</div></div><button id="refresh">刷新数据</button></header>
  <div id="summary" class="grid"></div>
  <section class="panel section"><h2>Catalog 当前状态</h2><div id="feeds"></div></section>
  <section class="panel section"><h2>当前运行状态</h2><div id="runtime"></div></section>
  <section class="panel section"><h2>每日接口调用</h2><div id="http"></div></section>
  <section class="panel section"><h2>每日 TMDB 调用</h2><div id="tmdb"></div></section>
  <section class="panel section"><h2>最近刷新事件</h2><div id="events"></div></section>
  <section class="panel section"><h2>内存 Catalog 内容</h2><div class="controls"><select id="itemFeed"><option>latest</option><option>popular</option><option>top_rated</option></select><select id="itemGroup"><option>all</option><option>movie</option><option>tv</option><option>animation</option><option>variety</option></select><input id="itemPage" type="number" min="1" value="1"><button id="loadItems">查看内容</button></div><pre id="items">点击“查看内容”后按页读取，不会触发 TMDB 或刷新榜单。</pre></section>
</main><script>
const $=id=>document.getElementById(id);const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=value=>{const units=['B','KiB','MiB','GiB'];let n=Number(value)||0,i=0;while(n>=1024&&i<3){n/=1024;i++}return n.toFixed(i?1:0)+' '+units[i]};
const time=(value,timezone)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)):'-';
function table(headers,rows){if(!rows.length)return '<div class="empty">暂无数据</div>';return '<table><thead><tr>'+headers.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
function render(data){const memory=data.runtime.memory;const today=data.history.days[0]?.metrics;const requests=Object.values(today?.http||{}).reduce((n,x)=>n+x.requests,0);const tmdbCalls=Object.values(today?.tmdb||{}).reduce((n,x)=>n+x.logicalCalls,0);$('summary').innerHTML=[['今日请求',requests,'本监控时区内累计'],['今日 TMDB',tmdbCalls,'逻辑调用次数'],['RSS（进程内存）',bytes(memory.rss),'Node 进程当前占用的物理内存'],['Heap（V8 堆）',bytes(memory.heapUsed)+' / '+bytes(memory.heapTotal),'已用 / 当前已分配；上限 '+bytes(data.runtime.heapLimit)],['运行时长',Math.floor(data.runtime.uptimeSeconds/60)+' 分钟','进程启动至今'],['监控存储',data.history.stateFile.enabled?(data.history.stateFile.dirty?'待保存':'已保存'):'纯内存','每日聚合数据的持久化状态']].map(x=>'<div class="panel"><div class="muted">'+esc(x[0])+'</div><div class="value">'+esc(x[1])+'</div><div class="hint">'+esc(x[2])+'</div></div>').join('');
const feeds=Object.entries(data.catalog.feeds).map(([name,x])=>[name,x.available?(x.stale?'stale':'ok'):'missing',x.itemCount??'-',x.refreshing?'是':'否',x.generatedAt??'-',x.sizes?bytes(x.sizes.jsonBytes):'-']);$('feeds').innerHTML=table(['Feed','状态','条目','刷新中','生成时间','JSON 大小'],feeds);
const concurrency=data.tmdb.concurrency||{};$('runtime').innerHTML=table(['项目','当前值'],[['Node',data.runtime.nodeVersion],['V8 Heap 上限',bytes(data.runtime.heapLimit)],['External / ArrayBuffers',bytes(memory.external)+' / '+bytes(memory.arrayBuffers)],['Catalog 状态文件',data.catalog.stateFile?.enabled?data.catalog.stateFile.path:'未启用'],['监控状态文件',data.history.stateFile.enabled?data.history.stateFile.path:'未启用'],['TMDB Detail Cache',data.tmdb.detailCacheEntries??'-'],['TMDB 在途 Detail',data.tmdb.detailInflight??'-'],['TMDB 并发',String(concurrency.active??'-')+' / '+String(concurrency.maximum??'-')],['TMDB 等待队列',concurrency.waiting??'-']]);
const http=[];for(const day of data.history.days)for(const [route,x] of Object.entries(day.metrics.http))http.push([day.date,route,x.requests,time(x.firstCalledAt,data.history.timezone),time(x.lastCalledAt,data.history.timezone),Object.entries(x.statuses).map(([s,n])=>s+':'+n).join(' '),(x.duration.sumMs/Math.max(1,x.duration.count)).toFixed(1)+' ms',x.duration.maxMs+' ms',bytes(x.responseBytes)]);$('http').innerHTML=table(['日期','接口','次数','首次调用','最近调用','状态码','平均耗时','最大耗时','流量'],http);
const tmdb=[];for(const day of data.history.days)for(const [route,x] of Object.entries(day.metrics.tmdb))tmdb.push([day.date,route,x.logicalCalls,x.attempts,x.successes,x.failures,x.retries,x.rateLimited,(x.duration.sumMs/Math.max(1,x.duration.count)).toFixed(1)+' ms']);$('tmdb').innerHTML=table(['日期','端点','调用','请求','成功','失败','重试','429','平均耗时'],tmdb);
$('events').innerHTML=table(['时间','级别','Feed','事件','详情'],data.history.recentEvents.map(x=>[x.occurredAt,x.level,x.feed??'-',x.message,x.detail??'-']));$('updated').textContent='读取时间：'+new Date(data.generatedAt).toLocaleString()+' · 时区：'+data.history.timezone}
async function refresh(){const button=$('refresh');button.disabled=true;button.textContent='读取中…';try{const response=await fetch('/admin/api/overview?days=30',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);render(await response.json())}catch(error){$('updated').textContent='读取失败：'+error.message}finally{button.disabled=false;button.textContent='刷新数据'}}
async function loadItems(){const button=$('loadItems');button.disabled=true;try{const query=new URLSearchParams({feed:$('itemFeed').value,group:$('itemGroup').value,page:$('itemPage').value,pageSize:'20'});const response=await fetch('/admin/api/catalog/items?'+query,{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||('HTTP '+response.status));$('items').textContent=JSON.stringify(body,null,2)}catch(error){$('items').textContent='读取失败：'+error.message}finally{button.disabled=false}}
$('refresh').addEventListener('click',refresh);refresh();
$('loadItems').addEventListener('click',loadItems);
</script></body></html>`;
