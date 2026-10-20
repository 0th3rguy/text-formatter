# -*- coding: utf-8 -*-
"""替换 ui.js 里的分页段：改成单遍几何驱动，去掉会造碎片的事后切分校验。
用法：python test/patch_pagination.py
"""
import io
import os
import sys

UI = r"D:\WorkSpace\text-formatter\src\ui.js"

with io.open(UI, "r", encoding="utf-8") as f:
    src = f.read()

START = "    const avail = pageContentHeight(page);"
END = "    // 统一角标为「当前 / 总页数」"

i = src.find(START)
j = src.find(END)
if i < 0:
    print("找不到起始标记")
    sys.exit(1)
if j < 0:
    print("找不到结束标记")
    sys.exit(1)
if j < i:
    print("标记顺序不对")
    sys.exit(1)

NEW = '''    const avail = pageContentHeight(page);

    /* 单遍分页：每块「放进去 → 量真实几何 → 放不下才处理」。
       这里刻意**只有一处切分点**。早先的实现除了这个主循环，后面还有一段
       「事后校验再切一次」的循环，两套逻辑互相踩：同一段落被反复切开，
       实测一个整段被切成 27/27/27/132 四个碎片，页首孤零零落着一行
       （用户看到的「掌」「握」被拆到两页就是它造成的）。
       去掉事后切分后，每段每一页最多切一刀，且切点由 Range 落在行边界上。 */
    const items = Array.from(doc.children);
    const queue = items.map(el => ({ el }));
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
       避免出现「掌握」只剩一个字、或整页只放一行残段的难看情形。 */
    var MIN_PIECE = 8;

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
         仅当本页前面已有其它块，否则挪了也没用。 */
      if (isHead && used <= avail + 0.5 && doc.children.length > 1 && qi + 1 < queue.length) {
        const roomLeft = avail - used;
        if (roomLeft > 0.5) {
          const need = minKeepHeight(queue[qi + 1].el, 0);
          if (need > roomLeft + 0.5) {
            el.remove();
            nextPage();
            doc.appendChild(el);
            used = pageUsed(doc);
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
        const n0 = charsFittingInPage(doc, el, avail);
        if (n0 >= MIN_PIECE && full0.length - n0 >= MIN_PIECE) cut = n0;
      }

      if (cut > 0) {
        const node = el.firstChild;
        const full = node.data;
        node.data = full.slice(0, cut).replace(/\\s+$/, '');
        const tail = el.cloneNode(false);
        tail.classList.add('cont');        // .cont 去掉首行缩进（续排段不再缩进两格）
        tail.textContent = full.slice(cut).replace(/^\\s+/, '');
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

'''

src = src[:i] + NEW + src[j:]

with io.open(UI, "w", encoding="utf-8", newline="\n") as f:
    f.write(src)

print("已替换分页段：删掉 %d 字符，写入 %d 字符" % (j - i, len(NEW)))
