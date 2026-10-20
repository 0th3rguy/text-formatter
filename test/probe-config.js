/* 诊断：「规范」与「我的方案」到底是什么关系、当前用的是哪一套。
   验证 3 件事：
   1. 套用内置规范后，提示条显示来源 + 未改动；
   2. 改一项设置后，提示条显示「改过 N 项」；
   3. 存为方案 → 套用方案后，来源变成「我的方案」。
   用法: node probe-config.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_probe-cfg.html');

const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CHROMES.find(p => fs.existsSync(p));
const PORT = 9401 + (process.pid % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
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

  const readState = [
    '(function(){',
    '  return {',
    '    chip: (document.getElementById("chipPreset")||{}).textContent,',
    '    cur: (document.getElementById("curConfig")||{}).innerText,',
    '    desc: (document.getElementById("presetDesc")||{}).textContent.slice(0,40),',
    '    presetSel: (document.getElementById("presetSel")||{}).value',
    '  };',
    '})()'
  ].join('\n');

  console.log('=== 1. 初始状态（默认党政机关公文格式）===');
  console.log(JSON.stringify(await ev(readState), null, 1));

  console.log('');
  console.log('=== 2. 改一项设置（正文改成宋体）后是否显示「改过 N 项」===');
  await ev([
    '(function(){',
    '  const s=document.getElementById("q_body_font");',
    '  s.value="宋体"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return true;',
    '})()'
  ].join('\n'));
  await sleep(700);
  console.log(JSON.stringify(await ev(readState), null, 1));

  console.log('');
  console.log('=== 3. 切到「简洁 / 无修饰」规范 ===');
  await ev([
    '(function(){',
    '  const s=document.getElementById("presetSel");',
    '  s.value="简洁 / 无修饰"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return true;',
    '})()'
  ].join('\n'));
  await sleep(800);
  console.log(JSON.stringify(await ev(readState), null, 1));

  console.log('');
  console.log('=== 4. 在「规范」里改字体，看是否提示改动、且不与规范冲突 ===');
  await ev([
    '(function(){',
    '  const s=document.getElementById("q_body_font");',
    '  s.value="黑体"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return true;',
    '})()'
  ].join('\n'));
  await sleep(700);
  const st4 = await ev(readState);
  console.log(JSON.stringify(st4, null, 1));
  console.log('  判读：chip 应显示「简洁 / 无修饰（改过 N 项）」，说明改动叠加在当前规范之上，"以当前规范为准 + 本次改动"。');

  console.log('');
  console.log('=== 5. 存为我的方案 → 套用 ===');
  await ev([
    '(function(){',
    '  document.getElementById("btnSaveScheme").click();',
    '  return true;',
    '})()'
  ].join('\n'));
  await sleep(600);
  const saved = await ev([
    '(function(){',
    '  const inp=document.getElementById("schemeName");',
    '  if(!inp) return "no-input";',
    '  inp.value="测试方案A";',
    '  const btns=[...document.querySelectorAll("#modalFoot button")];',
    '  const b=btns.find(x=>x.textContent.trim()==="保存");',
    '  if(!b) return "no-save-btn";',
    '  b.click();',
    '  return "ok";',
    '})()'
  ].join('\n'));
  console.log('  存方案: ' + saved);
  await sleep(600);

  await ev([
    '(function(){',
    '  const s=document.getElementById("presetSel");',
    '  s.value="党政机关公文格式"; s.dispatchEvent(new Event("change",{bubbles:true}));',
    '  return true;',
    '})()'
  ].join('\n'));
  await sleep(700);

  await ev('document.getElementById("btnManageScheme").click();true');
  await sleep(600);
  const applied = await ev([
    '(function(){',
    '  const b=document.querySelector("#modalBody [data-apply]");',
    '  if(!b) return "no-apply-btn:"+(document.getElementById("modalBody")||{}).innerText;',
    '  const n=b.dataset.apply; b.click(); return n;',
    '})()'
  ].join('\n'));
  console.log('  套用方案: ' + applied);
  await sleep(900);
  console.log(JSON.stringify(await ev(readState), null, 1));
  console.log('  判读：chip 应显示「方案：测试方案A」，cur 应显示「我的方案「测试方案A」」→ 证明方案可以覆盖规范，两者同层。');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
