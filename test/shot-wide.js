/* 截图：把左栏拉宽到 620px，验证「③ 自定义」里所有下拉框内容都完整显示。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const BROWSER = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const appPath = path.join(OUT, '_shot-wide.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9969;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-wide-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'file:///' + appPath.replace(/\\/g, '/')
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('端口未就绪');
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const w = new Map();
    ws.addEventListener('open', () => res({
      send(m, p) { return new Promise(r => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); }); },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => rej(new Error('ws')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m.result); }
    });
  });
}

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev(`document.querySelector('[data-tab="adv"]').click(); true`);
  await sleep(900);
  // 拖宽左栏到 620px
  await ev(`(function(){
    var sp=document.getElementById('splitter');
    var r=sp.getBoundingClientRect();
    sp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+5}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+5+220}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    return document.getElementById('colLeft').offsetWidth;
  })()`);
  await sleep(700);

  // 展开所有折叠区
  await ev(`(function(){
    document.querySelectorAll('#pane-adv details').forEach(function(d){d.open=true});
    return true})()`);
  await sleep(600);

  // 检查所有 select 是否被截断
  const trunc = await ev(`(function(){
    var bad = [];
    document.querySelectorAll('#pane-adv select, #fontTable select, #q_title_font, #q_h1_font, #q_h2_font').forEach(function(s){
      if (s.offsetWidth < 60) return;
      var cs = getComputedStyle(s);
      var avail = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      // 用 canvas 量当前显示文本宽度
      var c = document.createElement('canvas').getContext('2d');
      c.font = cs.fontSize + ' ' + cs.fontFamily;
      var txt = s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : '';
      var w = c.measureText(txt).width;
      if (w > avail) bad.push({id:s.id || s.className, txt:txt, textW:Math.round(w), avail:Math.round(avail)});
    });
    return JSON.stringify({total: document.querySelectorAll('#pane-adv select').length, bad: bad});
  })()`);
  console.log('select 截断检查: ' + trunc);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, 'ui-apple-adv-wide.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot: ui-apple-adv-wide.png');

  cdp.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
