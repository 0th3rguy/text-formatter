/* ============================================================
 * docx-read.js — 读取已有 .docx，抽取文本/表格/图片 → 块数组
 * 用于「重新排版已有文档」。
 * 依赖：zip.js。解析用 DOMParser（无外部依赖）。
 * ============================================================ */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML 解析失败：' + err.textContent.slice(0, 200));
  return doc;
}

function wEl(node, name) {
  return node.getElementsByTagNameNS(W_NS, name);
}

/** 取段落文本（含 tab / br 处理） */
function getParagraphText(p) {
  let s = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        const ln = child.localName;
        if (child.namespaceURI === W_NS) {
          if (ln === 't') s += child.textContent;
          else if (ln === 'tab') s += '\t';
          else if (ln === 'br') s += '\n';
          else if (ln === 'cr') s += '\n';
          else if (ln === 'drawing' || ln === 'pict' || ln === 'object') { /* 图片单独处理 */ }
          else if (ln === 'fldSimple') { s += child.textContent; }
          else if (ln === 'instrText') { /* 域代码忽略 */ }
          else walk(child);
        }
      }
    }
  };
  walk(p);
  return s.replace(/\u0007/g, '');
}

/** 段落样式 → 角色推断 */
function inferRole(p) {
  const pPr = Array.from(p.childNodes).find(n => n.nodeType === 1 && n.localName === 'pPr');
  if (!pPr) return null;
  const style = Array.from(pPr.childNodes).find(n => n.nodeType === 1 && n.localName === 'pStyle');
  const styleId = style ? (style.getAttributeNS(W_NS, 'val') || style.getAttribute('w:val')) : null;

  const outline = Array.from(pPr.childNodes).find(n => n.nodeType === 1 && n.localName === 'outlineLvl');
  const lvlRaw = outline ? (outline.getAttributeNS(W_NS, 'val') || outline.getAttribute('w:val')) : null;
  const lvl = lvlRaw != null ? parseInt(lvlRaw, 10) : null;

  const jcEl = Array.from(pPr.childNodes).find(n => n.nodeType === 1 && n.localName === 'jc');
  const jc = jcEl ? (jcEl.getAttributeNS(W_NS, 'val') || jcEl.getAttribute('w:val')) : null;

  if (styleId) {
    const s = styleId.toLowerCase();
    if (/^(heading|标题)\s*([1-9])/.test(s) || /^h[1-9]$/.test(s)) {
      const m = s.match(/([1-9])/);
      const lv = m ? parseInt(m[1], 10) : 1;
      return { role: 'h' + Math.min(4, lv), align: jc };
    }
    if (/^(title|标题)$/.test(s) || s === 'title') return { role: 'title', align: jc };
    if (/^(subtitle|副标题)$/.test(s)) return { role: 'subtitle', align: jc };
  }
  if (lvl != null && !isNaN(lvl) && lvl >= 0 && lvl <= 3) {
    return { role: 'h' + (lvl + 1), align: jc };
  }
  return { role: null, align: jc };
}

/** 取段落在文档流中的图片 */
function extractImages(p, relMap) {
  const out = [];
  const drawings = p.getElementsByTagNameNS(W_NS, 'drawing');
  for (const d of drawings) {
    const blips = d.getElementsByTagNameNS(A_NS, 'blip');
    for (const b of blips) {
      const embed = b.getAttributeNS(R_NS, 'embed') || b.getAttribute('r:embed');
      if (!embed || !relMap[embed]) continue;
      let w = 0, h = 0;
      const exts = d.getElementsByTagNameNS(WP_NS, 'extent');
      if (exts.length) {
        w = parseInt(exts[0].getAttribute('cx'), 10) || 0;
        h = parseInt(exts[0].getAttribute('cy'), 10) || 0;
      }
      out.push({ type: 'image', rid: embed, target: relMap[embed], w, h });
    }
  }
  // 旧式 VML 图片
  const picts = p.getElementsByTagNameNS(W_NS, 'pict');
  for (const pic of picts) {
    const imgs = pic.getElementsByTagNameNS('urn:schemas-microsoft-com:vml', 'imagedata');
    for (const im of imgs) {
      const embed = im.getAttributeNS(R_NS, 'id') || im.getAttribute('r:id');
      if (!embed || !relMap[embed]) continue;
      out.push({ type: 'image', rid: embed, target: relMap[embed], w: 0, h: 0 });
    }
  }
  return out;
}

