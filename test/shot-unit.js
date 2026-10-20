/* shot-unit.js — 截图 + 预览左缩进验证 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BIN = CHROMES.find(p => fs.existsSync(p));
const PORT = 9989 + (process.pid % 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = path.join(OUT, '_shot-unit.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-su-'));
  const browser = spawn(BIN, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-dev-shm-usage',
    '--allow-file-access-from-files', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, 'file:///' + app.replace(/\\/g, '/'),
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 100; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const t = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { ws = t.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(250);
  }
  const sock = new WebSocket(ws);
  let id = 0; const waiters = new Map();
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
  });
  const send = (m, p) => new Promise(r => {
    const i = ++id; waiters.set(i, r); sock.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true }); await sleep(1500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(300);

  // 载入示例，切到「③ 自定义」，滚到行距与缩进
  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1200);
  await ev(`document.querySelector('.tab[data-tab="adv"]').click();true`);
  await sleep(300);
  await ev(`(function(){
    var hs=document.querySelectorAll('.collapse-h');
    for(var i=0;i<hs.length;i++){
      var b=document.getElementById('b'+hs[i].id.slice(1));
      if(b && b.classList.contains('hide')) hs[i].click();
    }
    var sp=document.getElementById('hSpacing');
    if(sp) sp.scrollIntoView({block:'start'});
    return true})()`);
  await sleep(500);

  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-units-spacing.png'), Buffer.from(shot.data, 'base64'));

  // 验证预览左缩进
  const check = await ev(`(function(){
    var body=document.querySelector('#pages .blk-body');
    var before=body?getComputedStyle(body).paddingLeft:'none';
    var el=document.querySelector('[data-cfg="left_indent_value"]');
    el.value='2'; el.dispatchEvent(new Event('input',{bubbles:true}));
    var u=document.querySelector('[data-cfg="left_indent_unit"]');
    u.value='chars'; u.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({before:before})})()`);
  await sleep(1200);
  const after = await ev(`(function(){
    var body=document.querySelector('#pages .blk-body');
    return JSON.stringify({
      padL: body?getComputedStyle(body).paddingLeft:'none',
      fs: body?getComputedStyle(body).fontSize:'none',
      hint: (document.getElementById('lineSpacingHint')||{}).textContent||''})})()`);
  console.log('左缩进前: ' + check);
  console.log('左缩进后: ' + after);

  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-units-indent.png'), Buffer.from(shot.data, 'base64'));

  // 宽左栏下的字体表
  await ev(`(function(){
    var s=document.getElementById('splitter'); var r=s.getBoundingClientRect();
    s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+5,clientY:r.top+100}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+5+230,clientY:r.top+100}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+5+230,clientY:r.top+100}));
    var f=document.getElementById('hFont'); var b=document.getElementById('bFont');
    if(b&&b.classList.contains('hide')) f.click();
    f.scrollIntoView({block:'start'});
    return true})()`);
  await sleep(700);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-units-wide.png'), Buffer.from(shot.data, 'base64'));

  console.log('截图完成');
  sock.close(); browser.kill();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
