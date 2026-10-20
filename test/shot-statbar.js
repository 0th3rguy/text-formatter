/* shot-statbar.js —— 截图：工具栏里的统计条 + 「详情」弹窗
   用法: node shot-statbar.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_shot-statbar.html');
const BROWSER = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const PORT = 9551 + (process.pid % 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DOC = [
  '卷烟物流配送中心“四个强化”夯实运营管理根基',
  '各部门、各直属单位：',
  '为降低卷烟破损损耗、规范破损卷烟调换流程，近日，卷烟物流配送中心聚焦运输、交接、处置各环节，推动破损管控从“事后补损”向“全链控损”转变。',
  '一、总体要求',
  '坚持问题导向、目标导向、结果导向，以标准化、规范化、精细化为抓手，全面提升运营管理水平。',
  '（一）指导思想',
  '突出应用牵引，注重实效，避免重复建设，形成可复制、可推广的经验做法。',
  '二、重点任务',
  '加快统一平台建设，打通数据链路，实现主要业务线上办理，做到一事一档、有据可查。',
  '三、工作要求',
  '各单位要高度重视，明确专人负责，确保各项任务按期完成，取得实效。'
].join('\n');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shotbar-'));
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

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 950, deviceScaleFactor: 2, mobile: false });
  await send('Page.reload', { ignoreCache: true });
  await sleep(1800);

  await ev('(function(){var s=document.getElementById("src");s.value=' +
    JSON.stringify(DOC) + ';s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await sleep(1300);

  // 1. 工具栏（统计紧跟在来源标签右侧）
  await shot('ui-statbar.png');

  // 2. 只截工具栏那一条，放大看清
  const box = await ev([
    '(function(){',
    '  var t=document.querySelector(".ptool");',
    '  var r=t.getBoundingClientRect();',
    '  return {x:r.x,y:r.y,w:r.width,h:r.height};',
    '})()'
  ].join('\n'));
  if (box) {
    const r2 = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 }
    });
    if (r2 && r2.data) {
      fs.writeFileSync(path.join(OUT, 'ui-statbar-zoom.png'), Buffer.from(r2.data, 'base64'));
      console.log('  写出 ui-statbar-zoom.png');
    }
  }

  // 3. 「详情」弹窗
  await ev('document.getElementById("btnStatsMore").click();true');
  await sleep(600);
  await shot('ui-statbar-detail.png');

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
