/* 量预览里标题与主送机关之间的垂直间距，并与导出的 .docx 对照。 */
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

const appPath = path.join(OUT, '_probe-gap.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9971;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-gap-'));
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

const PROBE = [
  'function __gap(){',
  '  var doc = document.querySelector("#pages .doc");',
  '  if (!doc) return {err:"no doc"};',
  '  var out = [];',
  '  var all = doc.children;',
  '  for (var i=0;i<all.length;i++){',
  '    var el = all[i];',
  '    var r = el.getBoundingClientRect();',
  '    var cs = getComputedStyle(el);',
  '    out.push({',
  '      i:i,',
  '      cls: el.className,',
  '      txt: (el.textContent||"").trim().slice(0,18),',
  '      top: Math.round(r.top*100)/100,',
  '      h: Math.round(r.height*100)/100,',
  '      fs: cs.fontSize,',
  '      lh: cs.lineHeight,',
  '      mt: cs.marginTop,',
  '      mb: cs.marginBottom',
  '    });',
  '  }',
  '  var res = [];',
  '  for (var j=1;j<out.length;j++){',
  '    res.push({',
  '      from: out[j-1].txt,',
  '      to: out[j].txt,',
  '      gap: Math.round((out[j].top - (out[j-1].top + out[j-1].h))*100)/100',
  '    });',
  '  }',
  '  return {blocks: out.slice(0,7), gaps: res.slice(0,6)};',
  '}',
  '__gap()'
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

  // 切到 100% 便于按像素判断
  await ev('document.getElementById("zoomPct").value="100";document.getElementById("zoomPct").dispatchEvent(new Event("change",{bubbles:true}));true');
  await sleep(700);
  await ev('document.getElementById("btnSample").click();true');
  await sleep(1200);

  const data = await ev(PROBE);
  console.log('=== 预览前 7 块 ===');
  for (const b of data.blocks) {
    console.log(`  [${b.i}] ${b.cls.padEnd(22)} top=${String(b.top).padStart(8)} h=${String(b.h).padStart(7)} fs=${b.fs.padStart(6)} lh=${b.lh.padStart(7)} mt=${b.mt} mb=${b.mb} | ${b.txt}`);
  }
  console.log('=== 相邻块间距 ===');
  for (const g of data.gaps) {
    console.log(`  ${String(g.gap).padStart(7)}px  ${g.from} → ${g.to}`);
  }

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
