/* probe-unitrow.js — 量 .unitrow 是否换行、单位是否与输入框同一行 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9841 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_probe_ur.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pur-'));
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

  const r = await ev(`(function(){
    var rows=[];
    var urs=document.querySelectorAll('.col-left .unitrow');
    for(var i=0;i<urs.length;i++){
      var u=urs[i];
      if(!u.offsetParent) continue;
      var inp=u.querySelector('input,select');
      if(!inp) continue;
      var ut=u.querySelector('.utag');
      var ir=inp.getBoundingClientRect();
      var ur=u.getBoundingClientRect();
      var tr=ut?ut.getBoundingClientRect():null;
      rows.push({
        cfg: inp.dataset.cfg || inp.id,
        rowW: Math.round(ur.width), rowH: Math.round(ur.height),
        inpW: Math.round(ir.width), inpH: Math.round(ir.height),
        tagTop: tr?Math.round(tr.top-ir.top):null,
        /* 单位比输入框低 3px 以上 = 换行了 */
        wrapped: tr ? (tr.top - ir.top > 3) : null,
        tagTxt: ut?ut.textContent.trim():''
      });
    }
    return rows;
  })()`);
  console.log('unitrow 数量: ' + r.length);
  const wrapped = r.filter(x => x.wrapped);
  console.log('换行的: ' + wrapped.length);
  for (const x of r.slice(0, 20)) {
    console.log('  ' + (x.wrapped ? 'WRAP ' : 'ok   ') + x.cfg +
      '  row ' + x.rowW + 'x' + x.rowH + '  inp ' + x.inpW + '  tagΔ' + x.tagTop + '  [' + x.tagTxt + ']');
  }

  /* 再看 .field 与 .grid2 的宽度分配 */
  const g = await ev(`(function(){
    var out=[];
    var gs=document.querySelectorAll('.col-left .grid2');
    for(var i=0;i<gs.length;i++){
      var el=gs[i];
      if(!el.offsetParent) continue;
      var cs=getComputedStyle(el);
      out.push({cols:cs.gridTemplateColumns, w:Math.round(el.getBoundingClientRect().width)});
    }
    return out.slice(0,6);
  })()`);
  console.log('\n.grid2: ' + JSON.stringify(g));

  const f = await ev(`(function(){
    var u=document.querySelector('.unitrow');
    if(!u) return null;
    var cs=getComputedStyle(u);
    var p=u.parentNode, pcs=getComputedStyle(p);
    return {unit_display:cs.display, unit_flexWrap:cs.flexWrap, unit_flex:cs.flex,
      parentTag:p.tagName, parentClass:p.className,
      parent_display:pcs.display, parent_flexWrap:pcs.flexWrap,
      parent_w:Math.round(p.getBoundingClientRect().width)};
  })()`);
  console.log('.unitrow 自身: ' + JSON.stringify(f));

  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
