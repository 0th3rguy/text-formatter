/* probe-headpage.js —— 专测「各级标题附近的分页」
   用户反馈：明明下面还有空白区域却分了页，要重点看一级/二级/三级/四级标题。
   做法：构造「标题刚好落在页底」的临界文档，扫遍所有可能的填充位置，
   检查是否出现「本页还剩很多空间却把标题推走」或「标题孤零零留在页尾」。

   判据（与 Word 的排版习惯对齐）：
     A. 非末页底部剩余 > 100px               → 不该分页却分页（白留）
     B. 页面内容溢出 > 2px                   → 挤出去了
     C. 空页                                  → 明显错误
     D. 标题是页内最后一块（孤行）             → 标题与正文被拆散
     E. 标题在页首但上一页末尾还空很多          → 标题被无理由推走

   用法: node probe-headpage.js [起始种子] [轮数] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-headpage.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9861 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SEED0 = parseInt(process.argv[2], 10) || 1;
const ROUNDS = parseInt(process.argv[3], 10) || 12;
const TOL = 100;

const SENTS = [
  '坚持统筹推进，注重实效，形成合力。',
  '严格落实责任制，明确专人负责，定期检查通报。',
  '加强统筹协调，优化资源配置，强化过程管控。',
  '聚焦主责主业，突出问题导向，健全工作机制。',
  '完善制度体系，规范工作流程，提升管理效能。',
  '强化风险防控，守牢安全底线，确保万无一失。'
];
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* 每轮固定：一串「标题 + 正文」交替，正文长度随机 —— 这样标题会落在页内各种位置 */
function makeDoc(rnd) {
  const lines = ['关于进一步加强信息化建设工作的通知', '各部门、各直属单位：'];
  let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  const n = 6 + Math.floor(rnd() * 10);
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(rnd() * 4);
    if (kind === 0) { h1++; h2 = 0; h3 = 0; h4 = 0; lines.push(CN[h1 % 10] + '、总体要求'); }
    else if (kind === 1) { h2++; h3 = 0; h4 = 0; lines.push('（' + CN[h2 % 10] + '）指导思想'); }
    else if (kind === 2) { h3++; h4 = 0; lines.push(h3 + '. 统一规划'); }
    else { h4++; lines.push('（' + h4 + '）第一阶段'); }
    /* 标题后跟一段正文，长度在 1~12 句之间随机 —— 制造各种「标题落在页底」的临界 */
    const m = 1 + Math.floor(rnd() * 12);
    let s = '';
    for (let k = 0; k < m; k++) s += SENTS[Math.floor(rnd() * SENTS.length)];
    lines.push(s);
  }
  return lines.join('\n');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-hp-'));
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

  let badA = 0, badB = 0, badC = 0, badD = 0;
  const fails = [];

  for (let round = 0; round < ROUNDS; round++) {
    const seed = SEED0 + round;
    const rnd = mulberry32(seed * 2654435761 + 11);
    const text = makeDoc(rnd);

    await ev('(function(){var s=document.getElementById("src");s.value=' +
      JSON.stringify(text) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
    await sleep(900);

    const data = await ev([
      '(function(){',
      '  var host=document.getElementById("pages");',
      '  var saved=host.style.transform; host.style.transform="none";',
      '  var PX=96/2.54;',
      '  var out=[];',
      '  [...host.querySelectorAll(".page")].forEach(function(p){',
      '    var cs=getComputedStyle(p);',
      '    var avail=29.7*PX-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
      '    var d=p.querySelector(".doc");',
      '    var kids=[...d.children];',
      '    var top0=null,bot=null;',
      '    kids.forEach(function(k){var r=k.getBoundingClientRect();',
      '      if(top0===null)top0=r.top; bot=r.bottom;});',
      '    var used=bot===null?0:bot-top0;',
      '    var last=kids[kids.length-1];',
      '    var lastIsHead=!!(last && last.dataset && last.dataset.lv);',
      '    out.push({avail:Math.round(avail),used:Math.round(used),',
      '              rest:Math.round(avail-used),kids:kids.length,',
      '              lastCls:last?(last.className||""):"",',
      '              lastLv:last&&last.dataset?(last.dataset.lv||""):"",',
      '              lastIsHead:lastIsHead,',
      '              lastTxt:last?(last.textContent||"").slice(0,14):""});',
      '  });',
      '  host.style.transform=saved;',
      '  return out;',
      '})()'
    ].join('\n'));

    const iss = [];
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const isLast = i === data.length - 1;
      if (!isLast && d.rest > TOL) { iss.push('A:p' + (i + 1) + '余' + d.rest); badA++; }
      if (d.used > d.avail + 2) { iss.push('B:p' + (i + 1) + '溢出' + (d.used - d.avail)); badB++; }
      if (d.kids === 0) { iss.push('C:p' + (i + 1) + '空页'); badC++; }
      if (!isLast && d.lastIsHead) { iss.push('D:p' + (i + 1) + '标题孤行[' + d.lastTxt + ']'); badD++; }
    }
    const ratios = data.map(d => Math.round(d.used / d.avail * 100));
    const mark = iss.length ? '  ⚠ ' + iss.join(' ') : '  OK';
    console.log('seed ' + String(seed).padStart(3) + ' ' + String(data.length).padStart(2) +
      ' 页 ' + JSON.stringify(ratios) + mark);
    if (iss.length) fails.push({ seed, iss, ratios, text });
  }

  console.log('');
  console.log('='.repeat(64));
  console.log('轮数 ' + ROUNDS + '   A(白留) ' + badA + '   B(溢出) ' + badB +
    '   C(空页) ' + badC + '   D(标题孤行) ' + badD);
  if (fails.length) {
    fs.writeFileSync(path.join(OUT, 'headpage-fail.json'),
      JSON.stringify(fails, null, 2), 'utf8');
    console.log('  失败用例已存: ' + path.join(OUT, 'headpage-fail.json'));
  }
  console.log(fails.length === 0 ? '全部通过' : '有 ' + fails.length + ' 轮失败');

  sock.close();
  process.exit(fails.length === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
