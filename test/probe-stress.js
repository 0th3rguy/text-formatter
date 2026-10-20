/* probe-stress.js —— 分页压力测试：多种段落长度分布 + 各种开关组合，
   检查「除末页外是否还有大量底部留白」（那说明该切没切）。
   用法: node probe-stress.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-stress.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9651 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 造多种长度分布的段落 */
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
const CASES = [
  { name: '均匀中段 12×3句', text: mk(12, 3) },
  { name: '均匀长段 8×6句', text: mk(8, 6) },
  { name: '超长段 4×12句', text: mk(4, 12) },
  { name: '长短混杂', text: mk(3, 1) + '\n' + mk(2, 8) + '\n' + mk(5, 2) + '\n' + mk(1, 14) },
  { name: '带标题层级', text: '关于测试的通知\n各部门：\n' + mk(2, 4) + '\n一、总体要求\n' + mk(3, 5) +
      '\n（一）指导思想\n' + mk(2, 6) + '\n二、重点任务\n' + mk(3, 4) },
  { name: '带空格（高亮开）', text: mk(6, 4).replace(/，/g, '， '), hl: true },
  { name: '带引号（原文里的）', text: mk(6, 4).replace(/码放/g, '“码放”') },
  { name: '带表格', text: mk(4, 5) + '\n序号\t任务\t部门\n1\t升级\t信息中心\n2\t改造\t后勤\n' + mk(3, 4) }
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-stress-'));
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

  let worst = 0;
  for (const c of CASES) {
    await ev([
      '(function(){',
      '  var hl=document.getElementById("c_space_highlight");',
      '  if(hl){ hl.checked=' + (c.hl ? 'true' : 'false') + ';',
      '    hl.dispatchEvent(new Event("change",{bubbles:true})); }',
      '  var s=document.getElementById("src");',
      '  s.value=' + JSON.stringify(c.text) + ';',
      '  s.dispatchEvent(new Event("input",{bubbles:true}));',
      '  return 1;',
      '})()'
    ].join('\n'));
    await sleep(1500);

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
      '    var used=0;',
      '    kids.forEach(function(k){',
      '      var r=k.getBoundingClientRect();',
      '      used+=r.height+(parseFloat(getComputedStyle(k).marginBottom)||0);',
      '    });',
      '    out.push({avail:Math.round(avail),used:Math.round(used),kids:kids.length,',
      '              lastCls:kids.length?kids[kids.length-1].className:""});',
      '  });',
      '  host.style.transform=saved;',
      '  return out;',
      '})()'
    ].join('\n'));

    /* 「该切没切」判据：非末页、底部余量 > 120px、且这一页最后一块不是独占整页的超大块 */
    const bad = [];
    for (let i = 0; i < data.length - 1; i++) {
      const rest = data[i].avail - data[i].used;
      if (rest > 120) bad.push('p' + (i + 1) + ' 余 ' + rest + 'px');
    }
    const last = data[data.length - 1];
    const lastRest = last.avail - last.used;
    if (lastRest > worst) worst = lastRest;
    console.log('');
    console.log('【' + c.name + '】' + data.length + ' 页');
    console.log('  ' + data.map((d, i) =>
      'p' + (i + 1) + ':' + Math.round(d.used / d.avail * 100) + '%(' + d.kids + '块)').join('  '));
    if (bad.length) console.log('  ⚠ 非末页留白过大 → ' + bad.join(' · '));
    else console.log('  OK 非末页都排满了');
  }

  console.log('');
  console.log('末页最大余量 ' + worst + 'px（末页留白属正常，取决于内容量）');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
