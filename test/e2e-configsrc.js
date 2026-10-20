/* e2e-configsrc.js —— 「规范」与「我的方案」的关系 + 当前用哪一套的指示器
   断言 5 组：
   1. 默认来源是内置规范，提示条显示「内置规范」且「未做改动」
   2. 改一项设置 → 提示条显示「改动 1 项」，chip 也带「改过 1 项」
   3. 切换内置规范 → 来源跟着换、改动数归零
   4. 存为方案 → 方案出现在「规范方案」下拉的「我的方案」分组里
   5. 从下拉选方案 → 来源变「我的方案」，再改一项只影响本次
   用法: node e2e-configsrc.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_e2e-cfg.html');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CHROMES.find(p => fs.existsSync(p));
const PORT = 9421 + (process.pid % 80);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + (extra !== undefined ? extra : '')); }
};

(async () => {
  if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-cfg-'));
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

  await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async expr =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result.value;
  const J = a => a.join('\n');

  const state = J([
    '(function(){',
    '  return {',
    '    chip: (document.getElementById("chipPreset")||{}).textContent||"",',
    '    cur: (document.getElementById("curConfig")||{}).innerText||"",',
    '    sel: (document.getElementById("presetSel")||{}).value||"",',
    '    groups: [...document.querySelectorAll("#presetSel optgroup")].map(g=>g.label+":"+g.children.length)',
    '  };',
    '})()'
  ]);

  console.log('=== 1. 默认来源：内置规范、未改动 ===');
  const s1 = await ev(state);
  console.log('  ' + JSON.stringify(s1));
  check('初始来源是内置规范', s1.sel === 'preset:党政机关公文格式', s1.sel);
  check('提示条显示内置规范', /内置规范「党政机关公文格式」/.test(s1.cur));
  check('提示条显示未做改动', /未做改动/.test(s1.cur));
  check('chip 不带改动计数', !/改过/.test(s1.chip), s1.chip);

  console.log('');
  console.log('=== 2. 改一项 → 显示改动数量 ===');
  await ev(J([
    '(function(){',
    '  const s=document.getElementById("q_body_font");',
    '  s.value="宋体"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return true;',
    '})()'
  ]));
  await sleep(700);
  const s2 = await ev(state);
  console.log('  ' + JSON.stringify({ chip: s2.chip, cur: s2.cur.slice(0, 46) }));
  /* 注意：innerText 会丢掉 <b> 标签；且「② 规范」页签隐藏时 innerText 退化为
     textContent（不带 <br> 换行）。所以这里只匹配纯文字。 */
  check('提示条出现改动计数', /已在此基础上改动\s*1\s*项设置/.test(s2.cur), s2.cur.slice(0, 60));
  check('chip 带「改过 1 项」', /改过 1 项/.test(s2.chip), s2.chip);

  console.log('');
  console.log('=== 3. 切换内置规范 → 来源更换、改动归零 ===');
  await ev(J([
    '(function(){',
    '  const s=document.getElementById("presetSel");',
    '  s.value="preset:简洁 / 无修饰"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return true;',
    '})()'
  ]));
  await sleep(900);
  const s3 = await ev(state);
  console.log('  ' + JSON.stringify({ chip: s3.chip, sel: s3.sel, cur: s3.cur.slice(0, 40) }));
  check('来源切换为「简洁 / 无修饰」', s3.sel === 'preset:简洁 / 无修饰', s3.sel);
  check('提示条跟到新规范', /内置规范「简洁 \/ 无修饰」/.test(s3.cur), s3.cur.slice(0, 40));
  check('改动计数归零', /未做改动/.test(s3.cur), s3.cur.slice(0, 40));

  console.log('');
  console.log('=== 4. 存为方案 → 出现在「我的方案」分组 ===');
  await ev('document.getElementById("btnSaveScheme").click();true');
  await sleep(600);
  const saved = await ev(J([
    '(function(){',
    '  const i=document.getElementById("schemeName");',
    '  if(!i) return "no-input";',
    '  i.value="配置测试方案";',
    '  const b=[...document.querySelectorAll("#modalFoot button")].find(x=>/保存/.test(x.textContent));',
    '  if(!b) return "no-save";',
    '  b.click(); return "ok";',
    '})()'
  ]));
  await sleep(700);
  const s4 = await ev(state);
  console.log('  ' + JSON.stringify({ saved: saved, groups: s4.groups }));
  check('方案保存成功', saved === 'ok', saved);
  check('下拉分成「内置规范」+「我的方案」两组', s4.groups.length === 2, JSON.stringify(s4.groups));
  check('「我的方案」分组含 1 项', /我的方案:1/.test(s4.groups.join(',')), s4.groups.join(','));

  console.log('');
  console.log('=== 5. 从下拉选「我的方案」→ 来源变方案 ===');
  await ev(J([
    '(function(){',
    '  const s=document.getElementById("presetSel");',
    '  s.value="scheme:配置测试方案"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return true;',
    '})()'
  ]));
  await sleep(900);
  const s5 = await ev(state);
  console.log('  ' + JSON.stringify({ chip: s5.chip, sel: s5.sel, cur: s5.cur.slice(0, 44) }));
  check('来源变为「我的方案」', s5.sel === 'scheme:配置测试方案', s5.sel);
  check('chip 显示「方案：」', /^方案：/.test(s5.chip), s5.chip);
  check('提示条显示我的方案', /我的方案「配置测试方案」/.test(s5.cur), s5.cur.slice(0, 44));

  console.log('');
  console.log('=== 6. 零未捕获异常 ===');
  check('页面无未捕获错误', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 2)));

  sock.close();
  console.log('');
  console.log('='.repeat(56));
  console.log('配置来源指示器：PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
