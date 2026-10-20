/* 截图：把预览第一页在 100% 缩放下单独截出来，用于和 Word 渲染逐像素比对页边距。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BROWSER = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const appPath = path.join(OUT, '_shot-margin.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9955;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-sm-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'file:///' + appPath.replace(/\\/g, '/')
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('端口未就绪');
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const w = new Map();
    ws.addEventListener('open', () => res({
      send(m, p) { return new Promise(r => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); }); },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => rej(new Error('ws')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m.result); }
    });
  });
}

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) { console.error('ERR ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return null; }
    return r.result.value;
  };

  await ev(`document.getElementById('btnSample').click(); true`);
  await sleep(1200);
  await ev(`(function(){var p=document.getElementById('zoomPct');p.value='100';p.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(900);

  // 只截第一张 .page
  const clip = await ev([
    'JSON.stringify((function(){',
    '  var p = document.querySelector("#pages .page");',
    '  var r = p.getBoundingClientRect();',
    '  return {x:r.left, y:r.top, w:r.width, h:r.height};',
    '})())'
  ].join('\n'));
  const c = JSON.parse(clip);
  console.log('page rect: ' + clip);

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 }
  });
  const file = path.join(OUT, 'preview-page1-100.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('saved: ' + file);

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
