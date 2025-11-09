/* ===== Worker (performance-tuned, green edition) ===== */
const workerSrc=`
const URL_RX=/https?:\\/\\/\\S+/i;
const DOMAIN_ANYWHERE_RX=/\\b([a-z0-9-]+(?:\\.[a-z0-9-]+)+)(?:\\/[\\S^:]*)?/i;
const TRAIL=/[),.;:!?}\\]>’"'”]+$/;
const MULTI_TLD=new Set(["co.uk","org.uk","ac.uk","gov.uk","co.jp","ne.jp","or.jp","com.au","net.au","org.au","com.br","com.ph","net.ph","org.ph"]);
function parseAliases(text){
  const lines=(text||"").split("\\n").map(s=>s.trim()).filter(Boolean);
  const map=new Map();
  for(const line of lines){
    const m=line.split("=>"); if(m.length<2) continue;
    const canon=m[0].trim().toLowerCase();
    const alts=m[1].split("|").map(s=>s.trim().toLowerCase()).filter(Boolean);
    for(const a of alts) map.set(a, canon); map.set(canon, canon);
  } return map;
}
function canonicalHost(host,{stripWww=true,mergeSub=true,aliasMap=null}={}){
  host=(host||"").toLowerCase();
  if(stripWww && host.startsWith("www.")) host=host.slice(4);
  if(aliasMap && aliasMap.has(host)) host=aliasMap.get(host);
  if(!mergeSub) return host;
  const p=host.split(".").filter(Boolean);
  if(p.length<=2) return host;
  const l2=p.slice(-2).join("."), l3=p.slice(-3).join(".");
  if(MULTI_TLD.has(l2) && p.length>=3) return p.slice(-3).join(".");
  if(MULTI_TLD.has(l3) && p.length>=4) return p.slice(-4).join(".");
  return p.slice(-2).join(".");
}
function findUrlOrHostAnywhere(line){
  const m1=line.match(URL_RX); if(m1) return m1[0].replace(TRAIL,"");
  const m2=line.match(DOMAIN_ANYWHERE_RX);
  if(m2){ const host=m2[1]; const after=line.slice(m2.index+m2[0].length);
    const path=(/^(\\/[\\S^:]*)/.exec(after)||["",""])[1];
    return ("https://"+host+path).replace(TRAIL,"");
  } return null;
}
function extractLine(line){
  const url=findUrlOrHostAnywhere(line); if(!url) return {url:null,user:null,pass:null,raw:line};
  const token=url.includes("://")?url:url.replace(/^https?:\\/\\//i,"");
  let idx=line.indexOf(url); if(idx<0) idx=line.indexOf(token);
  let tail=line.slice(idx+(idx>=0?url.length:0)).trim().replace(/^[ :\\t]+/,"");
  if(!tail) return {url,user:null,pass:null,raw:line};
  const c=tail.indexOf(":"); let user=null, pass=null;
  if(c>=0){ user=tail.slice(0,c).trim(); pass=tail.slice(c+1).trim(); }
  else{ const parts=tail.split(/\\s+/).filter(Boolean);
    if(parts.length===1) user=parts[0]; else if(parts.length>=2){ user=parts[0]; pass=parts.slice(1).join(" "); }
  } return {url,user,pass,raw:line};
}
function normCore(h){ h=(h||"").toLowerCase().replace(/^www\\./,""); h=h.replace(/\\b(accounts|account|secure|login|auth|id|m|mobile|www2|app)\\./g,""); const p=h.split("."); if(p.length>=2) p.pop(); return p.join("."); }
function dice(a,b){
  a=a||""; b=b||""; if(!a||!b) return 0; if(a===b) return 1;
  const grams=s=>{const z=[]; for(let i=0;i<s.length-1;i++) z.push(s.slice(i,i+2)); return z;};
  const A=grams(a), B=grams(b), map=new Map(); for(const g of A) map.set(g,(map.get(g)||0)+1); let inter=0;
  for(const g of B){ const k=map.get(g)||0; if(k>0){ inter++; map.set(g,k-1);} } return (2*inter)/(A.length+B.length||1);
}
function blockKey(core){ return (core||"").slice(0,3); }
let STORE=null;
self.onmessage=async (e)=>{
  const {type,payload}=e.data;
  if(type==="process"){
    const {text,opts,fuzzy,thresh,maxpower}=payload;
    const aliasMap=parseAliases(opts.aliases);
    const groups=new Map(), meta=new Map(), unidentified=[], noCreds=[], badFmt=[];
    let rawCount=0;
    const lines=text.split(/\\r?\\n/);
    const N=lines.length;
    const big=N>250000, huge=N>600000;
    const chunk = maxpower ? (huge?24000: (big?16000:9000)) : 6000;
    let tick=0, tickEvery = maxpower ? 4 : 2; // fewer UI pings in max mode
    for(let i=0;i<N;i+=chunk){
      for(let j=i;j<Math.min(i+chunk,N);j++){
        let line=lines[j].trim();
        if(!line || line.startsWith("#")) continue;
        rawCount++;
        const {url,user,pass}=extractLine(line);
        if(!url){ unidentified.push(line); continue; }
        try{
          const u=new URL(url); let key;
          if(opts.mode==="url"){
            let clean=url.replace(/[),.;:!?}\\]>’"'”]+$/,"");
            if(clean.endsWith("/")) clean=clean.slice(0,-1);
            key=clean; meta.set(key,{host:u.hostname, core:normCore(u.hostname)});
          }else{
            const host=canonicalHost(u.hostname,{stripWww:opts.stripWww,mergeSub:opts.mergeSub,aliasMap});
            key=host; meta.set(key,{host,core:normCore(host)});
          }
          if(!user || !pass){ noCreds.push(line); continue; }
          const pair=\`\${user.trim()}:\${pass.trim()}\`;
          if(!groups.has(key)) groups.set(key,new Map());
          const pm=groups.get(key);
          if(!pm.has(pair)) pm.set(pair,new Set());
          pm.get(pair).add(url);
        }catch(_){ badFmt.push(line); }
      }
      if((tick++ % tickEvery)===0) postMessage({type:"progress",payload:{done:Math.min(i+chunk,N),total:N}});
      await new Promise(r=>setTimeout(r,0));
    }
    if(fuzzy && opts.mode==="domain"){
      const keys=[...groups.keys()], byBlock=new Map();
      for(const k of keys){ const core=meta.get(k)?.core||k; const b=blockKey(core); if(!byBlock.has(b)) byBlock.set(b,[]); byBlock.get(b).push(k); }
      const parent=new Map(keys.map(k=>[k,k]));
      const find=k=>parent.get(k)===k?k:parent.set(k,find(parent.get(k))).get(k);
      const unite=(a,b)=>{a=find(a); b=find(b); if(a!==b) parent.set(a,b);};
      for(const arr of byBlock.values()){
        arr.sort((a,b)=>(groups.get(b)?.size||0)-(groups.get(a)?.size||0));
        for(let i=0;i<arr.length;i++){
          const a=arr[i], ca=meta.get(a)?.core||a;
          for(let j=i+1;j<arr.length;j++){
            const b=arr[j], cb=meta.get(b)?.core||b;
            if(Math.abs(ca.length-cb.length)>4) continue;
            if(dice(ca,cb)>=thresh) unite(a,b);
          }
        }
      }
      const merged=new Map();
      for(const k of keys){
        const r=find(k); if(!merged.has(r)) merged.set(r,new Map());
        const dst=merged.get(r), src=groups.get(k);
        for(const [pair,urls] of src.entries()){
          if(!dst.has(pair)) dst.set(pair,new Set());
          const d=dst.get(pair); for(const u of urls) d.add(u);
        }
      }
      const repr=new Map();
      for(const k of keys){ const r=find(k); const cur=repr.get(r); if(!cur || k.length<cur.length) repr.set(r,k); }
      groups.clear();
      for(const [r,mapPairs] of merged.entries()){ const name=repr.get(r)||r; groups.set(name,mapPairs); }
    }
    const rows=[...groups.entries()].map(([key,pm])=>({key,count:pm.size}))
      .sort((a,b)=> b.count-a.count || a.key.localeCompare(b.key));
    const totalPairs=rows.reduce((a,r)=>a+r.count,0);
    STORE={groups,unidentified,noCreds,badFmt,rows,totalPairs,rawCount};
    postMessage({type:"done",payload:{
      rows,totalPairs,rawCount,
      unidentifiedCount:unidentified.length,
      noCredCount:noCreds.length,
      badFmtCount:badFmt.length
    }});
  }else if(type==="downloadGroup"){
    const {group,trim}=payload;
    if(!STORE || !STORE.groups.has(group)){ postMessage({type:"blob",payload:{name:"group.txt",url:null}}); return; }
    const pm=STORE.groups.get(group), out=[];
    for(const [pair,urls] of pm.entries()){
      if(trim) out.push(pair);
      else for(const u of urls) out.push(`\${u}:\${pair}`);
    }
    out.sort();
    const blob=new Blob([out.join("\\n")+"\\n"],{type:"text/plain"});
    const url=URL.createObjectURL(blob);
    postMessage({type:"blob",payload:{name:group.replace(/[^a-zA-Z0-9._-]+/g,"_")+".txt",url}});
  }else if(type==="downloadBucket"){
    if(!STORE) return;
    const arr=STORE[payload.bucket]||[];
    const blob=new Blob([arr.join("\\n")+"\\n"],{type:"text/plain"});
    const url=URL.createObjectURL(blob);
    postMessage({type:"blob",payload:{name:payload.bucket+".txt",url}});
  }else if(type==="downloadSummary"){
    if(!STORE) return;
    const rows=STORE.rows;
    if(payload.format==="csv"){
      const esc=s=>"\\"" + String(s).replace(/"/g,'""') + "\\"";
      const csv=["group,count,percent"].concat(
        rows.map(r=> esc(r.key)+","+r.count+","+(STORE.totalPairs?((r.count/STORE.totalPairs*100).toFixed(2)):"0.00"))
      ).join("\\n");
      const blob=new Blob([csv],{type:"text/csv"}), url=URL.createObjectURL(blob);
      postMessage({type:"blob",payload:{name:"summary.csv",url}});
    }else{
      const json=JSON.stringify({parsed_pairs:STORE.totalPairs,raw_lines:STORE.rawCount,groups:rows},null,2);
      const blob=new Blob([json],{type:"application/json"}), url=URL.createObjectURL(blob);
      postMessage({type:"blob",payload:{name:"summary.json",url}});
    }
  }
};
`;

