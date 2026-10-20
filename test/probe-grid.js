const fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
const ROOT='D:/WorkSpace/text-formatter', OUT=ROOT+'/test/out';
const BIN='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT=9801;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const app=path.join(OUT,'_probe.html');
  fs.copyFileSync(path.join(ROOT,'dist','文本排版工具.html'),app);
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'wfp-p-'));
  const b=spawn(BIN,['--headless=new','--disable-gpu','--no-first-run','--disable-breakpad','--disable-crash-reporter','--allow-file-access-from-files','--remote-debugging-port='+PORT,'--user-data-dir='+prof,'file:///'+app.replace(/\\/g,'/')],{stdio:'ignore'});
  let ws=null;
  for(let i=0;i<100;i++){try{const l=await(await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();const t=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(t){ws=t.webSocketDebuggerUrl;break}}catch(e){}await sleep(250)}
  const s=new WebSocket(ws);let id=0;const w=new Map();
  await new Promise(r=>s.addEventListener('open',r));
  s.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&w.has(m.id)){w.get(m.id)(m.result);w.delete(m.id)}});
  const send=(me,p)=>new Promise(r=>{const i=++id;w.set(i,r);s.send(JSON.stringify({id:i,method:me,params:p||{}}))});
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.reload',{ignoreCache:true});await sleep(1500);
  const ev=async ex=>{const r=await send('Runtime.evaluate',{expression:ex,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value};
  await ev('document.querySelector(\'.tab[data-tab="adv"]\').click();true');
  await sleep(300);
  await ev('(function(){var hs=document.querySelectorAll(".collapse-h");for(var i=0;i<hs.length;i++){var b=document.getElementById("b"+hs[i].id.slice(1));if(b&&b.classList.contains("hide"))hs[i].click()}return true})()');
  await sleep(400);
  const r=await ev(`(function(){
    var g=document.querySelectorAll('#bHeadIndent .grid2')[0];
    var cs=getComputedStyle(g);
    var f=g.querySelector('.field');
    return JSON.stringify({cols:cs.gridTemplateColumns,gap:cs.gap,gw:g.offsetWidth,
      fieldW:f.offsetWidth, fieldH:f.offsetHeight,
      leftW:document.getElementById('colLeft').offsetWidth,
      pane:document.querySelector('#pane-adv').offsetWidth,
      fs:document.querySelector('#pane-adv').offsetWidth})})()`);
  console.log(r);
  s.close();b.kill();process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
