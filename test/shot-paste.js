/* 截图：模拟「从 Word 粘贴带换行文本」后的预览效果，确认段落没有被并成一段。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
const appPath = path.join(OUT, '_shot-paste.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9949;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shotp-'));
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

/* Word 复制出来的形态：一段一行，段间无空行，Windows 用 \r\n */
const PASTE = [
  '卷烟物流配送中心从“事后补损”到“全链控损”',
  '为降低卷烟破损损耗、规范破损卷烟调换流程，近日，卷烟物流配送中心聚焦运输、交接、处置各环节，推动破损管控从“事后补损”向“全链控损”转变。',
  '一是装卸控损，把好运输“源头关”。干线运输和装卸搬运是卷烟破损的主要发生环节。中心严格执行《干线运输交接管理制度》，细化笼车装载加固、车厢分层码放等作业要求，明确轻拿轻放、重不压轻、码放整齐的操作规范。',
  '二是认定登记，记实破损“明白账”。严格落实《河南烟草商业破损卷烟管理规定》（豫烟办〔2008〕69号），建立破损卷烟发现即登记机制，对破损品规、数量、发现环节、破损部位逐项记录并拍照留存，做到一损一单、有据可查。',
  '三是规范调换，畅通处置“快车道”。按照《残损、缺失卷烟识别、入库及处理办法》要求，统一破损卷烟调换口径，明确申请、审核、退回、补货各环节的时限要求和责任分工；实行破损卷烟专区暂存、单独码放、标识清晰，避免与正常卷烟混放。'
].join('\r\n');

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1600);

  const ev = async (expr, awaitPromise) => (await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true })).result.value;

  await ev(`(() => {
    const ta = document.getElementById('src');
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(PASTE)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(1100);

  const stats = await ev(`document.getElementById('stStats').textContent`);
  const pv = JSON.parse(await ev(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('#pages .doc > *')) {
      const t = (el.textContent || '').trim();
      if (t) out.push(el.className + ' :: ' + t.slice(0, 40));
    }
    return JSON.stringify(out);
  })()`));
  console.log('状态栏: ' + stats);
  pv.forEach((x, i) => console.log('  [' + i + '] ' + x));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const outp = path.join(OUT, 'ui-paste-newline.png');
  fs.writeFileSync(outp, Buffer.from(shot.data, 'base64'));
  console.log('screenshot: ' + outp);

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exit(1);
});