/** 解析表格 → 二维数组 */
function extractTable(tbl) {
  const rows = [];
  const trs = Array.from(tbl.childNodes).filter(n => n.nodeType === 1 && n.localName === 'tr');
  for (const tr of trs) {
    const cells = [];
    const tcs = Array.from(tr.childNodes).filter(n => n.nodeType === 1 && n.localName === 'tc');
    for (const tc of tcs) {
      const ps = Array.from(tc.childNodes).filter(n => n.nodeType === 1 && n.localName === 'p');
      const txt = ps.map(getParagraphText).join(' ').trim();
      const span = tc.getElementsByTagNameNS(W_NS, 'gridSpan');
      const n = span.length ? (parseInt(span[0].getAttributeNS(W_NS, 'val') || span[0].getAttribute('w:val'), 10) || 1) : 1;
      cells.push(txt);
      for (let k = 1; k < n; k++) cells.push('');
    }
    rows.push(cells);
  }
  return rows;
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
  emf: 'image/x-emf', wmf: 'image/x-wmf', svg: 'image/svg+xml'
};

/**
 * 读取 .docx → { blocks, images, styles, warnings }
 * @param {ArrayBuffer|Uint8Array} buf
 */
async function readDocx(buf) {
  const Zip = window.WFPZip;
  const files = await Zip.readZip(buf);
  const warnings = [];

  const docFile = files['word/document.xml'];
  if (!docFile) throw new Error('不是有效的 .docx：缺少 word/document.xml');

  const docXml = Zip.fromUtf8(docFile);
  const doc = parseXml(docXml);

  // 关系映射
  const relMap = {};
  if (files['word/_rels/document.xml.rels']) {
    const rels = parseXml(Zip.fromUtf8(files['word/_rels/document.xml.rels']));
    const rs = rels.getElementsByTagName('Relationship');
    for (const r of rs) {
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      const mode = r.getAttribute('TargetMode');
      if (id && target && mode !== 'External') {
        relMap[id] = target.replace(/^\.\//, '').replace(/^\/word\//, '');
      }
    }
  }

  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new Error('文档缺少 body');

  const blocks = [];
  const images = {};       // name → Uint8Array
  let imageIndex = 0;
  let titleSeen = false;   // 是否已确定主标题（用于把居中首段认成标题而非一级标题）
  let salutationSeen = false;  // 主送机关只允许出现一次，且紧邻主标题
  let sinceTitle = 0;      // 主标题之后已跨过的内容段落数

  const handleParagraph = (p) => {
    const text = getParagraphText(p).trim();
    const imgs = extractImages(p, relMap);
    const info = inferRole(p);

    if (imgs.length) {
      for (const im of imgs) {
        const src = files['word/' + im.target] || files[im.target];
        if (!src) continue;
        const ext = (im.target.split('.').pop() || 'png').toLowerCase();
        const name = `media/image${++imageIndex}.${ext}`;
        images[name] = src;
        blocks.push({
          type: 'image', name,
          mime: MIME_BY_EXT[ext] || 'application/octet-stream',
          w: im.w, h: im.h,
          text
        });
      }
      if (!text) return;
    }

    if (!text) { blocks.push({ type: 'blank', count: 1 }); return; }

    // 主标题判定：文档第一个有内容的段落，若居中且是 Heading1/outline 0，认成主标题
    const centered = info && info.align === 'center';
    if (!titleSeen) {
      if ((info && info.role === 'title') ||
          (centered && (info.role === 'h1' || info.role === null))) {
        blocks.push({ type: 'title', text, align: 'center' });
        titleSeen = true;
        return;
      }
      titleSeen = true;   // 首段不是居中标题，之后不再把居中段当标题
    }
    if (info && info.role === 'title') blocks.push({ type: 'title', text });
    else if (info && info.role === 'subtitle') { blocks.push({ type: 'subtitle', text }); sinceTitle++; }
    else if (info && /^h[1-4]$/.test(info.role)) {
      blocks.push({ type: 'heading', level: parseInt(info.role[1], 10), text, kind: 'style' });
      sinceTitle++;
    } else {
      /* 主送机关：紧跟主标题（允许一个副标题）之后的「xxx：」行，顶格、无句末标点。
         回读时必须还原，否则「各部门、各直属单位：」会被当成正文并缩进两格。 */
      if (titleSeen && !salutationSeen && sinceTitle <= 1 &&
          text.length <= 60 && /[：:]$/.test(text) && !/[。！？!?；;]/.test(text) &&
          window.WFPParser.hasCJK(text)) {
        blocks.push({ type: 'salutation', text });
        salutationSeen = true;
        sinceTitle++;
        return;
      }
      // 用文本特征判断（复用 parser 的识别，含段内拆分）
      const P = window.WFPParser;
      const r = P.resolveHeading(text, { split_inline_heading: true });
      if (r) {
        if (r.type === 'heading') {
          blocks.push({ type: 'heading', level: r.level, text: r.text, kind: r.kind });
          if (r.bodyText) blocks.push({ type: 'body', text: r.bodyText });
        } else {
          blocks.push({ type: r.type, text: r.text });
        }
      } else {
        blocks.push({ type: 'body', text });
      }
      sinceTitle++;
    }
  };

  // 按文档顺序遍历 body 直接子元素
  const walkBody = (parent) => {
    for (const node of parent.childNodes) {
      if (node.nodeType !== 1 || node.namespaceURI !== W_NS) continue;
      const ln = node.localName;
      if (ln === 'p') handleParagraph(node);
      else if (ln === 'tbl') {
        const rows = extractTable(node);
        if (rows.length) blocks.push({ type: 'table', rows });
      } else if (ln === 'sdt') {
        const content = node.getElementsByTagNameNS(W_NS, 'sdtContent')[0];
        if (content) walkBody(content);
      } else if (ln === 'sectPr') {
        // 忽略
      }
    }
  };
  walkBody(body);

  // 合并连续空行
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (b.type === 'blank' && last && last.type === 'blank') last.count += b.count;
    else merged.push(b);
  }

  if (Object.keys(images).length) {
    warnings.push(`已保留 ${Object.keys(images).length} 张图片`);
  }

  return { blocks: merged, images, warnings };
}

