/* shot-features3.js —— 截图：统计条、空格高亮、标题后空行、空格提示条
   用法: node shot-features3.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_shot-f3.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9531 + (process.pid % 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DOC = [
  '关于加强信息化建设工作的通知',
  '各部门、各直属单位：',
  '为深入贯彻落实上级关于数字化转型的决策部署，现将有关事项通知如下。',
  '一、总体要求',
  '坚持问题导向，以需求为核心，统筹推进基础设施与业务系统建设。',
  '（一）指导思想',
  '突出应用牵引，注重实效，避免重复建设。',
  '二、重点任务',
  '加快统一平台建设，打通数据链路，实现主要业务线上办理。',
  '三、工作要求',
  '各单位要高度重视，明确专人负责，确保各项任务按期完成。'
].join('\n');

const SPACED = '一、总体要求\n这是　一段带有  空格的文本 ，需要检查。\n二、重点任务\n另一段 也有空格 。';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shotf3-'));
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
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
      console.log('  写出 ' + name);
    }
  };
  const setSrc = async txt => {
    await ev('(function(){var s=document.getElementById("src");s.value=' +
      JSON.stringify(txt) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
    await sleep(1000);
  };
  const setSel = async (id2, v) => {
    await ev('(function(){var e=document.getElementById(' + JSON.stringify(id2) +
      ');e.value=' + JSON.stringify(v) + ';e.dispatchEvent(new Event("change",{bubbles:true}));return 1;})()');
    await sleep(1000);
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.reload', { ignoreCache: true });
  await sleep(1800);

  // 1. 标题后留空行 + 统计条
  await setSel('c_blank_line_mode', 'heading_gap');
  await setSrc(DOC);
  await shot('ui-f3-stats.png');

  // 2. 空格提示条 + 高亮
  await setSrc(SPACED);
  await sleep(400);
  await ev('document.getElementById("q_space_hl").click();true');
  await sleep(1100);
  await shot('ui-f3-space.png');

  // 3. 自定义面板里的空格/空行设置
  await ev('document.querySelector(".tab[data-tab=\'adv\']").click();true');
  await sleep(500);
  await ev([
    '(function(){',
    '  var hs=document.querySelectorAll(".collapse-h");',
    '  for(var i=0;i<hs.length;i++){',
    '    var n=hs[i].nextElementSibling;',
    '    if(n&&n.classList.contains("collapse-b")&&n.classList.contains("hide")) hs[i].click();',
    '  }',
    '  return hs.length;',
    '})()'
  ].join('\n'));
  await sleep(600);
  await ev([
    '(function(){',
    '  var t=document.getElementById("c_blank_line_mode");',
    '  if(t&&t.scrollIntoView) t.scrollIntoView({block:"center"});',
    '  return 1;',
    '})()'
  ].join('\n'));
  await sleep(500);
  await shot('ui-f3-adv.png');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
