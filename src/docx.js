/* ============================================================
 * docx.js — DOCX 生成器（手写 OOXML + 零依赖 ZIP）
 * 输入：parser.js 的块数组 + 配置
 * 输出：.docx Blob
 * ============================================================ */

const TWIP_PER_CM = 566.9291338582677;   // 1cm = 566.93 twips
const TWIP_PER_PT = 20;
const TWIP_PER_MM = TWIP_PER_CM / 10;
const A4_W = 11906, A4_H = 16838;        // A4 twips

/* 纸张尺寸表（mm）。与 defaults.js 的 PAPER_SIZES 保持一致；
   这里单独留一份是为了 docx.js 不依赖 defaults.js 的加载顺序。 */
const PAPER_MM = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  B5: { w: 176, h: 250 },
  '16K': { w: 184, h: 260 },
  Letter: { w: 216, h: 279 }
};

/** 按配置取纸张宽高（twip）。force_a4 打开时强制 A4。 */
function paperTwip(cfg) {
  if (!cfg || cfg.force_a4 === true) return { w: A4_W, h: A4_H };
  const p = PAPER_MM[cfg.paper_size] || PAPER_MM.A4;
  return { w: Math.round(p.w * TWIP_PER_MM), h: Math.round(p.h * TWIP_PER_MM) };
}

function cm2twip(cm) { return Math.round(Number(cm || 0) * TWIP_PER_CM); }
function pt2twip(pt) { return Math.round(Number(pt || 0) * TWIP_PER_PT); }
function pt2half(pt) { return Math.round(Number(pt || 0) * 2); }

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/* ---------------- 行距 ---------------- */

/**
 * 行距值换算成磅。单位是「倍」时，按字号换算（1 倍 = 1 个字号的行高），
 * 单位是「磅」时直接用。fixed / atLeast 两种规则在 Word 里只吃磅值，
 * 所以用户在界面上选「倍」时，这里负责统一换算。
 */
function lineSpacingPt(cfg) {
  const v = Number(cfg.line_spacing_value);
  if (!isFinite(v) || v <= 0) return 28;
  if ((cfg.line_spacing_unit || 'pt') === 'mult') {
    const size = Number(cfg.body_size) || 16;
    return v * size;
  }
  return v;
}

/**
 * 某一段（title / h1 / h2 …）实际使用的行距规则对象。
 * 该段自己的 *_line_rule 为 'inherit'（或未设）时回退到正文行距配置。
 * @returns {{line_spacing_rule, line_spacing_value, line_spacing_unit, body_size}}
 */
function roleSpacing(cfg, role, roleSize) {
  const base = {
    line_spacing_rule: cfg.line_spacing_rule,
    line_spacing_value: cfg.line_spacing_value,
    line_spacing_unit: cfg.line_spacing_unit || 'pt',
    body_size: cfg.body_size
  };
  if (!role) return base;
  const rule = cfg[role + '_line_rule'];
  if (!rule || rule === 'inherit') return base;
  const val = cfg[role + '_line_value'];
  const unit = cfg[role + '_line_unit'] || 'pt';
  return {
    line_spacing_rule: rule,
    line_spacing_value: val != null ? val : (unit === 'mult' ? 1 : 28),
    line_spacing_unit: unit,
    /* 倍率行距按「本段自己的字号」算，而不是正文字号 —— 一级标题三号、正文三号虽同号，
       但主标题二号时按正文 16pt 算就明显偏小 */
    body_size: roleSize || cfg.body_size
  };
}

/** 缩进值换算成 twip。unit = chars / cm / pt */
function indentToTwip(value, unit, sizePt) {
  const v = Number(value);
  if (!isFinite(v) || v === 0) return 0;
  if (unit === 'chars') return pt2twip(v * (Number(sizePt) || 16));
  if (unit === 'pt') return pt2twip(v);
  return cm2twip(v);
}

/**
 * 返回 <w:spacing .../> 属性串（不含尖括号）
 */
function lineSpacingAttrs(cfg) {
  const rule = cfg.line_spacing_rule || 'single';
  let lineAttr = '', lineRule = '';
  switch (rule) {
    case 'single':   lineAttr = 240; lineRule = 'auto'; break;
    case 'onehalf':  lineAttr = 360; lineRule = 'auto'; break;
    case 'double':   lineAttr = 480; lineRule = 'auto'; break;
    case 'multiple': lineAttr = Math.round((Number(cfg.line_spacing_value) || 1) * 240); lineRule = 'auto'; break;
    case 'fixed':    lineAttr = pt2twip(lineSpacingPt(cfg)); lineRule = 'exact'; break;
    case 'atLeast':  lineAttr = pt2twip(lineSpacingPt(cfg)); lineRule = 'atLeast'; break;
    default:         lineAttr = 240; lineRule = 'auto';
  }
  return `w:line="${lineAttr}" w:lineRule="${lineRule}"`;
}