/** 读取 .txt / .md / .rtf / .html 文本型文件 */
function readPlainText(buf) {
  const Zip = window.WFPZip;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  // BOM 检测
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: Zip.fromUtf8(bytes.subarray(3)), encoding: 'UTF-8' };
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE' };
  }
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16BE' };
  }

  // 尝试 UTF-8 严格解码，失败则回退 GBK
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    return { text: dec.decode(bytes), encoding: 'UTF-8' };
  } catch (e) {
    try {
      return { text: new TextDecoder('gbk').decode(bytes), encoding: 'GBK' };
    } catch (e2) {
      return { text: Zip.fromUtf8(bytes), encoding: 'UTF-8(容错)' };
    }
  }
}

/* ---------------- 旧格式检测 ---------------- */

/**
 * 识别文件真实类型（因为扩展名常不可靠）
 * @returns {{kind:string, note:string, canParse:boolean}}
 */
function detectFormat(bytes, filename) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ext = (filename || '').split('.').pop().toLowerCase();
  const head4 = b.length >= 4 ? (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0 : 0;

  // ZIP / OOXML
  if (b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    return { kind: 'docx', note: 'OOXML 包（.docx/.docm）', canParse: true };
  }
  // OLE2 复合文档
  if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) {
    return {
      kind: 'ole',
      note: '二进制 .doc/.wps（OLE2 复合文档）',
      canParse: false,
      hint: '这是 Word 97-2003 二进制格式，浏览器无法直接解析。请在 Word/WPS 中「另存为 → .docx」后再拖入。'
    };
  }
  // RTF
  if (b[0] === 0x7B && b[1] === 0x5C && b[2] === 0x72 && b[3] === 0x74) {
    return { kind: 'rtf', note: 'RTF 格式', canParse: true };
  }
  // HTML
  const txt = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 2048)).trim().toLowerCase();
  if (txt.startsWith('<!doctype html') || txt.startsWith('<html') || txt.includes('<body')) {
    return { kind: 'html', note: 'HTML 格式', canParse: true };
  }
  if (/^%pdf/.test(new TextDecoder('latin1').decode(b.subarray(0, 4)))) {
    return { kind: 'pdf', note: 'PDF 文件', canParse: false,
             hint: 'PDF 不是文字处理格式，浏览器无法还原其段落结构。请先用 Word/WPS 转为 .docx 或直接复制文本粘贴。' };
  }
  if (ext === 'docx') return { kind: 'docx', note: '按扩展名判定为 .docx', canParse: true };
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return { kind: 'text', note: '纯文本', canParse: true };
  return { kind: 'text', note: '按纯文本处理', canParse: true };
}

