/* 量「空行提示条」的尺寸，确认按钮没有被拉伸成整行。 */
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

const appPath = path.join(OUT, '_probe-hint.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9977;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-hint-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
  '--disable-breakpad', '--disable-crash-reporter', '--hide-scrollbars',
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

const MEASURE = [
  'function __hint(){',
  '  var b = document.getElementById("btnDropBlank");',
  '  var h = document.getElementById("blankHint");',
  '  if (!b || !h) return {err:"missing"};',
  '  var rb = b.getBoundingClientRect();',
  '  var rh = h.getBoundingClientRect();',
  '  var cs = getComputedStyle(b);',
  '  return {',
  '    btnW: Math.round(rb.width), btnH: Math.round(rb.height),',
  '    hintW: Math.round(rh.width), hintH: Math.round(rh.height),',
  '    btnBg: cs.backgroundColor, txt: b.textContent.trim()',
  '  };',
  '}',
  '__hint()'
].join('\n');

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev('document.getElementById("btnSample").click(); true');
  await sleep(1400);
  const m = await ev(MEASURE);
  console.log('提示条: ' + JSON.stringify(m));
  const okBtn = m.btnW > 60 && m.btnW < m.hintW * 0.6;
  console.log(okBtn ? 'PASS 按钮宽度正常（未被拉伸）' : 'FAIL 按钮宽度异常');
  cdp.close(); browser.kill();
  process.exit(okBtn ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
