/* 端到端：验证「左栏可拖拽调宽 / 双击收起」「界面字号密度切换」「页边距四边分调」。 */
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

const appPath = path.join(OUT, '_e2e-layout.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9961;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-layout-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--allow-file-access-from-files', '--disable-breakpad', '--disable-crash-reporter',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'file:///' + appPath.replace(/\\/g, '/')
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
};

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
    let id = 0; const w = new Map(); const exceptions = [];
    ws.addEventListener('open', () => res({
      exceptions,
      send(m, p) { return new Promise(r => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); }); },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => rej(new Error('ws')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        exceptions.push((d.exception && d.exception.description) || d.text);
      }
      if (m.id && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m.result); }
    });
  });
}

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1700);

  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('EVAL: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  };

  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1300);

  console.log('\n=== 1. 左栏拖拽调宽 ===');
  const w0 = await ev(`document.getElementById('colLeft').offsetWidth`);
  check('初始左栏宽度约 400px', w0 >= 380 && w0 <= 430, w0 + 'px');

  // 模拟 mousedown → mousemove → mouseup
  const drag = await ev(`(function(){
    var sp = document.getElementById('splitter');
    var r = sp.getBoundingClientRect();
    var x0 = r.left + 5;
    sp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:x0}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x0+140}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    return document.getElementById('colLeft').offsetWidth;
  })()`);
  check('拖拽后左栏变宽（+140px 左右）', drag > w0 + 100, w0 + ' → ' + drag + 'px');

  // 拖到超限应被夹住
  const clamp = await ev(`(function(){
    var sp = document.getElementById('splitter');
    var r = sp.getBoundingClientRect();
    sp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+5}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:3000}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    return document.getElementById('colLeft').offsetWidth;
  })()`);
  check('拖到极右被夹在 720px 上限', clamp <= 725, clamp + 'px');

  const clampMin = await ev(`(function(){
    var sp = document.getElementById('splitter');
    var r = sp.getBoundingClientRect();
    sp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+5}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:0}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    return document.getElementById('colLeft').offsetWidth;
  })()`);
  check('拖到极左被夹在 260px 下限', clampMin >= 255 && clampMin <= 275, clampMin + 'px');

  // 双击收起 / 展开
  const dbl = await ev(`(function(){
    var sp = document.getElementById('splitter');
    sp.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    var collapsed = document.getElementById('colLeft').style.display;
    sp.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    var restored = document.getElementById('colLeft').style.display;
    return JSON.stringify({collapsed:collapsed, restored:restored});
  })()`);
  const D = JSON.parse(dbl);
  check('双击收起左栏', D.collapsed === 'none', D.collapsed);
  check('再次双击展开左栏', D.restored !== 'none', D.restored || '(默认)');

  // 宽度持久化
  const persist = await ev(`(function(){
    var sp=document.getElementById('splitter');
    var r=sp.getBoundingClientRect();
    sp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+5}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+5+500}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    return localStorage.getItem('textformatter.leftw.v1');
  })()`);
  check('宽度写入 localStorage', !!persist && parseInt(persist, 10) > 400, persist + 'px');

  console.log('\n=== 2. 界面字号密度 ===');
  const dens = await ev(`(function(){
    var out = [];
    var btn = document.getElementById('btnDensity');
    out.push({label: btn.textContent, scale: getComputedStyle(document.body).getPropertyValue('--ui-scale').trim()});
    btn.click(); out.push({label: btn.textContent, scale: getComputedStyle(document.body).getPropertyValue('--ui-scale').trim()});
    btn.click(); out.push({label: btn.textContent, scale: getComputedStyle(document.body).getPropertyValue('--ui-scale').trim()});
    return JSON.stringify(out);
  })()`);
  const DN = JSON.parse(dens);
  console.log('  ' + dens);
  check('密度按钮初始为「标准」1', DN[0].label === '标准' && DN[0].scale === '1', DN[0].label + ' ' + DN[0].scale);
  check('点击后变「紧凑」0.92', DN[1].label === '紧凑' && DN[1].scale === '0.92', DN[1].label + ' ' + DN[1].scale);
  check('再点击变「更小」0.84', DN[2].label === '更小' && DN[2].scale === '0.84', DN[2].label + ' ' + DN[2].scale);

  // 实际上有没有变小？量一个 select 的字号
  const fontDelta = await ev(`(function(){
    var btn = document.getElementById('btnDensity');
    // 回到标准
    while (btn.textContent !== '标准') btn.click();
    var a = parseFloat(getComputedStyle(document.querySelector('#pane-adv .field span')).fontSize);
    btn.click(); btn.click(); btn.click();  // 最小 0.76
    var b = parseFloat(getComputedStyle(document.querySelector('#pane-adv .field span')).fontSize);
    while (btn.textContent !== '标准') btn.click();
    return JSON.stringify({standard:a, small:b, label:btn.textContent});
  })()`);
  const FD = JSON.parse(fontDelta);
  check('密度切换确实缩小了界面字号', FD.small < FD.standard, FD.standard + 'px → ' + FD.small + 'px');

  console.log('\n=== 3. 页边距四边分别可调 ===');
  const mg = await ev(`(function(){
    var r = {};
    ['top','bottom','left','right'].forEach(function(s){
      var el = document.getElementById('q_margin_'+s);
      r[s] = el ? el.value : null;
    });
    r.gbtBtn = !!document.getElementById('btnMarginGbt');
    r.uniBtn = !!document.getElementById('btnMarginUniform');
    r.noOld = document.getElementById('q_margin') === null;
    return JSON.stringify(r);
  })()`);
  const MG = JSON.parse(mg);
  console.log('  ' + mg);
  check('四个页边距输入框都存在', MG.top === '3.7' && MG.bottom === '3.5' && MG.left === '2.8' && MG.right === '2.6', mg);
  check('旧的「统一页边距」单框已移除', MG.noOld === true);
  check('「公文标准」「四边统一」按钮都在', MG.gbtBtn && MG.uniBtn);

  // 改左边距 → 预览跟着变（预览有 90ms 防抖，必须等渲染完再量）
  await ev(`(function(){
    var el = document.getElementById('q_margin_left');
    el.value = '4.2';
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await sleep(900);
  const changeMargin = await ev(
    `getComputedStyle(document.querySelector('#pages .page')).paddingLeft`);
  // 4.2cm ≈ 158.7px
  check('改左边距后预览内边距随之变化（4.2cm≈159px）',
    Math.abs(parseFloat(changeMargin) - 4.2 * 96 / 2.54) < 3, changeMargin);

  // 「四边统一」把上边距套到四边
  const uni = await ev(`(function(){
    document.getElementById('btnMarginUniform').click();
    return JSON.stringify({
      top: document.getElementById('q_margin_top').value,
      bottom: document.getElementById('q_margin_bottom').value,
      left: document.getElementById('q_margin_left').value,
      right: document.getElementById('q_margin_right').value});
  })()`);
  const U = JSON.parse(uni);
  check('四边统一后四值相等', U.top === U.bottom && U.left === U.right && U.top === U.left, uni);

  // 恢复公文标准
  const gbt = await ev(`(function(){
    document.getElementById('btnMarginGbt').click();
    return JSON.stringify({
      top: document.getElementById('q_margin_top').value,
      bottom: document.getElementById('q_margin_bottom').value,
      left: document.getElementById('q_margin_left').value,
      right: document.getElementById('q_margin_right').value});
  })()`);
  check('「公文标准」恢复 3.7/3.5/2.8/2.6', gbt.includes('3.7') && gbt.includes('3.5') && gbt.includes('2.8') && gbt.includes('2.6'), gbt);

  console.log('\n=== 4. 控制台错误 ===');
  check('无未捕获错误', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions.slice(0, 3)));

  console.log('\n' + '='.repeat(56));
  console.log(`布局与密度：PASS=${pass} FAIL=${fail}`);
  cdp.close(); browser.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); try { browser.kill(); } catch (x) {} process.exit(1); });
