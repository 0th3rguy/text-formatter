/* probe-avail.js —— 检查每一页的「可用高度」是否一致。
   分页算法只用第一页算出的一个 avail 值；若各页实际可用高度不同，
   就会出现「有的页装得下却分页、有的页溢出」这类时对时错的现象。
   用法: node probe-avail.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-avail.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9831 + (process.pid % 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const S = '坚持统筹推进，注重实效，形成合力，确保各项任务落到实处，取得实实在在的成效。';
const lines = ['关于测试分页可用高度的通知', '各部门：'];
for (let i = 0; i < 40; i++) lines.push('第' + (i + 1) + '段。' + S + S);
const TEXT = lines.join('\n');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-avail-'));
  spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    'file:///' + APP.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 120; i++) {
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
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
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
  await sleep(1700);

  await ev('(function(){var s=document.getElementById("src");s.value=' +
    JSON.stringify(TEXT) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(1600);

  const data = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var pages=[...host.querySelectorAll(".page")];',
    '  var out=[];',
    '  pages.forEach(function(p,i){',
    '    var cs=getComputedStyle(p);',
    '    var pt=parseFloat(cs.paddingTop)||0, pb=parseFloat(cs.paddingBottom)||0;',
    '    var doc=p.querySelector(".doc");',
    '    var dr=doc.getBoundingClientRect();',
    '    var kids=[...doc.children];',
    '    var first=kids[0]?kids[0].getBoundingClientRect():null;',
    '    var last=kids.length?kids[kids.length-1].getBoundingClientRect():null;',
    '    out.push({',
    '      page:i+1,',
    '      cssMinHeight:cs.minHeight,',
    '      offsetH:p.offsetHeight, clientH:p.clientHeight, scrollH:p.scrollHeight,',
    '      padT:Math.round(pt), padB:Math.round(pb),',
    '      avail:Math.round(p.clientHeight-pt-pb),',
    '      theoretical:Math.round(1122.52-pt-pb),',
    '      docH:Math.round(dr.height),',
    '      used: last?Math.round(last.bottom-first.top):0,',
    '      rest: last?Math.round((p.clientHeight-pt-pb)-(last.bottom-first.top)):0,',
    '      headText:(kids[0]?kids[0].textContent:"").slice(0,14)',
    '    });',
    '  });',
    '  host.style.transform=saved;',
    '  return out;',
    '})()'
  ].join('\n'));

  console.log('页  可用(clientH-内边距)  理论(1122.5-内边距)  offsetH  clientH  scrollH  实占  余  首块');
  for (const p of data) {
    console.log(
      String(p.page).padStart(2) + '  ' +
      String(p.avail).padStart(6) + '            ' +
      String(p.theoretical).padStart(6) + '          ' +
      String(p.offsetH).padStart(5) + '   ' +
      String(p.clientH).padStart(5) + '   ' +
      String(p.scrollH).padStart(5) + '  ' +
      String(p.used).padStart(4) + '  ' +
      String(p.rest).padStart(4) + '  ' + p.headText);
  }
  const uniq = [...new Set(data.map(d => d.avail))];
  console.log('');
  console.log('各页可用高度去重: ' + JSON.stringify(uniq));
  if (uniq.length > 1) {
    console.log('⚠ 各页可用高度不一致！分页只用第一页的 avail，必然导致部分页留白/溢出');
  } else {
    console.log('各页可用高度一致');
  }
  const over = data.filter(d => d.used > d.avail + 2);
  console.log(over.length ? '⚠ 有 ' + over.length + ' 页内容超出可用高度' : '无溢出');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
