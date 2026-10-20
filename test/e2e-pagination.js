/* e2e-pagination.js —— 分页回归：非末页不应留大片空白（长段落必须跨页续排）
   用法: node e2e-pagination.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_e2e-pagination.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9711 + (process.pid % 60);
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

const CASES = [
  { name: '均匀中段 12×3句', text: mk(12, 3) },
  { name: '均匀长段 8×6句', text: mk(8, 6) },
  { name: '超长段 4×12句', text: mk(4, 12) },
  { name: '长短混杂', text: mk(3, 1) + '\n' + mk(2, 8) + '\n' + mk(5, 2) + '\n' + mk(1, 14) },
  {
    name: '带标题层级（回归：标题不该被整段推走）',
    text: '关于测试的通知\n各部门：\n' + mk(2, 4) + '\n一、总体要求\n' + mk(3, 5) +
      '\n（一）指导思想\n' + mk(2, 6) + '\n二、重点任务\n' + mk(3, 4)
  },
  { name: '带表格', text: mk(4, 5) + '\n序号\t任务\t部门\n1\t升级\t信息中心\n2\t改造\t后勤\n' + mk(3, 4) }
];

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pg-'));
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
  const exceptions = [];
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push((d.exception && d.exception.description) || d.text || 'unknown');
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
  await sleep(1700);

  console.log('=== 分页：非末页不得留大片空白 ===');
  for (const c of CASES) {
    await ev('(function(){var s=document.getElementById("src");s.value=' +
      JSON.stringify(c.text) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
    await sleep(1400);

    const data = await ev([
      '(function(){',
      '  var host=document.getElementById("pages");',
      '  var saved=host.style.transform;',
      '  host.style.transform="none";',
      '  var pages=[...host.querySelectorAll(".page")];',
      '  var out=[];',
      '  pages.forEach(function(p){',
      '    var cs=getComputedStyle(p);',
      '    var avail=p.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
      '    var kids=[...p.querySelector(".doc").children];',
      '    var used=0;',
      '    kids.forEach(function(k){',
      '      used+=k.getBoundingClientRect().height+(parseFloat(getComputedStyle(k).marginBottom)||0);',
      '    });',
      '    out.push({avail:Math.round(avail),used:Math.round(used),kids:kids.length});',
      '  });',
      '  host.style.transform=saved;',
      '  return out;',
      '})()'
    ].join('\n'));

    const nonLast = data.slice(0, -1);
    const worst = nonLast.reduce((m, d) => Math.max(m, d.avail - d.used), 0);
    const ratios = data.map(d => Math.round(d.used / d.avail * 100));
    check(c.name + '：非末页无大片空白', worst <= 120,
      data.length + ' 页 ' + JSON.stringify(ratios) + ' 最大余 ' + worst + 'px');
    check(c.name + '：所有内容都在页内（无溢出）',
      data.every(d => d.used <= d.avail + 2), '');
    check(c.name + '：无空页', data.every(d => d.kids > 0), '');
  }

  console.log('');
  console.log('=== 跨页续排段不带首行缩进 ===');
  await ev('(function(){var s=document.getElementById("src");s.value=' +
    JSON.stringify(mk(6, 8)) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(1400);
  const contInfo = await ev([
    '(function(){',
    '  var cont=document.querySelectorAll("#pages .doc > .cont");',
    '  var out=[];',
    '  for(var i=0;i<cont.length;i++){',
    '    var cs=getComputedStyle(cont[i]);',
    '    out.push({indent:cs.textIndent, cls:cont[i].className});',
    '  }',
    '  return {count:cont.length, items:out};',
    '})()'
  ].join('\n'));
  check('确实产生了跨页续排段', contInfo.count > 0, '共 ' + contInfo.count + ' 段');
  check('续排段的 text-indent 为 0（不重复缩进两格）',
    contInfo.items.every(x => parseFloat(x.indent) === 0),
    JSON.stringify(contInfo.items.map(x => x.indent)));

  console.log('');
  console.log('=== 统计条随分页更新 ===');
  const stat = await ev([
    '(function(){',
    '  var el=document.getElementById("pvStats");',
    '  var items=[...el.querySelectorAll(".psi")].map(function(s){',
    '    return s.querySelector("i").textContent+"="+s.querySelector("b").textContent;',
    '  });',
    '  return {items: items, pages: document.querySelectorAll("#pages .page").length};',
    '})()'
  ].join('\n'));
  const shown = (stat.items.find(x => /^页数=/.test(x)) || '').replace('页数=', '');
  check('统计条页数与实际页数一致', shown === stat.pages + ' 页',
    '统计 ' + shown + ' / 实际 ' + stat.pages + ' 页');

  console.log('');
  console.log('=== 零未捕获异常 ===');
  check('页面无未捕获错误', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 2)));

  sock.close();
  console.log('');
  console.log('='.repeat(56));
  console.log('分页回归：PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
