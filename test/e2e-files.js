/* 浏览器端到端测试（第 2 部分）：文件上传 / 重新排版 / 旧格式检测 / 界面截图。
   与 e2e-browser.js 共用同一套 CDP 驱动方式。 */
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

const appPath = path.join(OUT, '_e2e-files.html');
fs.copyFileSync(path.join(ROOT, 'dist', '文本排版工具.html'), appPath);
const PORT = 9811;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-files-'));
const fileUrl = 'file:///' + appPath.replace(/\\/g, '/');

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files',
  '--disable-breakpad', '--disable-crash-reporter',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, fileUrl
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('调试端口未就绪');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map(); const exceptions = [];
    ws.addEventListener('open', () => resolve({
      exceptions,
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id; waiting.set(mid, { res, rej });
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
        if (m.error) w.rej(new Error(JSON.stringify(m.error))); else w.res(m.result);
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
  const cdp = await connect(await wsUrl());
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  async function evalJs(expr, awaitPromise) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description)
        || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  // 通过 CDP 给 <input type=file> 塞真实文件
  async function setFile(files) {
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
    await evalJs(`document.getElementById('file').dispatchEvent(new Event('change', { bubbles: true })); true`);
  }

  /* 先用工具产出一个真实 .docx 作为“已有文档” */
  const madeDocx = path.join(OUT, 'sample-default.docx');
  check('已有测试用 .docx', fs.existsSync(madeDocx), madeDocx);

  console.log('=== 7. 上传已有 .docx → 重新排版 ===');
  await setFile([madeDocx]);
  await sleep(1800);
  const after = await evalJs(`JSON.stringify({
    srcFilled: document.getElementById('src').value.length,
    fileInfo: document.getElementById('fileInfo').textContent.trim(),
    previewTitle: (document.querySelector('#pages .blk-title') || {}).textContent,
    previewTables: document.querySelectorAll('#pages table').length,
    stats: document.getElementById('stStats').textContent,
    status: document.getElementById('stText').textContent
  })`);
  console.log('  ' + after);
  const a = JSON.parse(after);
  check('.docx 被读入并回填到文本框', a.srcFilled > 200, a.srcFilled + ' 字符');
  check('文件信息已提示', /docx|Word|样品|sample/i.test(a.fileInfo), a.fileInfo);
  check('预览还原主标题', !!a.previewTitle && a.previewTitle.indexOf('信息化') >= 0, a.previewTitle);
  check('预览还原表格', a.previewTables >= 1, a.previewTables + ' 个');
  check('状态栏统计正确', /一~四级\s*3\/3\/2\/2/.test(a.stats), a.stats);

  console.log('\n=== 8. 旧格式 .doc / .wps → 应给出明确指引而非静默失败 ===');
  const fakeDoc = path.join(OUT, '_fake.doc');
  const ole = Buffer.alloc(2048);
  Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).copy(ole, 0);  // OLE2 头
  fs.writeFileSync(fakeDoc, ole);
  await setFile([fakeDoc]);
  await sleep(1500);
  const docRes = await evalJs(`JSON.stringify({
    modalOpen: document.getElementById('mask').classList.contains('on'),
    modalTitle: document.getElementById('modalTitle').textContent,
    modalBody: document.getElementById('modalBody').textContent.slice(0, 300),
    fileInfo: document.getElementById('fileInfo').textContent.trim(),
    srcLen: document.getElementById('src').value.length
  })`);
  console.log('  ' + docRes);
  const dr = JSON.parse(docRes);
  check('.doc 被识别为旧格式并给出提示', /doc|旧格式|另存|wps/i.test(dr.fileInfo + dr.modalTitle + dr.modalBody),
    (dr.fileInfo || dr.modalTitle).slice(0, 80));

  console.log('\n=== 9. 纯文本 .txt 上传 ===');
  await setFile([path.join(ROOT, 'test', 'sample.txt')]);
  await sleep(1500);
  const txtRes = await evalJs(`JSON.stringify({
    srcLen: document.getElementById('src').value.length,
    stats: document.getElementById('stStats').textContent,
    status: document.getElementById('stText').textContent
  })`);
  console.log('  ' + txtRes);
  const tr = JSON.parse(txtRes);
  check('.txt 读入成功', tr.srcLen > 200, tr.srcLen + ' 字符');
  check('.txt 解析出结构', /一~四级/.test(tr.stats), tr.stats);

  console.log('\n=== 10. 界面截图 ===');
  await evalJs(`(() => {
    document.querySelector('.tab[data-tab="input"]').click();
    return true;
  })()`);
  await sleep(800);
  let shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'ui-input.png'), Buffer.from(shot.data, 'base64'));
  console.log('  已保存 ui-input.png');

  await evalJs(`document.querySelector('.tab[data-tab="adv"]').click(); true`);
  await sleep(600);
  shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-adv.png'), Buffer.from(shot.data, 'base64'));
  console.log('  已保存 ui-adv.png');

  await evalJs(`document.querySelector('.tab[data-tab="preset"]').click(); true`);
  await sleep(600);
  shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-preset.png'), Buffer.from(shot.data, 'base64'));
  console.log('  已保存 ui-preset.png');

  console.log('\n=== 11. 使用说明 / 关于弹窗 ===');
  await evalJs(`document.getElementById('btnHelp').click(); true`);
  await sleep(500);
  const help = await evalJs(`JSON.stringify({
    open: document.getElementById('mask').classList.contains('on'),
    title: document.getElementById('modalTitle').textContent,
    len: document.getElementById('modalBody').textContent.length
  })`);
  console.log('  ' + help);
  const h = JSON.parse(help);
  check('使用说明弹窗可打开且有内容', h.open && h.len > 300, h.title + ' / ' + h.len + ' 字');

  await evalJs(`document.getElementById('btnManageScheme').click(); true`);
  await sleep(500);
  const sch = await evalJs(`JSON.stringify({
    open: document.getElementById('mask').classList.contains('on'),
    title: document.getElementById('modalTitle').textContent,
    hasImport: !!document.getElementById('btnImportScheme')
  })`);
  console.log('  ' + sch);
  const s = JSON.parse(sch);
  check('方案管理弹窗可用', s.open && s.hasImport, s.title);

  console.log('\n=== 12. 控制台错误 ===');
  check('无未捕获错误', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions));

  cdp.close(); browser.kill();
  console.log('\n' + '='.repeat(56));
  if (problems.length) {
    console.log('失败项 (' + problems.length + '):');
    problems.forEach(x => console.log('  * ' + x));
    process.exitCode = 1;
  } else console.log('文件/界面测试：全部通过');
})().catch(e => {
  console.error('异常:', e.message);
  try { browser.kill(); } catch (x) {}
  process.exitCode = 1;
});
