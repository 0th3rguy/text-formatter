/* probe-hf.js — 看预览页与页脚元素是否存在 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9701 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_probe_hf.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-phf-'));
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
  await send('Page.reload', { ignoreCache: true }); await sleep(1600);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + ((r.exceptionDetails.exception || {}).description || ''));
    return r.result.value;
  };

  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1800);
  const info = await ev(`(function(){
    return {
      pages: document.querySelectorAll('#pages .page').length,
      docBlanks: document.querySelectorAll('#pages .doc > *').length,
      ftr: document.querySelectorAll('#pages .ftr').length,
      hdr: document.querySelectorAll('#pages .hdr').length,
      pnFmt: window.WFPDefaults.DEFAULT_CONFIG.page_number_format,
      pw: document.getElementById('pages') ? document.getElementById('pages').style.transform : 'none',
      stats: document.getElementById('stStats').textContent
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
