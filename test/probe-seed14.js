/* probe-seed14.js —— 复现 fuzz2 的失败用例，
   逐块打印「块高 / marginTop / marginBottom / 累加值 / 相邻块实际间距」，
   判断高度累加与真实几何在哪里分叉。
   用法: node probe-seed14.js [失败用例 json 路径]（默认 fuzz2-fail-14.json） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-seed14.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9811 + (process.pid % 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const failFile = process.argv[2] ? path.resolve(process.argv[2])
  : path.join(OUT, 'fuzz2-fail-14.json');
const fail = JSON.parse(fs.readFileSync(failFile, 'utf8'));
console.log('用例: ' + failFile + '  seed ' + fail.seed + '  ' + (fail.issues || []).join(' '));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-s14-'));
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
    JSON.stringify(fail.text) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(800);

  await ev([
    '(function(){',
    '  var conf=' + JSON.stringify(fail.conf) + ';',
    '  Object.keys(conf).forEach(function(k){',
    '    var el=document.querySelector("[data-cfg=\\""+k+"\\"]");',
    '    if(!el) return;',
    '    if(el.type==="checkbox"){ el.checked = conf[k]===true; }',
    '    else { el.value = String(conf[k]); }',
    '    el.dispatchEvent(new Event("change",{bubbles:true}));',
    '    el.dispatchEvent(new Event("input",{bubbles:true}));',
    '  });',
    '  return 1;',
    '})()'
  ].join('\n'));
  await sleep(1400);

  const data = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform; host.style.transform="none";',
    '  var pages=[...host.querySelectorAll(".page")];',
    '  var out=[];',
    '  pages.forEach(function(p,pi){',
    '    var cs=getComputedStyle(p);',
    '    var avail=p.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
    '    var doc=p.querySelector(".doc");',
    '    var docTop=doc.getBoundingClientRect().top;',
    '    var kids=[...doc.children];',
    '    var rows=[]; var prevBot=null;',
    '    kids.forEach(function(k){',
    '      var r=k.getBoundingClientRect();',
    '      var ks=getComputedStyle(k);',
    '      var mt=parseFloat(ks.marginTop)||0, mb=parseFloat(ks.marginBottom)||0;',
    '      rows.push({cls:(k.className||"").replace("blk-",""),',
    '                 lv:k.dataset?k.dataset.lv:"",',
    '                 h:Math.round(r.height), mt:Math.round(mt*10)/10, mb:Math.round(mb*10)/10,',
    '                 top:Math.round(r.top-docTop), bot:Math.round(r.bottom-docTop),',
    '                 gapPrev: prevBot===null?0:Math.round(r.top-prevBot),',
    '                 accum:Math.round(r.height+mb),',
    '                 txt:(k.textContent||"").slice(0,16)});',
    '      prevBot=r.bottom;',
    '    });',
    '    var last=rows.length?rows[rows.length-1]:null;',
    '    out.push({page:pi+1,avail:Math.round(avail),',
    '              used: last?last.bot:0, rest: last?Math.round(avail-last.bot):Math.round(avail),',
    '              sumAccum: rows.reduce(function(a,r){return a+r.accum;},0),',
    '              kids:rows.length, rows:rows});',
    '  });',
    '  host.style.transform=saved;',
    '  return out;',
    '})()'
  ].join('\n'));

  for (const p of data) {
    const pct = Math.round(p.used / p.avail * 100);
    console.log('');
    console.log('第 ' + p.page + ' 页  可用 ' + p.avail + '  实占 ' + p.used + ' (' + pct + '%)  余 ' + p.rest +
      '   Σ(块高+段后)=' + p.sumAccum);
    console.log('  ' + 'class'.padEnd(9) + 'lv  ' + '高'.padStart(4) + '  ' +
      'mt'.padStart(5) + '  ' + 'mb'.padStart(5) + '  ' + '与上块间距'.padStart(9) + '  文本');
    for (const r of p.rows) {
      console.log('  ' + r.cls.padEnd(9) + (r.lv || '-').padEnd(4) +
        String(r.h).padStart(4) + '  ' + String(r.mt).padStart(5) + '  ' + String(r.mb).padStart(5) +
        '  ' + String(r.gapPrev).padStart(9) + '  「' + r.txt + '」');
    }
    if (p.sumAccum !== p.used) {
      console.log('  ↑ Σ(块高+段后)=' + p.sumAccum + ' 与真实占用 ' + p.used + ' 相差 ' +
        (p.sumAccum - p.used) + 'px（正=累加高估）');
    }
  }

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
