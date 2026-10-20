/* shot-hl.js — 滚到「各级标题行距」并截图 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9871 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_shot_hl.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shl-'));
  const b = spawn(BIN, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--disable-extensions', '--allow-file-access-from-files',
    '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + app.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 100; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const t = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { ws = t.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(250);
  }
  const s = new WebSocket(ws); let id = 0; const w = new Map();
  await new Promise(r => s.addEventListener('open', r));
  s.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); }
  });
  const send = (me, p) => new Promise(r => { const i = ++id; w.set(i, r); s.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1700);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1500);
  await ev(`document.querySelector('.tab[data-tab="adv"]').click();true`);
  await sleep(500);

  /* 展开「各级标题行距」并滚到它 */
  const found = await ev(`(function(){
    var hs=document.querySelectorAll('.collapse-h');
    for(var i=0;i<hs.length;i++){
      if(/各级标题行距/.test(hs[i].textContent||'')){
        var bd=hs[i].parentNode.querySelector('.collapse-b');
        if(bd && bd.classList.contains('hide')) hs[i].click();
        return true;
      }
    }
    return false;
  })()`);
  console.log('找到各级标题行距: ' + found);
  await sleep(600);

  await ev(`(function(){
    var t=document.getElementById('headLineTable');
    if(t) t.scrollIntoView({block:'center'});
    return true;
  })()`);
  await sleep(600);

  const info = await ev(`(function(){
    var rows=[];
    var ls=document.querySelectorAll('.hline');
    for(var i=0;i<ls.length;i++){
      var l=ls[i];
      if(!l.offsetParent) continue;
      var rl=l.querySelector('.hl-rule');
      var val=l.querySelector('.hl-val');
      var un=l.querySelector('.hl-unit');
      rows.push({role:l.dataset.role, rule:rl?rl.value:null,
        ruleTxt: rl&&rl.options[rl.selectedIndex]?rl.options[rl.selectedIndex].text:null,
        val:val?val.value:null, valDis:val?val.disabled:null,
        unit:un&&un.options[un.selectedIndex]?un.options[un.selectedIndex].text:null,
        w:Math.round(l.getBoundingClientRect().width)});
    }
    return rows;
  })()`);
  console.log(JSON.stringify(info, null, 1));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-hf-headline.png'), Buffer.from(r.data, 'base64'));
  console.log('→ ui-hf-headline.png');

  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
