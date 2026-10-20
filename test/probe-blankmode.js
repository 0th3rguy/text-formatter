/* 对比四种空行模式下的分页与填充率，用于决定默认值。 */
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

const appPath = path.join(OUT, '_probe-blankmode.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9973;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-bm-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars',
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
  'function __m(){',
  '  var pages = document.querySelectorAll("#pages .page");',
  '  var res = [];',
  '  for (var i=0;i<pages.length;i++){',
  '    var pg = pages[i];',
  '    var doc = pg.querySelector(".doc");',
  '    var cs = getComputedStyle(pg);',
  '    var avail = pg.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);',
  '    var used = 0;',
  '    for (var j=0;j<doc.children.length;j++){',
  '      used += doc.children[j].getBoundingClientRect().height;',
  '    }',
  '    res.push({n:i+1, avail:Math.round(avail), used:Math.round(used),',
  '              pct: Math.round(used/avail*100), kids: doc.children.length});',
  '  }',
  '  return {pages: pages.length, detail: res};',
  '}',
  '__m()'
].join('\n');

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev('document.getElementById("btnSample").click();true');
  await sleep(1200);

  for (const mode of ['keep_all', 'keep_single', 'delete_single', 'delete_all']) {
    await ev(`(function(){
      var s=document.getElementById('q_blank');
      if(!s) return 'no q_blank';
      s.value=${JSON.stringify(mode)};
      s.dispatchEvent(new Event('change',{bubbles:true}));
      return s.value;
    })()`);
    await sleep(1100);
    const m = await ev(MEASURE);
    console.log(`${mode.padEnd(14)} 页数=${String(m.pages).padStart(2)}  ` +
      m.detail.map(d => `p${d.n}:${d.pct}%(${d.kids}块)`).join(' '));
  }

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
