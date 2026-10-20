/* probe-over.js — 定位「页面溢出 8px」到底溢在哪
   用法：node test/probe-over.js [页号] [txt路径] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probeover.html');
const PAGE = parseInt(process.argv[2] || '2', 10);
const TXT = process.argv[3] && fs.existsSync(process.argv[3])
  ? process.argv[3] : path.join(ROOT, 'test', 'sample-shuzhi.txt');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const PORT = 9961 + (process.pid % 30);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-over-'));
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

  const r = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var pages=[...host.querySelectorAll(".page")];',
    '  var p=pages[' + (PAGE - 1) + '];',
    '  var cs=getComputedStyle(p);',
    '  var pr=p.getBoundingClientRect();',
    '  var padT=parseFloat(cs.paddingTop)||0, padB=parseFloat(cs.paddingBottom)||0;',
    '  var contentTop=pr.top+padT;',
    '  var PX=96/2.54;',
    '  var avail=29.7*PX-padT-padB;',
    '  var kids=[...p.querySelector(".doc").children];',
    '  var list=kids.map(function(k,i){',
    '    var r2=k.getBoundingClientRect();',
    '    var c2=getComputedStyle(k);',
    '    return {i:i,cls:k.className,',
    '            top:+(r2.top-contentTop).toFixed(1),',
    '            bot:+(r2.bottom-contentTop).toFixed(1),',
    '            h:+r2.height.toFixed(1),',
    '            mt:c2.marginTop, mb:c2.marginBottom,',
    '            lh:c2.lineHeight, fs:c2.fontSize,',
    '            head:(k.textContent||"").replace(/\\u00a0/g,"").slice(0,16)};',
    '  });',
    '  var bot=0; list.forEach(function(x){ if(x.bot>bot) bot=x.bot; });',
    '  host.style.transform=saved;',
    '  return {pageH:+pr.height.toFixed(1), padT:padT, padB:padB,',
    '          avail:+avail.toFixed(1), used:+bot.toFixed(1),',
    '          over:+(bot-avail).toFixed(1), kids:list};',
    '})()'
  ].join('\n'));

  console.log('页高 ' + r.pageH + '  上内距 ' + r.padT + '  下内距 ' + r.padB);
  console.log('可用 ' + r.avail + '  实占 ' + r.used + '  溢出 ' + r.over + '\n');
  r.kids.forEach(k => {
    console.log('  ' + k.i + '. [' + k.cls + ']  top=' + k.top + ' bot=' + k.bot +
      ' h=' + k.h + '  mt=' + k.mt + ' mb=' + k.mb + ' lh=' + k.lh);
    console.log('      「' + k.head + '」');
  });

  sock.close(); child.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