/** 表格内行距（简化为倍率） */
function tableLineSpacingAttrs(cfg) {
  const v = String(cfg.table_line_spacing || 'single');
  let line = 240;
  if (v === '1.5') line = 360;
  else if (v === '2.0') line = 480;
  else if (/^[\d.]+$/.test(v)) line = Math.round(parseFloat(v) * 240) || 240;
  return `w:line="${line}" w:lineRule="auto"`;
}

/* ---------------- 字体 / 字号 ---------------- */

/**
 * 生成 <w:rPr> 内容（不含外标签）。
 */
function makeRPr(opts) {
  const o = opts || {};
  const cjk = o.font || '宋体';
  const en = (o.useEnglish && o.englishFont) ? o.englishFont : cjk;
  let s = '';
  s += `<w:rFonts w:ascii="${xmlEsc(en)}" w:hAnsi="${xmlEsc(en)}" w:eastAsia="${xmlEsc(cjk)}" w:cs="${xmlEsc(en)}"/>`;
  if (o.bold) s += '<w:b/><w:bCs/>';
  if (o.italic) s += '<w:i/><w:iCs/>';
  if (o.underline) s += '<w:u w:val="single"/>';
  if (o.color) s += `<w:color w:val="${xmlEsc(o.color)}"/>`;
  if (o.size) s += `<w:sz w:val="${pt2half(o.size)}"/><w:szCs w:val="${pt2half(o.size)}"/>`;
  if (o.spacingChars) s += `<w:spacing w:val="${Math.round(o.spacingChars * 20)}"/>`;
  return s;
}

function rPrXml(opts) {
  const inner = makeRPr(opts);
  return inner ? `<w:rPr>${inner}</w:rPr>` : '';
}

/** 文本 → run 序列（自动把连续 ASCII 段落交给英文字体）。此处简化为整体一个 run。 */
function makeRuns(text, rprOpts) {
  if (text === '' || text == null) return '';
  const rpr = rPrXml(rprOpts);
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}

/* ---------------- 段落 ---------------- */

/**
 * 生成段落 XML。
 * @param {object} p
 *   text, style(可选), align, spacing(rule,value), before, after,
 *   indentChars, indentLeft, indentRight, outlineLevel, pageBreakBefore,
 *   keepNext, font, size, bold, color, useEnglish, englishFont, tabs
 *   indentLeftTwip / indentRightTwip：已换算好的 twip（优先于 indentLeft/indentRight）
 */
