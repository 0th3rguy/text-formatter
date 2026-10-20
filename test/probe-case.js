/* probe-case.js —— 详查单个用例的块级分页决策
   用法: node probe-case.js heading|mixed|tail */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-case.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9671 + (process.pid % 60);
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

const CASES = {
  heading: '关于测试的通知\n各部门：\n' + mk(2, 4) + '\n一、总体要求\n' + mk(3, 5) +
    '\n（一）指导思想\n' + mk(2, 6) + '\n二、重点任务\n' + mk(3, 4),
  mixed: mk(3, 1) + '\n' + mk(2, 8) + '\n' + mk(5, 2) + '\n' + mk(1, 14)
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-case-'));
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
  await sleep(1600);

  const which = process.argv[2] || 'heading';
  const text = CASES[which] || CASES.heading;

  await ev('(function(){var s=document.getElementById("src");s.value=' +
    JSON.stringify(text) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(1600);

  const data = await ev([
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var saved=host.style.transform;',
    '  host.style.transform="none";',
    '  var pages=[...host.querySelectorAll(".page")];',
    '  var out=[];',
    '  pages.forEach(function(p,pi){',
    '    var cs=getComputedStyle(p);',
    '    var avail=p.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
    '    var kids=[...p.querySelector(".doc").children];',
    '    var used=0, rows=[];',
    '    kids.forEach(function(k){',
    '      var r=k.getBoundingClientRect();',
    '      var mb=parseFloat(getComputedStyle(k).marginBottom)||0;',
    '      used+=r.height+mb;',
    '      rows.push({cls:k.className, lv:k.dataset?k.dataset.lv:"",',
    '                 h:Math.round(r.height), mb:Math.round(mb),',
    '                 txt:(k.textContent||"").slice(0,16)});',
    '    });',
    '    out.push({page:pi+1,avail:Math.round(avail),used:Math.round(used),',
    '              rest:Math.round(avail-used),rows:rows});',
    '  });',
    '  host.style.transform=saved;',
    '  return out;',
    '})()'
  ].join('\n'));

  for (const p of data) {
    console.log('');
    console.log('第 ' + p.page + ' 页  可用 ' + p.avail + '  已用 ' + p.used +
      ' (' + Math.round(p.used / p.avail * 100) + '%)  余 ' + p.rest);
    for (const r of p.rows) {
      console.log('    ' + r.cls.padEnd(24) + ' lv=' + (r.lv || '-') +
        ' 高' + String(r.h).padStart(4) + ' 段后' + String(r.mb).padStart(3) +
        '  「' + r.txt + '」');
    }
  }

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
