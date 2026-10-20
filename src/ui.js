/* ============================================================
 * ui.js — 界面逻辑：输入 → 解析 → 预览 → 导出
 * ============================================================ */

(function () {
  const D = window.WFPDefaults;
  const P = window.WFPParser;
  const X = window.WFPDocx;
  const R = window.WFPDocxRead;
  const Zip = window.WFPZip;

  const SCHEME_KEY = 'textformatter.schemes.v1';
  const LAST_KEY = 'textformatter.last.v1';
  /* 配置版本：默认值有实质改动时 +1，靠它把老用户存下来的旧默认值迁到新默认值。
     2 = 空行默认改为 delete_single；各级标题默认与正文一样缩进 2 字符。 */
  const CFG_VERSION = 2;

  /** 当前配置 */
  let cfg = Object.assign({}, D.DEFAULT_CONFIG);
  let currentPreset = '党政机关公文格式';
  /* 「当前用的是哪一套」：规范（内置预设）和方案（自己存的）本质是同一层 ——
     两者都只是「一批配置值的起点」，套用后写的都是同一个 cfg，不存在谁覆盖谁。
     记下来源与套用时的快照，就能准确告诉用户「现在是哪套、有没有改过」。 */
  let configSource = { kind: 'preset', name: '党政机关公文格式' };
  let baseSnapshot = null;      // 套用时的配置快照，用于判断「改了哪些」
  let blocks = [];
  let loadedImages = {};      // name → Uint8Array（重新排版时保留的图片）
  let imageMeta = {};         // name → {w,h,mime}（图片原始尺寸，避免重新排版后尺寸丢失）
  let pendingFiles = [];      // 待处理文件

  const $ = (id) => document.getElementById(id);

  /* ---------------- 状态栏 ---------------- */

  function status(text, kind) {
    $('stText').textContent = text;
    const dot = $('stDot');
    dot.className = 'dot' + (kind ? ' ' + kind : '');
  }

  function setStats(txt) { $('stStats').textContent = txt || ''; }

  function fail(msg) {
    status(msg, 'err');
  }
  function ok(msg) {
    status(msg, 'ok');
  }

  /* ---------------- 配置读写 ---------------- */

  function cfgValue(key) {
    const v = cfg[key];
    return v === undefined ? '' : v;
  }

  /** 把配置写进所有 [data-cfg] 控件 */
  function syncControlsFromCfg() {
    document.querySelectorAll('[data-cfg]').forEach((el) => {
      const key = el.dataset.cfg;
      const v = cfgValue(key);
      if (el.type === 'checkbox') el.checked = v === true || v === 'true';
      else if (el.tagName === 'SELECT' && el.dataset.flag === 'bool') el.value = String(v === true);
      else el.value = v;
    });

    // 快速面板
    setVal('q_body_font', cfg.body_font);
    setVal('q_body_size', cfg.body_size);
    setVal('q_indent', cfg.first_line_indent_chars);
    setVal('q_blank', cfg.blank_line_mode);
    setVal('q_space', cfg.space_mode || 'off');
    setVal('c_space_mode', cfg.space_mode || 'off');
    setVal('c_space_highlight', cfg.space_highlight === true, true);
    const hlBtn = $('q_space_hl');
    if (hlBtn) hlBtn.classList.toggle('on', cfg.space_highlight === true);
    setVal('q_margin_top', cfg.margin_top);
    setVal('q_margin_bottom', cfg.margin_bottom);
    setVal('q_margin_left', cfg.margin_left);
    setVal('q_margin_right', cfg.margin_right);
    setVal('q_title_font', cfg.title_font);
    setVal('q_title_size', cfg.title_size);
    setVal('q_h1_font', cfg.h1_font);
    setVal('q_h1_size', cfg.h1_size);
    setVal('q_h2_font', cfg.h2_font);
    setVal('q_h2_size', cfg.h2_size);
    setVal('c_enable_header', cfg.enable_header === true, true);
    setVal('c_page_number_start', cfg.page_number_start);

    // 行距快速选择
    const lsSel = $('q_line_spacing');
    const lsKey = cfg.line_spacing_rule + ':' + cfg.line_spacing_value;
    const match = Array.from(lsSel.options).find(o => o.value === lsKey);
    lsSel.value = match ? lsKey : lsSel.options[0].value;

    updateLineSpacingHint();
    renderFontTable();
    syncHeadLineFromCfg();
  }

  /** 行距单位提示：选「倍」和选「磅」时同一个数字的含义不同，必须提示清楚 */
  function updateLineSpacingHint() {
    const el = $('lineSpacingHint');
    if (!el) return;
    const mult = (cfg.line_spacing_unit || 'pt') === 'mult';
    const v = parseFloat(cfg.line_spacing_value) || 0;
    if (mult) {
      const size = parseFloat(cfg.body_size) || 16;
      el.textContent = '按「倍」解释：' + v + ' × 正文字号 ' + size + 'pt = 实际行高 ' +
        (v * size).toFixed(1) + 'pt。要写定值行高请改选「磅」。';
    } else {
      el.textContent = '按「磅」解释：固定行高 ' + v + ' 磅' +
        (Math.abs(v - 28) < 0.01 ? '（公文标准）' : '') +
        '。要写相对行距请改选「倍」。';
    }
  }

  function setVal(id, v, isCheck) {
    const el = $(id);
    if (!el) return;
    if (isCheck) el.checked = !!v; else el.value = v;
  }

  /** 读取单个控件 → cfg */
  function readControl(el) {
    const key = el.dataset.cfg;
    if (!key) return;
    if (el.type === 'checkbox') cfg[key] = el.checked;
    else if (el.type === 'number') {
      const n = parseFloat(el.value);
      cfg[key] = isNaN(n) ? 0 : n;
    } else if (el.tagName === 'SELECT') {
      /* 布尔配置用下拉呈现时（force_a4 / use_custom_english_font），
         option 的 value 是字符串 "true"/"false"，必须转成真正的布尔值 ——
         否则 `cfg.force_a4 === true` 永远不成立，纸张设置会失效。 */
      if (el.value === 'true') cfg[key] = true;
      else if (el.value === 'false') cfg[key] = false;
      else cfg[key] = el.value;
    } else {
      cfg[key] = el.value;
    }
  }

  /* ---------------- 字体表（逐级） ---------------- */

  const FONT_ROLES = [
    ['title', '主标题'], ['subtitle', '副标题'], ['salutation', '主送机关'],
    ['h1', '一级标题'], ['h2', '二级标题'], ['h3', '三级标题'], ['h4', '四级标题'],
    ['body', '正文'], ['attachment', '附件标记'],
    ['table_caption', '表标题'], ['figure_caption', '图标题']
  ];

  function renderFontTable() {
    const host = $('fontTable');
    if (!host) return;
    let html = '';
    /* 字体名较长（如「方正小标宋_GBK」），两列并排会被截断，
       因此每行改为「字体 select 占满 + 字号 select 固定窄列」。 */
    for (const [role, label] of FONT_ROLES) {
      html += '<div class="fontline">';
      html += '<span class="fl-label">' + label + '</span>';
      html += '<select class="fl-font" data-cfg="' + role + '_font" data-role="' + role + '"></select>';
      html += '<select class="fl-size" data-cfg="' + role + '_size" data-role="' + role + '"></select>';
      html += '</div>';
    }
    // 页眉/页码字体
    html += '<hr>';
    const extra = [
      ['页码字体', 'page_number_font'], ['页码字号', 'page_number_size'],
      ['页眉字体', 'header_font'], ['页眉字号', 'header_size']
    ];
    for (const [label, key] of extra) {
      html += '<div class="fontline"><span class="fl-label">' + label + '</span>' +
        '<select class="fl-font" data-cfg="' + key + '"></select></div>';
    }
    host.innerHTML = html;

    // 填充 select
    host.querySelectorAll('select').forEach(sel => {
      const key = sel.dataset.cfg;
      if (/_size$/.test(key)) {
        sel.innerHTML = sizeOptionsHtml(cfg[key]);
        sel.value = cfg[key];
      } else {
        sel.innerHTML = fontOptionsHtml();
        sel.value = cfg[key];
      }
      sel.addEventListener('change', () => {
        cfg[key] = /_size$/.test(key) ? parseFloat(sel.value) : sel.value;
        schedulePreview();
        syncChips();
      });
    });
  }

  /* ---------------- 各级标题行距表 ---------------- */

  /* 每级标题一行：标签 + 行距规则 + 数值 + 单位。
     规则选「跟随正文」时，数值与单位置灰（不存在独立的行距值）。 */
  const HEAD_LINE_ROLES = [
    ['title', '主标题'], ['h1', '一级标题'], ['h2', '二级标题'],
    ['h3', '三级标题'], ['h4', '四级标题']
  ];

  function renderHeadLineTable() {
    const host = $('headLineTable');
    if (!host) return;
    let html = '';
    for (const [role, label] of HEAD_LINE_ROLES) {
      html += '<div class="hline" data-role="' + role + '">';
      html += '<span class="hl-label">' + label + '</span>';
      html += '<select class="hl-rule" data-cfg="' + role + '_line_rule"></select>';
      html += '<div class="unitrow">';
      html += '<input type="number" class="hl-val" step="0.05" data-cfg="' + role + '_line_value">';
      html += '<select class="hl-unit" data-cfg="' + role + '_line_unit"></select>';
      html += '</div></div>';
    }
    host.innerHTML = html;

    host.querySelectorAll('.hl-rule').forEach(sel => {
      sel.innerHTML = D.ROLE_LINE_SPACING_RULE_OPTIONS.map(o =>
        '<option value="' + o.value + '">' + o.label + '</option>').join('');
    });
    host.querySelectorAll('.hl-unit').forEach(sel => {
      sel.innerHTML = D.LINE_SPACING_UNIT_OPTIONS.map(o =>
        '<option value="' + o.value + '">' + o.label + '</option>').join('');
    });
    host.querySelectorAll('select, input').forEach(el => {
      el.addEventListener('change', () => {
        readControl(el);
        if (/^h[1-4]_line_rule$|^title_line_rule$/.test(el.dataset.cfg)) syncHeadLineDisabled();
        schedulePreview();
      });
    });
    syncHeadLineDisabled();
  }

  /** 规则为「跟随正文」时禁用数值与单位 */
  function syncHeadLineDisabled() {
    for (const [role] of HEAD_LINE_ROLES) {
      const line = document.querySelector('.hline[data-role="' + role + '"]');
      if (!line) continue;
      const inherit = (cfg[role + '_line_rule'] || 'inherit') === 'inherit';
      const val = line.querySelector('.hl-val');
      const unit = line.querySelector('.hl-unit');
      if (val) { val.disabled = inherit; val.style.opacity = inherit ? '.45' : '1'; }
      if (unit) { unit.disabled = inherit; unit.style.opacity = inherit ? '.45' : '1'; }
    }
  }

  function syncHeadLineFromCfg() {
    for (const [role] of HEAD_LINE_ROLES) {
      const line = document.querySelector('.hline[data-role="' + role + '"]');
      if (!line) continue;
      const rule = line.querySelector('.hl-rule');
      const val = line.querySelector('.hl-val');
      const unit = line.querySelector('.hl-unit');
      if (rule) rule.value = cfg[role + '_line_rule'] || 'inherit';
      if (val) val.value = cfg[role + '_line_value'] != null ? cfg[role + '_line_value'] : 28;
      if (unit) unit.value = cfg[role + '_line_unit'] || 'pt';
    }
    syncHeadLineDisabled();
  }

  function fontOptionsHtml() {
    return D.PRESET_FONT_OPTIONS.map(f =>
      '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>').join('');
  }

  function sizeOptionsHtml(current) {
    const sizes = [42, 36, 26, 24, 22, 18, 16, 15, 14, 12, 10.5, 9, 8, 7.5];
    const names = { 42: '初号', 36: '小初', 26: '一号', 24: '小一', 22: '二号', 18: '小二',
                    16: '三号', 15: '小三', 14: '四号', 12: '小四', 10.5: '五号', 9: '小五',
                    8: '六号', 7.5: '小六' };
    let html = sizes.map(s =>
      '<option value="' + s + '">' + s + ' pt' + (names[s] ? ' · ' + names[s] : '') + '</option>').join('');
    if (current != null && !sizes.includes(Number(current))) {
      html = '<option value="' + current + '">' + current + ' pt</option>' + html;
    }
    return html;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 空格高亮：把空格 / 全角空格 / 制表符包成带背景色的 span，
     让「肉眼看不见」的空格变成一眼能看到的色块。
     只在预览里做标记，绝不改动文本本身。

     必须一次性替换（单遍 + 函数式替换）：若先替换制表符、再替换全角空格、
     最后替换半角空格的顺序做三次，最后那次会把前面刚生成的
     `<span class="sp-wide">` 属性里的空格也替换掉，把 HTML 打坏（真实缺陷）。
     单遍替换不会回头扫自己生成的产物。 */
  function markSpaces(s) {
    return escapeHtml(s).replace(/[\t\u3000\u00a0 ]/g, (m) => {
      if (m === '\t') return '<span class="sp-tab">\u2192&nbsp;&nbsp;</span>';
      if (m === '\u3000') return '<span class="sp-wide">\u3000</span>';
      if (m === '\u00a0') return '<span class="sp-wide">\u00a0</span>';
      return '<span class="sp"> </span>';
    });
  }

  /** 文本进预览用：根据 space_highlight 决定是否标记空格 */
  function txt(s) {
    return cfg.space_highlight === true ? markSpaces(s) : escapeHtml(s);
  }

  /** 切换空格高亮（只影响预览显示，不动文本、不影响导出） */
  function toggleSpaceHighlight() {
    cfg.space_highlight = !cfg.space_highlight;
    const c = $('c_space_highlight');
    if (c) c.checked = !!cfg.space_highlight;
    const b = $('q_space_hl');
    if (b) b.classList.toggle('on', !!cfg.space_highlight);
    /* 必须重新解析、不能只 renderPreview()：space_highlight 会通过 keepSpaces
       让标点标准化别动空格（否则全角空格已被归一半角、连续空格已被压缩，
       高亮出来分不清是哪种空格）。只重绘的话读到的还是上一轮解析的旧块。 */
    runParse();
    const n = P.countSpaces($('src').value);
    if (cfg.space_highlight) {
      ok(n ? ('已高亮 ' + n + ' 个空格（空格黄、全角红、制表符蓝）')
           : '当前文本里没有空格');
    } else {
      ok('已关闭空格高亮');
    }
  }

  /* ---------------- 初始化控件 ---------------- */

  function buildStaticSelects() {
    // 空行模式
    const blm = $('c_blank_line_mode');
    blm.innerHTML = D.BLANK_LINE_MODE_OPTIONS.map(o =>
      '<option value="' + o.value + '">' + o.label + '</option>').join('');
    blm.value = cfg.blank_line_mode;
    blm.addEventListener('change', () => { cfg.blank_line_mode = blm.value; runParse(); });

    // 空格处理模式（快速面板 + 自定义面板共用同一份选项）
    const spaceOpts = D.SPACE_MODE_OPTIONS.map(o =>
      '<option value="' + o.value + '">' + o.label + '</option>').join('');
    const csm = $('c_space_mode');
    if (csm) {
      csm.innerHTML = spaceOpts;
      csm.value = cfg.space_mode || 'off';
      csm.addEventListener('change', () => { cfg.space_mode = csm.value; runParse(); });
    }
    const qs = $('q_space');
    if (qs) {
      qs.innerHTML = spaceOpts;
      qs.value = cfg.space_mode || 'off';
      qs.addEventListener('change', () => {
        cfg.space_mode = qs.value;
        if (csm) csm.value = qs.value;
        runParse();
      });
    }
    const qshl = $('q_space_hl');
    if (qshl) qshl.addEventListener('click', () => toggleSpaceHighlight());
    const cshl = $('c_space_highlight');
    if (cshl) cshl.addEventListener('change', () => {
      cfg.space_highlight = !!cshl.checked;
      renderPreview();
    });

    // 行距类型
    const lsr = document.querySelector('[data-cfg="line_spacing_rule"]');
    lsr.innerHTML = D.LINE_SPACING_RULE_OPTIONS.map(o =>
      '<option value="' + o.value + '">' + o.label + '</option>').join('');

    // 行距值单位（磅 / 倍）
    const lsu = document.querySelector('[data-cfg="line_spacing_unit"]');
    if (lsu) {
      lsu.innerHTML = D.LINE_SPACING_UNIT_OPTIONS.map(o =>
        '<option value="' + o.value + '">' + o.label + '</option>').join('');
      lsu.addEventListener('change', updateLineSpacingHint);
    }

    // 左/右缩进单位（字符 / 厘米 / 磅）
    document.querySelectorAll('[data-cfg$="_indent_unit"]').forEach(sel => {
      sel.innerHTML = D.INDENT_UNIT_OPTIONS.map(o =>
        '<option value="' + o.value + '">' + o.label + '</option>').join('');
    });

    // 纸张尺寸
    const paperSel = $('paperSize');
    if (paperSel) {
      paperSel.innerHTML = D.PAPER_SIZES.map(o =>
        '<option value="' + o.value + '">' + o.label + '</option>').join('');
    }

    // 编号样式
    const ns = document.querySelector('[data-cfg="number_style"]');
    ns.innerHTML = D.NUMBER_STYLE_OPTIONS.map(o =>
      '<option value="' + o.value + '">' + o.label + '</option>').join('');

    // 页码格式 / 位置
    const pnf = $('c_page_number_format');
    pnf.innerHTML = D.PAGE_NUMBER_FORMAT_OPTIONS.map(o =>
      '<option value="' + o.value + '">' + o.label + '</option>').join('');
    const pnp = $('c_page_number_position');
    pnp.innerHTML = D.PAGE_NUMBER_POSITION_OPTIONS.map(o =>
      '<option value="' + o.value + '">' + o.label + '</option>').join('');

    // 快速面板字体
    ['q_body_font', 'q_title_font', 'q_h1_font', 'q_h2_font'].forEach(id => {
      const el = $(id);
      el.innerHTML = fontOptionsHtml();
    });

    // 快速面板字号
    ['q_body_size', 'q_title_size', 'q_h1_size', 'q_h2_size'].forEach(id => {
      const el = $(id);
      el.innerHTML = sizeOptionsHtml(cfg[id.replace('q_', '').replace('_font', '') + '_size']);
    });

    // 行距快速选项
    const qls = $('q_line_spacing');
    const quickSpacing = [
      ['single:1', '单倍行距'],
      ['onehalf:1.5', '1.5 倍行距'],
      ['double:2', '2 倍行距'],
      ['fixed:28', '固定值 28 磅（公文标准）'],
      ['fixed:22', '固定值 22 磅'],
      ['fixed:20', '固定值 20 磅'],
      ['atLeast:20', '最小值 20 磅'],
      ['multiple:1.25', '多倍 1.25']
    ];
    qls.innerHTML = quickSpacing.map(([v, l]) =>
      '<option value="' + v + '">' + l + '</option>').join('');

    // 段落间空行快速选项（默认建议「压缩为一个」，公文段间通常不放空行）
    const qb = $('q_blank');    if (qb) {
      qb.innerHTML = D.BLANK_LINE_MODE_OPTIONS.map(o =>
        '<option value="' + o.value + '">' + escapeHtml(o.label) + '</option>').join('');
    }

    // 规范方案（内置规范 + 我存过的方案，统一在一个下拉里选）
    renderPresetSelect();

    // 英文段落布尔 select
    const ucef = document.querySelector('[data-cfg="use_custom_english_font"]');
    if (ucef) ucef.dataset.bool = '1';
  }

  /** 「规范方案」下拉：4 套内置规范 + 用户自己存的方案（分组显示）。
      两者本质同层 —— 都是整套配置的起点，所以放同一个下拉里才不会让用户
      以为要「二选一」或担心互相冲突。 */
  function renderPresetSelect() {
    const ps = $('presetSel');
    if (!ps) return;
    const builtin = Object.keys(D.PRESETS);
    const schemes = Object.keys(loadSchemes());
    let html = '<optgroup label="内置规范">' + builtin.map(k =>
      '<option value="preset:' + escapeHtml(k) + '">' + escapeHtml(k) + '</option>').join('') +
      '</optgroup>';
    if (schemes.length) {
      html += '<optgroup label="我的方案">' + schemes.map(k =>
        '<option value="scheme:' + escapeHtml(k) + '">' + escapeHtml(k) + '</option>').join('') +
        '</optgroup>';
    }
    ps.innerHTML = html;
    ps.value = (configSource.kind === 'scheme' ? 'scheme:' : 'preset:') + configSource.name;
    /* 方案如果已删掉，回落到当前预设 */
    if (!ps.value) ps.value = 'preset:' + (D.PRESETS[currentPreset] ? currentPreset : builtin[0]);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    // tabs
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
        document.querySelectorAll('.pane').forEach(x => x.classList.add('hide'));
        t.classList.add('on');
        $('pane-' + t.dataset.tab).classList.remove('hide');
      });
    });

    // 折叠区
    document.querySelectorAll('.collapse-h').forEach(h => {
      h.addEventListener('click', () => {
        h.classList.toggle('off');
        const body = $('b' + h.id.slice(1));
        if (body) body.classList.toggle('hide');
      });
    });
    /* 默认展开前两个折叠区。要容错：纸张/页边距那一段已经改成直接露出的
       fieldset（不再是折叠区），对应 id 可能不存在。 */
    ['hPage', 'hFont'].forEach(id => { const el = $(id); if (el) el.classList.remove('off'); });

    // 输入
    $('src').addEventListener('input', debounce(runParse, 260));

    /* 粘贴规范化：从 Word / WPS / 网页复制的富文本，粘贴进 textarea 时可能带
       \r、\u2028、\u2029、\v 等各种「软换行」；有的应用甚至只给 HTML flavor。
       这里统一成 \n，避免整篇被当成一行（真实缺陷：预览里段落全部并在一起）。 */
    $('src').addEventListener('paste', e => {
      const cd = e.clipboardData;
      if (!cd) return;
      let txt = cd.getData('text/plain');
      if (!txt || !/\S/.test(txt)) {
        // 少数情况下只有 HTML flavor：抽出带换行的纯文本
        const html = cd.getData('text/html');
        if (html) txt = htmlToPlainForPaste(html);
      }
      if (txt == null) return;
      e.preventDefault();
      const norm = normalizePastedNewlines(txt);
      const ta = $('src');
      const s = ta.selectionStart, en = ta.selectionEnd;
      const v = ta.value;
      ta.value = v.slice(0, s) + norm + v.slice(en);
      ta.selectionStart = ta.selectionEnd = s + norm.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    ['c_detect_headings', 'c_detect_title', 'c_detect_tables',
     'c_enable_attachment_formatting', 'c_strip_markdown', 'c_normalize_punctuation'
    ].forEach(id => {
      $(id).addEventListener('change', () => {
        cfg[id.slice(2)] = $(id).checked;
        runParse();
      });
    });

    // 所有 data-cfg 控件
    document.querySelectorAll('[data-cfg]').forEach(el => {
      if (el.dataset.role) return;    // 字体表已单独绑定
      const evt = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(evt, () => {
        readControl(el);
        if (/^page_number_(format|position)$/.test(el.dataset.cfg)) syncPageNumberControls();
        if (/line_spacing_(value|unit)$/.test(el.dataset.cfg)) updateLineSpacingHint();
        /* 页眉/页脚距与纸张会影响 .page 的内联尺寸和 --hdrDist/--ftrDist，
           必须整页重绘（schedulePreview 只会重排块，不会重建页面容器）。 */
        if (/^(header|footer)_distance$|^(paper_size|force_a4)$/.test(el.dataset.cfg)) {
          renderPreview();
        } else {
          schedulePreview();
        }
        syncChips();
        saveLast();
      });
    });

    // 快速面板
    $('q_body_font').addEventListener('change', e => { cfg.body_font = e.target.value; afterQuick(); });
    $('q_body_size').addEventListener('change', e => { cfg.body_size = parseFloat(e.target.value); afterQuick(); });
    $('q_title_font').addEventListener('change', e => { cfg.title_font = e.target.value; afterQuick(); });
    $('q_title_size').addEventListener('change', e => { cfg.title_size = parseFloat(e.target.value); afterQuick(); });
    $('q_h1_font').addEventListener('change', e => { cfg.h1_font = e.target.value; afterQuick(); });
    $('q_h1_size').addEventListener('change', e => { cfg.h1_size = parseFloat(e.target.value); afterQuick(); });
    $('q_h2_font').addEventListener('change', e => { cfg.h2_font = e.target.value; afterQuick(); });
    $('q_h2_size').addEventListener('change', e => { cfg.h2_size = parseFloat(e.target.value); afterQuick(); });
    $('q_indent').addEventListener('change', e => { cfg.first_line_indent_chars = parseFloat(e.target.value) || 0; afterQuick(); });
    $('q_blank').addEventListener('change', e => {
      cfg.blank_line_mode = e.target.value;
      const c = $('c_blank_line_mode');
      if (c) c.value = e.target.value;
      runParse();
    });
    // 页边距：四边各自独立可调
    ['top', 'bottom', 'left', 'right'].forEach(side => {
      const id = 'q_margin_' + side;
      if (!$(id)) return;
      $(id).addEventListener('change', e => {
        cfg['margin_' + side] = parseFloat(e.target.value) || 0;
        syncControlsFromCfg();
        afterQuick();
      });
    });
    if ($('btnMarginGbt')) {
      $('btnMarginGbt').addEventListener('click', () => {
        cfg.margin_top = 3.7; cfg.margin_bottom = 3.5;
        cfg.margin_left = 2.8; cfg.margin_right = 2.6;
        syncControlsFromCfg(); afterQuick();
      });
    }
    if ($('btnMarginUniform')) {
      $('btnMarginUniform').addEventListener('click', () => {
        const v = parseFloat($('q_margin_top').value) || 0;
        cfg.margin_top = cfg.margin_bottom = cfg.margin_left = cfg.margin_right = v;
        syncControlsFromCfg(); afterQuick();
      });
    }
    $('q_line_spacing').addEventListener('change', e => {
      const [rule, val] = e.target.value.split(':');
      cfg.line_spacing_rule = rule;
      cfg.line_spacing_value = parseFloat(val);
      /* 快捷项自带单位语义：固定值/最小值是「磅」，多倍是「倍」。
         不对齐的话，选了「固定值 28 磅」而单位还是「倍」，
         会被算成 28 × 16pt = 448pt 行高，页面直接爆掉。 */
      if (rule === 'fixed' || rule === 'atLeast') cfg.line_spacing_unit = 'pt';
      else if (rule === 'multiple') cfg.line_spacing_unit = 'mult';
      syncControlsFromCfg(); afterQuick();
    });

    // 方案切换
    $('presetSel').addEventListener('change', e => {
      const v = e.target.value;
      const ix = v.indexOf(':');
      const kind = ix > 0 ? v.slice(0, ix) : 'preset';
      const name = ix > 0 ? v.slice(ix + 1) : v;
      if (kind === 'scheme') applyScheme(name, true);
      else applyPreset(name, true);
    });

    // 按钮
    $('btnRun').addEventListener('click', doExport);
    $('btnClear').addEventListener('click', () => {
      $('src').value = '';
      pendingFiles = [];
      loadedImages = {};
      imageMeta = {};
      $('fileInfo').innerHTML = '';
      runParse();
    });
    $('btnSample').addEventListener('click', () => { $('src').value = SAMPLE; runParse(); });
    $('btnReset').addEventListener('click', () => {
      cfg = Object.assign({}, D.DEFAULT_CONFIG);
      syncControlsFromCfg(); afterQuick();
      ok('已恢复默认设置');
    });

    $('btnSaveScheme').addEventListener('click', saveSchemeDialog);
    $('btnManageScheme').addEventListener('click', manageSchemesDialog);
    $('btnHelp').addEventListener('click', helpDialog);
    $('btnAbout').addEventListener('click', aboutDialog);

    // 缩放：滑块 + 加减（1% 精度，Shift 一次 10%）+ 直接输入 + 适应宽度
    $('zoom').addEventListener('input', e => setZoom(e.target.value));
    bindZoomButton($('zoomOut'), -1);
    bindZoomButton($('zoomIn'), 1);
    $('zoomFit').addEventListener('click', fitWidth);
    $('zoomPct').addEventListener('change', e => setZoom(e.target.value));
    $('zoomPct').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); setZoom(e.target.value); e.target.blur(); }
    });
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); stepZoom(10); }
      else if (e.key === '-') { e.preventDefault(); stepZoom(-10); }
      else if (e.key === '0') { e.preventDefault(); setZoom(100); }
    });
    // 窗口变化时，若处于「适应宽度」模式则重新计算
    window.addEventListener('resize', () => { if (fitMode) fitWidth(); });

    bindSplitter();
    bindDensity();

    // 文件
    $('drop').addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', e => {
      if (e.target.files.length) handleFiles(Array.from(e.target.files));
      e.target.value = '';
    });
    ['dragenter', 'dragover'].forEach(ev => {
      $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.remove('over'); });
    });
    $('drop').addEventListener('drop', e => {
      const fs = Array.from(e.dataTransfer.files || []);
      if (fs.length) handleFiles(fs);
    });
    // 全窗口拖放
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      const fs = Array.from(e.dataTransfer.files || []);
      if (fs.length) handleFiles(fs);
    });

    // 键盘
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doExport(); }
      if (e.key === 'Escape') closeModal();
    });
  }

  function afterQuick() { schedulePreview(); syncChips(); saveLast(); }

  function syncPageNumberControls() {
    const fmt = cfg.page_number_format;
    $('c_page_number_start').disabled = (fmt === 'none');
  }

  /* ---------------- 规范方案 ---------------- */

  function applyPreset(name, notify) {
    const p = D.PRESETS[name];
    if (!p) return;
    currentPreset = name;
    configSource = { kind: 'preset', name: name };
    cfg = D.mergeConfig(Object.assign({}, cfg), p);
    baseSnapshot = Object.assign({}, cfg);
    syncControlsFromCfg();
    schedulePreview();
    syncChips();
    if (notify) ok('已套用规范：' + name);
    saveLast();
  }

  /** 套用「我的方案」。与套用内置规范完全同一套流程 ——
      方案就是一批存好的配置值，套用后写的也是同一个 cfg，不存在优先级冲突。 */
  function applyScheme(name, notify) {
    const all = loadSchemes();
    if (!all[name]) return;
    currentPreset = name;
    configSource = { kind: 'scheme', name: name };
    cfg = D.mergeConfig(Object.assign({}, D.DEFAULT_CONFIG), all[name]);
    baseSnapshot = Object.assign({}, cfg);
    syncControlsFromCfg();
    schedulePreview();
    syncChips();
    if (notify) ok('已套用我的方案：' + name);
    saveLast();
  }

  const PRESET_DESC = {
    '党政机关公文格式': '依据《党政机关公文格式》GB/T 9704：方正小标宋二号标题、黑体三号一级标题、楷体三号二级标题、仿宋_GB2312 三号正文，行距固定值 28 磅，页边距上 3.7 / 下 3.5 / 左 2.8 / 右 2.6 cm。',
    '通用报告（宋体）': '常规工作报告排版：黑体标题 + 宋体正文小四，1.5 倍行距，首行缩进 2 字符。适合大多数内部材料。',
    '论文 / 学术': '学术论文风格：黑体分级标题 + 宋体正文小四，多倍行距 1.25。',
    '简洁 / 无修饰': '不缩进、单倍行距、无页码，只做层级区分。适合快速整理与二次加工。'
  };

  function syncChips() {
    const chip = $('chipPreset');
    const mods = countModified();
    /* 把「当前用哪套、改过几项」显式写出来 —— 用户原来分不清
       「规范」下拉和「我的方案」谁说了算，其实它们只是同一个 cfg 的不同来源。 */
    const label = configSource.kind === 'scheme'
      ? '方案：' + configSource.name
      : configSource.name;
    if (chip) {
      chip.textContent = label + (mods ? '（改过 ' + mods + ' 项）' : '');
      chip.title = configSource.kind === 'scheme'
        ? '当前基于「我的方案」里的这一套，改动只影响本次，点「存为我的方案」可覆盖保存'
        : '当前基于内置规范「' + configSource.name + '」，改动只影响本次，可「存为我的方案」';
    }
    $('presetDesc').textContent = PRESET_DESC[configSource.name] || PRESET_DESC[currentPreset] || '';
    /* 规范页的「当前使用」提示条 */
    const nowEl = $('curConfig');
    if (nowEl) {
      const base = configSource.kind === 'scheme'
        ? '我的方案「' + configSource.name + '」'
        : '内置规范「' + configSource.name + '」';
      nowEl.innerHTML = '当前使用：<b>' + escapeHtml(base) + '</b>' +
        (mods ? '，已在此基础上改动 <b>' + mods + '</b> 项设置' : '，未做改动') +
        '<br><small>「规范」和「我的方案」是同一层：都是整套配置的起点，选哪个就以哪个为准，' +
        '之后再改任何一项都只在本次生效；要长期保留请点「存为我的方案」。</small>';
    }
    /* 让下拉跟随当前来源（套用方案后要指到「我的方案」分组里那一项） */
    const sel = $('presetSel');
    if (sel) {
      const want = (configSource.kind === 'scheme' ? 'scheme:' : 'preset:') + configSource.name;
      if (sel.querySelector('option[value="' + CSS.escape(want) + '"]')) sel.value = want;
    }
  }

  /** 相对「套用时的快照」改了几项（没有快照时以当前预设为基准） */
  function countModified() {
    const base = baseSnapshot || D.PRESETS[currentPreset] ||
      (D.PRESETS[configSource.name]) || null;
    if (!base) return 0;
    let n = 0;
    for (const k of Object.keys(cfg)) {
      if (base[k] === undefined) continue;
      if (String(cfg[k]) !== String(base[k])) n++;
    }
    return n;
  }

  /* ---------------- 文件处理 ---------------- */

  async function handleFiles(files) {
    pendingFiles = [];
    loadedImages = {};
    imageMeta = {};
    const infos = [];

    for (const f of files) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        const det = R.detectFormat(buf, f.name);

        if (det.kind === 'docx') {
          const res = await R.readDocx(buf);
          blocks = res.blocks;
          loadedImages = res.images || {};
          // 记录图片原始尺寸与类型：文本往返会丢掉这些信息，导出时从这里恢复
          imageMeta = {};
          for (const b of blocks) {
            if (b.type === 'image' && b.name) {
              imageMeta[b.name] = { w: b.w || 0, h: b.h || 0, mime: b.mime || '' };
            }
          }
          infos.push({ ok: true, name: f.name, msg: '已读取 .docx（' + blocks.length + ' 个段落块）' + (res.warnings.length ? '，' + res.warnings.join('，') : '') });
          // 同步到文本框，便于手动修改
          $('src').value = blocksToText(blocks);
        } else if (det.kind === 'rtf') {
          const txt = R.rtfToText(Zip.fromUtf8(buf));
          $('src').value = txt;
          infos.push({ ok: true, name: f.name, msg: '已解析 RTF（' + txt.length + ' 字）' });
        } else if (det.kind === 'html') {
          const txt = R.htmlToText(Zip.fromUtf8(buf));
          $('src').value = txt;
          infos.push({ ok: true, name: f.name, msg: '已解析 HTML（' + txt.length + ' 字）' });
        } else if (det.kind === 'ole' || det.kind === 'pdf') {
          infos.push({ ok: false, name: f.name, msg: det.hint });
          continue;
        } else {
          const { text, encoding } = R.readPlainText(buf);
          $('src').value = text;
          infos.push({ ok: true, name: f.name, msg: '已读取纯文本（' + text.length + ' 字，' + encoding + '）' });
        }
      } catch (err) {
        infos.push({ ok: false, name: f.name, msg: '读取失败：' + err.message });
      }
    }

    /* 统一换行符：无论文本来自 .txt / .rtf / .html / .docx，写进文本框前都归一化，
       保证「文本框里看到的」与「解析用的」完全一致（避免软换行导致整篇并成一行）。 */
    $('src').value = normalizePastedNewlines($('src').value);

    $('fileInfo').innerHTML = infos.map(i =>
      '<div class="' + (i.ok ? 'okbox' : 'errbox') + '"><b>' + escapeHtml(i.name) + '</b><br>' +
      escapeHtml(i.msg) + '</div>').join('');

    runParse();
  }

  /** 块数组 → 可编辑文本（用于重新排版场景的忠实还原） */
  function blocksToText(bs) {
    const out = [];
    for (const b of bs) {
      switch (b.type) {
        case 'title': out.push(b.text, ''); break;
        case 'subtitle': out.push(b.text, ''); break;
        case 'salutation': out.push(b.text, ''); break;
        case 'heading':
          out.push('#'.repeat(b.level) + ' ' + b.text, '');
          break;
        case 'attachment': case 'table_caption': case 'figure_caption':
          out.push(b.text, ''); break;
        case 'table':
          out.push(b.rows.map(r => r.join('\t')).join('\n'), ''); break;
        case 'image':
          out.push('[图片：' + (b.name || '') + ']', ''); break;
        case 'blank': out.push(''); break;
        default: out.push(b.text, ''); break;
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------------- 字数 / 页数统计 ---------------- */

  /** 统计块数组的文字量。中文按「字」计，西文按「词」计 —— 与 Word 的
      「字数」口径基本一致（Word 也把连着的英文串算 1 个字）。
      标点判定必须覆盖「通用标点区」U+2000–U+206F，否则中文引号 “ ”、破折号 —、
      省略号 …、间隔号 · 都会被漏算，导致「字符数 = 中文 + 标点」对不上。 */
  const RE_CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
  const RE_SPACE = /[\u3000\u00a0 ]/;
  const RE_PUNCT = new RegExp(
    '[\\u2000-\\u206f' +          // 通用标点：— – ‘ ’ “ ” … ‰ ′ ″ ‹ ›
    '\\u3001-\\u303f' +           // 中文标点：、。〈〉《》「」『』【】
    '\\uff01-\\uff60' +           // 全角标点：，！？：；（）【】
    '\\uffe0-\\uffe6' +           // 全角符号：￥ ￠ ￡ ￢ ￣
    '\\u00a1-\\u00bf' +           // 拉丁标点：¡ § ° ± · ¶
    '\\u00d7\\u00f7' +            // × ÷
    '!-\\/:-@\\[-`{-~' +          // ASCII 标点
    ']');
  function computeStats(bs) {
    let cjk = 0, word = 0, punct = 0, digit = 0, space = 0, chars = 0;
    let other = 0;
    let tableCells = 0, images = 0, paras = 0;
    const eat = (s) => {
      const str = String(s || '');
      chars += str.length;
      for (const ch of str) {
        if (RE_SPACE.test(ch)) { space++; continue; }
        if (RE_CJK.test(ch)) { cjk++; continue; }
        if (/[0-9]/.test(ch)) { digit++; continue; }
        if (RE_PUNCT.test(ch)) { punct++; continue; }
        other++;   // 拉丁字母等：计入「字数」里的英文单词，字符层不重复计
      }
      // 西文单词：连续字母串（字母已在上面归入 other）
      const ws = str.match(/[A-Za-z][A-Za-z0-9'’\-]*/g);
      if (ws) word += ws.length;
    };
    for (const b of bs || []) {
      if (b.type === 'blank') continue;
      if (b.type === 'table') {
        paras++;
        for (const row of b.rows || []) {
          for (const cell of row) { eat(cell); tableCells++; }
        }
        continue;
      }
      if (b.type === 'image') { images++; continue; }
      paras++;
      eat(b.text);
    }
    const total = cjk + word + digit;
    return {
      total, cjk, word, digit, punct, space, chars, other,
      paras, tableCells, images,
      charsNoSpace: chars - space
    };
  }

  function fmtNum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 把统计写进预览工具栏（紧跟来源标签，不占版面） */
  function renderStats() {
    const el = $('pvStats');
    if (!el) return;
    /* 统计始终显示（用户明确要求：不需要开关，默认显示就行）。
       只有「文档为空」时才隐藏，避免空文档还挂一条 0 字 0 页。 */
    if (!blocks.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const s = computeStats(blocks);
    const pageCount = ($('pages') ? $('pages').querySelectorAll('.page').length : 0);
    const items = [
      ['页数', pageCount + ' 页'],
      ['字数', fmtNum(s.total)],
      ['字符', fmtNum(s.charsNoSpace)]
    ];
    let html = items.map(([k, v]) =>
      '<span class="psi"><i>' + k + '</i><b>' + v + '</b></span>').join('');
    /* 「详情」是按钮（原来只是 title 悬停提示，用户点了没有任何反应 —— 真实缺陷） */
    html += '<button type="button" class="psmore" id="btnStatsMore">详情</button>';
    el.innerHTML = html;
    const more = $('btnStatsMore');
    if (more && !more.__bound) {
      more.__bound = true;
      more.addEventListener('click', statsDialog);
    }
  }

  /** 「详情」弹窗：完整统计细分 */
  function statsDialog() {
    const s = computeStats(blocks);
    const pageCount = ($('pages') ? $('pages').querySelectorAll('.page').length : 0);
    const rows = [
      ['页数', pageCount + ' 页', '按当前纸张与页边距实际排版得出'],
      ['字数', fmtNum(s.total), '中文 + 英文单词 + 数字（与 Word 字数口径接近）'],
      ['字符数', fmtNum(s.charsNoSpace) + '（不含空格）', '逐字符计数，不含任何空格'],
      ['', fmtNum(s.chars) + '（含空格）', '逐字符计数，含全部空格'],
      ['中文', fmtNum(s.cjk), '汉字字数'],
      ['英文单词', fmtNum(s.word), '连续的字母序列算 1 个'],
      ['数字', fmtNum(s.digit), '阿拉伯数字逐位计数'],
      ['标点符号', fmtNum(s.punct), '中英文标点合计（含 “ ” — … ·）'],
      ['字母', fmtNum(s.other), '构成英文单词的字母，逐字符计数'],
      ['段落', fmtNum(s.paras), '标题、正文、题注都算一段；表格算 1 段'],
      ['表格单元格', fmtNum(s.tableCells), '所有表格的单元格总数'],
      ['图片', fmtNum(s.images), '内嵌图片张数'],
      ['空格', fmtNum(s.space), '半角与全角空格合计']
    ];
    const body =
      '<table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.9">' +
      rows.map(r =>
        '<tr>' +
        '<td style="padding:3px 10px 3px 0;color:#8e8e93;white-space:nowrap;vertical-align:top">' +
          (r[0] || '') + '</td>' +
        '<td style="padding:3px 10px 3px 0;font-weight:600;white-space:nowrap;vertical-align:top">' +
          r[1] + '</td>' +
        '<td style="padding:3px 0;color:#8e8e93;font-size:12px">' + (r[2] || '') + '</td>' +
        '</tr>').join('') +
      '</table>' +
      '<p style="margin:12px 0 0;color:#8e8e93;font-size:12px;line-height:1.6">' +
      '页数是按当前纸张与页边距真实分页后统计的，改任何设置都会立刻跟着变。</p>';
    openModal('字数与页数统计', body, [{ text: '关闭', cls: '', fn: closeModal }]);
  }

  /* ---------------- 解析 + 预览 ---------------- */

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 90);
  }

  function runParse() {
    const text = $('src').value;
    try {
      if (!text.trim()) {
        blocks = [];
        showEmpty(true);
        setStats('');
        /* 空文档时也要把统计条收起来，否则会残留上一次的「N 页 / N 字」
           （这里早先直接 return，没调 renderStats，统计条就挂着旧数字）。 */
        renderStats();
        ok('就绪');
        return;
      }
      blocks = P.parseText(text, cfg);
      // 保留图片块（重新排版时图片不在文本里）
      if (Object.keys(loadedImages).length) {
        // 图片已在 readDocx 时作为块加入，但被 blocksToText 丢弃；此处从缓存重建
        // 简化策略：图片仅在直接「重新排版」按钮路径保留
      }
      renderPreview();
      const s = P.summarizeBlocks(blocks);
      setStats('标题 ' + s.title + ' · 副题 ' + s.subtitle + (s.salutation ? ' · 主送 ' + s.salutation : '') +
        ' · 一~四级 ' + s.h1 + '/' + s.h2 + '/' + s.h3 + '/' + s.h4 +
        ' · 正文 ' + s.body + ' · 表格 ' + s.table + ' · 题注 ' + s.caption);
      /* 空行提示：真实公文段与段之间不放空行，而网页 / Word 粘来的文本常带空行。
         这些空行会实实在在占掉整行高度（实测 22 个空行 ≈ 吃掉一整页），
         于是用户看到「页面空白太多」。

         ⚠ 两种模式不提示：
         - heading_gap：「只在标题后留空行」生成的空行是用户**要的**版式，
           若还弹「文中有 5 个空行，会占掉大量版面」就是自相矛盾（真实缺陷）。
         - delete_all：用户已经明确不要空行，剩下的也只可能是极少数漏网的。 */
      const blMode = cfg.blank_line_mode || 'delete_single';
      if (s.blank >= 3 && blMode !== 'heading_gap' && blMode !== 'delete_all') {
        ok('已解析 ' + blocks.length + ' 个段落块（含 ' + s.blank + ' 个空行，约占 ' +
           (s.blank * (cfg.line_spacing_value || 28) >= 200 ? '一整页' : '大半页') + '）');
        showBlankHint(s.blank);
      } else {
        ok('已解析 ' + blocks.length + ' 个段落块');
        showBlankHint(0);
      }
      /* 空格提示：只在文本里确实有空格、且没在处理时才提醒，
         否则用户永远不知道排版为什么歪。 */
      const nSpace = P.countSpaces(text);
      if (nSpace > 0 && (cfg.space_mode || 'off') === 'off') {
        showSpaceHint(nSpace);
      } else {
        showSpaceHint(0);
      }
    } catch (err) {
      fail('解析失败：' + err.message);
    }
  }

  /** 空格提示条（可一键清除 / 一键高亮） */
  function showSpaceHint(n) {
    const el = $('spaceHint');
    if (!el) return;
    if (!n) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = '<span>🔍 文中有 <b>' + n + '</b> 个空格，肉眼不容易发现，可能导致排版不齐。</span>' +
      '<button class="btn ghost" id="btnHLSpace" style="padding:3px 9px;font-size:11.5px">高亮显示</button>' +
      '<button class="btn ghost" id="btnDelSpace" style="padding:3px 9px;font-size:11.5px">删除所有空格</button>';
    const b1 = $('btnHLSpace');
    if (b1) b1.onclick = () => { if (!cfg.space_highlight) toggleSpaceHighlight(); };
    const b2 = $('btnDelSpace');
    if (b2) b2.onclick = () => {
      cfg.space_mode = 'remove_all';
      const qs = $('q_space'); if (qs) qs.value = 'remove_all';
      const cs = $('c_space_mode'); if (cs) cs.value = 'remove_all';
      runParse();
      saveLast();
    };
  }

  function showEmpty(on) {
    $('emptyTip').style.display = on ? '' : 'none';
    const wrap = $('pagesWrap') || $('pages');
    if (wrap) wrap.style.display = on ? 'none' : '';
  }

  /** 空行过多时的提示条（可一键删除空行） */
  function showBlankHint(n) {
    const el = $('blankHint');
    if (!el) return;
    if (!n) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = '<span>⚠️ 文中有 <b>' + n + '</b> 个空行，会占掉大量版面（公文段间通常不留空行）。</span>' +
      '<button class="btn ghost" id="btnDropBlank" style="padding:3px 9px;font-size:11.5px">删除全部空行</button>';
    const b = $('btnDropBlank');
    if (b) b.onclick = () => {
      cfg.blank_line_mode = 'delete_all';
      const sel = $('q_blank');
      if (sel) sel.value = 'delete_all';
      const c2 = $('c_blank_line_mode');
      if (c2) c2.value = 'delete_all';
      runParse();
      saveLast();
    };
  }

  /* ---------------- 预览：真正的分页预览 ---------------- */

  /* 纸张尺寸按配置算（cm）。force_a4 打开时强制 A4；
     默认就是 A4，但用户可以把纸张换成 A3 / B5 / 16 开 / Letter。 */
  function paperCm() {
    if (cfg.force_a4 === true) return { w: 21, h: 29.7 };
    const p = (D.PAPER_MAP || {})[cfg.paper_size] || { w: 210, h: 297 };
    return { w: p.w / 10, h: p.h / 10 };
  }
  function paperPx() {
    const p = paperCm();
    return { w: p.w * 96 / 2.54, h: p.h * 96 / 2.54 };
  }
  let zoomLevel = 80;
  let fitMode = false;

  function clampZoom(z) {
    // 1% 精度：不再吸附到 5% 的整数倍，用户可以精确停在 87%、133% 这样的值
    const n = Math.round(parseFloat(z) || 80);
    return Math.max(30, Math.min(200, n));
  }

  /** 应用缩放：只用 transform:scale()。
      不能改用 CSS zoom —— zoom 会改变元素的布局宽度，文字在缩放时会重新换行，
      于是每一档缩放的断行位置都不一样（用户实测：100% 以上正常、100% 以下一直乱换行）。
      transform 只做视觉缩放，排版宽度恒为 A4，所有缩放级别的断行完全一致。
      外层 .pageswrap 按「自然尺寸 × 缩放比」占位，这样滚动条与居中仍然正确。 */
  function applyZoom(z) {
    zoomLevel = clampZoom(z);
    const host = $('pages');
    const wrap = $('pagesWrap');
    if (!host) return;
    const k = zoomLevel / 100;
    /* 自然尺寸要在「未缩放」状态下量 —— transform 虽然不改布局，
       但取 scrollWidth 时若元素处于 scale 状态，部分浏览器返回的是视觉尺寸。 */
    host.style.transform = 'none';
    const natW = host.scrollWidth || paperPx().w;
    const natH = host.scrollHeight || 0;
    host.style.transform = 'scale(' + k + ')';
    if (wrap) {
      wrap.style.width = Math.ceil(natW * k) + 'px';
      wrap.style.height = Math.ceil(natH * k) + 'px';
    }
    if ($('zoom')) $('zoom').value = String(zoomLevel);
    if ($('zoomPct')) $('zoomPct').value = String(zoomLevel);
  }

  function setZoom(z) {
    fitMode = false;
    applyZoom(z);
  }

  function stepZoom(delta) {
    setZoom(zoomLevel + delta);
  }

  /** 绑定缩放按钮：单击 1%（精确），Shift+单击 10%（快调），按住可连续走 */
  function bindZoomButton(btn, dir) {
    if (!btn) return;
    let timer = null, delay = null;
    const bump = (big) => stepZoom(dir * (big ? 10 : 1));
    const startHold = () => {
      delay = setTimeout(() => {
        timer = setInterval(() => bump(true), 90);
      }, 420);
    };
    const stopHold = () => {
      clearTimeout(delay); clearInterval(timer);
      delay = null; timer = null;
    };
    btn.addEventListener('click', e => { if (!e.shiftKey) bump(false); });
    btn.addEventListener('mousedown', e => { if (!e.shiftKey) startHold(); });
    ['mouseup', 'mouseleave', 'blur'].forEach(t => btn.addEventListener(t, stopHold));
    // Shift 单击：一次性 10%
    btn.addEventListener('click', e => { if (e.shiftKey) bump(true); });
  }

  /** 适应可用宽度 */
  function fitWidth() {
    const view = $('view');
    if (!view) return;
    const cs = getComputedStyle(view);
    const availW = view.clientWidth - (parseFloat(cs.paddingLeft) || 0) -
                   (parseFloat(cs.paddingRight) || 0) - 8;
    fitMode = true;
    applyZoom(Math.floor(availW / paperPx().w * 100));
  }

  /* ---------------- 左栏宽度拖拽 ---------------- */

  const LEFT_MIN = 260;
  const LEFT_MAX = 720;
  const LEFT_DEFAULT = 400;
  const LEFT_KEY = 'textformatter.leftw.v1';

  function setLeftWidth(px) {
    const w = Math.max(LEFT_MIN, Math.min(LEFT_MAX, Math.round(px)));
    document.documentElement.style.setProperty('--leftw', w + 'px');
    try { localStorage.setItem(LEFT_KEY, String(w)); } catch (e) {}
    if (fitMode) fitWidth();
    return w;
  }

  function getLeftWidth() {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--leftw'), 10);
    return isNaN(v) ? LEFT_DEFAULT : v;
  }

  function bindSplitter() {
    const sp = $('splitter');
    if (!sp) return;
    try {
      const saved = parseInt(localStorage.getItem(LEFT_KEY), 10);
      if (saved) setLeftWidth(saved);
    } catch (e) {}

    let dragging = false;
    const onMove = (x) => {
      if (!dragging) return;
      const rect = document.querySelector('main').getBoundingClientRect();
      setLeftWidth(x - rect.left);
    };
    sp.addEventListener('mousedown', e => {
      dragging = true;
      sp.classList.add('on');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => onMove(e.clientX));
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('on');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
    // 双击：收起 / 展开（收起时留 0 宽并隐藏左栏）
    sp.addEventListener('dblclick', () => {
      const left = $('colLeft');
      if (!left) return;
      const collapsed = left.dataset.collapsed === '1';
      if (collapsed) {
        left.dataset.collapsed = '0';
        left.style.display = '';
        setLeftWidth(getLeftWidth() || LEFT_DEFAULT);
      } else {
        left.dataset.collapsed = '1';
        left.style.display = 'none';
        setLeftWidth(LEFT_MIN);
      }
      if (fitMode) fitWidth();
    });
    // 键盘：聚焦分隔条后 ← → 微调
    sp.setAttribute('tabindex', '0');
    sp.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setLeftWidth(getLeftWidth() - (e.shiftKey ? 40 : 8)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setLeftWidth(getLeftWidth() + (e.shiftKey ? 40 : 8)); }
    });
  }

  /* ---------------- 界面紧凑度（整体缩字） ---------------- */

  const DENSITY_KEY = 'textformatter.density.v1';
  const DENSITY_STEPS = [1, 0.92, 0.84, 0.76];
  const DENSITY_LABELS = ['标准', '紧凑', '更小', '最小'];
  let densityIndex = 0;

  function applyDensity(i) {
    densityIndex = ((i % DENSITY_STEPS.length) + DENSITY_STEPS.length) % DENSITY_STEPS.length;
    document.body.style.setProperty('--ui-scale', String(DENSITY_STEPS[densityIndex]));
    const btn = $('btnDensity');
    if (btn) {
      btn.textContent = DENSITY_LABELS[densityIndex];
      btn.title = '界面字号：' + DENSITY_LABELS[densityIndex] + '（点击切换）';
    }
    try { localStorage.setItem(DENSITY_KEY, String(densityIndex)); } catch (e) {}
    if (fitMode) fitWidth();
  }

  function bindDensity() {
    let saved = 0;
    try {
      const v = parseInt(localStorage.getItem(DENSITY_KEY), 10);
      if (!isNaN(v)) saved = v;
    } catch (e) {}
    applyDensity(saved);
    const btn = $('btnDensity');
    if (btn) btn.addEventListener('click', () => applyDensity(densityIndex + 1));
    // Ctrl+Shift+= / Ctrl+Shift+- 也能调
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key === '>' || e.key === '.') { e.preventDefault(); applyDensity(densityIndex - 1); }
      else if (e.key === '<' || e.key === ',') { e.preventDefault(); applyDensity(densityIndex + 1); }
    });
  }


  /* 注：原先有个 outerHeight(el) = offsetHeight + marginTop + marginBottom，已移除。
     浏览器会合并相邻块的上下外边距，逐块相加会高估总高度导致多分页，
     现在改用相邻块 getBoundingClientRect().top 之差来量真实占用高度。 */

  /** 一页可容纳的内容高度 = A4 高度 − 上下页边距。
      注意：不能用 page.offsetHeight / clientHeight —— 调用时页里已经放进了全部内容，
      .page 是 min-height + 自动高度，量出来的是「整篇高度」而不是「一页可用高度」，
      这会让分页永不触发（长文档只显示一页的根因之一）。 */
  function pageContentHeight(pageEl) {
    const cs = getComputedStyle(pageEl);
    return paperPx().h - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  }

  /** 造一个空白页（纸张尺寸按配置）：页眉 + 正文容器 + 页脚页码 + 页码角标 */
  function makePage(index, printedNumber) {
    const el = document.createElement('div');
    el.className = 'page';
    const papel = paperCm();
    el.style.width = papel.w + 'cm';
    el.style.minHeight = papel.h + 'cm';
    el.style.setProperty('--padt', cfg.margin_top + 'cm');
    el.style.setProperty('--padb', cfg.margin_bottom + 'cm');
    el.style.setProperty('--padl', cfg.margin_left + 'cm');
    el.style.setProperty('--padr', cfg.margin_right + 'cm');
    /* 页眉/页脚距纸张边缘的距离（.hdr / .ftr 的定位基准），
       原来写死 1.35cm / 1.1cm，改配置后预览不跟着动。 */
    el.style.setProperty('--hdrDist', (cfg.header_distance != null ? cfg.header_distance : 1.5) + 'cm');
    el.style.setProperty('--ftrDist', (cfg.footer_distance != null ? cfg.footer_distance : 1.75) + 'cm');

    if (cfg.enable_header && cfg.header_text) {
      const h = document.createElement('div');
      h.className = 'hdr';
      h.textContent = String(cfg.header_text).split('\n')[0];
      h.style.textAlign = cfg.header_align || 'center';
      h.style.fontFamily = q(cfg.header_font);
      h.style.fontSize = (cfg.header_size || 14) + 'pt';
      el.appendChild(h);
    }

    const doc = document.createElement('div');
    doc.className = 'doc';
    // 空格高亮模式下给 .doc 加类，让 CSS 打开 white-space:pre-wrap
    if (cfg.space_highlight === true) doc.classList.add('showspace');
    el.appendChild(doc);

    if (cfg.page_number_format !== 'none') {
      const f = document.createElement('div');
      f.className = 'ftr';
      f.textContent = pvPageNumber(printedNumber);
      const pos = cfg.page_number_position;
      f.style.textAlign = /right/.test(pos) ? 'right' : 'center';
      f.style.fontFamily = q(cfg.page_number_font);
      f.style.fontSize = (cfg.page_number_size || 14) + 'pt';
      el.appendChild(f);
    }

    const badge = document.createElement('span');
    badge.className = 'pnum';
    badge.textContent = String(index);
    el.appendChild(badge);

    return el;
  }

  /* ---------------- 长段落跨页续排 ----------------
     Word 里一个长段落会自动从本页底部续到下一页继续排；
     若预览把整段当作「不可拆分单位」，页面底部就会留下大片空白
     （实测：一段 485px、可用 851px 时每页只放得下一段，底部空 366px）。
     这里用 Range 量行盒，把段落按整行切开：
     前一段留在本页（保留首行缩进），后一段推到下一页（续排，不带首行缩进）。 */

  /** 找出「从段首开始、能在 room 像素内排完」的最大字符数；返回 0 表示一行都放不下 */
  function charsFitting(el, room) {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return 0;
    const len = node.data.length;
    if (!len) return 0;

    /* 强制回流再量。元素刚被 appendChild 到新页时，浏览器可能还没重新布局，
       这时 getBoundingClientRect / Range.getClientRects 拿到的都是旧位置，
       二分查找会得出「整段都放得下」的错误结论，于是该切的地方不肯切
       （实测某页明明只剩 403px，段落 410px，却判成 274 个字全放得下，
        结果整段被推到下一页，那一页白留 403px）。 */
    void el.offsetHeight;

    const elRect = el.getBoundingClientRect();
    const limit = elRect.top + room;
    const range = document.createRange();
    let lo = 1, hi = len, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      range.setStart(node, 0);
      range.setEnd(node, mid);
      const rects = range.getClientRects();
      if (!rects.length) { lo = mid + 1; continue; }
      /* 有多个行盒时最后一个就是当前行；它的 bottom 决定是否越界 */
      if (rects[rects.length - 1].bottom <= limit + 0.5) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    /* 复核：把切点后面的字临时摘掉不会改变前面已排好的行，
       但若 best 已经等于全长而整段确实超过 room，说明测量仍不可靠 —— 退一格重试。 */
    if (best >= len) {
      const cs = getComputedStyle(el);
      const lineH = parseFloat(cs.lineHeight) || 0;
      const fullH = elRect.height;
      if (fullH > room + 0.5 && lineH > 0) {
        /* 按「能放几行」粗算兜底，再二分确认 */
        const lines = Math.max(1, Math.floor(room / lineH));
        let guess = Math.min(len, Math.max(1, Math.floor(len * lines / Math.max(1, Math.round(fullH / lineH)))));
        while (guess > 0) {
          range.setStart(node, 0);
          range.setEnd(node, guess);
          const rr = range.getClientRects();
          if (rr.length && rr[rr.length - 1].bottom <= limit + 0.5) break;
          guess--;
        }
        best = guess;
      }
    }
    return best;
  }

  /** 该块能否被拆开续排（只拆正文段落）。
      表格/图片（有子元素）、空行、主标题、各级标题、题注都不拆 ——
      标题被劈成两半落在两页上是最明显的排版事故。 */
  function canSplitBlock(el) {
    if (!el || el.children.length) return false;           // 有子元素（表格/图片）不拆
    if (el.classList.contains('blk-blank')) return false;   // 空行已在分页里单独处理
    if (el.classList.contains('blk-title')) return false;   // 主标题不拆
    if (el.classList.contains('blk-sub')) return false;     // 副标题不拆
    if (el.classList.contains('blk-head')) return false;    // 各级标题不拆
    if (el.classList.contains('blk-cap')) return false;     // 图表题注不拆
    if (el.classList.contains('blk-sal')) return false;     // 主送机关不拆
    const node = el.firstChild;
    if (!node || node.nodeType !== 3 || node.data.length < 8) return false;
    return true;
  }

  /** 某一页里「已经用掉多少高度」。
      直接量最后一个子块的下边缘到页面内容区上边缘的距离，
      不做任何算术累加 —— 累加会在「段前距 > 段后距」或「相邻外边距合并」时产生偏差，
      几块下来累积十几到几十像素（实测同一次分页里有的页少算 20px、有的页多算 4px），
      于是表现为「有时候明明还剩空间却分页了，有时候又挤得溢出」。

      注意：这里**不含最后一块的下外边距**。页底的行尾空白在 Word 里也是被忽略的
      （下一块从新页顶部开始，不存在「继承上页页尾空白」这回事），
      把它算进来反而会把本来放得下的块误判成溢出。 */
  function pageUsed(doc) {
    if (!doc || !doc.children.length) return 0;
    const page = doc.parentNode;
    if (!page) return 0;
    const cs = getComputedStyle(page);
    const top = page.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0);
    let bottom = 0;
    for (const k of doc.children) {
      const r = k.getBoundingClientRect();
      if (r.bottom > bottom) bottom = r.bottom;
    }
    return bottom - top;
  }

  /** 该块顶部会带来多少「额外」间距（块的上外边距，会被浏览器与上一块的段后距合并取大者）。
      判断「还能不能再放一块」时必须把它算上，否则下一块的段前距会把内容顶出页面。 */
  function topGap(el) {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    return parseFloat(cs.marginTop) || 0;
  }

  /** 从段首开始，最多多少个字还能排进本页剩余空间 */
  function charsFittingInPage(doc, el, avail) {
    const node = el && el.firstChild;
    if (!node || node.nodeType !== 3) return 0;
    const len = node.data.length;
    if (!len) return 0;
    const page = doc.parentNode;
    if (!page) return 0;
    /* 刚 append 的元素浏览器可能还没重排，量到的是旧位置 —— 强制回流 */
    void doc.offsetHeight;
    const cs = getComputedStyle(page);
    const contentTop = page.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0);
    const limit = contentTop + avail;
    const range = document.createRange();
    let lo = 1, hi = len, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      range.setStart(node, 0);
      range.setEnd(node, mid);
      const rects = range.getClientRects();
      if (!rects.length) { lo = mid + 1; continue; }
      /* 多个行盒时最后一个就是当前行，用它的 bottom 判断是否越界 */
      if (rects[rects.length - 1].bottom <= limit + 0.5) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }

    /* 兜底：二分说「整段都放得下」但页面确实溢出时，测量结果不可靠
       （元素刚挂进新页、字体尚未完成布局等）。改为按行数粗算再逐字复核，
       否则会判成「不用切」，整段被推到下一页，上一页白留一大片空白。 */
    const elRect = el.getBoundingClientRect();
    const ecs = getComputedStyle(el);
    let lineH = parseFloat(ecs.lineHeight);
    if (!isFinite(lineH) || lineH <= 0) lineH = (parseFloat(ecs.fontSize) || 16) * 1.6;
    const roomPx = limit - elRect.top;
    if (best >= len && elRect.height > roomPx + 0.5 && lineH > 0) {
      const totalLines = Math.max(1, Math.round(elRect.height / lineH));
      const fitLines = Math.max(0, Math.floor(roomPx / lineH));
      let guess = Math.min(len - 1, Math.max(0, Math.floor(len * fitLines / totalLines)));
      while (guess > 0) {
        range.setStart(node, 0);
        range.setEnd(node, guess);
        const rr = range.getClientRects();
        if (rr.length && rr[rr.length - 1].bottom <= limit + 0.5) break;
        guess--;
      }
      best = guess;
    }
    return best;
  }

  /** 该块「至少要占多高」才不至于孤零零留在页尾。
      可拆的段落只需一行的高度（剩下的可以续排到下一页），
      不可拆的块（表格、短段落、题注、标题）则要整块高度。
      fullH 传 0 或省略时会现场量 —— 早先调用方一律传 0，导致返回值恒为 0，
      标题防孤行判断从不触发（标题照样孤零零留在页尾）。 */
  function minKeepHeight(el, fullH) {
    const h = (fullH > 0) ? fullH : (el ? el.getBoundingClientRect().height : 0);
    if (!canSplitBlock(el)) return h;
    const cs = getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (!isFinite(lh) || lh <= 0) {
      lh = (parseFloat(cs.fontSize) || 16) * 1.6;
    }
    return Math.min(lh, h || lh);
  }

  function renderPreview() {
    if (!blocks.length) { showEmpty(true); return; }
    showEmpty(false);

    const host = $('pages');
    /* 量尺寸前必须摘掉缩放：transform:scale 会影响 getBoundingClientRect 的返回值，
       带着缩放量出来的块高会被乘上缩放比，分页就全乱了。量完在函数末尾重新 applyZoom。 */
    host.style.transform = '';
    host.innerHTML = '';

    const startNo = parseInt(cfg.page_number_start, 10) || 1;

    let page = makePage(1, startNo);
    host.appendChild(page);
    let doc = page.querySelector('.doc');
    doc.innerHTML = blocks.map(blockToHtml).join('');

    /* 分页：先在第一页里把所有块排好并量出高度（各页宽度一致，高度可复用），
       再按「可用高度」贪心切页。这就是之前长文本只显示一页的修复点 ——
       旧实现只有一个 .page 容器且 overflow:hidden，超出的内容被直接裁掉。

       高度必须用「相邻块 top 之差」来量，不能用 每块 offsetHeight + marginTop + marginBottom 累加：
       浏览器会合并相邻块的外边距（margin collapsing），逐块相加会系统性高估总高度，
       于是本该一页放完的文档被切成两页，页面底部留出大片空白。
       用 top 之差得到的是「真实排版流里占用的高度」，边距合并已被浏览器算掉。 */
    const avail = pageContentHeight(page);

    /* 单遍分页：每块「放进去 → 量真实几何 → 放不下才处理」。
       这里刻意**只有一处切分点**。早先的实现除了这个主循环，后面还有一段
       「事后校验再切一次」的循环，两套逻辑互相踩：同一段落被反复切开，
       实测一个整段被切成 27/27/27/132 四个碎片，页首孤零零落着一行
       （用户看到的「掌」「握」被拆到两页就是它造成的）。
       去掉事后切分后，每段每一页最多切一刀，且切点由 Range 落在行边界上。 */
    const items = Array.from(doc.children);
    /* 先把每块的高度和行高量好再摘出来。
       为什么要提前量：标题防孤行必须知道「下一块至少要多高」，
       而下一块那时还在队列里、没排进任何页面，getBoundingClientRect 全是 0，
       事前判断必然失准（这就是「标题孤零零留在页尾」的根因）。
       此刻所有块都还在第一页里、宽度就是正文宽度，量出的高度是准确的。 */
    const queue = items.map(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      let lh = parseFloat(cs.lineHeight);
      if (!isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 16) * 1.6;
      return { el, h: r.height, lh };
    });
    for (const it of queue) {
      if (it.el.parentNode) it.el.parentNode.removeChild(it.el);
    }

    let pageIdx = 1;

    /** 开新页，并把 doc 指针移过去 */
    function nextPage() {
      pageIdx++;
      page = makePage(pageIdx, startNo + pageIdx - 1);
      host.appendChild(page);
      doc = page.querySelector('.doc');
    }

    /* 切下来的头/尾都至少要有这么多字，否则宁可不切 ——
       避免出现「掌握」只剩一个字、或整页只放一行残段的难看情形。
       取 4 而不是更大：正文一行的字数一般是 28 个汉字，剩 4 个字说明真的还能
       排下一行；反过来，卡到 8 会让很多「本页还能再放一行」的机会被放掉，
       结果是明明还有空间却整段挪走（实测 A 类白留从 0 例反弹到 3 例）。 */
    var MIN_PIECE = 4;

    for (let qi = 0; qi < queue.length; qi++) {
      const el = queue[qi].el;
      if (!el) continue;

      const isH1 = el.dataset && el.dataset.lv === '1';
      const isHead = !!(el.dataset && el.dataset.lv);
      const isBlank = !!(el.classList && el.classList.contains('blk-blank'));

      /* 「一级标题前分页」是可选项 */
      if (cfg.add_page_break_before_h1 && isH1 && pageUsed(doc) > 0) nextPage();

      /* 空行不参与分页决策 —— 真实公文段与段之间没有空行，这些多半来自粘贴。
         规则：页首的空行丢掉；会溢出的空行也丢掉，而不是为它另开一页。 */
      if (isBlank) {
        if (pageUsed(doc) === 0) continue;                     // 页首空行直接丢
        doc.appendChild(el);
        if (pageUsed(doc) > avail + 0.5) el.remove();           // 放不下也丢
        continue;
      }

      /* 放进当前页，然后量真实占用（不做算术估算 —— 见 pageUsed 的注释） */
      doc.appendChild(el);
      let used = pageUsed(doc);

      /* 标题防孤行：标题放下了，但它后面连一行正文都放不下时，把标题一起挪到下一页。
         仅当本页前面已有其它块，否则挪了也没用。
         「下一块至少要多高」用队列里预量好的值（见 queue 的注释）——
         可拆的段落只需一行高度（剩下能续排），不可拆的块要整块高度。

         注意要**跳过标题与正文之间的空行块**再量：选了「只在标题后留空行」时，
         标题后面紧跟一个 h=37 的空行块，若只量紧邻那一个，会以为「还剩 37px 够放」，
         于是标题连空行一起留在页底，真正的正文却整段跳到了下一页 ——
         看起来就是标题孤零零挂在页尾（正文是「（五）……」那一条）。
         空行本身没有意义，必须有正文跟着才留得住。 */
      if (isHead && used <= avail + 0.5 && doc.children.length > 1 && qi + 1 < queue.length) {
        const roomLeft = avail - used;
        if (roomLeft > 0.5) {
          /* 累加紧随其后的空行块高度 */
          let j = qi + 1, gap = 0;
          while (j < queue.length && queue[j].el.classList &&
                 queue[j].el.classList.contains('blk-blank')) { gap += queue[j].h || 0; j++; }
          if (j < queue.length) {
            const nx = queue[j];
            let need;
            if (canSplitBlock(nx.el)) {
              need = nx.lh || 0;
              if (!need) need = nx.h || 0;
            } else {
              need = nx.h || 0;
            }
            if (gap + need > roomLeft + 0.5) {
              el.remove();
              nextPage();
              doc.appendChild(el);
              used = pageUsed(doc);
            }
          }
        }
      }

      if (used <= avail + 0.5) continue;                       // 放得下，处理下一块

      /* ---- 放不下：先试着按整行切一刀（长段落跨页续排，与 Word 一致）----
         Word 里长段落会从本页底部续到下一页继续排；若把整段当作不可拆分单位，
         一段比剩余空间长就只能整段跳到下一页，页面底部留下大片空白。
         这里用 Range 逐行量出切点，切点落在行边界上，不会把一行劈成两半。 */
      let cut = 0;
      if (canSplitBlock(el)) {
        const node0 = el.firstChild;
        const full0 = node0 ? node0.data : '';
        let n0 = charsFittingInPage(doc, el, avail);
        /* 复核：Range 量出的切点偶尔偏乐观 1 行（页高会随之被撑高 7~8px，
           实测 A4 1122.5px 被撑到 1130.3px）。这里真把文字截上去再量一次，
           仍然溢出就按整行退回，直到放得下 —— 保证切完的页一点不溢出。
           注意退出循环后必须把 node0.data 还原成全文，否则正式切分时会读到截断后的文本。 */
        if (n0 > 0 && n0 < full0.length) {
          const cs0 = getComputedStyle(el);
          let lh0 = parseFloat(cs0.lineHeight);
          if (!isFinite(lh0) || lh0 <= 0) lh0 = (parseFloat(cs0.fontSize) || 16) * 1.6;
          for (let guard = 0; guard < 80 && n0 > 0; guard++) {
            node0.data = full0.slice(0, n0);
            if (pageUsed(doc) <= avail + 0.5) break;
            /* 退一整行：按「当前截断后平均每行多少字」估，逐轮收敛 */
            const h = el.getBoundingClientRect().height;
            const lines = Math.max(1, Math.round(h / lh0));
            const charsPerLine = Math.max(1, Math.round(n0 / lines));
            n0 = Math.max(0, n0 - charsPerLine);
          }
          node0.data = full0;                 // 还原全文，正式切分时再截
        }
        if (n0 >= MIN_PIECE && full0.length - n0 >= MIN_PIECE) cut = n0;
      }
      if (cut > 0) {
        const node = el.firstChild;
        const full = node.data;
        node.data = full.slice(0, cut).replace(/\s+$/, '');
        const tail = el.cloneNode(false);
        tail.classList.add('cont');        // .cont 去掉首行缩进（续排段不再缩进两格）
        tail.textContent = full.slice(cut).replace(/^\s+/, '');
        nextPage();
        doc.appendChild(tail);
        /* 尾巴仍然比一整页长 → 插回队列，下一轮继续切 */
        if (pageUsed(doc) > avail + 0.5) queue.splice(qi + 1, 0, { el: tail });
        continue;
      }

      /* 切不了（标题/表格/太短的段落）→ 整块挪到下一页。
         本页后面若还有内容，挪走不会白留；挪完仍超高就让它把页面撑高。 */
      if (doc.children.length > 1) {
        el.remove();
        nextPage();
        doc.appendChild(el);
        used = pageUsed(doc);
      }

      /* 单块比一整页还高（超大表格 / 超长不可拆段）：
         让这一页长高，而不是被 overflow:hidden 裁掉。 */
      if (used > avail + 0.5 && doc.children.length === 1) {
        const cs = getComputedStyle(page);
        page.style.minHeight = (used + (parseFloat(cs.paddingTop) || 0) +
          (parseFloat(cs.paddingBottom) || 0) + 2) + 'px';
      }
    }

    /* ---- 事后收尾：只挪标题，绝不切分段落 ----
       分页主循环里已经做了标题防孤行，但那时「下一块」还没排进页面，
       量出来的是游离元素的 0 高度，判断必然失准（这就是「标题孤零零
       留在页尾」的来源）。全部页面建好之后再核一遍，此时几何是真实终态。

       这里刻意**只做搬移、不做切分**：切分只允许发生在主循环那一处，
       否则两套切分逻辑互相踩，同一段落会被反复切开、断在词中间
       （实测整段被切成 27/27/27/132 四个碎片，页首孤零零落着一行）。 */
    for (let pass = 0; pass < 6; pass++) {
      const all = Array.from(host.children);
      let moved = false;
      for (let i = 0; i < all.length; i++) {
        const p = all[i];
        const d = p.querySelector('.doc');
        if (!d) continue;
        const av = pageContentHeight(p);

        /* 页尾是标题、而这一页还有其它内容 → 把标题挪到下一页开头。
           只在「标题是页尾最后一两个块」时动手，且标题链（连续多级标题）
           一起挪，避免把「一、」挪走而「（一）」留下。 */
        const last = d.lastElementChild;
        if (last && last.dataset && last.dataset.lv && d.children.length > 1) {
          /* 找出页尾这一串连续标题的起点 */
          let k = d.children.length - 1;
          while (k > 0 && d.children[k - 1].dataset && d.children[k - 1].dataset.lv) k--;
          const chain = Array.from(d.children).slice(k);
          /* 后面还有页才挪；挪走后本页不能变成空页 */
          const np = all[i + 1];
          if (np && chain.length < d.children.length) {
            const nd = np.querySelector('.doc');
            if (nd) {
              /* 先量下一页还剩多少空间，装不下就不挪 —— 挪过去撑出页面
                 比标题留在页尾更糟（溢出会被 .page 的 overflow:hidden 裁掉）。 */
              const nav = pageContentHeight(np);
              let need = 0;
              for (const c of chain) {
                const r = c.getBoundingClientRect();
                const cs2 = getComputedStyle(c);
                need += r.height + (parseFloat(cs2.marginBottom) || 0);
              }
              const nused = pageUsed(nd);
              if (nav - nused >= need - 0.5) {
                for (const c of chain) nd.insertBefore(c, nd.firstChild);
                moved = true;
              }
            }
          }
        }
      }
      if (!moved) break;
    }

    // 统一角标为「当前 / 总页数」
    const pages = Array.from(host.children);
    pages.forEach((p, i) => {
      const b = p.querySelector('.pnum');
      if (b) b.textContent = (i + 1) + ' / ' + pages.length;
    });

    applyZoom(zoomLevel);
    renderStats();   // 页数只有分页完成后才知道，所以放在这里
  }

  function pvPageNumber(n) {
    const fmt = cfg.page_number_format;
    const pre = cfg.page_number_prefix || '', suf = cfg.page_number_suffix || '';
    if (fmt === 'chinese') return pre + X.toChineseNumber(n) + suf;
    if (fmt === 'roman') return pre + X.toRoman(n, true) + suf;
    return pre + n + suf;
  }

  /** 左/右缩进 → em。优先用新的「值 + 单位」，没有就回落到旧的厘米键（兼容老配置/老方案）。 */
  function sideIndentEm(side) {
    const v = cfg[side + '_indent_value'];
    const unit = cfg[side + '_indent_unit'] || 'cm';
    if (v != null && v !== '') return indentEm(v, unit, cfg.body_size);
    return indentEm(cfg[side + '_indent_cm'], 'cm', cfg.body_size);
  }

  /** 左右缩进的 CSS 片段（padding 而非 margin：不参与外边距合并，量块高时更准） */
  function sideIndentCss() {
    const l = sideIndentEm('left'), r = sideIndentEm('right');
    let s = '';
    if (l) s += 'padding-left:' + l.toFixed(3) + 'em;';
    if (r) s += 'padding-right:' + r.toFixed(3) + 'em;';
    return s;
  }

  function blockToHtml(b) {
    const ls = previewLineHeight();
    switch (b.type) {
      case 'title': {
        const tInd = Number(cfg.title_indent_chars) || 0;
        return '<p class="blk-title" style="text-align:' + (cfg.title_align || 'center') +
          ';font-family:' + q(cfg.title_font) + ';font-size:' + cfg.title_size + 'pt;' +
          'font-weight:' + (roleBold('title') ? '700' : '400') + ';' +
          (tInd ? 'text-indent:' + tInd + 'em;' : '') +
          'margin:' + pt2em(cfg.title_space_before) + ' 0 ' + pt2em(cfg.title_space_after) + ';' +
          /* 主标题行距：设了独立规则就用它，否则沿用 title_line_spacing 的倍率语义 */
          'line-height:' + ((cfg.title_line_rule && cfg.title_line_rule !== 'inherit')
            ? previewLineHeight('title', cfg.title_size)
            : fixedLineHeight(cfg.title_line_spacing || 1)) + ';">' + txt(b.text) + '</p>';
      }
      case 'subtitle':
        return '<p class="blk-sub" style="text-align:center;font-family:' + q(cfg.subtitle_font) +
          ';font-size:' + cfg.subtitle_size + 'pt;font-weight:' + (roleBold('subtitle') ? '700' : '400') +
          ';margin:' + pt2em(cfg.title_space_after) + ' 0;line-height:' +
          ((cfg.subtitle_line_rule && cfg.subtitle_line_rule !== 'inherit')
            ? previewLineHeight('subtitle', cfg.subtitle_size)
            : fixedLineHeight(cfg.subtitle_line_spacing || 1)) + ';">' +
          txt(b.text) + '</p>';
      case 'heading': {
        const lv = b.level;
        const font = cfg['h' + lv + '_font'];
        const size = cfg['h' + lv + '_size'];
        /* 各级标题可各自设定首行缩进字符数（h1~h4_indent_chars），0 = 顶格 */
        const hInd = Number(cfg['h' + lv + '_indent_chars']) || 0;
        /* 各级标题行距可独立设置（h1~h4_line_rule），inherit 时跟随正文 */
        const hLs = previewLineHeight('h' + lv, size);
        return '<p class="blk-head" data-lv="' + lv + '" style="font-family:' + q(font) +
          ';font-size:' + size + 'pt;' +
          'font-weight:' + (roleBold('h' + lv) ? '700' : '400') + ';' +
          (hInd ? 'text-indent:' + hInd + 'em;' : '') + sideIndentCss() +
          'margin:' + pt2em(cfg.heading_space_before) + ' 0 ' + pt2em(cfg.heading_space_after) + ';' +
          'line-height:' + hLs + ';">' + txt(b.text) + '</p>';
      }
      case 'salutation':
        /* 主送机关：顶格、不缩进、左对齐 */
        return '<p class="blk-sal" style="text-align:left;font-family:' + q(cfg.salutation_font) +
          ';font-size:' + cfg.salutation_size + 'pt;font-weight:' + (roleBold('salutation') ? '700' : '400') +
          ';margin:' + pt2em(cfg.body_space_after) + ' 0;line-height:' +
          previewLineHeight('salutation', cfg.salutation_size) + ';">' +
          txt(b.text) + '</p>';
      case 'attachment':
        return '<p class="blk-att" style="font-family:' + q(cfg.attachment_font) + ';font-size:' + cfg.attachment_size +
          'pt;margin:' + pt2em(cfg.heading_space_before) + ' 0;line-height:' + ls + ';">' +
          txt(b.text) + '</p>';
      case 'table_caption':
        return '<p class="blk-cap" style="font-family:' + q(cfg.table_caption_font) +
          ';font-size:' + cfg.table_caption_size + 'pt;font-weight:' + (roleBold('table_caption') ? '700' : '400') +
          ';">' + txt(b.text) + '</p>';
      case 'figure_caption':
        return '<p class="blk-cap" style="font-family:' + q(cfg.figure_caption_font) +
          ';font-size:' + cfg.figure_caption_size + 'pt;font-weight:' + (roleBold('figure_caption') ? '700' : '400') +
          ';">' + txt(b.text) + '</p>';
      case 'table': {
        if (cfg.enable_table_formatting === false) {
          return b.rows.map(r => '<p class="blk-body" style="font-family:' + q(cfg.table_font) +
            ';font-size:' + cfg.table_size + 'pt;">' + escapeHtml(r.join('  ')) + '</p>').join('');
        }
        let h = '<table style="font-family:' + q(cfg.table_font) + ';font-size:' +
          cfg.table_size + 'pt;line-height:' + tableLineHeight() + '">';
        b.rows.forEach((row, ri) => {
          const isHead = (ri === 0 && cfg.table_header_bold);
          const tag = isHead ? 'th' : 'td';
          const cellStyle = isHead
            ? ' style="font-family:' + q(cfg.table_header_font) + ';font-size:' +
              (cfg.table_header_size || cfg.table_size) + 'pt;font-weight:700"'
            : '';
          h += '<tr>';
          row.forEach(c => { h += '<' + tag + cellStyle + '>' + escapeHtml(c) + '</' + tag + '>'; });
          h += '</tr>';
        });
        return h + '</table>';
      }
      case 'image':
        return '<p class="blk-cap" style="color:#94a3b8">［图片：' + escapeHtml(b.name || '') + '］</p>';
      case 'blank': {
        /* 空行必须和 Word 里的一整行等高：Word 里一个空段落 = 一个正文行（固定值 28 磅）。
           不设 font-size 时它继承 body 的 13px，预览里空行只有真行的三分之一高，
           与导出结果不一致。这里显式给正文的字体与字号。 */
        let h = '';
        const n = Math.max(1, Math.min(4, b.count || 1));
        const st = 'font-family:' + q(cfg.body_font) + ';font-size:' + cfg.body_size +
          'pt;line-height:' + ls + ';margin:0';
        for (let k = 0; k < n; k++) h += '<p class="blk-blank" style="' + st + '">&nbsp;</p>';
        return h;
      }
      default:
        return '<p class="blk-body" style="font-family:' + q(cfg.body_font) + ';font-size:' + cfg.body_size +
          'pt;text-align:' + bodyAlignCss() + ';' +
          'text-indent:' + (cfg.first_line_indent_chars || 0) + 'em;line-height:' + ls + ';' +
          sideIndentCss() +
          'margin:' + pt2em(cfg.body_space_before) + ' 0 ' + pt2em(cfg.body_space_after) + ';">' +
          txt(b.text) + '</p>';
    }
  }

  /* 正文对齐：配置里的 both/distribute 映射为 CSS 值 */
  function bodyAlignCss() {
    const a = cfg.body_align || 'both';
    if (a === 'both') return 'justify';
    if (a === 'distribute') return 'justify-all';
    return a;
  }

  /* ---------------- 粘贴规范化 ---------------- */

  /** 把各种「软换行」统一成 \n（Word/WPS/网页复制常见） */
  function normalizePastedNewlines(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u2028\u2029\u0085\v\f]/g, '\n')
      .replace(/\u00a0/g, ' ');
  }

  /** 极简 HTML → 纯文本：仅在剪贴板只提供 text/html 时兜底 */
  function htmlToPlainForPaste(html) {
    let s = String(html);
    // 块级标签与 <br> 转换成换行，避免段落粘连
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n');
    s = s.replace(/<li[^>]*>/gi, '\n');
    s = s.replace(/<\/t[dh]>/gi, '\t');
    s = s.replace(/<[^>]+>/g, '');
    // 解实体
    s = s.replace(/&nbsp;/g, ' ')
         .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
         .replace(/&amp;/g, '&');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 标题加粗：与 docx.js 的 roleStyle 保持一致 ——
     显式配置优先，未配置时沿用内置规则（三/四级与图表题注加粗）。 */
  function roleBold(role) {
    const explicit = cfg[role + '_bold'];
    if (explicit != null && explicit !== '') return explicit === true || explicit === 'true';
    return role === 'h3' || role === 'h4' || role === 'table_caption' || role === 'figure_caption';
  }

  /* 标题/副标题行距是「倍率」语义（docx.js 用 multiple 写入），预览同样按倍率 */
  function fixedLineHeight(mult) {
    const m = parseFloat(mult) || 1;
    return (m * 1.3).toFixed(2);
  }

  /* 表格行距：docx.js 的 tableLineSpacingAttrs 支持 '1.5'/'2.0'/数字 */
  function tableLineHeight() {
    const v = String(cfg.table_line_spacing || 'single');
    if (v === 'single') return '1.3';
    if (/^[\d.]+$/.test(v)) return (parseFloat(v) * 1.3).toFixed(2);
    return '1.3';
  }

  /** 行距值换算成磅（与 docx.js 的 lineSpacingPt 完全同源，保证预览＝产物） */
  function lineSpacingPt() {
    const v = parseFloat(cfg.line_spacing_value);
    if (!isFinite(v) || v <= 0) return 28;
    if ((cfg.line_spacing_unit || 'pt') === 'mult') {
      return v * (parseFloat(cfg.body_size) || 16);
    }
    return v;
  }

  /** 某一段自己的行距值换算成磅；role 为空时用正文配置 */
  function roleLineSpacingPt(role, roleSize) {
    if (!role) return lineSpacingPt();
    const rule = cfg[role + '_line_rule'];
    if (!rule || rule === 'inherit') return lineSpacingPt();
    const v = parseFloat(cfg[role + '_line_value']);
    const val = isFinite(v) && v > 0 ? v : 28;
    if ((cfg[role + '_line_unit'] || 'pt') === 'mult') {
      /* 倍率按本段自己的字号算（主标题二号 22pt 与正文三号 16pt 不同） */
      return val * (parseFloat(roleSize) || parseFloat(cfg.body_size) || 16);
    }
    return val;
  }

  /**
   * 预览用的 line-height。
   * @param {string} [role] 'title' / 'h1' … — 传了就读该段自己的行距规则
   * @param {number} [roleSize] 该段的字号（倍率行距要用它换算）
   */
  function previewLineHeight(role, roleSize) {
    let rule = cfg.line_spacing_rule;
    let pt = lineSpacingPt();
    let size = parseFloat(cfg.body_size) || 12;
    if (role && cfg[role + '_line_rule'] && cfg[role + '_line_rule'] !== 'inherit') {
      rule = cfg[role + '_line_rule'];
      pt = roleLineSpacingPt(role, roleSize);
      size = parseFloat(roleSize) || size;
    }
    if (rule === 'single') return 1.3;
    if (rule === 'onehalf') return 1.95;
    if (rule === 'double') return 2.6;
    if (rule === 'multiple') {
      const v = role && cfg[role + '_line_rule'] && cfg[role + '_line_rule'] !== 'inherit'
        ? (parseFloat(cfg[role + '_line_value']) || 1)
        : (parseFloat(cfg.line_spacing_value) || 1);
      return (v * 1.3).toFixed(2);
    }
    /* fixed / atLeast：pt 已把「倍」换算成磅，再除以本段字号得到相对行高，
       与 w:line=pt2twip(磅) w:lineRule=exact 语义一致。 */
    return (pt / size).toFixed(2);
  }

  /** 缩进值 → em（字符）。unit = chars / cm / pt，1 字符 = 1 个正文字号 */
  function indentEm(value, unit, sizePt) {
    const v = parseFloat(value);
    if (!isFinite(v) || v === 0) return 0;
    const size = parseFloat(sizePt) || parseFloat(cfg.body_size) || 16;
    if (unit === 'chars') return v;
    if (unit === 'pt') return v / size;
    return (v * 72 / 2.54) / size;   // cm → pt → em
  }

  function pt2em(pt) {
    if (!pt) return '0';
    const size = cfg.body_size || 12;
    return (pt / size).toFixed(2) + 'em';
  }

  /* 字体回退链：主字体在本机没装时用近似的公文字体顶上，
     保证预览里中文字体不会掉回系统默认黑体。
     注意：返回值会被塞进 style="..." 里，字体名必须用【单引号】包裹 ——
     用双引号会在第二个 " 处提前闭合 HTML 属性，导致 font-family 之后
     的所有声明（font-size / line-height / margin / text-indent）被整段丢弃。
     这正是「预览里看不到二号标题、三号正文、首行缩进」的根因。 */
  const FONT_FALLBACKS = {
    '方正小标宋简体': ['方正小标宋_GBK', 'FZXiaoBiaoSong-B05S', '华文中宋', 'STZhongsong'],
    '方正小标宋_GBK': ['方正小标宋简体', 'FZXiaoBiaoSong-B05S', '华文中宋', 'STZhongsong'],
    '仿宋_GB2312': ['仿宋', 'FangSong', 'FZFangSong-Z02S', '华文仿宋', 'STFangsong'],
    '仿宋': ['仿宋_GB2312', 'FangSong', 'FZFangSong-Z02S', 'STFangsong'],
    '方正仿宋': ['方正仿宋_GBK', '方正仿宋简体', '仿宋_GB2312', '仿宋', 'FangSong'],
    '方正仿宋_GBK': ['方正仿宋简体', '仿宋_GB2312', '仿宋', 'FangSong'],
    '楷体_GB2312': ['楷体', 'KaiTi', 'FZKai-Z03S', '华文楷体', 'STKaiti'],
    '楷体': ['楷体_GB2312', 'KaiTi', 'FZKai-Z03S', 'STKaiti'],
    '方正楷体': ['方正楷体_GBK', '方正楷体简体', '楷体_GB2312', '楷体', 'KaiTi'],
    '黑体': ['SimHei', '方正黑体简体', 'FZHei-B01S', '思源黑体', 'Microsoft YaHei'],
    '方正黑体': ['方正黑体_GBK', '方正黑体简体', 'SimHei', '黑体'],
    '宋体': ['SimSun', 'NSimSun', '新宋体', '思源宋体'],
    '新宋体': ['NSimSun', 'SimSun', '宋体'],
    '华文中宋': ['STZhongsong', '宋体', 'SimSun'],
    '华文宋体': ['STSong', '宋体', 'SimSun'],
    '思源宋体': ['Source Han Serif CN', 'Noto Serif CJK SC', '宋体', 'SimSun'],
    '思源黑体': ['Source Han Sans CN', 'Noto Sans CJK SC', 'Microsoft YaHei'],
    '微软雅黑': ['Microsoft YaHei UI', 'Microsoft YaHei', 'SimHei']
  };
  /* 字体大类：决定最后追加 serif 还是 sans-serif 通用族 */
  function genericFamily(n) {
    if (/宋|仿宋|标宋|书宋|楷|隶|舒|魏碑|Song|Kai|Sun|Times|Georgia|Cambria|serif|SimSun|FangSong/i.test(n)) return 'serif';
    return 'sans-serif';
  }
  /* 字体名 → CSS font-family 值（单引号包裹，含回退链 + 通用族兜底） */
  function q(s) {
    const n = String(s || '').replace(/['"\\]/g, '').trim();
    if (!n) return 'inherit';
    const list = [n].concat(FONT_FALLBACKS[n] || []);
    return list.map(x => "'" + x + "'").concat(genericFamily(n)).join(', ');
  }

  /* ---------------- 导出 ---------------- */

  async function doExport() {
    const text = $('src').value;
    if (!text.trim() && !blocks.length) {
      fail('请先输入文本或选择文件');
      return;
    }
    status('正在生成 Word 文档…', 'busy');
    $('btnRun').disabled = true;
    try {
      const bs = blocks.length ? blocks : P.parseText(text, cfg);
      // 重新贴上图片块
      const withImages = attachImages(bs);

      const blob = await X.buildDocx(withImages, cfg);
      const fname = suggestName();
      downloadBlob(blob, fname);
      ok('已生成 ' + fname + '（' + fmtSize(blob.size) + '）');
    } catch (err) {
      console.error(err);
      fail('生成失败：' + err.message);
    } finally {
      $('btnRun').disabled = false;
    }
  }

  function attachImages(bs) {
    if (!Object.keys(loadedImages).length) return bs;
    // 文本里若有 [图片：xxx] 占位则替换为图片块
    const out = [];
    for (const b of bs) {
      const m = b.type === 'body' && /^\[图片[：:](.+?)\]$/.exec((b.text || '').trim());
      if (m) {
        const key = Object.keys(loadedImages).find(k => k.endsWith('/' + m[1]) || k === m[1]);
        if (key) {
          const meta = imageMeta[m[1]] || imageMeta[key] || {};
          out.push({
            type: 'image', name: m[1], data: loadedImages[key],
            w: meta.w, h: meta.h, mime: meta.mime
          });
          continue;
        }
      }
      out.push(b);
    }
    return out;
  }

  function suggestName() {
    const t = blocks.find(b => b.type === 'title');
    let base = t && t.text ? t.text : (cfg.document_title || '');
    base = String(base).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40);
    if (!base) base = '排版文档';
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    return base + '_' + stamp + '.docx';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ---------------- 方案管理 ---------------- */

  function loadSchemes() {
    try { return JSON.parse(localStorage.getItem(SCHEME_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveSchemes(obj) {
    try { localStorage.setItem(SCHEME_KEY, JSON.stringify(obj)); }
    catch (e) { alert('保存失败：浏览器不允许本地存储'); }
  }

  function saveSchemeDialog() {
    openModal('存为我的方案', 
      '<div class="field"><span style="width:80px">方案名称</span>' +
      '<input type="text" id="schemeName" placeholder="例如：财务部月度报告" value="' +
      escapeHtml(currentPreset + ' 副本') + '"></div>' +
      '<div class="note">保存当前全部 ' + Object.keys(cfg).length + ' 项设置到浏览器本地。</div>',
      [
        { text: '取消', cls: 'ghost', fn: closeModal },
        { text: '保存', fn: () => {
          const name = $('schemeName').value.trim();
          if (!name) { alert('请输入名称'); return; }
          const all = loadSchemes();
          all[name] = Object.assign({}, cfg);
          saveSchemes(all);
          closeModal();
          renderPresetSelect();
          ok('已保存方案：' + name + '（可在「规范」页的「规范方案」下拉里直接选）');
        }}
      ]);
  }

  function manageSchemesDialog() {
    const all = loadSchemes();
    const names = Object.keys(all);
    let html = '';
    if (!names.length) {
      html = '<div class="note">还没有自定义方案。在「自定义」标签页调好设置后，点「存为我的方案」。</div>';
    } else {
      html = names.map(n =>
        '<div class="scheme"><span class="nm">' + escapeHtml(n) +
        '<small>' + Object.keys(all[n]).length + ' 项</small></span>' +
        '<button class="btn ghost sm" data-apply="' + escapeHtml(n) + '">套用</button>' +
        '<button class="btn ghost sm" data-exp="' + escapeHtml(n) + '">导出</button>' +
        '<button class="btn ghost sm" data-del="' + escapeHtml(n) + '">删除</button></div>').join('');
    }
    html += '<hr><div class="row"><button class="btn ghost sm" id="btnImportScheme">📥 从文件导入方案</button>' +
            '<input type="file" id="schemeFile" accept=".json" style="display:none"></div>';

    openModal('管理我的方案', html, [{ text: '关闭', cls: 'ghost', fn: closeModal }]);

    $('modalBody').querySelectorAll('[data-apply]').forEach(b => {
      b.addEventListener('click', () => {
        const n = b.dataset.apply;
        closeModal();
        applyScheme(n, true);
      });
    });
    $('modalBody').querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', () => {
        const n = b.dataset.del;
        if (!confirm('确定删除方案「' + n + '」？')) return;
        const a2 = loadSchemes(); delete a2[n]; saveSchemes(a2);
        renderPresetSelect();
        manageSchemesDialog();
      });
    });
    $('modalBody').querySelectorAll('[data-exp]').forEach(b => {
      b.addEventListener('click', () => {
        const n = b.dataset.exp;
        const blob = new Blob([JSON.stringify({ name: n, config: all[n] }, null, 2)],
          { type: 'application/json' });
        downloadBlob(blob, '排版方案_' + n + '.json');
      });
    });
    const imp = $('btnImportScheme');
    if (imp) {
      imp.addEventListener('click', () => $('schemeFile').click());
      $('schemeFile').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const txt = await f.text();
          const obj = JSON.parse(txt);
          const data = obj.config || obj;
          const nm = obj.name || f.name.replace(/\.json$/i, '');
          const a2 = loadSchemes(); a2[nm] = data; saveSchemes(a2);
          renderPresetSelect();
          manageSchemesDialog();
          ok('已导入方案：' + nm);
        } catch (err) { alert('导入失败：' + err.message); }
      });
    }
  }

  /* ---------------- 模态框 ---------------- */

  let modalButtons = [];
  function openModal(title, bodyHtml, buttons) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    const foot = $('modalFoot');
    foot.innerHTML = '';
    modalButtons = buttons || [];
    modalButtons.forEach((b, i) => {
      const el = document.createElement('button');
      el.className = 'btn sm ' + (b.cls || '');
      el.textContent = b.text;
      el.addEventListener('click', b.fn);
      foot.appendChild(el);
    });
    $('mask').classList.add('on');
  }
  function closeModal() { $('mask').classList.remove('on'); }

  function helpDialog() {
    openModal('使用说明',
      '<h4 style="margin-top:0">最简单用法（三步）</h4>' +
      '<ol style="line-height:2;padding-left:20px">' +
      '<li>把没有格式的文字<b>粘贴</b>到左边，或把 <b>.txt / .md / .docx</b> 文件拖进来。</li>' +
      '<li>在「② 规范」里选一个规范（默认就是党政机关公文格式）。</li>' +
      '<li>点下面的<b>「一键排版 → 生成 Word」</b>，文件自动下载。</li>' +
      '</ol>' +
      '<h4>它会自动做什么</h4>' +
      '<ul style="line-height:1.9;padding-left:20px">' +
      '<li>认出一级标题「一、」、二级「（一）」、三级「1.」、四级「（1）」</li>' +
      '<li>把第一段当主标题居中加大，第二段当副标题</li>' +
      '<li>正文自动首行缩进 2 字符、两端对齐</li>' +
      '<li>制表符或 <kbd>|</kbd> 分隔的行自动变成真表格</li>' +
      '<li>英文逗号、引号、括号自动转成中文标点</li>' +
      '<li>Markdown 标记（<kbd>**</kbd>、<kbd>#</kbd>、<kbd>-</kbd>）自动剥离</li>' +
      '<li>加页码、页眉、大纲级别（Word 里能一键生成目录）</li>' +
      '<li>重新排版已有 <b>.docx</b> 时，<b>图片原样保留</b>（位置与大小不变）</li>' +
      '</ul>' +
      '<h4>支持的文件</h4>' +
      '<div class="note">直接读：<b>.txt .md .docx .rtf .html</b>　·　需先转换：<b>.doc .wps</b>（见下）</div>' +
      '<h4>关于 .doc / .wps</h4>' +
      '<div class="warnbox">这两种是 Word 97-2003 的<b>二进制专有格式</b>，浏览器无法解析。' +
      '请在 Word 或 WPS 里打开后，「另存为」选择 <b>.docx</b>，再拖进来即可。</div>' +
      '<h4>快捷操作</h4>' +
      '<div class="note"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 直接生成 Word　·　<kbd>Esc</kbd> 关闭弹窗</div>' +
      '<h4>隐私</h4>' +
      '<div class="okbox">整个工具是单个 HTML 文件，<b>不联网、不上传</b>。' +
      '所有文字处理都在你自己的浏览器里完成。</div>',
      [{ text: '知道了', fn: closeModal }]);
  }

  function aboutDialog() {
    openModal('关于',
      '<p style="line-height:1.9">一个把<b>无格式文本</b>整理成规范 Word 文档的小工具。' +
      '参照 Word Formatter Pro 的功能设计，重新实现为<b>零安装、零依赖的单文件网页</b>。</p>' +
      '<hr><div class="note">' +
      '• 无外部依赖：ZIP 读写、OOXML 生成、文本解析全部内置<br>' +
      '• 不联网：不发起任何网络请求<br>' +
      '• 纯前端：数据不出本机<br>' +
      '• 配置项：' + Object.keys(cfg).length + ' 项' +
      '</div>',
      [{ text: '关闭', cls: 'ghost', fn: closeModal }]);
  }

  /* ---------------- 本地记忆 ---------------- */

  function saveLast() {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({
        cfg, preset: currentPreset, v: CFG_VERSION,
        source: configSource, base: baseSnapshot
      }));
    } catch (e) { /* ignore */ }
  }
  function loadLast() {
    try {
      const s = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (!s || !s.cfg) return;
      const oldVer = Number(s.v || 1);
      cfg = D.mergeConfig(Object.assign({}, D.DEFAULT_CONFIG), s.cfg);
      currentPreset = s.preset || currentPreset;
      /* 恢复「当前用的是哪一套」，这样重开浏览器还能看到准确来源 */
      configSource = s.source || { kind: D.PRESETS[currentPreset] ? 'preset' : 'scheme', name: currentPreset };
      baseSnapshot = s.base || (D.PRESETS[configSource.name] ? Object.assign({}, cfg) : null);
      /* 老版本存下的配置里带着旧默认值（keep_all / 标题不缩进）。
         这些值和「用户主动改过」无法区分，但它们的观感明显更差，
         所以仅当值仍等于旧默认值时才迁移到新默认值。 */
      if (oldVer < 2) {
        if (s.cfg.blank_line_mode === 'keep_all') cfg.blank_line_mode = 'delete_single';
        ['h1', 'h2', 'h3', 'h4'].forEach(r => {
          const k = r + '_indent_chars';
          if (Number(s.cfg[k]) === 0) cfg[k] = 2;
        });
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 工具 ---------------- */

  function debounce(fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  const SAMPLE = [
    '关于进一步加强信息化建设工作的通知',
    '各部门、各直属单位：',
    '',
    '为深入贯彻落实上级关于数字化转型的决策部署，进一步提升我单位信息化建设水平，现将有关事项通知如下。',
    '',
    '一、总体要求',
    '',
    '（一）指导思想',
    '',
    '坚持以需求为导向、以应用为核心，统筹推进基础设施、业务系统与数据资源的协调发展。',
    '',
    '（二）基本原则',
    '',
    '1. 统一规划。避免重复建设，确保系统互联互通。',
    '',
    '2. 分步实施。按照轻重缓急，有序推进各项任务。',
    '',
    '二、重点任务',
    '',
    '（一）完善基础设施',
    '',
    '加快网络升级改造，提升带宽保障能力。',
    '',
    '表1  重点任务分工表',
    '序号\t任务内容\t责任部门\t完成时限',
    '1\t网络升级改造\t信息中心\t2026年6月',
    '2\t业务系统整合\t业务处\t2026年9月',
    '3\t数据资源目录编制\t综合处\t2026年12月',
    '',
    '（二）强化安全保障',
    '',
    '落实网络安全责任制，定期开展风险评估与应急演练。',
    '',
    '三、工作要求',
    '',
    '各单位要高度重视，明确专人负责，确保各项任务按期完成。',
    '',
    '附件：重点任务分工表'
  ].join('\n');

  /* ---------------- 启动 ---------------- */

  function init() {
    // 检测浏览器能力
    if (!Zip || !Zip.HAS_COMPRESSION) {
      console.warn('浏览器不支持 CompressionStream，将使用无压缩 ZIP（文件略大但完全可用）');
    }

    loadLast();
    buildStaticSelects();
    /* 各级标题行距表是动态生成的，必须在 syncControlsFromCfg（会调用
       syncHeadLineFromCfg）之前插进 DOM，否则 setVal 找不到元素。 */
    renderHeadLineTable();
    // data-cfg 控件先填充 select 选项（字体类）
    document.querySelectorAll('select[data-cfg$="_font"], select[data-cfg="table_font"], select[data-cfg="table_header_font"], select[data-cfg="english_font"]').forEach(sel => {
      if (!sel.options.length) sel.innerHTML = fontOptionsHtml();
    });
    syncControlsFromCfg();
    syncChips();
    syncPageNumberControls();
    bind();

    // 页码控件绑定
    ['c_page_number_format', 'c_page_number_position'].forEach(id => {
      $(id).addEventListener('change', () => {
        cfg[id.slice(2)] = $(id).value;
        syncPageNumberControls();
        schedulePreview();
      });
    });
    $('c_page_number_start').addEventListener('input', () => {
      cfg.page_number_start = parseInt($('c_page_number_start').value, 10) || 1;
      schedulePreview();
    });
    $('c_header_text').addEventListener('input', () => {
      cfg.header_text = $('c_header_text').value;
      schedulePreview();
    });
    $('c_enable_header').addEventListener('change', () => {
      cfg.enable_header = $('c_enable_header').checked;
      schedulePreview();
    });
    /* force_a4 现在是 [data-cfg] 下拉（在「页面设置」里），
       通用绑定已处理，这里不再单独绑 #c_force_a4 —— 那个复选框已移除，
       留着会报 Cannot read properties of null (reading 'addEventListener')。 */

    status('就绪 · 粘贴文本或拖入文件即可开始');
    runParse();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
