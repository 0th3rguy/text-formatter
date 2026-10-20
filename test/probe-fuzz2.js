/* probe-fuzz2.js —— 分页模糊测试（变化配置版）
   与 probe-fuzz.js 的区别：同时随机化排版配置（段前/段后间距、行距、字号、
   首行缩进、各级标题缩进），因为真实使用时这些设置千变万化。
   重点验证：非零 margin 时「高度累加」是否仍然准确。
   用法: node probe-fuzz2.js [轮数] [起始种子] */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-fuzz2.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9791 + (process.pid % 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOL = 100;
const ROUNDS = parseInt(process.argv[2], 10) || 10;
const SEED0 = parseInt(process.argv[3], 10) || 1;

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
  '强化风险防控，守牢安全底线，确保万无一失。'
];
const CN = ['一', '二', '三', '四', '五', '六', '七', '八'];

function makeDoc(rnd) {
  const lines = [];
  lines.push('关于进一步加强信息化建设工作的通知');
  lines.push('各部门、各直属单位：');
  let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  const blocks = Math.floor(8 + rnd() * 22);
  for (let i = 0; i < blocks; i++) {
    const r = rnd();
    if (r < 0.16) { h1++; h2 = 0; h3 = 0; h4 = 0; lines.push(CN[h1 % CN.length] + '、总体要求'); }
    else if (r < 0.28) { h2++; h3 = 0; h4 = 0; lines.push('（' + CN[h2 % CN.length] + '）指导思想'); }
    else if (r < 0.36) { h3++; h4 = 0; lines.push(h3 + '. 统一规划'); }
    else if (r < 0.42) { h4++; lines.push('（' + h4 + '）第一阶段'); }
    else {
      const n = 1 + Math.floor(rnd() * 10);
      let s = '';
      for (let k = 0; k < n; k++) s += SENTS[Math.floor(rnd() * SENTS.length)];
      lines.push(s);
    }
  }
  return lines.join('\n');
}

