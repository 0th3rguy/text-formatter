/* probe-fuzz.js —— 分页模糊测试：随机生成含各级标题与各种段落长度的公文，
   逐页检查三类问题，找出「底部还有空白却分页」的确切复现条件。
   用法: node probe-fuzz.js [轮数] [起始种子]
   判定：
     A. 非末页底部余量 > TOL 且后面还有内容  → 不该分页却分页了（用户报的问题）
     B. 页内容底边超出可用高度              → 内容溢出被裁切
     C. 出现空页                            → 分页错乱
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-fuzz.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9771 + (process.pid % 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOL = 100;         // 非末页允许的最大底部余量（px）
const ROUNDS = parseInt(process.argv[2], 10) || 12;
const SEED0 = parseInt(process.argv[3], 10) || 1;

/* ---- 可复现的伪随机 ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const SENTS = [
  '坚持统筹推进，注重实效，形成合力。',
  '严格落实责任制，明确专人负责，定期检查通报。',
  '加强统筹协调，优化资源配置，强化过程管控。',
  '聚焦主责主业，突出问题导向，健全工作机制。',
  '完善制度体系，规范工作流程，提升管理效能。',
  '强化风险防控，守牢安全底线，确保万无一失。',
  '深化数据应用，打通信息壁垒，实现协同联动。',
  '注重队伍建设，加强业务培训，提升专业能力。'
];

function makeDoc(rnd) {
  const lines = [];
  const titleN = rnd() < 0.25 ? 2 : 1;
  for (let i = 0; i < titleN; i++) {
    lines.push('关于进一步加强和改进' + ['信息化', '安全生产', '运营管理', '党建工作'][Math.floor(rnd() * 4)] +
      '有关工作的通知' + (i === 1 ? '（试行）' : ''));
  }
  if (rnd() < 0.7) lines.push('各部门、各直属单位：');

  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  const blocks = Math.floor(6 + rnd() * 26);
  for (let i = 0; i < blocks; i++) {
    const r = rnd();
    if (r < 0.16) {
      h1++; h2 = 0; h3 = 0; h4 = 0;
      lines.push(CN[h1 % CN.length] + '、' + ['总体要求', '重点任务', '工作要求', '保障措施', '组织领导'][h1 % 5]);
    } else if (r < 0.28) {
      h2++; h3 = 0; h4 = 0;
      lines.push('（' + CN[h2 % CN.length] + '）' + ['指导思想', '基本原则', '主要目标', '实施步骤'][h2 % 4]);
    } else if (r < 0.36) {
      h3++; h4 = 0;
      lines.push(h3 + '. ' + ['统一规划', '分步实施', '压实责任', '强化督导'][h3 % 4]);
    } else if (r < 0.42) {
      h4++;
      lines.push('（' + h4 + '）' + ['第一阶段', '第二阶段', '第三阶段'][h4 % 3]);
    } else if (r < 0.46 && rnd() < 0.5) {
      lines.push('');
    } else {
      const n = 1 + Math.floor(rnd() * 11);
      let s = '';
      for (let k = 0; k < n; k++) s += SENTS[Math.floor(rnd() * SENTS.length)];
      lines.push(s);
    }
  }
  return lines.join('\n');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-fuzz-'));
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

  let badA = 0, badB = 0, badC = 0;
  const failures = [];

  for (let round = 0; round < ROUNDS; round++) {
    const seed = SEED0 + round;
    const rnd = mulberry32(seed * 7919 + 13);
    const text = makeDoc(rnd);

    await ev('(function(){var s=document.getElementById("src");s.value=' +
      JSON.stringify(text) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
    await sleep(1250);

    const data = await ev([
      '(function(){',
      '  var host=document.getElementById("pages");',
      '  var saved=host.style.transform; host.style.transform="none";',
      '  var pages=[...host.querySelectorAll(".page")];',
      '  var out=[];',
      '  pages.forEach(function(p){',
      '    var cs=getComputedStyle(p);',
      '    var avail=p.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
      '    var kids=[...p.querySelector(".doc").children];',
      '    var top0=null, bot=null;',
      '    kids.forEach(function(k){',
      '      var r=k.getBoundingClientRect();',
      '      if(top0===null) top0=r.top;',
      '      bot=r.bottom;',
      '    });',
      '    var real=bot!==null?bot-top0:0;',
      '    out.push({avail:Math.round(avail), real:Math.round(real),',
      '              rest:Math.round(avail-real), kids:kids.length,',
      '              last:(kids.length?kids[kids.length-1].className:"")});',
      '  });',
      '  host.style.transform=saved;',
      '  return out;',
      '})()'
    ].join('\n'));

    const issues = [];
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const isLast = i === data.length - 1;
      if (!isLast && d.rest > TOL) {
        issues.push('A:p' + (i + 1) + ' 余' + d.rest + 'px(还有' + (data.length - i - 1) + '页)');
        badA++;
      }
      if (d.real > d.avail + 2) {
        issues.push('B:p' + (i + 1) + ' 溢出' + (d.real - d.avail) + 'px');
        badB++;
      }
      if (d.kids === 0) { issues.push('C:p' + (i + 1) + ' 空页'); badC++; }
    }

    const ratios = data.map(d => Math.round(d.real / d.avail * 100));
    const mark = issues.length ? '  ⚠ ' + issues.join('  ') : '  OK';
    console.log('seed ' + String(seed).padStart(3) + '  ' + String(data.length).padStart(2) + ' 页 ' +
      JSON.stringify(ratios) + mark);
    if (issues.length) failures.push({ seed, issues, text, ratios });
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('轮数 ' + ROUNDS + '   不该分页却分页(A) ' + badA +
    '   内容溢出(B) ' + badB + '   空页(C) ' + badC);
  if (failures.length) {
    const f = failures[0];
    console.log('');
    console.log('首个失败 seed=' + f.seed + '  ' + JSON.stringify(f.ratios));
    console.log('  ' + f.issues.join('  '));
    const dump = path.join(OUT, 'fuzz-fail-' + f.seed + '.txt');
    fs.writeFileSync(dump, f.text, 'utf8');
    console.log('  用例已存: ' + dump);
  }
  console.log(failures.length === 0 ? '全部通过' : '有 ' + failures.length + ' 轮失败');

  sock.close();
  process.exit(failures.length === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
