/* 截图：新版 Apple 风格界面 + 多页预览。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
const appPath = path.join(OUT, '_shot2.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9945;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-shot2-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files',
  '--disable-breakpad', '--disable-crash-reporter',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'file:///' + appPath.replace(/\\/g, '/')
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('端口未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map();
    ws.addEventListener('open', () => resolve({
      send(m, p) {
        return new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => reject(new Error('WS error')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w(m.result); }
    });
  });
}

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result.value;

  // 1) 示例文档 → 多页预览
  await ev(`document.getElementById('btnSample').click(); true`);
  await sleep(1200);
  await ev(`(function(){
    var t=document.getElementById('src');
    var base=t.value;
    // 追加足够多内容以产生多页
    for(var i=1;i<=8;i++){
      base += '\\n\\n（'+(i+1)+'）后续工作要求第'+i+'条\\n\\n这是补充的正文段落，用于演示长文档在预览中会自动分成多页，'+
        '排满一页后继续排到下一页，不再出现内容被裁掉的情况。每页都有独立的页眉页脚与页码角标。';
    }
    t.value=base; t.dispatchEvent(new Event('input',{bubbles:true})); return true})();`);
  await sleep(1500);
  const pageInfo = await ev(`JSON.stringify({pages:document.querySelectorAll('.pages > .page').length,
    badge:(document.querySelector('.pnum')||{}).textContent, zoom:document.getElementById('zoomPct').value})`);
  console.log('pages info: ' + pageInfo);

  let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-apple-input.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot: ui-apple-input.png');

  // 2) 滚到第二页看看
  await ev(`(function(){var p=document.querySelectorAll('.pages > .page')[1];
    p.scrollIntoView({block:'start'}); return true})();`);
  await sleep(600);
  shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-apple-page2.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot: ui-apple-page2.png');

  // 3) 自定义页
  await ev(`(function(){window.scrollTo(0,0);document.getElementById('view').scrollTop=0;
    document.querySelectorAll('.tab')[2].click(); return true})();`);
  await sleep(700);
  shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-apple-adv.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot: ui-apple-adv.png');

  // 4) 规范页
  await ev(`document.querySelectorAll('.tab')[1].click(); true`);
  await sleep(600);
  shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-apple-preset.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot: ui-apple-preset.png');

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