/* ===== Main (UI) ===== */
const worker=new Worker(URL.createObjectURL(new Blob([workerSrc],{type:"application/javascript"})));
const $=s=>document.querySelector(s);
const input=$("#input"), mode=$("#mode"), merge=$("#merge"), stripwww=$("#stripwww"), trimlink=$("#trimlink");
const maxpower=$("#maxpower"), fuzzy=$("#fuzzy"), thresh=$("#thresh"), threshVal=$("#threshVal"), aliasesTA=$("#aliases");
const rawCountEl=$("#rawCount"), pairsCountEl=$("#pairsCount"), groupsCountEl=$("#groupsCount");
const unidCountEl=$("#unidCount"), noCredCountEl=$("#noCredCount"), badFmtCountEl=$("#badFmtCount");
const dlCSV=$("#dlCSV"), dlJSON=$("#dlJSON"), dlUnid=$("#dlUnid"), dlNoCred=$("#dlNoCred"), dlBadFmt=$("#dlBadFmt");
const vwrap=$("#vwrap"), rowsEl=$("#rows"), spacerTop=$("#spacerTop"), spacerBot=$("#spacerBot"), maxBadge=$("#maxBadge");
const ROW_H=48, VBUF=20;

let viewRows=[], fullRows=[], totalPairs=0;