function makeParagraph(p) {
  const o = p || {};
  const pPrParts = [];
  if (o.style) pPrParts.push(`<w:pStyle w:val="${xmlEsc(o.style)}"/>`);
  if (o.pageBreakBefore) pPrParts.push('<w:pageBreakBefore/>');
  if (o.keepNext) pPrParts.push('<w:keepNext/>');
  if (o.keepLines) pPrParts.push('<w:keepLines/>');

  const spacingAttrs = [];
  if (o.spacing) spacingAttrs.push(lineSpacingAttrs(o.spacing));
  if (o.before != null) spacingAttrs.push(`w:before="${pt2twip(o.before)}"`);
  if (o.after != null) spacingAttrs.push(`w:after="${pt2twip(o.after)}"`);
  if (spacingAttrs.length) pPrParts.push(`<w:spacing ${spacingAttrs.join(' ')}/>`);

  const leftTwip = (o.indentLeftTwip != null) ? o.indentLeftTwip : (o.indentLeft ? cm2twip(o.indentLeft) : 0);
  const rightTwip = (o.indentRightTwip != null) ? o.indentRightTwip : (o.indentRight ? cm2twip(o.indentRight) : 0);
  if (o.indentChars || leftTwip || rightTwip || o.indentHanging) {
    const ind = [];
    if (leftTwip) ind.push(`w:left="${leftTwip}"`);
    if (rightTwip) ind.push(`w:right="${rightTwip}"`);
    if (o.indentChars) ind.push(`w:firstLineChars="${Math.round(o.indentChars * 100)}" w:firstLine="${pt2twip(o.indentChars * (o.size || 12))}"`);
    if (o.indentHanging) ind.push(`w:hangingChars="${Math.round(o.indentHanging * 100)}" w:hanging="${pt2twip(o.indentHanging * (o.size || 12))}"`);
    pPrParts.push(`<w:ind ${ind.join(' ')}/>`);
  }

  if (o.align) pPrParts.push(`<w:jc w:val="${o.align}"/>`);
  if (o.outlineLevel != null && o.outlineLevel >= 0) {
    pPrParts.push(`<w:outlineLvl w:val="${Math.min(8, o.outlineLevel)}"/>`);
  }
  if (o.numId) {
    pPrParts.push(`<w:numPr><w:ilvl w:val="${o.ilvl || 0}"/><w:numId w:val="${o.numId}"/></w:numPr>`);
  }
  if (o.tabs && o.tabs.length) {
    pPrParts.push('<w:tabs>' + o.tabs.map(t => `<w:tab w:val="${t.val}" w:pos="${t.pos}"/>`).join('') + '</w:tabs>');
  }
  if (o.border) {
    pPrParts.push(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>`);
  }
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : '';

  const body = o.runs != null ? o.runs : makeRuns(o.text, o);
  return `<w:p>${pPr}${body}</w:p>`;
}

function makeEmptyParagraph(opts) {
  const o = opts || {};
  return makeParagraph({ text: '', size: o.size, spacing: o.spacing });
}

/* ---------------- 表格 ---------------- */

function makeTable(rows, cfg, pageContentWidth) {
  if (!rows || !rows.length) return '';
  const cols = Math.max.apply(null, rows.map(r => r.length));
  if (cols === 0) return '';

  const borderSz = Math.max(2, Math.round((Number(cfg.table_border_size_pt) || 0.5) * 8));
  const colW = Math.floor(pageContentWidth / cols);

  let s = '';
  s += '<w:tbl>';
  s += '<w:tblPr>';
  s += `<w:tblW w:w="${cfg.table_width_percent || 100}" w:type="pct"/>`;
  s += `<w:jc w:val="center"/>`;
  if (cfg.table_unified_borders !== false) {
    const b = `<w:top w:val="single" w:sz="${borderSz}" w:space="0" w:color="000000"/>` +
              `<w:left w:val="single" w:sz="${borderSz}" w:space="0" w:color="000000"/>` +
              `<w:bottom w:val="single" w:sz="${borderSz}" w:space="0" w:color="000000"/>` +
              `<w:right w:val="single" w:sz="${borderSz}" w:space="0" w:color="000000"/>` +
              `<w:insideH w:val="single" w:sz="${borderSz}" w:space="0" w:color="000000"/>` +
              `<w:insideV w:val="single" w:sz="${borderSz}" w:space="0" w:color="000000"/>`;
    s += `<w:tblBorders>${b}</w:tblBorders>`;
  }
  s += '<w:tblLayout w:type="fixed"/>';
  s += '<w:tblCellMar>' +
       '<w:top w:w="28" w:type="dxa"/><w:left w:w="85" w:type="dxa"/>' +
       '<w:bottom w:w="28" w:type="dxa"/><w:right w:w="85" w:type="dxa"/>' +
       '</w:tblCellMar>';
  s += '</w:tblPr>';

  s += '<w:tblGrid>' + Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join('') + '</w:tblGrid>';

  const rowH = cm2twip(cfg.table_row_height_cm || 0);

  rows.forEach((row, ri) => {
    const isHeader = ri === 0 && cfg.table_header_bold !== false;
    s += '<w:tr>';
    if (rowH > 0) s += `<w:trPr><w:trHeight w:val="${rowH}" w:hRule="atLeast"/>${isHeader ? '<w:tblHeader/>' : ''}</w:trPr>`;
    else if (isHeader) s += '<w:trPr><w:tblHeader/></w:trPr>';

    for (let ci = 0; ci < cols; ci++) {
      const cell = row[ci] == null ? '' : String(row[ci]);
      const numeric = /^[\s\d.,%¥$€+\-]+$/.test(cell) && /\d/.test(cell);
      let align = 'left';
      if (cfg.table_smart_align !== false && numeric) align = 'center';
      else if (ci === 0 && row.length > 2) align = 'center';

      const font = isHeader ? (cfg.table_header_font || cfg.table_font) : (cfg.table_font || '仿宋_GB2312');
      const size = isHeader ? (cfg.table_header_size || cfg.table_size) : (cfg.table_size || 12);

      s += '<w:tc>';
      s += `<w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>` +
           `<w:vAlign w:val="center"/>` +
           `</w:tcPr>`;
      s += makeParagraph({
        text: cell,
        align: cfg.table_smart_align !== false ? (isHeader ? 'center' : align) : 'left',
        font, size,
        bold: isHeader && cfg.table_header_bold !== false,
        useEnglish: cfg.use_custom_english_font,
        englishFont: cfg.english_font,
        before: 1, after: 1,
        spacing: tableSpacingFor(cfg)
      });
      s += '</w:tc>';
    }
    s += '</w:tr>';
  });

  s += '</w:tbl>';
  // 表格后空段，避免表格粘连
  s += makeParagraph({ text: '', size: cfg.table_size });
  return s;
}

/** 表格行距对象（复用 lineSpacingAttrs 的接口） */
function tableSpacingFor(cfg) {
  const v = String(cfg.table_line_spacing || 'single');
  if (v === 'single') return { line_spacing_rule: 'single' };
  if (v === '1.5') return { line_spacing_rule: 'onehalf' };
  if (v === '2.0') return { line_spacing_rule: 'double' };
  const n = parseFloat(v);
  if (!isNaN(n)) return { line_spacing_rule: 'multiple', line_spacing_value: n };
  return { line_spacing_rule: 'single' };
}

/* ---------------- 自动编号 ---------------- */

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function toChineseNumber(n) {
  if (n <= 0) return '零';
  if (n < 10) return CN_DIGITS[n];
  if (n === 10) return '十';
  if (n < 20) return '十' + CN_DIGITS[n % 10];
  if (n < 100) {
    const t = Math.floor(n / 10), r = n % 10;
    return CN_DIGITS[t] + '十' + (r ? CN_DIGITS[r] : '');
  }
  return String(n);
}

function toRoman(n, upper) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
               [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  let v = n;
  for (const [val, sym] of map) { while (v >= val) { s += sym; v -= val; } }
  return upper ? s.toUpperCase() : s;
}

const NUMBER_STYLE_TPL = {
  cn_dun:       ['cnDun', 'cnParen', 'arabicDot', 'cnCircle'],
  cn_paren:     ['cnParen', 'cnCircle', 'arabicDot', 'arabicParen'],
  cn_circle:    ['cnCircle', 'arabicDot', 'arabicParen', 'arabicParen'],
  arabic_dot:   ['arabicDot', 'arabicParen', 'arabicParen', 'arabicParen'],
  arabic_dun:   ['arabicDun', 'arabicParen', 'arabicParen', 'arabicParen'],
  arabic_multi: ['multi1', 'multi2', 'multi3', 'multi4'],
  chapter:      ['chapter', 'cnDun', 'cnParen', 'cnCircle']
};

function formatNumber(kind, counters, level) {
  const c = counters;
  switch (kind) {
    case 'cnDun':        return toChineseNumber(c[0]) + '、';
    case 'cnParen':      return '（' + toChineseNumber(c[level] || c[0]) + '）';
    case 'cnCircle':     return '（' + (c[level] || c[0]) + '）';
    case 'arabicDot':    return (c[level] || c[0]) + '.';
    case 'arabicDun':    return (c[level] || c[0]) + '、';
    case 'arabicParen':  return (c[level] || c[0]) + ')';
    case 'multi1':       return c[0] + '.';
    case 'multi2':       return c[0] + '.' + c[1];
    case 'multi3':       return c[0] + '.' + c[1] + '.' + c[2];
    case 'multi4':       return c[0] + '.' + c[1] + '.' + c[2] + '.' + c[3];
    case 'chapter':      return '第' + toChineseNumber(c[0]) + '章';
    default:             return '';
  }
}

/** 编号状态机 */
function createNumberer(cfg) {
  const style = cfg.number_style || 'cn_dun';
  const tpl = NUMBER_STYLE_TPL[style] || NUMBER_STYLE_TPL.cn_dun;
  const counters = [0, 0, 0, 0];
  return {
    next(level) {
      const idx = Math.max(0, Math.min(3, level - 1));
      counters[idx]++;
      for (let k = idx + 1; k < 4; k++) counters[k] = 0;
      const kind = tpl[idx];
      return { label: formatNumber(kind, counters, idx), ilvl: idx };
    },
    reset() { counters[0] = counters[1] = counters[2] = counters[3] = 0; }
  };
}

/* ---------------- 角色 → 样式解析 ---------------- */

/** 取某角色的字体/字号/加粗等 */
function roleStyle(cfg, role) {
  const fontKey = role + '_font';
  const sizeKey = role + '_size';
  const font = cfg[fontKey] || cfg.body_font;
  const size = cfg[sizeKey] || cfg.body_size;
  // 加粗：显式配置优先；未配置时沿用内置规则（三级、四级标题加粗）
  const explicit = cfg[role + '_bold'];
  const builtinBold = role === 'h3' || role === 'h4' || role === 'table_caption' || role === 'figure_caption';
  const bold = explicit != null ? explicit === true : builtinBold;
  return {
    font, size, bold,
    useEnglish: cfg.use_custom_english_font !== false,
    englishFont: cfg.english_font
  };
}

/* ---------------- 文档装配 ---------------- */

/**
 * @param {Array} blocks parser 输出
 * @param {object} cfg
 * @returns {{documentXml:string, headerXml:string|null, footerXml:string|null,
 *            evenHeaderXml:string|null, evenFooterXml:string|null, sectPrExtras:string}}
 */
function buildDocumentBody(blocks, cfg) {
  const pageW = paperTwip(cfg).w;
  const contentW = pageW - cm2twip(cfg.margin_left) - cm2twip(cfg.margin_right);

  const numberer = cfg.auto_numbering ? createNumberer(cfg) : null;
  const parts = [];

  const bodySpacing = {
    line_spacing_rule: cfg.line_spacing_rule,
    line_spacing_value: cfg.line_spacing_value,
    line_spacing_unit: cfg.line_spacing_unit || 'pt',
    body_size: cfg.body_size
  };

  for (const b of blocks) {
    switch (b.type) {
      case 'blank': {
        // 空行 → 一个空段落（可能是多个）
        const n = Math.max(1, Math.min(6, b.count || 1));
        for (let k = 0; k < n; k++) {
          parts.push(makeParagraph({ text: '', size: cfg.body_size, spacing: bodySpacing }));
        }
        break;
      }

      case 'title': {
        const st = roleStyle(cfg, 'title');
        parts.push(makeParagraph(Object.assign({}, st, {
          text: b.text,
          align: cfg.title_align || 'center',
          /* 主标题行距：*_line_rule 为 inherit 时，沿用原来的「倍率」语义（title_line_spacing） */
          spacing: (cfg.title_line_rule && cfg.title_line_rule !== 'inherit')
            ? roleSpacing(cfg, 'title', st.size)
            : { line_spacing_rule: 'multiple', line_spacing_value: cfg.title_line_spacing || 1 },
          before: cfg.title_space_before, after: cfg.title_space_after,
          outlineLevel: cfg.set_outline ? 0 : null
        })));
        break;
      }

      case 'subtitle': {
        const st = roleStyle(cfg, 'subtitle');
        parts.push(makeParagraph(Object.assign({}, st, {
          text: b.text,
          align: 'center',
          spacing: (cfg.subtitle_line_rule && cfg.subtitle_line_rule !== 'inherit')
            ? roleSpacing(cfg, 'subtitle', st.size)
            : { line_spacing_rule: 'multiple', line_spacing_value: cfg.subtitle_line_spacing || 1 },
          before: cfg.title_space_before, after: cfg.title_space_after
        })));
        break;
      }

      case 'heading': {
        const lv = Math.max(1, Math.min(4, b.level || 1));
        const st = roleStyle(cfg, 'h' + lv);
        let text = b.text;
        if (numberer) {
          const num = numberer.next(lv);
          // 去掉原有手写序号后加自动编号（编号写进正文文本，保证任何阅读器都显示一致）
          const stripped = stripLeadingNumber(text);
          text = num.label + stripped;
        }
        const isH1 = lv === 1;
        /* 各级标题的缩进字符数各自独立可配（cfg.h1_indent_chars … h4_indent_chars），
           0 = 顶格。左/右缩进沿用正文的「值 + 单位」。 */
        const headIndent = Number(cfg['h' + lv + '_indent_chars']) || 0;
        parts.push(makeParagraph(Object.assign({}, st, {
          text,
          bold: cfg['h' + lv + '_bold'] != null ? cfg['h' + lv + '_bold'] : (st.bold || false),
          align: lv === 1 ? (cfg.h1_align || 'left') : 'left',
          /* 各级标题行距可独立设置：*_line_rule = inherit 时跟随正文 */
          spacing: roleSpacing(cfg, 'h' + lv, st.size),
          before: cfg.heading_space_before, after: cfg.heading_space_after,
          indentChars: headIndent,
          indentLeftTwip: indentToTwip(cfg.left_indent_value != null ? cfg.left_indent_value : cfg.left_indent_cm,
                                       cfg.left_indent_unit || 'cm', st.size),
          indentRightTwip: indentToTwip(cfg.right_indent_value != null ? cfg.right_indent_value : cfg.right_indent_cm,
                                        cfg.right_indent_unit || 'cm', st.size),
          outlineLevel: cfg.set_outline ? lv - 1 : null,
          pageBreakBefore: cfg.add_page_break_before_h1 && isH1,
          keepNext: true
        })));
        break;
      }

      case 'salutation': {
        /* 主送机关：公文称呼行，顶格、不缩进、左对齐 */
        const st = roleStyle(cfg, 'salutation');
        parts.push(makeParagraph(Object.assign({}, st, {
          text: b.text, align: 'left',
          spacing: roleSpacing(cfg, 'salutation', st.size),
          indentChars: 0, outlineLevel: null
        })));
        break;
      }

      case 'attachment': {
        const st = roleStyle(cfg, 'attachment');
        parts.push(makeParagraph(Object.assign({}, st, {
          text: b.text, align: 'left', spacing: bodySpacing,
          before: cfg.heading_space_before, after: cfg.heading_space_after,
          outlineLevel: null, keepNext: true
        })));
        break;
      }

      case 'table_caption':
      case 'figure_caption': {
        const role = b.type === 'table_caption' ? 'table_caption' : 'figure_caption';
        const st = roleStyle(cfg, role);
        parts.push(makeParagraph(Object.assign({}, st, {
          text: b.text, align: 'center', spacing: bodySpacing,
          before: cfg.heading_space_before, after: cfg.heading_space_after,
          keepNext: b.type === 'table_caption'
        })));
        break;
      }

      case 'table':
      case 'image': {
        if (b.type === 'image') {
          parts.push({ __image: b });
          break;
        }
        if (cfg.enable_table_formatting === false) {
          for (const row of b.rows) {
            parts.push(makeParagraph(Object.assign({}, roleStyle(cfg, 'body'), {
              text: row.join('\t'), spacing: bodySpacing,
              indentChars: cfg.first_line_indent_chars
            })));
          }
        } else {
          parts.push(makeTable(b.rows, cfg, contentW));
        }
        break;
      }

      case 'body':
      default: {
        const st = roleStyle(cfg, 'body');
        const indent = (cfg.first_line_indent_chars != null) ? cfg.first_line_indent_chars
                     : (cfg.body_indent_chars != null ? cfg.body_indent_chars : 2);
        parts.push(makeParagraph(Object.assign({}, st, {
          text: b.text,
          align: cfg.body_align || 'both',
          spacing: bodySpacing,
          before: cfg.body_space_before, after: cfg.body_space_after,
          indentChars: indent,
          indentLeftTwip: indentToTwip(cfg.left_indent_value != null ? cfg.left_indent_value : cfg.left_indent_cm,
                                       cfg.left_indent_unit || 'cm', st.size),
          indentRightTwip: indentToTwip(cfg.right_indent_value != null ? cfg.right_indent_value : cfg.right_indent_cm,
                                        cfg.right_indent_unit || 'cm', st.size)
        })));
        break;
      }
    }
  }

  // 后处理：图片占位 → 实际 XML，并登记关系
  const images = [];
  const bodyParts = [];
  let ridSeq = 100;
  for (const p of parts) {
    if (p && p.__image) {
      const img = p.__image;
      const rid = ridSeq++;
      /* 只取文件名：img.name 可能是 "media/image1.png"（回读时带目录），
         若原样拼进 "media/" 前缀会得到 media/media/image1.png 这种重复路径。 */
      const baseName = String(img.name || ('image' + rid + '.png')).split('/').pop().split('\\').pop();
      images.push({ rid, name: baseName, data: img.data, mime: img.mime });
      bodyParts.push(makeImageParagraph(img, rid, contentW * 635));
    } else {
      bodyParts.push(p);
    }
  }

  return { body: bodyParts.join(''), contentW, images, maxRid: ridSeq - 1 };
}

/** 去掉行首已有编号："一、xxx" → "xxx" */
function stripLeadingNumber(text) {
  const patterns = [
    /^\s*[一二三四五六七八九十百]+\s*[、.．]\s*/,
    /^\s*[（(]\s*[一二三四五六七八九十百\d]+\s*[）)]\s*/,
    /^\s*\d{1,2}(?:[.．]\d{1,2}){1,3}\s*[.．、]?\s*/,
    /^\s*\d{1,2}\s*[、.．]\s*/,
    /^\s*第\s*[一二三四五六七八九十百\d]+\s*[章节部分篇]\s*/
  ];
  let s = text;
  for (const p of patterns) { s = s.replace(p, ''); }
  return s;
}

/* ---------------- 页眉 / 页脚 ---------------- */

function buildFooter(cfg, position, pageFmt) {
  const align = position === 'footer_right' || position === 'header_right' ? 'right'
              : position === 'footer_outer' ? 'right' : 'center';

  const prefix = cfg.page_number_prefix || '';
  const suffix = cfg.page_number_suffix || '';
  const fldFmt = pageFmt === 'chinese' ? 'chineseCounting'
               : pageFmt === 'roman' ? 'upperRoman' : 'decimal';

  // PAGE 域
  const fieldRuns =
    `<w:r>${rPrXml({ font: cfg.page_number_font, size: cfg.page_number_size, useEnglish: cfg.use_custom_english_font, englishFont: cfg.english_font })}` +
    `<w:t xml:space="preserve">${xmlEsc(prefix)}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t>1</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:r><w:t xml:space="preserve">${xmlEsc(suffix)}</w:t></w:r>`;

  const p = `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>${fieldRuns}</w:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${p}</w:ftr>`;
}

function buildEvenFooter(cfg, pageFmt) {
  const prefix = cfg.page_number_prefix || '';
  const suffix = cfg.page_number_suffix || '';
  const fieldRuns =
    `<w:r>${rPrXml({ font: cfg.page_number_font, size: cfg.page_number_size })}<w:t xml:space="preserve">${xmlEsc(prefix)}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t>2</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:r><w:t xml:space="preserve">${xmlEsc(suffix)}</w:t></w:r>`;
  const p = `<w:p><w:pPr><w:jc w:val="left"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>${fieldRuns}</w:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${p}</w:ftr>`;
}

function buildHeader(cfg, even) {
  const align = cfg.header_align || 'center';
  const boxW = paperTwip(cfg).w - cm2twip(cfg.margin_left) - cm2twip(cfg.margin_right);
  let p;
  if (cfg.enable_header && cfg.header_text) {
    const lines = String(cfg.header_text).split('\n');
    p = lines.map(line => makeParagraph({
      text: line,
      align,
      font: cfg.header_font || '宋体',
      size: cfg.header_size || 14,
      useEnglish: cfg.use_custom_english_font,
      englishFont: cfg.english_font,
      spacing: { line_spacing_rule: 'single' },
      border: cfg.header_underline === true
    })).join('');
  } else {
    // 空页眉，保证 headerReference 有效
    p = `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr></w:p>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${p}</w:hdr>`;
}

/* ---------------- 静态部件 ---------------- */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const CONTENT_TYPES = XML_DECL +
`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const RELS_ROOT = XML_DECL +
`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS_BASE = (extra) => XML_DECL +
`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>
<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>
${extra || ''}
</Relationships>`;

function buildStyles(cfg) {
  const defFont = cfg.body_font || '宋体';
  const defSize = pt2half(cfg.body_size || 12);
  const enFont = cfg.use_custom_english_font !== false ? (cfg.english_font || defFont) : defFont;
  return XML_DECL +
`<w:styles ${NS_W}>
<w:docDefaults>
<w:rPrDefault><w:rPr>
<w:rFonts w:ascii="${xmlEsc(enFont)}" w:hAnsi="${xmlEsc(enFont)}" w:eastAsia="${xmlEsc(defFont)}" w:cs="${xmlEsc(enFont)}"/>
<w:sz w:val="${defSize}"/><w:szCs w:val="${defSize}"/>
<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal">
<w:name w:val="Normal"/><w:qFormat/>
<w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${xmlEsc(enFont)}" w:hAnsi="${xmlEsc(enFont)}" w:eastAsia="${xmlEsc(defFont)}"/><w:sz w:val="${defSize}"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="TableNormal">
<w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>
<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
</w:style>
</w:styles>`;
}

function buildSettings(cfg) {
  const evenOdd = cfg.page_number_position === 'footer_outer' || cfg.header_even_odd === true;
  return XML_DECL +
`<w:settings ${NS_W}>
<w:zoom w:percent="100"/>
<w:defaultTabStop w:val="420"/>
${evenOdd ? '<w:evenAndOddHeaders/>' : ''}
<w:characterSpacingControl w:val="compressPunctuation"/>
<w:compat>
<w:useFELayout/>
<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
</w:compat>
</w:settings>`;
}

function buildFontTable(cfg) {
  const fonts = new Set();
  for (const k of Object.keys(cfg)) {
    if (/_font$/.test(k) && typeof cfg[k] === 'string' && cfg[k]) fonts.add(cfg[k]);
  }
  fonts.add('宋体'); fonts.add('Times New Roman');
  const items = Array.from(fonts).map((f, i) =>
    `<w:font w:name="${xmlEsc(f)}"><w:charset w:val="86"/><w:family w:val="auto"/><w:pitch w:val="variable"/></w:font>`
  ).join('');
  return XML_DECL + `<w:fonts ${NS_W}>${items}</w:fonts>`;
}

function buildCore(cfg) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = cfg.document_title || '排版文档';
  return XML_DECL +
`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEsc(title)}</dc:title>
<dc:creator>${xmlEsc(cfg.document_author || '')}</dc:creator>
<cp:lastModifiedBy>${xmlEsc(cfg.document_author || '')}</cp:lastModifiedBy>
<dc:subject>${xmlEsc(cfg.document_subject || '')}</dc:subject>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function buildApp() {
  return XML_DECL +
`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Text Formatter</Application>
<DocSecurity>0</DocSecurity>
<ScaleCrop>false</ScaleCrop>
<Company></Company>
<AppVersion>1.0000</AppVersion>
</Properties>`;
}

/* ---------------- 图片 ---------------- */

const EMU_PER_CM = 360000;
const EMU_PER_PX = 9525;

/** 图片扩展名 → MIME */
const MIME_BY_FILE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
  emf: 'image/x-emf', wmf: 'image/x-wmf', svg: 'image/svg+xml'
};

/**
 * 生成内嵌图片段落。
 * @param {{name:string, w?:number, h?:number, alt?:string}} img
 * @param {number} ridNum
 * @param {number} maxWidthEmu 可用内容宽度（EMU）
 */
function makeImageParagraph(img, ridNum, maxWidthEmu) {
  let cx = img.w || 0, cy = img.h || 0;
  if (!cx || !cy) { cx = 400 * EMU_PER_PX; cy = 300 * EMU_PER_PX; }

  const pageMax = maxWidthEmu || (A4_W - cm2twip(2.8) - cm2twip(2.6)) * 635; // twip→EMU 近似
  if (cx > pageMax) {
    const ratio = pageMax / cx;
    cx = Math.round(cx * ratio);
    cy = Math.round(cy * ratio);
  }

  const docPrId = 1000 + ridNum;
  const name = xmlEsc(img.alt || img.name || ('图片' + ridNum));

  const drawing =
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${docPrId}" name="${name}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rId${ridNum}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

  return drawing;
}

/* ---------------- 主入口 ---------------- */

/**
 * 由块数组生成 .docx Blob
 * @param {Array} blocks
 * @param {object} cfg
 */
async function buildDocx(blocks, cfg) {
  const Zip = window.WFPZip;
  if (!Zip) throw new Error('ZIP 模块未加载');

  const { body, contentW, images } = buildDocumentBody(blocks, cfg);
  const paper = paperTwip(cfg);

  const showPageNumber = (cfg.page_number_format || 'arabic') !== 'none';
  const fmt = cfg.page_number_format || 'arabic';
  const pos = cfg.page_number_position || 'footer_center';
  const useEvenOdd = pos === 'footer_outer';
  const inHeader = pos.indexOf('header_') === 0;

  const pgNumFmtAttr = fmt === 'chinese' ? 'chineseCounting' : fmt === 'roman' ? 'upperRoman' : 'decimal';
  const start = Math.max(1, parseInt(cfg.page_number_start, 10) || 1);

  let sectExtras = '';
  if (showPageNumber) {
    sectExtras += `<w:pgNumType w:fmt="${pgNumFmtAttr}" w:start="${start}"/>`;
  }
  sectExtras += `<w:headerReference w:type="default" r:id="rId4"/>`;
  if (useEvenOdd) sectExtras += `<w:headerReference w:type="even" r:id="rId6"/>`;
  sectExtras += `<w:footerReference w:type="default" r:id="rId5"/>`;
  if (useEvenOdd) sectExtras += `<w:footerReference w:type="even" r:id="rId7"/>`;

  const sectPr =
    `<w:sectPr>` +
    sectExtras +
    `<w:pgSz w:w="${paper.w}" w:h="${paper.h}"/>` +
    `<w:pgMar w:top="${cm2twip(cfg.margin_top)}" w:right="${cm2twip(cfg.margin_right)}" ` +
    `w:bottom="${cm2twip(cfg.margin_bottom)}" w:left="${cm2twip(cfg.margin_left)}" ` +
    `w:header="${cm2twip(cfg.header_distance || 1.5)}" w:footer="${cm2twip(cfg.footer_distance)}" w:gutter="${cm2twip(cfg.gutter || 0)}"/>` +
    `<w:cols w:space="425"/>` +
    `<w:docGrid w:type="lines" w:linePitch="312"/>` +
    `</w:sectPr>`;

  const documentXml = XML_DECL +
    `<w:document ${NS_W} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body}${sectPr}</w:body></w:document>`;

  let headerXml = buildHeader(cfg, false);
  let footerXml = XML_DECL + `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:ftr>`;
  if (showPageNumber && !inHeader) {
    footerXml = buildFooter(cfg, pos, fmt);
  }

  // 页码放页眉时：把 PAGE 域加到页眉
  if (showPageNumber && inHeader) {
    headerXml = buildHeaderWithPageNumber(cfg, pos, fmt);
  }

  const evenFooterXml = useEvenOdd ? buildEvenFooter(cfg, fmt) : footerXml;
  const evenHeaderXml = headerXml;

  // —— 图片关系与媒体部件 ——
  const relExtra = [];
  const mediaFiles = [];
  const extSeen = {};
  (images || []).forEach((im) => {
    const ext = (im.name.split('.').pop() || 'png').toLowerCase();
    extSeen[ext] = MIME_BY_FILE[ext] || 'image/png';
    relExtra.push(`<Relationship Id="rId${im.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${im.name}"/>`);
    mediaFiles.push({ name: 'word/media/' + im.name, data: im.data });
  });

  // 内容类型：为用到的图片扩展名补充 Default
  let contentTypes = CONTENT_TYPES;
  const extraDefaults = Object.keys(extSeen)
    .filter(ext => !/Extension="(rels|xml)"/.test(contentTypes.split('<Default')[1] || '') || !contentTypes.includes(`Extension="${ext}"`))
    .filter(ext => !contentTypes.includes(`Extension="${ext}"`))
    .map(ext => `<Default Extension="${ext}" ContentType="${extSeen[ext]}"/>`)
    .join('');
  if (extraDefaults) {
    contentTypes = contentTypes.replace('</Types>', extraDefaults + '</Types>');
  }

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: RELS_ROOT },
    { name: 'docProps/core.xml', data: buildCore(cfg) },
    { name: 'docProps/app.xml', data: buildApp() },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS_BASE(relExtra.join('')) },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: buildStyles(cfg) },
    { name: 'word/settings.xml', data: buildSettings(cfg) },
    { name: 'word/fontTable.xml', data: buildFontTable(cfg) },
    { name: 'word/header1.xml', data: headerXml },
    { name: 'word/header2.xml', data: evenHeaderXml },
    { name: 'word/footer1.xml', data: footerXml },
    { name: 'word/footer2.xml', data: evenFooterXml }
  ].concat(mediaFiles);

  return await Zip.makeZip(files, { compress: true });
}

