/* shot-curconfig.js —— 截图「② 规范」页的「当前使用」提示条 + 分页效果
   产出 test/out/ui-curconfig.png、ui-pagefill.png */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const APP = path.join(OUT, '_shot-cur.html');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CHROMES.find(p => fs.existsSync(p));
const PORT = 9441 + (process.pid % 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), APP);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shot-'));
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
  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    return r && r.result ? r.result.value : undefined;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  // 填入示例，让预览有内容
  await ev('document.getElementById("btnSample").click();true');
  await sleep(1500);

  // 切到「② 规范」
  await ev('document.querySelector(\'.tab[data-tab="preset"]\').click();true');
  await sleep(600);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-curconfig.png'), Buffer.from(shot1.data, 'base64'));
  console.log('写出: ui-curconfig.png');

  // 单独截右侧预览第一页，看填充率
  const clip = await ev([
    '(function(){',
    '  const p=document.querySelector("#pages .page");',
    '  if(!p) return null;',
    '  const r=p.getBoundingClientRect();',
    '  return {x:r.left,y:r.top,w:r.width,h:r.height};',
    '})()'
  ]);
  if (clip) {
    /* 缩放是 transform:scale，rect 已是视觉尺寸；截图 clip 用页面坐标 */
    const shot2 = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.round(clip.x), y: Math.round(clip.y), width: Math.round(clip.w), height: Math.round(clip.h), scale: 1 }
    });
    fs.writeFileSync(path.join(OUT, 'ui-pagefill.png'), Buffer.from(shot2.data, 'base64'));
    console.log('写出: ui-pagefill.png  ' + Math.round(clip.w) + 'x' + Math.round(clip.h));
  }

  sock.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
