# -*- coding: utf-8 -*-
"""量渲染出来的 Word 页面像素，验证真实页边距与配置值是否一致。"""
import sys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else r"D:\WorkSpace\text-formatter\test\out\render-cmp\page-0001.png"
img = Image.open(path).convert("L")
w, h = img.size
px = img.load()

# 自动识别 DPI：A4 宽 21cm，量出像素宽即可反推
#   渲染图 1191px -> 144dpi ；预览截图 793px -> 96dpi
CM = w / 21.0

# 页边距配置（默认党政机关公文格式 GB/T 9704-2012）
CONF = {"top": 3.7, "bottom": 3.5, "left": 2.8, "right": 2.6}


def row_has_ink(y, x0, x1):
    for x in range(x0, x1):
        if px[x, y] < 200:
            return True
    return False


def col_has_ink(x, y0, y1):
    for y in range(y0, y1):
        if px[x, y] < 200:
            return True
    return False


first_row = next((y for y in range(h) if row_has_ink(y, 0, w)), None)
last_row = next((y for y in range(h - 1, -1, -1) if row_has_ink(y, 0, w)), None)
first_col = next((x for x in range(w) if col_has_ink(x, 0, h)), None)
last_col = next((x for x in range(w - 1, -1, -1) if col_has_ink(x, 0, h)), None)

def verdict(name, got, want, tol=0.25):
    ok = got is not None and abs(got - want) <= tol
    diff = "" if got is None else f"（偏差 {got - want:+.2f}）"
    return f"{'OK  ' if ok else '偏差'} {name}: 实测 {got:.2f} cm / 期望 {want:.2f} cm{diff}"


print(f"图片: {path}")
print(f"像素: {w} x {h}   换算: {w/CM:.2f} x {h/CM:.2f} cm   分辨率 ≈ {CM*2.54:.0f} dpi")
print()
top = first_row / CM if first_row is not None else None
bot = (h - 1 - last_row) / CM if last_row is not None else None
left = first_col / CM if first_col is not None else None
right = (w - 1 - last_col) / CM if last_col is not None else None

print(verdict("上边距", top, CONF["top"]))
print(verdict("左边距", left, CONF["left"]))
# 下边距 / 右边距只在不溢出时才有意义
print(verdict("下边距", bot, CONF["bottom"], tol=1.2))
print(verdict("右边距", right, CONF["right"], tol=0.35))
if first_col is not None and last_col is not None:
    body_w = (last_col - first_col + 1) / CM
    print(verdict("版心宽", body_w, 15.6, tol=0.35))
print()
print("GB/T 9704-2012 要求: 上3.7 下3.5 左2.8 右2.6 cm，版心 15.6 x 22.5 cm")
print("说明: 下边距/右边距量的是「最后一行墨迹到底边」，末行不会恰好压线，")
print("      所以实际值通常略大于配置值，属正常。")
