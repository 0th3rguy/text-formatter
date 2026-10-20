/* 真实浏览器端到端测试：用 Chrome/Edge headless + CDP 驱动 dist 单文件 HTML。
   验证：UI 初始化 → 填入文本 → 实时预览 → 点击「一键排版」→ 捕获生成的 .docx → 落盘。
   仅用 Node 内置能力（fetch / WebSocket / fs），无第三方依赖。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER) { console.error('找不到 Chrome/Edge'); process.exit(1); }

// 把 dist 的中文文件名复制成 ASCII 路径，避免 file:// URL 编码问题
const distSrc = path.join(ROOT, 'dist', '文本排版工具.html');
if (!fs.existsSync(distSrc)) { console.error('先运行 build.js：', distSrc); process.exit(1); }
const appPath = path.join(OUT, '_e2e-app.html');
fs.copyFileSync(distSrc, appPath);

const PORT = 9333 + (process.pid % 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-e2e-'));
const fileUrl = 'file:///' + appPath.replace(/\\/g, '/');

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files',
  '--disable-breakpad', '--disable-crash-reporter', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  fileUrl
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('浏览器调试端口未就绪');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    const exceptions = [];
    ws.addEventListener('open', () => resolve({
      exceptions,
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          waiting.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', e => reject(new Error('WebSocket 错误')));
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        exceptions.push((d.exception && d.exception.description) || d.text);
      }
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.rej(new Error(JSON.stringify(msg.error)));
        else w.res(msg.result);
      }
    });
  });
}

const problems = [];
function check(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '  ' + extra : ''));
  if (!cond) problems.push(label + (extra ? ' — ' + extra : ''));
}

(async () => {
  const url = await wsUrl();
  const cdp = await connect(url);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // 重新加载一次，确保从第一行起就能捕获所有未捕获异常
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1400);

  async function evalJs(expr, awaitPromise) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  console.log('=== 1. 页面与 UI 初始化 ===');
  const boot = await evalJs(`JSON.stringify({
    title: document.title,
    modules: ['WFPZip','WFPDefaults','WFPParser','WFPDocx','WFPDocxRead'].filter(k => typeof window[k] === 'object'),
    hasCompression: typeof CompressionStream === 'function',
    hasDomParser: typeof DOMParser === 'function',
    presetOptions: document.querySelectorAll('#presetSel option').length,
    fontRows: document.querySelectorAll('#fontTable select').length,
    cfgControls: document.querySelectorAll('[data-cfg]').length,
    tabs: document.querySelectorAll('.tab').length
  })`);
  const b = JSON.parse(boot);
  console.log('  ' + boot);
  check('5 个模块全部加载', b.modules.length === 5, b.modules.join(','));
  check('浏览器原生 CompressionStream 可用', b.hasCompression);
  check('DOMParser 可用（.docx 回读依赖）', b.hasDomParser);
  check('预设方案下拉已填充', b.presetOptions >= 4, b.presetOptions + ' 项');
  check('字体表已渲染', b.fontRows >= 8, b.fontRows + ' 行');
  check('自定义项控件数量充足', b.cfgControls >= 60, b.cfgControls + ' 个');
  check('三标签页存在', b.tabs === 3, b.tabs + ' 个');

  console.log('\n=== 2. 填入文本 → 实时预览 ===');
  const sample = fs.readFileSync(path.join(ROOT, 'test', 'sample.txt'), 'utf8');
  await evalJs(`(() => {
    const ta = document.getElementById('src');
    ta.value = ${JSON.stringify(sample)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);   // 等 debounce(260ms) + 渲染

  const pv = await evalJs(`JSON.stringify({
    blocksInPreview: document.querySelectorAll('#pages .doc > *').length,
    headings: document.querySelectorAll('#pages .blk-head').length,
    title: document.querySelectorAll('#pages .blk-title').length,
    tables: document.querySelectorAll('#pages table').length,
    tableRows: document.querySelectorAll('#pages table tr').length,
    tableHeaderCells: document.querySelectorAll('#pages table th').length,
    stats: document.getElementById('stStats').textContent,
    emptyTipHidden: getComputedStyle(document.getElementById('emptyTip')).display === 'none'
  })`);
  console.log('  ' + pv);
  const p = JSON.parse(pv);
  check('预览已渲染块', p.blocksInPreview >= 20, p.blocksInPreview + ' 块');
  check('预览识别出主标题', p.title === 1);
  check('预览识别出各级标题', p.headings >= 9, p.headings + ' 个');
  check('预览渲染出表格', p.tables === 1 && p.tableRows === 4, p.tables + ' 表 / ' + p.tableRows + ' 行');
  check('预览表头用 th 渲染', p.tableHeaderCells === 4, p.tableHeaderCells + ' 个 th');
  check('状态栏统计已更新', /标题|正文|表格/.test(p.stats), p.stats);
  check('空提示已隐藏', p.emptyTipHidden);

  console.log('\n=== 3. 一键排版 → 捕获产出的 .docx ===');
  await evalJs(`(() => {
    window.__blob = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) { window.__blob = b; return orig(b); };
    HTMLAnchorElement.prototype.click = function () { window.__clicked = this.download || true; };
    document.getElementById('btnRun').click();
    return true;
  })()`);

  let b64 = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    b64 = await evalJs(`(async () => {
      if (!window.__blob) return null;
      const buf = new Uint8Array(await window.__blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);
    })()`, true);
    if (b64) break;
  }
  check('点击「一键排版」后产出了 docx Blob', !!b64);
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    const outFile = path.join(OUT, 'browser-e2e.docx');
    fs.writeFileSync(outFile, buf);
    console.log('  写出: ' + outFile + '  ' + buf.length + ' 字节');
    check('产出是 ZIP（PK 头）', buf[0] === 0x50 && buf[1] === 0x4B);
    check('产出大小合理（>4KB）', buf.length > 4000, buf.length + ' B');
    const status = await evalJs(`document.getElementById('stText').textContent`);
    console.log('  状态栏: ' + status);
    check('状态栏报告生成成功', /已生成/.test(status), status);
  }

  console.log('\n=== 4. .docx 回读（浏览器内 DOMParser，Node 下不可用）===');
  const reread = await evalJs(`(async () => {
    const buf = new Uint8Array(await window.__blob.arrayBuffer());
    const r = await window.WFPDocxRead.readDocx(buf);
    const s = window.WFPParser.summarizeBlocks(r.blocks);
    const first = r.blocks.find(b => b.type === 'title');
    const tbl = r.blocks.find(b => b.type === 'table');
    return JSON.stringify({
      blocks: r.blocks.length, stats: s, warnings: r.warnings,
      title: first && first.text,
      tableRows: tbl ? tbl.rows.length : 0,
      tableCols: tbl ? tbl.rows[0].length : 0,
      header: (r.blocks.filter(b => b.type === 'heading').map(b => b.level)).join('')
    });
  })()`, true);
  console.log('  ' + reread);
  const rr = JSON.parse(reread);
  check('回读成功且识别主标题', rr.title && rr.title.indexOf('信息化') >= 0, rr.title);
  check('回读识别出各级标题', /1/.test(rr.header) && /2/.test(rr.header) && /3/.test(rr.header) && /4/.test(rr.header), '级别序列 ' + rr.header);
  check('回读还原表格 4x4', rr.tableRows === 4 && rr.tableCols === 4, rr.tableRows + 'x' + rr.tableCols);

  console.log('\n=== 5. 自定义项生效（改配置 → 产出随之变化）===');
  const custom = await evalJs(`(async () => {
    const X = window.WFPDocx, P = window.WFPParser, Zip = window.WFPZip;
    const base = Object.assign({}, window.WFPDefaults.DEFAULT_CONFIG);
    const blocks = P.parseText(${JSON.stringify(sample)}, base);

    const changed = Object.assign({}, base, {
      body_font: '宋体', body_size: 12, margin_top: 2, margin_left: 2,
      auto_numbering: true, number_style: 'cn_dun',
      page_number_position: 'footer_right', page_number_start: 5,
      enable_header: true, header_text: '测试页眉', set_outline: false,
      first_line_indent_chars: 4, line_spacing_rule: 'multiple', line_spacing_value: 1.5
    });
    const offNum = Object.assign({}, base, { auto_numbering: false });
    const blobA = await X.buildDocx(blocks, base);
    const blobB = await X.buildDocx(blocks, changed);
    const blobN = await X.buildDocx(blocks, offNum);
    const fa = await Zip.readZip(await blobA.arrayBuffer());
    const fb = await Zip.readZip(await blobB.arrayBuffer());
    const fn = await Zip.readZip(await blobN.arrayBuffer());
    const da = Zip.fromUtf8(fa['word/document.xml']);
    const db = Zip.fromUtf8(fb['word/document.xml']);
    const dn = Zip.fromUtf8(fn['word/document.xml']);
    return JSON.stringify({
      sizeA: blobA.size, sizeB: blobB.size,
      aHasOutline: da.includes('outlineLvl'),
      bHasOutline: db.includes('outlineLvl'),
      bBodyFont: db.includes('w:eastAsia="宋体"'),
      bIndent4: db.includes('w:firstLineChars="400"'),
      bLine15: db.includes('w:lineRule="auto"'),
      bAutoNumCnDun: db.includes('一、总体要求'),
      bAutoNumParen: db.includes('（一）完善基础设施'),
      baseKeepsOriginal: da.includes('一、总体要求'),
      offKeepsOriginal: dn.includes('一、总体要求'),
      bMargin2cm: db.includes('w:top="1134"'),
      footerB: Zip.fromUtf8(fb['word/footer1.xml']).includes('right'),
      headerB: Zip.fromUtf8(fb['word/header1.xml']).includes('测试页眉')
    });
  })()`, true);
  console.log('  ' + custom);
  const c = JSON.parse(custom);
  check('改字体/字号后 XML 反映新字体', c.bBodyFont);
  check('首行缩进 4 字符生效（firstLineChars=400）', c.bIndent4);
  check('行距改为 1.5 倍生效', c.bLine15);
  check('自动编号：一级生成「一、」', c.bAutoNumCnDun);
  check('自动编号：二级生成「（一）」', c.bAutoNumParen);
  check('关闭自动编号时保留原文序号', c.offKeepsOriginal);
  check('页边距 2cm 生效（1134 twip）', c.bMargin2cm);
  check('页码位置改右生效', c.footerB);
  check('页眉文字写入 header1.xml', c.headerB);
  check('关闭大纲级别后 outlineLvl 消失', c.aHasOutline && !c.bHasOutline);
  check('配置变化确实改变了产出', c.sizeA !== c.sizeB, c.sizeA + ' → ' + c.sizeB);

  console.log('\n=== 6. 控制台错误检查 ===');
  const errs = JSON.stringify(cdp.exceptions);
  check('页面无未捕获错误', cdp.exceptions.length === 0, errs);

  cdp.close();
  browser.kill();

  console.log('\n' + '='.repeat(56));
  if (problems.length) {
    console.log('失败项 (' + problems.length + '):');
    problems.forEach(x => console.log('  * ' + x));
    process.exitCode = 1;
  } else {
    console.log('浏览器端到端：全部通过');
  }
})().catch(async e => {
  console.error('E2E 异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exitCode = 1;
});
