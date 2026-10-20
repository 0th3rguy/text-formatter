/* shot-hf.js — 截图：页面设置（纸张/页脚距/单位）、各级标题行距 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9821 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_shot_hf.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shf-'));
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
  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1700);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1800);

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  → ' + name);
  };

  /* 1) 页面设置（纸张 + 四边距 + 页眉页脚距，全部带单位） */
  await ev(`document.querySelector('.tab[data-tab="adv"]').click();true`);
  await sleep(700);
  await shot('ui-hf-page.png');

  /* 2) 各级标题行距（展开折叠区） */
  await ev(`(function(){
    var hs=document.querySelectorAll('.collapse-h');
    for(var i=0;i<hs.length;i++){
      var t=hs[i].textContent||'';
      if(/各级标题行距/.test(t)){
        var bd=hs[i].parentNode.querySelector('.collapse-b');
        if(bd && bd.classList.contains('hide')) hs[i].click();
      }
    }
    return true;
  })()`);
  await sleep(700);
  await shot('ui-hf-headline.png');

  /* 3) ① 规范页，看快速面板的单位 */
  await ev(`document.querySelector('.tab[data-tab="preset"]').click();true`);
  await sleep(600);
  await shot('ui-hf-preset.png');

  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
