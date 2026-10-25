"""生成扩展图标（纯 PIL 绘制，无外部素材依赖）。

图案：深蓝圆角底 + 白色放大镜 + 盾牌勾线，象征「检索溯源 / 核实可信」。
"""
import os
from PIL import Image, ImageDraw

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(BASE, exist_ok=True)

BG = (30, 41, 59)        # slate-800
FG = (248, 250, 252)     # slate-50
ACCENT = (56, 189, 248)  # sky-400
SAFE = os.path.join(BASE, "icon")


def draw_icon(size: int) -> Image.Image:
    ss = 8  # 超采样倍数
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # 放大镜镜筒
    cx, cy, r = s * 0.44, s * 0.44, s * 0.26
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=FG, width=int(s * 0.075))
    # 手柄
    d.line([cx + r * 0.72, cy + r * 0.72, s * 0.80, s * 0.80],
           fill=FG, width=int(s * 0.085))
    # 手柄末端圆角
    d.ellipse([s * 0.80 - s * 0.045, s * 0.80 - s * 0.045,
               s * 0.80 + s * 0.045, s * 0.80 + s * 0.045], fill=FG)

    # 盾牌勾线（可信验证）
    sx, sy, sw, sh = s * 0.47, s * 0.30, s * 0.20, s * 0.24
    shield = [
        (sx + sw / 2, sy),
        (sx + sw, sy + sh * 0.22),
        (sx + sw, sy + sh * 0.60),
        (sx + sw / 2, sy + sh),
        (sx, sy + sh * 0.60),
        (sx, sy + sh * 0.22),
    ]
    d.polygon(shield, fill=ACCENT)
    # 盾牌上的对勾
    d.line([sx + sw * 0.28, sy + sh * 0.50,
            sx + sw * 0.45, sy + sh * 0.68,
            sx + sw * 0.74, sy + sh * 0.33],
           fill=BG, width=int(s * 0.045), joint="curve")

    return img.resize((size, size), Image.LANCZOS)


for size in (16, 48, 128):
    path = os.path.join(BASE, f"icon-{size}.png")
    draw_icon(size).save(path, "PNG", optimize=True)
    print(f"[icons] icon-{size}.png -> {os.path.getsize(path)} bytes")
