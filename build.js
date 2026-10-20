/* 构建：把 src/*.js 合并进 template.html，产出单文件 dist/文本排版工具.html */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const ORDER = ['zip.js', 'defaults.js', 'parser.js', 'docx.js', 'docx-read.js', 'ui.js'];

const tpl = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8');
if (!tpl.includes('/* __BUNDLE__ */')) {
  console.error('模板里找不到 /* __BUNDLE__ */ 占位符');
  process.exit(1);
}

let js = '';
for (const f of ORDER) {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) { console.error('缺少源文件: ' + f); process.exit(1); }
  const code = fs.readFileSync(p, 'utf8');
  js += '\n/* ================= ' + f + ' ================= */\n' + code + '\n';
}

// 安全：XML/HTML 里不能出现 </script>
if (/<\/script/i.test(js)) {
  console.error('警告：源码里出现 </script 字面量，会破坏 HTML。已自动转义。');
  js = js.replace(/<\/script/gi, '<\\/script');
}

const out = tpl.replace('/* __BUNDLE__ */', () => js);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const outFile = path.join(ROOT, 'dist', '文本排版工具.html');
fs.writeFileSync(outFile, out, 'utf8');

const size = Buffer.byteLength(out, 'utf8');
console.log('已生成: ' + outFile);
console.log('大小: ' + (size / 1024).toFixed(1) + ' KB');
console.log('源码: ' + ORDER.join(', '));
