/* gen-docx.js — 用任意 txt 生成 docx，供 verify_docx.py 核对真实 Word 输出
   用法: node test/gen-docx.js <txt路径> <输出docx路径> [空行模式] */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const sandbox = {
  console, TextEncoder, TextDecoder,
  CompressionStream: globalThis.CompressionStream,
  DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob, setTimeout, clearTimeout,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of ['zip.js', 'defaults.js', 'parser.js', 'docx.js', 'docx-read.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
}

const D = sandbox.WFPDefaults;
const P = sandbox.WFPParser;
const X = sandbox.WFPDocx;

const TXT = process.argv[2];
const OUTDOCX = process.argv[3] || path.join(ROOT, 'test', 'out', 'gen-docx.docx');
const BLANK = process.argv[4] || 'heading_gap';

(async () => {
  const text = fs.readFileSync(TXT, 'utf8');
  const cfg = Object.assign({}, D.DEFAULT_CONFIG);
  cfg.blank_line_mode = BLANK;

  const blocks = P.parseText(text, cfg);
  const s = P.summarizeBlocks(blocks);
  console.log('块数: ' + blocks.length);
  console.log('统计: ' + JSON.stringify(s));
  const blanks = blocks.filter(b => b.type === 'blank');
  console.log('空行块: ' + blanks.length);
  blocks.forEach((b, i) => {
    if (b.type !== 'blank') return;
    const prev = blocks[i - 1], next = blocks[i + 1];
    console.log('  空行@' + i + '  前[' + (prev ? prev.type : '-') + '] 后[' + (next ? next.type : '-') + ']');
  });

  const blob = await X.buildDocx(blocks, cfg);
  const buf = Buffer.from(await blob.arrayBuffer());
  fs.mkdirSync(path.dirname(OUTDOCX), { recursive: true });
  fs.writeFileSync(OUTDOCX, buf);
  console.log('写出: ' + OUTDOCX + '  ' + buf.length + ' bytes');
})().catch(e => { console.error(e); process.exit(1); });
