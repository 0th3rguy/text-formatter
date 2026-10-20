/* 预览分页 + 缩放控件端到端测试。
   验证三件事：
   1. 长文档预览产生多页（之前只有一个 .page 且 overflow:hidden，内容被裁掉）；
   2. 每页高度 ≈ A4，内容不溢出页面可用高度；
   3. 缩放：加减按钮、直接输入百分比、适应宽度、滑块，均生效。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER) { console.error('未找到 Chrome/Edge'); process.exit(1); }

const appPath = path.join(OUT, '_e2e-pages.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);

// 造一篇足够长的测试文本：40 个段落 + 若干标题
function makeLongText() {
  const lines = ['关于加强信息化建设工作的通知', '各部门、各直属单位：', ''];
  for (let i = 1; i <= 6; i++) {
    lines.push('（' + '一二三四五六'[i - 1] + '）第' + i + '部分工作安排', '');
    for (let j = 1; j <= 6; j++) {
      lines.push('这是第 ' + i + ' 部分第 ' + j + ' 段正文内容，用于验证长文档的预览分页是否正常工作。' +
        '本段文字需要足够长，以便占据多行、产生可观的垂直高度，从而触发生成分页。' +
        '排版工具应当把它正确地排入 A4 纸张，一页排满后自动换到下一页继续排。', '');
    }
  }
  return lines.join('\n');
}

const PORT = 9943;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-pages-'));
const args = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files',
  '--disable-breakpad', '--disable-crash-reporter',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'file:///' + appPath.replace(/\\/g, '/')
];
const browser = spawn(BROWSER, args, { stdio: 'ignore' });
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
  throw new Error('调试端口未就绪');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map();
    const exceptions = [];
    ws.addEventListener('open', () => resolve({
      exceptions,
      send(method, params) {
        return new Promise(res => {
          const mid = ++id; waiting.set(mid, res);
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => reject(new Error('WebSocket 错误')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        exceptions.push((d.exception && d.exception.description) || d.text);
      }
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) w({ __error: m.error }); else w(m.result);
      }
    });
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

(async () => {
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1600);

  const ev = async (expr, awaitPromise) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
    return r.result.value;
  };

  // 设置窗口尺寸，让「适应宽度」有确定的可用宽度
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  console.log('=== 1. 长文档 → 多页预览 ===');
  const longText = makeLongText();
  await ev(`(function(){var t=document.getElementById('src');
    t.value=${JSON.stringify(longText)};
    t.dispatchEvent(new Event('input',{bubbles:true}));return true})();`);
  await sleep(1400);

  const info = await ev(`(function(){
    var pages=[].slice.call(document.querySelectorAll('.pages > .page'));
    var cs=pages.length?getComputedStyle(pages[0]):null;
    var avail=cs?(pages[0].offsetHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0)):0;
    return JSON.stringify({
      pageCount: pages.length,
      firstPageH: pages.length?pages[0].offsetHeight:0,
      availH: avail,
      blockTotal: document.querySelectorAll('.pages .doc > *').length,
      blocksPerPage: pages.map(function(p){return p.querySelectorAll('.doc > *').length}),
      overflowing: pages.filter(function(p){
        var d=p.querySelector('.doc');
        var c=getComputedStyle(p);
        var a=p.offsetHeight-(parseFloat(c.paddingTop)||0)-(parseFloat(c.paddingBottom)||0);
        return d.scrollHeight > a+2;
      }).length,
      badges: pages.map(function(p){var b=p.querySelector('.pnum');return b?b.textContent:''})
    })})();`);
  const I = JSON.parse(info);
  console.log('  ' + info);

  check('长文档生成了多页', I.pageCount >= 2, I.pageCount + ' 页');
  check('所有段落块都被放进页面', I.blockTotal > 40, I.blockTotal + ' 块');
  check('每页都分配到了内容', I.blocksPerPage.every(n => n > 0), I.blocksPerPage.join(','));
  check('没有内容溢出页面', I.overflowing === 0, '溢出页数 ' + I.overflowing);
  check('每页高度接近 A4', Math.abs(I.firstPageH - 1122) < 40, I.firstPageH + 'px');
  check('页码角标显示 当前/总数', /^1 \/ \d+$/.test(I.badges[0]), I.badges[0]);

  console.log('\n=== 2. 缩放控件 ===');
  const z0 = await ev(`(function(){
    var z=document.getElementById('zoomPct').value;
    var s=document.querySelector('.pages').style;
    return JSON.stringify({pct:z, zoom:s.zoom, transform:s.transform})})();`);
  console.log('  初始: ' + z0);

  // 加号（单击 1% —— 用户要求精确 1% 步进）
  await ev(`document.getElementById('zoomIn').click();true`);
  await sleep(200);
  const zIn = await ev(`document.getElementById('zoomPct').value`);
  check('＋ 按钮放大 1%', parseInt(zIn, 10) === 81, '80 → ' + zIn);

  // 减号（两次 = −2%）
  await ev(`document.getElementById('zoomOut').click();document.getElementById('zoomOut').click();true`);
  await sleep(200);
  const zOut = await ev(`document.getElementById('zoomPct').value`);
  check('－ 按钮缩小 1%/次', parseInt(zOut, 10) === parseInt(zIn, 10) - 2, zIn + ' → ' + zOut);

  // Shift+单击 = 10%
  const zShift = await ev(`(function(){
    var b=document.getElementById('zoomIn');
    b.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));
    return document.getElementById('zoomPct').value})()`);
  await sleep(200);
  check('Shift+单击放大 10%', parseInt(zShift, 10) === parseInt(zOut, 10) + 10, zOut + ' → ' + zShift);

  // 直接输入精确值
  const setPct = await ev(`(function(){
    var p=document.getElementById('zoomPct');
    p.value='135';
    p.dispatchEvent(new Event('change',{bubbles:true}));
    var s=document.querySelector('.pages').style;
    return JSON.stringify({pct:document.getElementById('zoomPct').value, transform:s.transform, slider:document.getElementById('zoom').value})})();`);
  const SP = JSON.parse(setPct);
  check('直接输入 135% 精确生效', SP.pct === '135' && /scale\(1\.35\)/.test(SP.transform || ''), setPct);
  check('滑块跟随输入同步', SP.slider === '135', 'slider=' + SP.slider);

  // 滑块拖动
  const sliderSync = await ev(`(function(){
    var s=document.getElementById('zoom');
    s.value='60';
    s.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify({pct:document.getElementById('zoomPct').value, transform:document.querySelector('.pages').style.transform})})();`);
  const SS = JSON.parse(sliderSync);
  check('拖滑块同步数字框', SS.pct === '60', sliderSync);

  // 适应宽度
  const fit = await ev(`(function(){
    document.getElementById('zoomFit').click();
    var s=document.querySelector('.pages').style;
    return JSON.stringify({pct:document.getElementById('zoomPct').value, transform:s.transform,
      viewW:document.getElementById('view').clientWidth,
      pageW:document.querySelector('.pages .page').offsetWidth})})();`);
  const F = JSON.parse(fit);
  console.log('  适应宽度: ' + fit);
  check('适应宽度算出合理百分比', parseInt(F.pct, 10) > 100 && parseInt(F.pct, 10) < 200, F.pct + '%');
  check('缩放用 transform 而非 zoom', /scale\(/.test(F.transform || ''), F.transform);

  // Ctrl +/- 快捷键
  await ev(`(function(){
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'0',ctrlKey:true,bubbles:true}));
    return true})();`);
  await sleep(200);
  const k0 = await ev(`document.getElementById('zoomPct').value`);
  check('Ctrl+0 回到 100%', k0 === '100', k0 + '%');

  // 刷新按钮已移除
  const noRefresh = await ev(`document.getElementById('btnRefresh')===null`);
  check('「刷新」按钮已移除（预览本就实时）', noRefresh === true);

  console.log('\n=== 3. 缩放后分页仍然正确 ===');
  await ev(`(function(){
    var p=document.getElementById('zoomPct'); p.value='100';
    p.dispatchEvent(new Event('change',{bubbles:true})); return true})();`);
  await sleep(500);
  const afterZoom = await ev(`(function(){
    var pages=[].slice.call(document.querySelectorAll('.pages > .page'));
    return JSON.stringify({pageCount:pages.length,
      overflowing:pages.filter(function(p){
        var d=p.querySelector('.doc'), c=getComputedStyle(p);
        var a=p.offsetHeight-(parseFloat(c.paddingTop)||0)-(parseFloat(c.paddingBottom)||0);
        return d.scrollHeight > a+2;}).length})})();`);
  const AZ = JSON.parse(afterZoom);
  check('缩放变化后页数稳定', AZ.pageCount === I.pageCount, AZ.pageCount + ' 页');
  check('缩放变化后仍不溢出', AZ.overflowing === 0);

  console.log('\n=== 4. 短文档只占一页 ===');
  await ev(`(function(){var t=document.getElementById('src');
    t.value='通知\\n\\n各部门：\\n\\n这是很短的一段正文。';
    t.dispatchEvent(new Event('input',{bubbles:true}));return true})();`);
  await sleep(900);
  const shortN = await ev(`document.querySelectorAll('.pages > .page').length`);
  check('短文档只生成 1 页', shortN === 1, shortN + ' 页');

  console.log('\n=== 5. 控制台错误 ===');
  check('无未捕获错误', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions.slice(0, 3)));

  console.log('\n' + '='.repeat(56));
  console.log(`预览分页 + 缩放：PASS=${pass} FAIL=${fail}`);
  cdp.close(); browser.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exit(1);
});
