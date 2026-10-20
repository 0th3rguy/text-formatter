/* Headless test: run zip.js + defaults.js + parser.js + docx.js in Node, emit a real .docx */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  CompressionStream: globalThis.CompressionStream,
  DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob,
  setTimeout,
  clearTimeout,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
for (const f of ['zip.js', 'defaults.js', 'parser.js', 'docx.js', 'docx-read.js']) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  vm.runInContext(code, ctx, { filename: f });
}

const D = sandbox.WFPDefaults;
const P = sandbox.WFPParser;
const X = sandbox.WFPDocx;
const Zip = sandbox.WFPZip;

const SAMPLE = fs.readFileSync(path.join(ROOT, 'test', 'sample.txt'), 'utf8');

(async () => {
  const cfg = Object.assign({}, D.DEFAULT_CONFIG);
  const problems = [];

  const blocks = P.parseText(SAMPLE, cfg);
  const s = P.summarizeBlocks(blocks);
  console.log('--- PARSE ---');
  console.log('blocks:', blocks.length);
  console.log('stats:', JSON.stringify(s));
  blocks.slice(0, 14).forEach((b, i) => {
    const t = b.type === 'table'
      ? 'table(' + b.rows.length + 'x' + b.rows[0].length + ')'
      : (b.text || '').slice(0, 30);
    console.log('  [' + i + '] ' + b.type + (b.level ? '(L' + b.level + ')' : '') + ' ' + JSON.stringify(t));
  });

  const types = blocks.map(b => b.type);
  if (!types.includes('title')) problems.push('no title detected');
  if (!types.includes('heading')) problems.push('no heading detected');
  if (!types.includes('table')) problems.push('no table detected');
  const lv = new Set(blocks.filter(b => b.type === 'heading').map(b => b.level));
  [1, 2, 3].forEach(n => { if (!lv.has(n)) problems.push('missing level ' + n + ' heading'); });
  console.log(problems.length ? 'PARSE ISSUES: ' + problems.join('; ') : 'PARSE ASSERT: pass');

  const blob = await X.buildDocx(blocks, cfg);
  const buf = Buffer.from(await blob.arrayBuffer());
  const outDir = path.join(ROOT, 'test', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'sample-default.docx');
  fs.writeFileSync(outFile, buf);
  console.log('--- BUILD ---');
  console.log('file:', outFile, buf.length, 'bytes');
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) problems.push('output is not a ZIP (no PK header)');

  const entries = await Zip.readZip(buf);
  const names = Object.keys(entries);
  const need = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml',
                'word/settings.xml', 'word/fontTable.xml', 'word/_rels/document.xml.rels'];
  need.forEach(n => { if (!entries[n]) problems.push('missing ' + n); });
  console.log('--- ENTRIES (' + names.length + ') ---');
  console.log(names.join('\n'));

  /* 回读需要 DOMParser，Node 无此全局对象 → 在此跳过；
     该环节由 test/e2e-browser.js 在真实浏览器中验证。 */
  if (typeof sandbox.DOMParser === 'function') {
    try {
      const back = await sandbox.WFPDocxRead.readDocx(buf);
      console.log('--- REREAD ---');
      console.log('blocks:', back.blocks.length, 'warnings:', JSON.stringify(back.warnings));
      const t2 = back.blocks.map(b => b.type);
      if (!t2.includes('title')) problems.push('reread: no title');
      if (!t2.includes('table')) problems.push('reread: no table');
      const tb = back.blocks.find(b => b.type === 'title');
      console.log('reread title:', tb && JSON.stringify(tb.text));
    } catch (e) {
      problems.push('reread failed: ' + e.message);
      console.log(e.stack);
    }
  } else {
    console.log('--- REREAD: skipped (no DOMParser in Node; covered by test/e2e-browser.js) ---');
  }

  console.log('---');
  if (problems.length) {
    console.log('PROBLEMS:');
    problems.forEach(p => console.log('  * ' + p));
    process.exitCode = 1;
  } else {
    console.log('ALL CHECKS PASSED');
  }
})();
