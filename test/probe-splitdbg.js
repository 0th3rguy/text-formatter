/* probe-splitdbg.js —— 打开 __SPLIT_DBG 抓分页切分的调试输出，看为何某页余量大
   用法: node probe-splitdbg.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-splitdbg.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9691 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SENT = '叉车作业时严格执行作业标准，按照货物摆放位置与重心要求分层码放，严禁超高、超重、倾斜堆码。';
function mk(n, sentences) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    let s = '第' + i + '段。';
    for (let k = 0; k < sentences; k++) s += SENT;
    out.push(s);
  }
  return out.join('\n');
}
const TEXT = '关于测试的通知\n各部门：\n' + mk(2, 4) + '\n一、总体要求\n' + mk(3, 5) +
  '\n（一）指导思想\n' + mk(2, 6) + '\n二、重点任务\n' + mk(3, 4);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-sdbg-'));
  spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + APP.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) { ws = pg.webSocketDebuggerUrl; break; }
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  if (!ws) { console.error('CDP 连接失败'); process.exit(1); }

  const sock = new WebSocket(ws);
  let id = 0; const waiters = new Map();
  const logs = [];
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description);
      logs.push(args.join(' '));
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; waiters.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1600);

  await ev('window.__SPLIT_DBG = true; true');
  await ev('(function(){var s=document.getElementById("src");s.value=' +
    JSON.stringify(TEXT) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(1800);

  console.log('--- 分页切分调试 ---');
  for (const l of logs) console.log('  ' + l);

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