const DEFAULT_ALIASES=`spotify.com => accounts.spotify.com | open.spotify.com | www.spotify.com
netflix.com => www.netflix.com | m.netflix.com
nike.com => www.nike.com | secure-store.nike.com
disneyplus.com => www.disneyplus.com
paypal.com => www.paypal.com
youtube.com => youtu.be | m.youtube.com | www.youtube.com
twitter.com => x.com | t.co | mobile.twitter.com | www.x.com
github.com => gist.github.com
hm.com => www.hm.com | m2.hm.com | www2.hm.com`;
aliasesTA.value=DEFAULT_ALIASES;

/* Loader */
const $L=id=>document.getElementById(id);
const loader=$L("loader"), loadTitle=$L("loadTitle"), loadFill=$L("loadFill"), loadLabel=$L("loadLabel"), loadMetricLeft=$L("loadMetricLeft"), loadLines=$L("loadLines"), loadPct=$L("loadPct"), loadElapsed=$L("loadElapsed"), loadEta=$L("loadEta");
let tStart=0,lastProgress={done:0,total:0},etaTicker=null;
const fmtTime=s=>{s=Math.max(0,Math.floor(s));const m=String(Math.floor(s/60)).padStart(2,"0"),x=String(s%60).padStart(2,"0");return `${m}:${x}`};
const showLoader=s=>loader.classList.toggle("show",!!s);
function setBusy(b,{title="Processing…",labelInit="Reading…",metric="Lines"}={}){
  $("#run").disabled=b; $("#loadFile").disabled=b;
  if(b){
    tStart=performance.now(); lastProgress={done:0,total:0};
    loadTitle.textContent=title; showLoader(true);
    loadFill.style.width="0%"; loadLabel.textContent="Reading…";
    loadMetricLeft.firstChild && (loadMetricLeft.firstChild.textContent=`${metric}: `);
    loadLines.textContent="0 / 0"; loadPct.textContent="0%"; loadElapsed.textContent="00:00"; loadEta.textContent="—";
    startEtaTicker();
  }else{ showLoader(false); stopEtaTicker(); }
}
function startEtaTicker(){
  stopEtaTicker();
  etaTicker=setInterval(()=>{
    const d=lastProgress.done,t=Math.max(1,lastProgress.total);
    const pct=Math.min(100,(d/t)*100), elapsed=(performance.now()-tStart)/1000, rate=d>0? elapsed/d:0, remain=d<t&&rate>0?(t-d)*rate:0;
    loadElapsed.textContent=fmtTime(elapsed);
    loadEta.textContent=remain?fmtTime(remain):"—";
    loadFill.style.width=pct.toFixed(2)+"%";
    loadPct.textContent=`${pct.toFixed(1)}%`;
    loadLines.textContent=`${d.toLocaleString()} / ${t.toLocaleString()}`;
  },240);
}
function stopEtaTicker(){ if(etaTicker){clearInterval(etaTicker); etaTicker=null;} }

