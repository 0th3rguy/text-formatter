/* shot-text.js — 把指定 txt 填进输入框后截图，人工核对真实观感
   用法: node test/shot-text.js <txt路径> <输出前缀> [空行模式] [缩放] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9901 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TXT = process.argv[2];
const PREFIX = process.argv[3] || 'shot-text';
const BLANK = process.argv[4] || 'heading_gap';
const ZOOM = process.argv[5] || '90';

(async () => {
  const app = path.join(OUT, '_' + PREFIX + '.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-st-'));
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
  if (!ws) { console.error('CDP 未就绪'); process.exit(1); }

  const s = new WebSocket(ws); let id = 0; const w = new Map();
  await new Promise(r => s.addEventListener('open', r));
  s.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); }
  });
  const send = (me, p) => new Promise(r => { const i = ++id; w.set(i, r); s.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1600);
  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    console.log('  写出 ' + file);
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  const text = fs.readFileSync(TXT, 'utf8');
  await ev(`var ta=document.getElementById('src');ta.value=${JSON.stringify(text)};ta.dispatchEvent(new Event('input',{bubbles:true}));true`);
  await sleep(2200);

  const mode = await ev(`var q=document.getElementById('q_blank');q.value=${JSON.stringify(BLANK)};q.dispatchEvent(new Event('change',{bubbles:true}));q.value`);
  await sleep(2400);

  const info = await ev(`(function(){
    var o={pages:document.querySelectorAll('#pages .page').length,
      blanks:document.querySelectorAll('#pages .blk-blank').length,
      fill:[],segs:[]};
    document.querySelectorAll('#pages .page').forEach(function(p){
      var d=p.querySelector('.doc'); if(!d)return;
      var cs=getComputedStyle(p);
      var pt=parseFloat(cs.paddingTop)||0, pb=parseFloat(cs.paddingBottom)||0;
      var top=p.getBoundingClientRect().top+pt;
      var bot=top;
      d.querySelectorAll(':scope > *').forEach(function(c){
        var r=c.getBoundingClientRect(); if(r.height<=0)return;
        if(r.bottom>bot)bot=r.bottom;
      });
      var av=parseFloat(p.dataset.avail)||(p.clientHeight-pt-pb);
      var avail=d.clientHeight-((parseFloat(getComputedStyle(d).paddingTop)||0)+(parseFloat(getComputedStyle(d).paddingBottom)||0));
      o.fill.push(((bot-top)/avail*100).toFixed(0));
    });
    document.querySelectorAll('#pages .doc > .cont').forEach(function(c){
      o.segs.push(c.textContent.slice(0,10));
    });
    return o;
  })()`);
  console.log('空行模式: ' + mode + '  页数: ' + info.pages + '  空行: ' + info.blanks);
  console.log('每页填充: ' + info.fill.join('/'));
  console.log('续排段 ' + info.segs.length + ' 个: ' + info.segs.join(' | '));

  await shot(PREFIX + '-p1.png');
  const n = info.pages;
  for (let i = 1; i < Math.min(n, 4); i++) {
    await ev(`(function(){var ps=document.querySelectorAll('#pages .page');if(ps[${i}])ps[${i}].scrollIntoView({block:'start'});return true})()`);
    await sleep(600);
    await shot(PREFIX + '-p' + (i + 1) + '.png');
  }

  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
