/* e2e-features3.js —— 三项新功能：标题后空行 / 空格处理 / 字数统计
   用法: node e2e-features3.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_e2e-f3.html');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CHROMES.find(p => fs.existsSync(p));
const PORT = 9501 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + (extra !== undefined ? extra : '')); }
};

/* 带标题层级 + 正文的测试文本（模拟真实公文骨架） */
const DOC = [
  '关于加强某项工作的通知',
  '各部门：',
  '为做好相关工作，现将有关事项通知如下。',
  '一、总体要求',
  '坚持问题导向，扎实推进各项任务。',
  '（一）指导思想',
  '以需求为核心，统筹推进。',
  '1. 统一规划',
  '避免重复建设。',
  '二、重点任务',
  '加快平台建设。',
  '三、工作要求',
  '各单位要抓好落实。'
].join('\n');

/* 空格样例：全角空格、行首空格、连续空格、中文之间的空格 */
const SPACED = '  这是　一段带有  空格的文本 。\n第二行 也有空格 。';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-f3-'));
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
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
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
    if (!r) return undefined;
    if (r.exceptionDetails) throw new Error('EVAL: ' + r.exceptionDetails.text);
    return r.result ? r.result.value : undefined;
  };
  const setSrc = async (txt) => {
    await ev('(function(){var s=document.getElementById("src");s.value=' +
      JSON.stringify(txt) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
    await sleep(900);
  };

  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1700);

  console.log('=== 1. 新配置项与界面控件存在 ===');
  const init = await ev([
    '(function(){',
    '  const c=window.__cfg ? window.__cfg() : null;',
    '  return {',
    '    spaceMode: (document.getElementById("c_space_mode")||{}).value||"",',
    '    qSpace: (document.getElementById("q_space")||{}).value||"",',
    '    hl: !!(document.getElementById("c_space_highlight")||{}).checked,',
    '    statsToggle: !!document.getElementById("c_show_stats"),',
    '    hlBtn: !!document.getElementById("q_space_hl"),',
    '    blankOpts: [...(document.getElementById("c_blank_line_mode")||{options:[]}).options].map(o=>o.value),',
    '    pvStats: !!document.getElementById("pvStats"),',
    '    spaceHint: !!document.getElementById("spaceHint")',
    '  };',
    '})()'
  ].join('\n'));
  console.log('  ' + JSON.stringify(init));
  check('空格处理控件存在', init.spaceMode === 'off' && init.qSpace === 'off');
  check('高亮复选框 + 高亮按钮都在', init.hl === false && init.hlBtn === true);
  check('统计开关已移除（统计改为始终显示）', init.statsToggle === false);
  check('空行模式含「标题后留空行」', init.blankOpts.indexOf('heading_gap') >= 0,
    JSON.stringify(init.blankOpts));
  check('统计条与空格提示条都存在', init.pvStats && init.spaceHint);

  console.log('');
  console.log('=== 2. 「只在标题后留空行」模式 ===');
  await setSrc(DOC);
  await ev([
    '(function(){',
    '  var s=document.getElementById("c_blank_line_mode");',
    '  s.value="heading_gap"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return 1;',
    '})()'
  ].join('\n'));
  await sleep(1100);
  const gap = await ev([
    '(function(){',
    '  var kids=[...document.querySelectorAll("#pages .doc > *")];',
    '  var seq=kids.map(function(k){',
    '    if(k.classList.contains("blk-blank")) return "B";',
    '    if(k.classList.contains("blk-title")) return "T";',
    '    if(k.classList.contains("blk-sal")) return "S";',
    '    if(k.classList.contains("blk-head")) return "H"+(k.dataset.lv||"");',
    '    return "P";',
    '  });',
    '  return {seq:seq.join(" "), blanks:seq.filter(function(x){return x==="B";}).length,',
    '    heads:seq.filter(function(x){return x[0]==="H";}).length};',
    '})()'
  ].join('\n'));
  console.log('  ' + JSON.stringify(gap));
  /* 期望：主标题后有空行、每个 H 后有空行、正文段之间没有空行 */
  check('空行数量 = 标题数（主标题 + 各级标题 + 主送）',
    gap.blanks >= gap.heads, 'blanks=' + gap.blanks + ' heads=' + gap.heads);
  const pairs = gap.seq.split(' ');
  let badPair = [];
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i] === 'P' && pairs[i + 1] === 'B') badPair.push(i);
  }
  check('正文段之间没有空行', badPair.length === 0, '违例位置 ' + JSON.stringify(badPair));
  check('标题后确实跟了空行',
    pairs.some((p, i) => p[0] === 'H' && pairs[i + 1] === 'B'), gap.seq);

  console.log('');
  console.log('=== 3. 空格处理四种模式 ===');
  await setSrc(SPACED);
  await ev([
    '(function(){',
    '  var s=document.getElementById("c_blank_line_mode");',
    '  s.value="keep_all"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return 1;',
    '})()'
  ].join('\n'));
  await sleep(900);
  const spaceModes = {};
  for (const m of ['off', 'collapse', 'remove_all']) {
    await ev([
      '(function(){',
      '  var s=document.getElementById("c_space_mode");',
      '  s.value=' + JSON.stringify(m) + '; s.dispatchEvent(new Event("change",{bubbles:true}));',
      '  return 1;',
      '})()'
    ].join('\n'));
    await sleep(800);
    spaceModes[m] = await ev([
      '(function(){',
      /* 只统计正文区：页脚页码「1 / 1」本身带空格，会把结果污染成「剩 2 个」 */
      '  var t=[...document.querySelectorAll("#pages .doc")].map(function(d){return d.textContent;}).join("");',
      '  return {sp:(t.match(/[ \\u3000]/g)||[]).length, head:t.slice(0,14)};',
      '})()'
    ].join('\n'));
  }
  console.log('  ' + JSON.stringify(spaceModes));
  /* 原文：'  这是　一段带有  空格的文本 。\n第二行 也有空格 。'
     行内空格 = 全角1 + 连续2 + 句号前1（行首的 2 个会被 trim 掉），共 4 个 */
  check('off 保留全部行内空格', spaceModes.off.sp >= 3, JSON.stringify(spaceModes.off));
  check('collapse 把连续/全角空格压成 1 个',
    spaceModes.collapse.sp < spaceModes.off.sp,
    spaceModes.off.sp + ' → ' + spaceModes.collapse.sp);
  check('remove_all 删干净所有空格', spaceModes.remove_all.sp === 0,
    '剩余 ' + spaceModes.remove_all.sp);

  console.log('');
  console.log('=== 4. 空格高亮 ===');
  await ev([
    '(function(){',
    '  var s=document.getElementById("c_space_mode");',
    '  s.value="off"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return 1;',
    '})()'
  ].join('\n'));
  await sleep(800);
  await ev('document.getElementById("q_space_hl").click();true');
  await sleep(900);
  const hl = await ev([
    '(function(){',
    '  var doc=document.querySelector("#pages .doc");',
    '  return {',
    '    showspace: !!(doc && doc.classList.contains("showspace")),',
    '    marks: document.querySelectorAll("#pages .sp").length,',
    '    wide: document.querySelectorAll("#pages .sp-wide").length,',
    '    checked: !!document.getElementById("c_space_highlight").checked',
    '  };',
    '})()'
  ].join('\n'));
  console.log('  ' + JSON.stringify(hl));
  check('高亮开启后 .doc 带 showspace 类', hl.showspace === true);
  check('普通空格被标成色块', hl.marks > 0, hl.marks + ' 个');
  check('全角空格单独标记', hl.wide > 0, hl.wide + ' 个');
  check('复选框同步勾上', hl.checked === true);

  console.log('');
  console.log('=== 5. 字数 / 页数统计 ===');
  await ev('document.getElementById("q_space_hl").click();true');  // 关掉高亮
  await sleep(700);
  await setSrc(DOC);
  const st = await ev([
    '(function(){',
    '  var el=document.getElementById("pvStats");',
    '  var items=[...el.querySelectorAll(".psi")].map(function(s){',
    '    return s.querySelector("i").textContent+"="+s.querySelector("b").textContent;',
    '  });',
    '  var inTool = !!(el.closest && el.closest(".ptool"));',
    '  var btn=document.getElementById("btnStatsMore");',
    '  return {visible: el.style.display!=="none", items: items, inTool: inTool,',
    '          hasBtn: !!btn, btnTag: btn ? btn.tagName : ""};',
    '})()'
  ].join('\n'));
  console.log('  ' + JSON.stringify({ visible: st.visible, items: st.items, inTool: st.inTool }));
  check('统计条可见', st.visible === true);
  check('显示页数', /页数=/.test(st.items.join(',')), st.items.join(','));
  check('显示字数', /字数=[\d,]+/.test(st.items.join(',')), st.items.join(','));
  check('显示字符数', /字符=[\d,]+/.test(st.items.join(',')), st.items.join(','));
  const totalShown = (st.items.find(x => /^字数=/.test(x)) || '').split('=')[1] || '';
  check('字数是个合理数字', /^\d[\d,]*$/.test(totalShown) && parseInt(totalShown.replace(/,/g, ''), 10) > 50,
    totalShown);
  check('统计显示在「实时预览」工具栏里（不另占版面）', st.inTool === true);
  check('「详情」是真正的按钮', st.hasBtn === true && st.btnTag === 'BUTTON', st.btnTag);

  /* 「详情」点开要真的弹窗，并把细分给全（旧版只是 title 悬停，点了没任何反应） */
  await ev('document.getElementById("btnStatsMore").click();true');
  await sleep(500);
  const detail = await ev([
    '(function(){',
    '  var m=document.getElementById("mask");',
    '  var body=document.getElementById("modalBody")||{};',
    '  var t=(document.getElementById("modalTitle")||{}).textContent||"";',
    '  var txt=body.textContent||"";',
    '  return {open: !!(m && m.classList.contains("on")), title: t,',
    '          hasCJK: txt.indexOf("中文")>=0, hasPunct: txt.indexOf("标点")>=0,',
    '          hasPara: txt.indexOf("段落")>=0, len: txt.length};',
    '})()'
  ].join('\n'));
  console.log('  ' + JSON.stringify(detail));
  check('点「详情」弹出统计明细窗', detail.open === true, detail.title);
  check('明细含中文 / 标点 / 段落细分',
    detail.hasCJK && detail.hasPunct && detail.hasPara);
  await ev([
    '(function(){',
    '  var f=document.querySelectorAll("#modalFoot .btn");',
    '  if(f.length) f[f.length-1].click(); return 1;',
    '})()'
  ].join('\n'));
  await sleep(350);

  console.log('');
  console.log('=== 6. 统计始终显示（无开关）===');
  check('自定义面板里已无统计开关',
    (await ev('!!document.getElementById("c_show_stats")')) === false);
  await ev('(function(){var s=document.getElementById("src");s.value="";' +
    's.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(700);
  const emptyHidden = await ev('document.getElementById("pvStats").style.display');
  check('空文档时统计条隐藏（避免 0 字 0 页）', emptyHidden === 'none', emptyHidden);
  await setSrc(DOC);
  const backShown = await ev('document.getElementById("pvStats").style.display');
  check('有内容时统计条自动显示', backShown !== 'none', backShown);

  console.log('');
  console.log('=== 7. 零未捕获异常 ===');
  check('页面无未捕获错误', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 2)));

  sock.close();
  console.log('');
  console.log('='.repeat(56));
  console.log('三项新功能：PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
