/* probe-indent.js — 量预览里标题/正文的首行缩进是否一致（默认应都是 2 字符） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9881 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_probe-indent.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pi-'));
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
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1500);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1500);

  const r = await ev(`(function(){
    var out={cfg:{}};
    var sel=document.getElementById('c_blank_line_mode');
    out.cfg.blank=sel?sel.value:null;
    ['h1','h2','h3','h4'].forEach(function(k){
      var el=document.querySelector('[data-cfg="'+k+'_indent_chars"]');
      out.cfg[k]=el?el.value:null;
    });
    var body=document.querySelector('#pages .blk-body');
    out.bodyIndent = body ? getComputedStyle(body).textIndent : null;
    out.bodySize = body ? getComputedStyle(body).fontSize : null;
    out.heads=[];
    var seen={};
    document.querySelectorAll('#pages .blk-head').forEach(function(h){
      var lv=h.dataset.lv;
      if(seen[lv]) return; seen[lv]=1;
      out.heads.push({lv:lv, indent:getComputedStyle(h).textIndent,
        size:getComputedStyle(h).fontSize, txt:(h.textContent||'').slice(0,16)});
    });
    out.hasBlank = document.querySelectorAll('#pages .blk-blank').length;
    out.pages = document.querySelectorAll('#pages .page').length;
    return out;
  })()`);

  console.log('默认配置: ' + JSON.stringify(r.cfg));
  console.log('预览页数: ' + r.pages + '   空行块: ' + r.hasBlank);
  console.log('正文 text-indent: ' + r.bodyIndent + '  (font-size ' + r.bodySize + ')');
  console.log('各级标题:');
  for (const h of r.heads) {
    console.log('  L' + h.lv + '  indent=' + String(h.indent).padEnd(12) +
      ' size=' + String(h.size).padEnd(12) + ' ' + h.txt);
  }
  /* 判定：缩进应 ≈ 2em = 2 × 正文 21.33px = 42.67px，标题按各自字号 × 2 */
  const expectBody = 2 * parseFloat(r.bodySize);
  const okBody = Math.abs(parseFloat(r.bodyIndent) - expectBody) < 1.5;
  console.log('\n正文缩进 2 字符: ' + (okBody ? 'OK' : '偏差 ' + r.bodyIndent + ' vs ' + expectBody.toFixed(2)));
  let okHeads = true;
  for (const h of r.heads) {
    const exp = 2 * parseFloat(h.size);
    const got = parseFloat(h.indent) || 0;
    const ok = Math.abs(got - exp) < 1.5;
    if (!ok) okHeads = false;
    console.log('  L' + h.lv + ' 缩进 2 字符: ' + (ok ? 'OK' : '偏差 ' + got + ' vs ' + exp.toFixed(2)));
  }
  s.close(); b.kill();
  process.exit(okBody && okHeads ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