function buildHeaderWithPageNumber(cfg, pos, fmt) {
  const align = pos === 'header_right' ? 'right' : 'center';
  const prefix = cfg.page_number_prefix || '';
  const suffix = cfg.page_number_suffix || '';
  const parts = [];
  if (cfg.enable_header && cfg.header_text) {
    for (const line of String(cfg.header_text).split('\n')) {
      parts.push(makeParagraph({
        text: line, align, font: cfg.header_font || '宋体', size: cfg.header_size || 14,
        useEnglish: cfg.use_custom_english_font, englishFont: cfg.english_font,
        spacing: { line_spacing_rule: 'single' }
      }));
    }
  }
  parts.push(
    `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>` +
    `<w:r>${rPrXml({ font: cfg.page_number_font, size: cfg.page_number_size })}<w:t xml:space="preserve">${xmlEsc(prefix)}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t>1</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:r><w:t xml:space="preserve">${xmlEsc(suffix)}</w:t></w:r>` +
    `</w:p>`
  );
  return XML_DECL + `<w:hdr ${NS_W}>${parts.join('')}</w:hdr>`;
}

if (typeof window !== 'undefined') {
  window.WFPDocx = {
    buildDocx, buildDocumentBody, makeParagraph, makeTable, makeRuns, rPrXml,
    toChineseNumber, toRoman, createNumberer, stripLeadingNumber,
    cm2twip, pt2twip, xmlEsc
  };
}
