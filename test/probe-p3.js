/* probe-p3.js — 逐块 dump 指定页的全部块（含完整文本），看碎块到底长什么样
   用法：node test/probe-p3.js [页号] [txt路径] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probep3.html');
const PAGE = parseInt(process.argv[2] || '3', 10);
const TXT = process.argv[3] && fs.existsSync(process.argv[3])
  ? process.argv[3] : path.join(ROOT, 'test', 'sample-shuzhi.txt');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const PORT = 9991 + (process.pid % 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-p3-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + APP.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 100; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) { ws = p.webSocketDebuggerUrl; break; }
    } catch (e) { /* noop */ }
    await sleep(250);
  }
  const sock = new WebSocket(ws);
  let id = 0; const w = new Map();
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; w.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1700);
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };

  const text = fs.readFileSync(TXT, 'utf8');
  await ev([
    'var ta=document.getElementById("src");',
    'ta.value=' + JSON.stringify(text) + ';',
    'ta.dispatchEvent(new Event("input",{bubbles:true}));true'
  ].join('\n'));
  await sleep(2200);
  await ev([
    'var q=document.getElementById("q_blank");',
    'q.value="heading_gap";q.dispatchEvent(new Event("change",{bubbles:true}));true'
  ].join('\n'));
  await sleep(2200);

  const dump = await ev([
    '(function(){',
    '  var pages=[...document.querySelectorAll("#pages .page")];',
    '  var p=pages[' + (PAGE - 1) + '];',
    '  if(!p) return {err:"没有这一页", total:pages.length};',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var out=[];',
    '  [...p.querySelector(".doc").children].forEach(function(el,i){',
    '    var r=el.getBoundingClientRect();',
    '    var cs=getComputedStyle(el);',
    '    out.push({',
    '      i:i, cls:el.className,',
    '      h:Math.round(r.height), top:Math.round(r.top), bot:Math.round(r.bottom),',
    '      mt:cs.marginTop, mb:cs.marginBottom, indent:cs.textIndent,',
    '      len:(el.textContent||"").length,',
    '      txt:(el.textContent||"").replace(/\\u00a0/g,"")',
    '    });',
    '  });',
    '  host.style.transform=saved;',
    '  return {total:pages.length, kids:out};',
    '})()'
  ].join('\n'));

  if (dump.err) { console.log(dump.err + '  总页数 ' + dump.total); process.exit(0); }
  console.log('共 ' + dump.total + ' 页，下面是第 ' + PAGE + ' 页：\n');
  dump.kids.forEach(k => {
    console.log(k.i + '. [' + k.cls + ']  h=' + k.h + '  len=' + k.len +
      '  mt=' + k.mt + ' mb=' + k.mb + ' indent=' + k.indent);
    console.log('    「' + k.txt + '」');
    console.log('');
  });

  sock.close(); child.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