/* Run */
function run(){
  const opts={mode:mode.value,mergeSub:merge.checked,stripWww:stripwww.checked,aliases:aliasesTA.value||""};
  worker.postMessage({type:"process",payload:{text:input.value||"",opts,fuzzy:fuzzy.checked,thresh:Number(thresh.value)/100,maxpower:maxpower.checked}});
  setBusy(true,{title:"Processing lines…",labelInit:"Parsing…",metric:"Lines"});
  saveSettings(); maxBadge.style.display=maxpower.checked?"inline-block":"none";
}

/* Worker messages */
worker.onmessage=(e)=>{
  const {type,payload}=e.data;
  if(type==="progress"){ lastProgress=payload; loadLabel.textContent="Grouping…"; return; }
  if(type==="done"){
    setBusy(false);
    fullRows=payload.rows; totalPairs=payload.totalPairs; viewRows=fullRows.slice();
    rawCountEl.textContent=String(payload.rawCount);
    pairsCountEl.textContent=String(totalPairs);
    groupsCountEl.textContent=String(viewRows.length);
    unidCountEl.textContent=String(payload.unidentifiedCount);
    noCredCountEl.textContent=String(payload.noCredCount);
    badFmtCountEl.textContent=String(payload.badFmtCount);
    dlCSV.disabled=fullRows.length===0; dlJSON.disabled=false;
    dlUnid.disabled=payload.unidentifiedCount===0; dlNoCred.disabled=payload.noCredCount===0; dlBadFmt.disabled=payload.badFmtCount===0;
    updateVirtual(); return;
  }
  if(type==="blob"){
    if(!payload.url) return;
    const a=document.createElement("a"); a.href=payload.url; a.download=payload.name;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{URL.revokeObjectURL(payload.url); a.remove();},0);
  }
};

/* Search */
let searchTimer=null;
$("#search").addEventListener("input", ()=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(applySearch,120);
});
$("#clearSearch").addEventListener("click",()=>{$("#search").value=""; applySearch();});
function applySearch(){
  const q=($("#search").value||"").trim().toLowerCase();
  viewRows=!q? fullRows.slice() : fullRows.filter(r=>r.key.toLowerCase().includes(q));
  groupsCountEl.textContent=String(viewRows.length);
  updateVirtual();
}

