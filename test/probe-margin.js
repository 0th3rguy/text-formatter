/* 探针：实测预览页的真实页边距，和配置值比对，找出「上下留空太多」的根因。 */
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

const appPath = path.join(OUT, '_probe-margin.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9951;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-margin-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
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
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) {
      console.error('EVAL ERROR: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return 'null';
    }
    return r.result.value;
  };

  await ev(`document.getElementById('btnSample').click(); true`);
  await sleep(1200);

  const expr = [
    'JSON.stringify((function(){',
    '  var CM = 96/2.54;',
    '  var page = document.querySelector("#pages .page");',
    '  var doc = page.querySelector(".doc");',
    '  var cs = getComputedStyle(page);',
    '  var pr = page.getBoundingClientRect();',
    '  var kids = Array.prototype.slice.call(doc.children);',
    '  var ne = kids.filter(function(k){return (k.textContent||"").trim()});',
    '  var firstText = ne[0], lastText = ne[ne.length-1];',
    '  var fr = firstText.getBoundingClientRect();',
    '  var lr = lastText.getBoundingClientRect();',
    '  var blanks = kids.filter(function(k){return k.className.indexOf("blk-blank")>=0});',
    '  return JSON.stringify({',
    '    pageHpx: pr.height, pageWpx: pr.width,',
    '    padTop_cm: +(parseFloat(cs.paddingTop)/CM).toFixed(2),',
    '    padBottom_cm: +(parseFloat(cs.paddingBottom)/CM).toFixed(2),',
    '    padLeft_cm: +(parseFloat(cs.paddingLeft)/CM).toFixed(2),',
    '    padRight_cm: +(parseFloat(cs.paddingRight)/CM).toFixed(2),',
    '    realTopGap_cm: +((fr.top-pr.top)/CM).toFixed(2),',
    '    realBottomGap_cm: +((pr.bottom-lr.bottom)/CM).toFixed(2),',
    '    realLeftGap_cm: +((fr.left-pr.left)/CM).toFixed(2),',
    '    realRightGap_cm: +((pr.right-fr.right)/CM).toFixed(2),',
    '    contentW_cm: +((pr.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight))/CM).toFixed(2),',
    '    docHpx: doc.offsetHeight,',
    '    kidsCount: kids.length,',
    '    blankCount: blanks.length,',
    '    blankHpx: blanks.reduce(function(s,k){return s+k.offsetHeight},0),',
    '    firstCls: firstText.className,',
    '    firstMarginTop: getComputedStyle(firstText).marginTop,',
    '    firstMarginBottom: getComputedStyle(firstText).marginBottom',
    '  });',
    '})())'
  ].join('\n');
  const dump = await ev(expr);
  console.log(dump);

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