/* 随机配置：重点打击非零 margin 与各种行距 */
function makeCfg(rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const c = {};
  c.heading_space_before = pick([0, 0, 6, 9, 12]);
  c.heading_space_after = pick([0, 0, 3, 6, 9]);
  c.body_space_before = pick([0, 0, 0, 3, 6]);
  c.body_space_after = pick([0, 0, 0, 3, 6]);
  c.title_space_before = pick([0, 12, 18]);
  c.title_space_after = pick([0, 6, 12]);
  const rule = pick(['fixed', 'single', 'onehalf', 'multiple']);
  c.line_spacing_rule = rule;
  c.line_spacing_unit = rule === 'fixed' ? 'pt' : 'mult';
  c.line_spacing_value = rule === 'fixed' ? pick([24, 28, 32]) : pick([1.25, 1.5, 2]);
  c.body_size = pick([14, 16, 18]);
  c.first_line_indent_chars = pick([0, 2, 2, 2]);
  c.h1_indent_chars = pick([0, 2]);
  c.h2_indent_chars = pick([0, 2]);
  c.h3_indent_chars = pick([0, 2]);
  c.h4_indent_chars = pick([0, 2]);
  return c;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-fuzz2-'));
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
    const rnd = mulberry32(seed * 104729 + 7);
    const text = makeDoc(rnd);
    const conf = makeCfg(rnd);

    /* 直接写 cfg（ui.js 的 cfg 是模块内变量，通过 window 暴露的钩子改不方便，
       这里改成逐个控件改 —— 用 data-cfg 属性找到控件并派发 input/change） */
    await ev([
      '(function(){',
      '  var s=document.getElementById("src");',
      '  s.value=' + JSON.stringify(text) + ';',
      '  s.dispatchEvent(new Event("input",{bubbles:true}));',
      '  return 1;',
      '})()'
    ].join('\n'));
    await sleep(700);

    const confStr = JSON.stringify(conf);
    await ev([
      '(function(){',
      '  var conf=' + confStr + ';',
      '  var changed=0;',
      '  Object.keys(conf).forEach(function(k){',
      '    var el=document.querySelector("[data-cfg=\\""+k+"\\"]");',
      '    if(!el) return;',
      '    if(el.type==="checkbox"){ el.checked = conf[k]===true; }',
      '    else { el.value = String(conf[k]); }',
      '    el.dispatchEvent(new Event("change",{bubbles:true}));',
      '    el.dispatchEvent(new Event("input",{bubbles:true}));',
      '    changed++;',
      '  });',
      '  return changed;',
      '})()'
    ].join('\n'));
    await sleep(1250);

    const data = await ev([
      '(function(){',
      '  var host=document.getElementById("pages");',
      '  var saved=host.style.transform; host.style.transform="none";',
      '  var pages=[...host.querySelectorAll(".page")];',
      '  var out=[];',
      '  pages.forEach(function(p){',
      '    var cs=getComputedStyle(p);',
      /* 可用高度用理论值：A4 高 29.7cm→px 减去上下内边距。
         不能用 clientHeight / getBoundingClientRect().height —— .page 是
         min-height + 内容撑高，量出来会随内容与四舍五入浮动
         （实测同一文档各页 1131/1123/1130px 都有），拿它当基准测出的偏差是假的。 */
      '    var PX = 96/2.54;',
      '    var avail=29.7*PX-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
      '    var kids=[...p.querySelector(".doc").children];',
      '    var top0=null, bot=null;',
      '    kids.forEach(function(k){',
      '      var r=k.getBoundingClientRect();',
      '      if(top0===null) top0=r.top;',
      '      bot=r.bottom;',
      '    });',
      '    var real=bot!==null?bot-top0:0;',
      /* 页尾若是标题，本页剩下的空白是「标题防孤行」主动让出来的（Word 也这样排），
         不算白留 —— 把它标出来，判定时跳过，否则 A 与 D 两条判据互相打架。 */
      '    var last=kids[kids.length-1];',
      '    var tailIsHead=!!(last && last.dataset && last.dataset.lv);',
      '    var first=kids[0];',
      '    var headIsFirst=!!(first && first.dataset && first.dataset.lv);',
      '    out.push({avail:Math.round(avail),real:Math.round(real),',
      '              rest:Math.round(avail-real),kids:kids.length,',
      '              tailIsHead:tailIsHead,headIsFirst:headIsFirst});',
      '  });',
      '  host.style.transform=saved;',
      '  return out;',
      '})()'
    ].join('\n'));

    const issues = [];
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const isLast = i === data.length - 1;
      /* A 判据：非末页底部还有大片空白 = 不该分页却分页。
         两类例外都是 Word 的正常行为，不算缺陷：
           ① 页尾是标题：这点空白是「标题防孤行」主动让出来的
              （标题必须跟下面正文待在同一页，Word 同样会留出这段空白）；
           ② 下一页开头是标题：那个标题连着一行正文塞不进本页剩余空间，
              Word 也会把它整块推到下一页，本页因此留白。 */
      const nextStartsHead = !isLast && data[i + 1] && data[i + 1].headIsFirst;
      if (!isLast && d.rest > TOL && !d.tailIsHead && !nextStartsHead) {
        issues.push('A:p' + (i + 1) + ' 余' + d.rest); badA++;
      }
      if (d.real > d.avail + 2) { issues.push('B:p' + (i + 1) + ' 溢出' + (d.real - d.avail)); badB++; }
      if (d.kids === 0) { issues.push('C:p' + (i + 1) + ' 空页'); badC++; }
    }

    const ratios = data.map(d => Math.round(d.real / d.avail * 100));
    const mark = issues.length ? '  ⚠ ' + issues.join(' ') : '  OK';
    const brief = 'hSB' + conf.heading_space_before + '/hSA' + conf.heading_space_after +
      '/bSB' + conf.body_space_before + '/' + conf.line_spacing_rule + '@' + conf.line_spacing_value +
      '/sz' + conf.body_size;
    console.log('seed ' + String(seed).padStart(3) + ' ' + String(data.length).padStart(2) +
      ' 页 ' + JSON.stringify(ratios) + mark);
    if (issues.length) {
      console.log('        配置: ' + brief);
      failures.push({ seed, issues, ratios, conf, text });
    }
  }

  console.log('');
  console.log('='.repeat(64));
  console.log('轮数 ' + ROUNDS + '   A(不该分页却分页) ' + badA +
    '   B(溢出) ' + badB + '   C(空页) ' + badC);
  if (failures.length) {
    for (const f of failures.slice(0, 3)) {
      console.log('  seed ' + f.seed + ' ' + JSON.stringify(f.ratios) + ' ' + f.issues.join(' '));
      console.log('    配置 ' + JSON.stringify(f.conf));
    }
    const dump = path.join(OUT, 'fuzz2-fail-' + failures[0].seed + '.json');
    fs.writeFileSync(dump, JSON.stringify(failures[0], null, 2), 'utf8');
    console.log('  首个失败用例已存: ' + dump);
  }
  console.log(failures.length === 0 ? '全部通过' : '有 ' + failures.length + ' 轮失败');

  sock.close();
  process.exit(failures.length === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
