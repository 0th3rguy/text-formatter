/* shot-sample.js — 用内置示例稿截图，确认各级标题缩进与空行默认值 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9901 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_shot-sample.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-ss-'));
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

  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1800);
  await ev(`(function(){var p=document.getElementById('zoomPct');p.value='90';p.dispatchEvent(new Event('change'));return true})()`);
  await sleep(700);

  const info = await ev(`(function(){
    var o={pages:document.querySelectorAll('#pages .page').length,
      blanks:document.querySelectorAll('#pages .blk-blank').length,
      blocks:document.querySelectorAll('#pages .doc > *').length,
      stats:document.getElementById('stStats').textContent,
      heads:[]};
    var seen={};
    document.querySelectorAll('#pages .blk-head').forEach(function(h){
      var lv=h.dataset.lv; if(seen[lv])return; seen[lv]=1;
      o.heads.push({lv:lv,ind:getComputedStyle(h).textIndent,size:getComputedStyle(h).fontSize,
        txt:(h.textContent||'').slice(0,14)});
    });
    var body=document.querySelector('#pages .blk-body');
    o.bodyIndent=body?getComputedStyle(body).textIndent:null;
    o.bodySize=body?getComputedStyle(body).fontSize:null;
    return o;
  })()`);
  console.log('页数: ' + info.pages + '  块: ' + info.blocks + '  空行: ' + info.blanks);
  console.log('统计: ' + info.stats);
  console.log('正文缩进: ' + info.bodyIndent + ' (字号 ' + info.bodySize + ')');
  for (const h of info.heads) console.log('  L' + h.lv + ' 缩进 ' + h.ind + '  字号 ' + h.size + '  ' + h.txt);

  await shot('ui-final-sample.png');
  await ev(`(function(){var ps=document.querySelectorAll('#pages .page');if(ps[1])ps[1].scrollIntoView({block:'start'});return true})()`);
  await sleep(600);
  await shot('ui-final-sample2.png');

  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