/* Virtual list */
function updateVirtual(){
  const n=viewRows.length, h=vwrap.clientHeight, top=vwrap.scrollTop;
  const start=Math.max(0,Math.floor(top/ROW_H)-VBUF);
  const end=Math.min(n,Math.ceil((top+h)/ROW_H)+VBUF);
  spacerTop.style.height=(start*ROW_H)+"px";
  spacerBot.style.height=((n-end)*ROW_H)+"px";
  const frag=document.createDocumentFragment();
  for(let i=start;i<end;i++){
    const r=viewRows[i], pct=totalPairs?((r.count/totalPairs)*100).toFixed(2):"0.00";
    const row=document.createElement("div"); row.className="row";
    row.innerHTML=`
      <div><span class="pill">${r.key}</span></div>
      <div>${r.count}</div>
      <div>
        <div class="barline"><div class="fill" style="width:${pct}%"></div></div>
        <div class="small">${pct}%</div>
      </div>
      <div><button class="btn" data-group="${r.key}">Download</button></div>`;
    frag.appendChild(row);
  }
  rowsEl.innerHTML=""; rowsEl.appendChild(frag);
  rowsEl.querySelectorAll("button[data-group]").forEach(btn=>{
    btn.onclick=()=>{ worker.postMessage({type:"downloadGroup",payload:{group:btn.getAttribute("data-group"),trim:trimlink.checked}}); };
  });
}
vwrap.addEventListener("scroll", ()=>{
  if(vwrap._busy) return; vwrap._busy=true; requestAnimationFrame(()=>{updateVirtual(); vwrap._busy=false;});
});

/* Exports */
dlCSV.onclick=()=>worker.postMessage({type:"downloadSummary",payload:{format:"csv"}});
dlJSON.onclick=()=>worker.postMessage({type:"downloadSummary",payload:{format:"json"}});
dlUnid.onclick=()=>worker.postMessage({type:"downloadBucket",payload:{bucket:"unidentified"}});
dlNoCred.onclick=()=>worker.postMessage({type:"downloadBucket",payload:{bucket:"noCreds"}});
dlBadFmt.onclick=()=>worker.postMessage({type:"downloadBucket",payload:{bucket:"badFmt"}});

/* Open / Drop */
$("#run").addEventListener("click", run);
$("#loadFile").addEventListener("click", ()=> $("#fileInput").click());
$("#fileInput").addEventListener("change", async (e)=>{ const f=e.target.files?.[0]; if(!f) return; await readFileStreamIntoTextarea(f); run(); });

const dropZone=document.querySelector(".input-section.drop");
["dragenter","dragover"].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.add("dragging")}));
["dragleave","drop"].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.remove("dragging")}));
dropZone.addEventListener("drop",async e=>{
  const f=[...(e.dataTransfer?.files||[])].find(x=>x.type==="" && x.name?.toLowerCase().endsWith(".txt"));
  if(!f) return; await readFileStreamIntoTextarea(f); run();
});

async function readFileStreamIntoTextarea(f){
  setBusy(true,{title:"Opening file…",labelInit:"Reading…",metric:"Bytes"});
  lastProgress.total=f.size;
  const reader=f.stream().getReader(), decoder=new TextDecoder(); let doneBytes=0, chunks=[];
  try{
    while(true){
      const {value,done}=await reader.read(); if(done) break;
      doneBytes+=value.byteLength; chunks.push(decoder.decode(value,{stream:true}));
      lastProgress.done=doneBytes; loadLabel.textContent="Reading…";
    }
    chunks.push(decoder.decode()); input.value=chunks.join("");
  }catch(_){ } finally{ setBusy(false); }
}

/* UX niceties */
document.addEventListener("keydown",e=>{ if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){ e.preventDefault(); run(); }});
thresh.addEventListener("input",e=>threshVal.textContent=(Number(e.target.value)/100).toFixed(2));

/* Settings */
const SETTINGS_KEY="slg_settings_green_v1";
function saveSettings(){
  const s={mode:mode.value,merge:merge.checked,stripwww:stripwww.checked,trimlink:trimlink.checked,fuzzy:fuzzy.checked,maxpower:maxpower.checked,thresh:thresh.value,aliases:aliasesTA.value};
  try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(s))}catch(_){}
}
(function loadSettings(){
  try{
    const s=JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}");
    if(s.mode) mode.value=s.mode;
    if(typeof s.merge==="boolean") merge.checked=s.merge;
    if(typeof s.stripwww==="boolean") stripwww.checked=s.stripwww;
    if(typeof s.trimlink==="boolean") trimlink.checked=s.trimlink;
    if(typeof s.fuzzy==="boolean") fuzzy.checked=s.fuzzy;
    if(typeof s.maxpower==="boolean") { maxpower.checked=s.maxpower; maxBadge.style.display=s.maxpower?"inline-block":"none"; }
    if(s.thresh){thresh.value=s.thresh; threshVal.textContent=(Number(s.thresh)/100).toFixed(2)}
    if(s.aliases) aliasesTA.value=s.aliases;
  }catch(_){}
})();
threshVal.textContent=(Number(thresh.value)/100).toFixed(2);