/** RTF → 纯文本（轻量解析） */
function rtfToText(rtf) {
  let s = String(rtf);
  // 去掉不可见组
  s = s.replace(/\{\\\*[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
  // 十六进制转义 \'xx
  const bytes = [];
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (m, h) => {
    const code = parseInt(h, 16);
    if (code >= 0x80) { bytes.push(code); return '\u0000' + (bytes.length - 1) + '\u0000'; }
    return String.fromCharCode(code);
  });
  s = s.replace(/\\u(-?\d+)\s?\??/g, (m, d) => String.fromCharCode(parseInt(d, 10) < 0 ? parseInt(d, 10) + 65536 : parseInt(d, 10)));
  s = s.replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t');
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, '');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\\[^a-zA-Z]/g, (m) => m[1] || '');
  // 还原 GBK 字节
  if (bytes.length) {
    let out = '';
    let i = 0;
    const parts = s.split('\u0000');
    for (let k = 0; k < parts.length; k++) {
      out += parts[k];
      if (k < bytes.length) out += String.fromCharCode(bytes[k]);
    }
    s = out;
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML → 纯文本（保留段落与表格结构） */
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script,style,head,meta,link').forEach(n => n.remove());

  const lines = [];
  const blockTags = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','LI','TR','BR','SECTION','ARTICLE','BLOCKQUOTE','PRE','TD','TH']);

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = child.textContent.replace(/\s+/g, ' ');
        if (t.trim()) lines.push(t);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;

      if (tag === 'TABLE') {
        const rows = [];
        child.querySelectorAll('tr').forEach(tr => {
          const cells = [];
          tr.querySelectorAll('th,td').forEach(td => cells.push(td.textContent.replace(/\s+/g, ' ').trim()));
          if (cells.length) rows.push(cells.join('\t'));
        });
        if (rows.length) lines.push('', rows.join('\n'), '');
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        child.querySelectorAll('li').forEach((li, i) => {
          lines.push((tag === 'OL' ? (i + 1) + '. ' : '') + li.textContent.replace(/\s+/g, ' ').trim());
        });
        lines.push('');
        continue;
      }
      if (/^H[1-6]$/.test(tag)) {
        lines.push('', child.textContent.replace(/\s+/g, ' ').trim(), '');
        continue;
      }
      if (tag === 'BR') { lines.push(''); continue; }
      if (blockTags.has(tag)) {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        lines.push(t, '');
        continue;
      }
      walk(child);
    }
  };
  walk(doc.body || doc.documentElement);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

if (typeof window !== 'undefined') {
  window.WFPDocxRead = {
    readDocx, readPlainText, detectFormat, rtfToText, htmlToText,
    getParagraphText, extractTable, inferRole, MIME_BY_EXT
  };
}
