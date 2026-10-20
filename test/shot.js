/* 截图：读入用户正规模板后的预览效果（用于交付确认）。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const TEMPLATE = process.argv[2] ||
  'D:\\Work\\政务信息\\2026\\2026.6.23卷烟物流配送中心“四个强化”夯实运营管理根基.docx';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
const appPath = path.join(OUT, '_shot.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9921;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shot-'));
const fileUrl = 'file:///' + appPath.replace(/\\/g, '/');

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files',
  '--disable-breakpad', '--disable-crash-reporter',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, fileUrl
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('调试端口未就绪');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise(res => {
          const mid = ++id; waiting.set(mid, res);
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => reject(new Error('WebSocket 错误')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w(m.result); }
    });
  });
}

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);

  const ev = async (expr, awaitPromise) => (await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true })).result.value;

  if (TEMPLATE && fs.existsSync(TEMPLATE)) {
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const n = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: n.nodeId, files: [TEMPLATE] });
    await ev('document.getElementById("file").dispatchEvent(new Event("change",{bubbles:true})); true');
    await sleep(2300);
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(600);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const outp = path.join(OUT, 'ui-preview-fixed.png');
  fs.writeFileSync(outp, Buffer.from(shot.data, 'base64'));
  console.log('screenshot: ' + outp);

  // 顺带截「③ 自定义」页
  await ev('document.querySelectorAll(".tab")[2].click(); true');
  await sleep(700);
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const outp2 = path.join(OUT, 'ui-preview-adv.png');
  fs.writeFileSync(outp2, Buffer.from(shot2.data, 'base64'));
  console.log('screenshot: ' + outp2);

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exit(1);
});
