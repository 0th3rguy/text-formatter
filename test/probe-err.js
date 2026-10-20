/* probe-err.js — 抓预览不生成时的运行时异常 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9711 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_probe_err.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-perr-'));
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
  const logs = [];
  await new Promise(r => s.addEventListener('open', r));
  s.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('CONSOLE[' + m.params.type + ']: ' +
        m.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); }
  });
  const send = (me, p) => new Promise(r => { const i = ++id; w.set(i, r); s.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1800);

  const ev = async ex => {
    const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) return 'THROW: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };

  console.log('--- 直接调 runParse 的等价路径 ---');
  const r1 = await ev(`(function(){
    try {
      var src=document.getElementById('src');
      var txt=window.__SAMPLE_TEXT__ || '';
      return {hasSrc: !!src, len: src ? src.value.length : -1};
    } catch(e){ return 'ERR '+e.message; }
  })()`);
  console.log(JSON.stringify(r1));

  const r2 = await ev(`(function(){
    try {
      document.getElementById('btnSample').click();
      return 'clicked';
    } catch(e){ return 'ERR '+e.message; }
  })()`);
  console.log('btnSample: ' + JSON.stringify(r2));
  await sleep(2000);

  const r3 = await ev(`(function(){
    return {srcLen: document.getElementById('src').value.length,
      pages: document.querySelectorAll('#pages .page').length,
      stText: document.getElementById('stText').textContent,
      stStats: document.getElementById('stStats').textContent};
  })()`);
  console.log('after sample: ' + JSON.stringify(r3));

  console.log('\n--- 浏览器日志 ---');
  for (const l of logs.slice(0, 30)) console.log('  ' + l);

  /* 直接调一次 parse+render 看抛什么 */
  console.log('\n--- 手动调 WFPParser.parseText ---');
  const r4 = await ev(`(function(){
    try{
      var t=document.getElementById('src').value;
      var b=window.WFPParser.parseText(t, window.WFPDefaults.DEFAULT_CONFIG);
      return {blocks:b.length};
    }catch(e){ return 'ERR '+e.message+' | '+e.stack; }
  })()`);
  console.log(JSON.stringify(r4));

  s.close(); b.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
