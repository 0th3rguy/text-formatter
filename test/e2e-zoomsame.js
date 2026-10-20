/* e2e-zoomsame.js — 缩放一致性回归测试
 *
 * 用户反馈（m03106）：「你这个缩放还是有问题 100%及以上，缩放的话文字不会换行，
 * 整体观感一致性存在，100%以下就不行了 随着缩放文字一直换行」
 *
 * 根因：旧实现用 CSS zoom 缩放。zoom 会改变元素的布局宽度，文字重新折行，
 * 于是每个缩放级别的断行位置都不一样。
 * 修复：统一用 transform:scale()，只做视觉缩放，永不改变排版宽度。
 *
 * 本测试量的是「每段文字的渲染行数」与「块的像素宽度」，
 * 在所有缩放级别下必须完全一致。这是判断缩放是否只影响视觉、不影响排版的硬指标。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BIN = CHROMES.find(p => fs.existsSync(p));
if (!BIN) { console.error('未找到浏览器'); process.exit(1); }

const PORT = 9981 + (process.pid % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const app = path.join(OUT, '_zoom-app.html');
  fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), app);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-zs-'));
  const browser = spawn(BIN, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-dev-shm-usage',
    '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    'file:///' + app.replace(/\\/g, '/'),
  ], { stdio: 'ignore' });

  async function wsUrl() {
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
        if (t) return t.webSocketDebuggerUrl;
      } catch (e) { /* 还没起来 */ }
      await sleep(250);
    }
    throw new Error('CDP 未就绪');
  }

  const url = await wsUrl();
  const sock = new WebSocket(url);
  let id = 0;
  const waiters = new Map();
  const exceptions = [];
  await new Promise(r => sock.addEventListener('open', r));
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails.exception || {}).description ||
        m.params.exceptionDetails.text);
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = ++id; waiters.set(i, r);
    sock.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 120));
    return r.result.value;
  };

  console.log('=== 1. 载入示例长文本 ===');
  await ev(`document.getElementById('btnSample').click();true`);
  await sleep(1200);
  const base = await ev(`(function(){
    var t=document.getElementById('src');
    /* 用示例文本再追加几段，保证足够长、跨多行、有多页 */
    var extra='';
    for(var i=0;i<6;i++){
      extra+='\\n\\n这是用于缩放一致性验证的补充段落，长度足够让它折成好几行，'+
        '以便检查不同缩放级别下断行位置是否完全一致。第'+(i+1)+'段。';
    }
    t.value=t.value+extra;
    t.dispatchEvent(new Event('input',{bubbles:true}));
    return t.value.length})()`);
  await sleep(1400);
  console.log('  文本长度: ' + base + ' 字');

  /* 关键测量：对每个块量出「渲染行数」（用 range 的 client rects 数量）与「布局宽度」。
     行数由文本折行决定，是最直接的断行位置指标。
     宽度必须用 offsetWidth（布局宽），不能用 getBoundingClientRect().width ——
     后者含 transform 的视觉效果，缩放时本来就该变。 */
  const MEASURE = [
    '(function(){',
    '  var host=document.getElementById("pages");',
    '  var els=[].slice.call(host.querySelectorAll(".doc > *"));',
    '  var rows=[], widths=[];',
    '  for(var i=0;i<els.length;i++){',
    '    var el=els[i];',
    '    widths.push(el.offsetWidth);',
    '    var n=0;',
    '    try{',
    '      var r=document.createRange();',
    '      r.selectNodeContents(el);',
    '      /* scale 会等比放大 rect 的 height，但行数不变；用 rects 的数量即可 */',
    '      var rects=r.getClientRects();',
    '      for(var k=0;k<rects.length;k++){ if(rects[k].height>1) n++; }',
    '    }catch(e){ n=-1; }',
    '    rows.push(n);',
    '  }',
    '  return JSON.stringify({rows:rows, widths:widths, pages:host.querySelectorAll(".page").length});',
    '})()',
  ].join('\n');

  const setZoom = async (pct) => {
    await ev(`(function(){
      var p=document.getElementById('zoomPct');
      p.value='${pct}';
      p.dispatchEvent(new Event('change',{bubbles:true}));
      return true})()`);
    await sleep(400);
  };

  console.log('\n=== 2. 逐级缩放，断行必须完全一致 ===');
  const levels = [60, 70, 80, 90, 100, 110, 125, 150, 175, 200];
  let ref = null;
  const report = [];
  for (const lv of levels) {
    await setZoom(lv);
    const m = JSON.parse(await ev(MEASURE));
    report.push({ lv, rows: m.rows.length, widths: m.widths.length, pages: m.pages });
    if (lv === 100) ref = m;
  }
  // 以 100% 为基准（若 100% 不在最后处理，重新取一次）
  await setZoom(100);
  ref = JSON.parse(await ev(MEASURE));

  console.log('  基准(100%): ' + ref.rows.length + ' 块 / ' + ref.pages + ' 页');

  for (const lv of levels) {
    await setZoom(lv);
    const m = JSON.parse(await ev(MEASURE));
    const sameRows = m.rows.length === ref.rows.length &&
      m.rows.every((n, i) => n === ref.rows[i]);
    const sameWidths = m.widths.length === ref.widths.length &&
      m.widths.every((w, i) => w === ref.widths[i]);
    const samePages = m.pages === ref.pages;
    const diffAt = m.rows.findIndex((n, i) => n !== ref.rows[i]);
    check(lv + '% 断行与 100% 完全一致', sameRows,
      sameRows ? '全部 ' + m.rows.length + ' 块行数相同'
        : '第 ' + diffAt + ' 块 ' + ref.rows[diffAt] + ' 行 → ' + m.rows[diffAt] + ' 行');
    check(lv + '% 块宽与 100% 一致', sameWidths,
      sameWidths ? '全部相同' : '第 ' + m.widths.findIndex((w, i) => w !== ref.widths[i]) + ' 块不同');
    check(lv + '% 页数与 100% 一致', samePages, m.pages + ' 页');
  }

  console.log('\n=== 3. 缩放确实是视觉缩放（不改布局） ===');
  const geom = await ev(`(function(){
    var host=document.getElementById('pages');
    var page=host.querySelector('.page');
    var wrap=document.getElementById('pagesWrap');
    /* page 的 offsetWidth 不受 transform 影响，应恒为 A4 宽度 */
    var offW=page.offsetWidth;
    var rectW=page.getBoundingClientRect().width;
    var wrapW=wrap.getBoundingClientRect().width;
    return JSON.stringify({offW:offW, rectW:Math.round(rectW), wrapW:Math.round(wrapW),
      pct:document.getElementById('zoomPct').value,
      transform:host.style.transform})})()`);
  const G = JSON.parse(geom);
  console.log('  ' + geom);
  const k = parseInt(G.pct, 10) / 100;
  check('页面布局宽度恒为 A4（不受缩放影响）', Math.abs(G.offW - 794) < 4, G.offW + 'px');
  check('视觉宽度 = 布局宽度 × 缩放比',
    Math.abs(G.rectW - G.offW * k) < 3, G.rectW + ' ≈ ' + G.offW + '×' + k);
  check('外层容器按视觉尺寸占位',
    Math.abs(G.wrapW - G.offW * k) < 6, G.wrapW + 'px');
  check('使用 transform:scale', /scale\(/.test(G.transform || ''), G.transform);

  console.log('\n=== 4. 缩放不影响导出产物 ===');
  /* doExport 是异步的，点完按钮要等 Blob 真正生成出来再读尺寸。
     先挂好 createObjectURL 的钩子、把结果等到 resolve 再返回。 */
  const exportAt = async (pct) => {
    await setZoom(pct);
    return await ev(`(function(){
      return new Promise(function(resolve){
        var oldCreate=URL.createObjectURL;
        var oldClick=HTMLAnchorElement.prototype.click;
        var done=false;
        URL.createObjectURL=function(b){
          if(!done){ done=true;
            setTimeout(function(){ URL.createObjectURL=oldCreate; resolve(b.size); },0); }
          return oldCreate.call(URL,b);
        };
        HTMLAnchorElement.prototype.click=function(){};
        setTimeout(function(){ HTMLAnchorElement.prototype.click=oldClick; },0);
        document.getElementById('btnRun').click();
        setTimeout(function(){ if(!done){ URL.createObjectURL=oldCreate; resolve(0); } },8000);
      });
    })()`);
  };
  const size60 = await exportAt(60);
  const size150 = await exportAt(150);
  check('60% 与 150% 导出的 .docx 字节数相同（缩放不参与排版）',
    size60 > 4000 && size60 === size150, size60 + ' / ' + size150);

  console.log('\n=== 5. 控制台错误 ===');
  check('无未捕获错误', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 3)));

  console.log('\n' + '='.repeat(56));
  console.log(`缩放一致性：PASS=${pass} FAIL=${fail}`);
  sock.close();
  browser.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('异常:', e.message);
  process.exit(1);
});
