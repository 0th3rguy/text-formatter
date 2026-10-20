/* probe-blocks.js — 逐块 dump 类型/高度，找出分页为何提前断页 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9851 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TARGET = (process.argv[2] && process.argv[2] !== '-') ? process.argv[2] : '';
const MODE = (process.argv[3] && process.argv[3] !== '-') ? process.argv[3] : '';

(async () => {
  const app = path.join(OUT, '_probe-blocks.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pb-'));
  const b = spawn(BIN, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--disable-breakpad', '--disable-crash-reporter', '--allow-file-access-from-files',
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
  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1500);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  if (TARGET) {
    const doc = await send('DOM.getDocument', { depth: -1 });
    const n = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId: n.nodeId, files: [TARGET] });
    await ev(`document.getElementById('file').dispatchEvent(new Event('change',{bubbles:true}));true`);
    await sleep(2500);
  } else {
    await ev(`document.getElementById('btnSample').click();true`);
    await sleep(1300);
  }
  if (MODE) {
    const before = await ev(`document.querySelectorAll('#pages .page').length`);
    const setRes = await ev(`(function(){
      var q=document.getElementById('q_blank');
      if(!q) return 'no q_blank';
      q.value=${JSON.stringify(MODE)};
      q.dispatchEvent(new Event('change',{bubbles:true}));
      return {v:q.value, stat:document.getElementById('stStats').textContent};
    })()`);
    await sleep(1400);
    const after = await ev(`({pages:document.querySelectorAll('#pages .page').length,
      wrapDisp:(document.getElementById('pagesWrap')||{}).style && document.getElementById('pagesWrap').style.display,
      emptyDisp:(document.getElementById('emptyTip')||{}).style && document.getElementById('emptyTip').style.display,
      stat:document.getElementById('stStats').textContent})`);
    console.log('MODE 切换: before=' + before + ' setRes=' + JSON.stringify(setRes) + ' after=' + JSON.stringify(after));
  }

  const r = await ev(`(function(){
    var host=document.getElementById('pages');
    host.style.transform='none';
    var pages=document.querySelectorAll('#pages .page');
    var out=[];
    for(var i=0;i<pages.length;i++){
      var pg=pages[i], doc=pg.querySelector('.doc');
      var cs=getComputedStyle(pg);
      var avail=pg.getBoundingClientRect().height-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);
      var kids=doc.children, sum=0, rows=[];
      for(var j=0;j<kids.length;j++){
        var k=kids[j], rc=k.getBoundingClientRect(), st=getComputedStyle(k);
        var h=rc.height+(parseFloat(st.marginTop)||0)+(parseFloat(st.marginBottom)||0);
        sum+=h;
        rows.push({t:(k.className||'?'),h:Math.round(h),txt:(k.textContent||'').slice(0,22)});
      }
      out.push({p:i+1,avail:Math.round(avail),sum:Math.round(sum),kids:kids.length,rows:rows});
    }
    return out;
  })()`);

  console.log('目标: ' + (TARGET || '(样例)') + (MODE ? '  空行模式=' + MODE : ''));
  for (const p of r) {
    console.log(`\n=== 第 ${p.p} 页  块${p.kids}  可用${p.avail}px  占用${p.sum}px (${Math.round(p.sum/p.avail*100)}%) ===`);
    p.rows.forEach((x, i) => {
      console.log(`  ${String(i).padStart(2)} ${x.t.padEnd(22)} ${String(x.h).padStart(4)}px  ${x.txt}`);
    });
  }
  s.close(); b.kill(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
