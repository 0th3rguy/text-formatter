/* probe-field.js — 量 .field 内容是否溢出所在 grid 列，以及单位是否与输入框同一行 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9861 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_probe_fld.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pfld-'));
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
  await send('Page.reload', { ignoreCache: true }); await sleep(1700);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev(`document.querySelector('.tab[data-tab="adv"]').click();true`);
  await sleep(600);

  const rows = await ev(`(function(){
    var out=[];
    var fs=document.querySelectorAll('.col-left .grid2 .field');
    for(var i=0;i<fs.length;i++){
      var f=fs[i];
      if(!f.offsetParent) continue;
      var lbl=f.querySelector('span:first-child');
      var inp=f.querySelector('input,select');
      if(!inp) continue;
      var fr=f.getBoundingClientRect();
      var ir=inp.getBoundingClientRect();
      var ur=inp.closest('.unitrow');
      var ut=f.querySelector('.utag');
      var us=f.querySelector('select[data-cfg$="_unit"]');
      var lastR = us?us.getBoundingClientRect().right:(ut?ut.getBoundingClientRect().right:ir.right);
      out.push({
        cfg: inp.dataset.cfg||inp.id,
        fieldW: Math.round(fr.width),
        lblW: lbl?Math.round(lbl.getBoundingClientRect().width):0,
        inpW: Math.round(ir.width),
        /* 内容右边界超出字段宽 → 溢出（会盖住右侧那一列） */
        overflow: Math.round(lastR - fr.right),
        /* 单位与输入框顶端差 >20px → 真的换行了 */
        tagBelow: ut?Math.round(ut.getBoundingClientRect().top - ir.top):null,
        unitSel: !!us
      });
    }
    return out;
  })()`);
  console.log('字段总数: ' + rows.length);
  const bad = rows.filter(x => x.overflow > 1);
  console.log('溢出的: ' + bad.length);
  for (const x of rows.slice(0, 26)) {
    console.log('  ' + (x.overflow > 1 ? 'OVER ' : 'ok   ') +
      (x.cfg || '?').padEnd(28) + ' field=' + String(x.fieldW).padStart(4) +
      ' lbl=' + String(x.lblW).padStart(3) +
      ' inp=' + String(x.inpW).padStart(4) +
      ' over=' + String(x.overflow).padStart(4) +
      ' tagΔ=' + String(x.tagBelow).padStart(4) +
      (x.unitSel ? ' [unit-select]' : ''));
  }

  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
