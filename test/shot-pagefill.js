/* shot-pagefill.js —— 截预览第 1 页，确认页面底部不再有大片空白
   产出 test/out/ui-pagefill.png */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_shot-pf.html');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CHROMES.find(p => fs.existsSync(p));
const PORT = 9481 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-spf-'));
  spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + APP.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) { ws = pg.webSocketDebuggerUrl; break; }
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  const sock = new WebSocket(ws);
  let id = 0; const waiters = new Map();
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; waiters.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (!r) return undefined;
    if (r.exceptionDetails) { console.error('EXC: ' + r.exceptionDetails.text); return undefined; }
    return r.result ? r.result.value : undefined;
  };

  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1560, deviceScaleFactor: 2, mobile: false });
  await sleep(500);

  // 100% 缩放，方便看清整页
  await ev('(function(){var p=document.getElementById("zoomPct");p.value="100";p.dispatchEvent(new Event("change",{bubbles:true}));return 1;})()');
  await sleep(600);
  await ev('document.getElementById("btnSample").click();true');
  await sleep(1600);

  const box = await ev([
    '(function(){',
    '  const p=document.querySelector("#pages .page");',
    '  if(!p) return null;',
    '  const r=p.getBoundingClientRect();',
    '  return {x:r.left+window.scrollX,y:r.top+window.scrollY,w:r.width,h:r.height};',
    '})()'
  ].join('\n'));
  console.log('第 1 页盒子: ' + JSON.stringify(box));

  if (box) {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h), scale: 1 }
    });
    fs.writeFileSync(path.join(OUT, 'ui-pagefill.png'), Buffer.from(shot.data, 'base64'));
    console.log('写出: ui-pagefill.png  ' + Math.round(box.w) + 'x' + Math.round(box.h));
  }

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
