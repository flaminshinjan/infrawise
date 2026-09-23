#!/usr/bin/env python3
"""Render an original, brand-neutral animated GIF of the Shared Device Lab
experience (chat command -> cursor flies to a target on a phone -> steps tick).
Pure PIL drawing, no screenshots, no logos. Output: docs/media/demo.gif
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 960, 540
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "media", "demo.gif")

# cream theme
BG = (243, 236, 221)
PANEL = (251, 247, 238)
PANEL2 = (239, 231, 213)
INK = (42, 38, 33)
INKSOFT = (75, 70, 61)
MUTED = (133, 124, 109)
LINE = (227, 217, 197)
ACCENT = (255, 82, 48)
ACCENT2 = (123, 92, 255)
OK = (31, 138, 84)
WHITE = (255, 255, 255)


def font(sz, bold=False, mono=False):
    paths = (
        ["/System/Library/Fonts/Menlo.ttc"] if mono else
        ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
         "/Library/Fonts/Arial.ttf"] if bold else
        ["/System/Library/Fonts/Supplemental/Arial.ttf",
         "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/HelveticaNeue.ttc"]
    )
    for p in paths:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            continue
    return ImageFont.load_default()


def ufont(sz):
    for p in ["/Library/Fonts/Arial Unicode.ttf",
              "/System/Library/Fonts/Apple Symbols.ttf"]:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            continue
    return font(sz)


F = {
    "h": font(15, bold=True), "sub": font(11), "body": font(13),
    "step": font(12), "mono": font(12, mono=True), "big": font(13, bold=True),
    "tile": ufont(20), "tlabel": font(8), "icon": ufont(12),
}

PHONE = (556, 44, 220, 452)      # x,y,w,h (bezel)
SCREEN = (568, 56, 196, 428)     # x,y,w,h
CMD = "open settings, then swipe up"
RESP = "On it — I'll open Settings, then swipe up."

TILES = [("☰", "Settings"), ("◉", "Camera"), ("◎", "Clock"),
         ("✉", "Mail"), ("☎", "Phone"), ("♪", "Music")]


def ease(t):
    return t * t * (3 - 2 * t)


def rr(d, box, r, **kw):
    d.rounded_rectangle(box, radius=r, **kw)


def draw_cursor(d, x, y, pressed=False):
    s = 0.82 if pressed else 1.0
    pts = [(0, 0), (14, 8), (8, 9.5), (5, 17)]
    pts = [(x + px * s, y + py * s) for px, py in pts]
    d.polygon(pts, fill=WHITE, outline=(17, 16, 14))
    if pressed:
        d.ellipse([x - 13, y - 13, x + 13, y + 13], outline=ACCENT, width=2)


def screen_home(d, box, scroll=0):
    sx, sy, sw, sh = box
    # wallpaper
    d.rectangle([sx, sy, sx + sw, sy + sh], fill=(24, 20, 42))
    for i in range(sh // 3):
        c = int(52 - i * 0.16)
        d.line([sx, sy + i * 3, sx + sw, sy + i * 3], fill=(max(c, 18), 16, 40))
    d.text((sx + sw / 2, sy + 14), "9:41", font=F["big"], fill=WHITE, anchor="mm")
    cols, cw = 3, sw / 3
    for idx, (g, name) in enumerate(TILES):
        r, c = divmod(idx, cols)
        cx = sx + c * cw + cw / 2
        cy = sy + 60 + r * 78 - scroll
        rr(d, [cx - 24, cy - 24, cx + 24, cy + 24], 14,
           fill=(255, 255, 255, 30) if False else (60, 52, 86))
        d.text((cx, cy), g, font=F["tile"], fill=WHITE, anchor="mm")
        d.text((cx, cy + 34), name, font=F["tlabel"], fill=(210, 205, 220), anchor="mm")


def screen_settings(d, box, scroll=0):
    sx, sy, sw, sh = box
    d.rectangle([sx, sy, sx + sw, sy + sh], fill=(247, 244, 250))
    d.rectangle([sx, sy, sx + sw, sy + 44], fill=(255, 255, 255))
    d.text((sx + 14, sy + 22), "Settings", font=F["big"], fill=(20, 18, 30), anchor="lm")
    rows = ["Network & internet", "Connected devices", "Apps", "Notifications",
            "Battery", "Display", "Sound & vibration", "Storage", "Privacy", "System"]
    for i, r in enumerate(rows):
        ry = sy + 58 + i * 40 - scroll
        if ry < sy + 44 or ry > sy + sh:
            continue
        d.ellipse([sx + 12, ry, sx + 30, ry + 18], fill=(228, 224, 236))
        d.text((sx + 40, ry + 9), r, font=F["step"], fill=(40, 36, 52), anchor="lm")
        d.line([sx + 40, ry + 30, sx + sw - 12, ry + 30], fill=(233, 230, 240))


def clamp(v, a, b):
    return max(a, min(b, v))


def render(t):
    """t in [0,1) over the loop."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # ----- right stage -----
    d.rectangle([360, 0, W, H], fill=(239, 231, 213))
    # phone bezel + screen (clip screen content via a sub-image)
    px, py, pw, ph = PHONE
    rr(d, [px, py, px + pw, py + ph], 34, fill=(26, 25, 24))

    real = SCREEN
    scr = Image.new("RGB", (real[2], real[3]), (0, 0, 0))
    sd = ImageDraw.Draw(scr, "RGBA")
    local_box = (0, 0, real[2], real[3])  # screen drawn at its own origin
    if t < 0.42:
        screen_home(sd, local_box)
    else:
        scroll = 0 if t < 0.62 else ease(clamp((t - 0.62) / 0.18, 0, 1)) * 120
        screen_settings(sd, local_box, scroll=scroll)
    # round the screen corners with a mask
    mask = Image.new("L", (real[2], real[3]), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, real[2], real[3]], radius=26, fill=255)
    img.paste(scr, (real[0], real[1]), mask)

    # camera dot + home bar
    d.ellipse([px + pw / 2 - 4, py + 12, px + pw / 2 + 4, py + 20], fill=(8, 8, 8))
    d.rounded_rectangle([px + pw / 2 - 34, py + ph - 16, px + pw / 2 + 34, py + ph - 12], 2,
                        fill=(255, 255, 255))

    # ----- cursor animation over the phone -----
    sx, sy, sw, sh = real
    settings_tile = (sx + sw / 6, sy + 60)          # top-left "Settings" tile
    park = (sx + sw * 0.5, sy + sh * 0.9)
    pressed = False
    if t < 0.18:
        cur = park
    elif t < 0.42:
        p = ease(clamp((t - 0.18) / 0.20, 0, 1))
        cur = (park[0] + (settings_tile[0] - park[0]) * p,
               park[1] + (settings_tile[1] - park[1]) * p)
        pressed = 0.36 <= t < 0.42
    elif t < 0.62:
        cur = settings_tile
    else:  # swipe up
        p = ease(clamp((t - 0.62) / 0.18, 0, 1))
        y0, y1 = sy + sh * 0.72, sy + sh * 0.34
        cur = (sx + sw * 0.5, y0 + (y1 - y0) * p)
        pressed = True
    draw_cursor(d, cur[0], cur[1], pressed=pressed)

    # ----- left chat panel -----
    d.rectangle([0, 0, 360, H], fill=PANEL)
    d.line([360, 0, 360, H], fill=LINE, width=1)
    d.text((20, 20), "Test console", font=F["h"], fill=INK, anchor="lm")
    d.text((20, 40), "natural language → ordered device input", font=F["sub"], fill=MUTED, anchor="lm")
    d.line([0, 58, 360, 58], fill=LINE)

    # user bubble
    uw = 250
    rr(d, [360 - 20 - uw, 74, 360 - 20, 108], 12, fill=ACCENT)
    d.text((360 - 24, 91), CMD, font=F["step"], fill=WHITE, anchor="rm")

    # system response typing
    n = int(clamp(t / 0.16, 0, 1) * len(RESP))
    resp = RESP[:n]
    # wrap response into panel width
    lines, cur_line = [], ""
    for word in resp.split(" "):
        test = (cur_line + " " + word).strip()
        if d.textlength(test, font=F["body"]) > 300:
            lines.append(cur_line)
            cur_line = word
        else:
            cur_line = test
    lines.append(cur_line)
    bh = 12 + len(lines) * 18
    rr(d, [20, 120, 20 + 310, 120 + bh], 12, fill=PANEL2, outline=LINE)
    for i, ln in enumerate(lines):
        d.text((32, 130 + i * 18), ln, font=F["body"], fill=INKSOFT, anchor="lm")
    if n < len(RESP):
        cy = 130 + (len(lines) - 1) * 18
        cx = 32 + d.textlength(lines[-1], font=F["body"]) + 3
        d.rectangle([cx, cy - 7, cx + 6, cy + 7], fill=ACCENT)

    # steps box (appears after typing)
    if t > 0.16:
        by = 120 + bh + 14
        rr(d, [20, by, 330, by + 66], 12, fill=PANEL2, outline=LINE)
        s1_done = t > 0.42
        s2_active = t > 0.45
        s2_done = t > 0.80
        # step 1
        icon = "✓" if s1_done else "●"
        col = OK if s1_done else ACCENT
        d.text((34, by + 20), icon, font=F["icon"], fill=col, anchor="lm")
        d.text((52, by + 20), "open Settings", font=F["step"], fill=INKSOFT, anchor="lm")
        if s1_done:
            d.text((316, by + 20), "128 ms", font=F["sub"], fill=MUTED, anchor="rm")
        # step 2
        if s2_active:
            icon2 = "✓" if s2_done else "●"
            col2 = OK if s2_done else ACCENT
            d.text((34, by + 46), icon2, font=F["icon"], fill=col2, anchor="lm")
            d.text((52, by + 46), "swipe up", font=F["step"], fill=INKSOFT, anchor="lm")
            if s2_done:
                d.text((316, by + 46), "312 ms", font=F["sub"], fill=MUTED, anchor="rm")
        else:
            d.text((34, by + 46), "·", font=F["step"], fill=MUTED, anchor="lm")
            d.text((52, by + 46), "swipe up", font=F["step"], fill=MUTED, anchor="lm")

    # device caption bottom-right
    d.text((666, 512), "Pixel 8 · 1080 × 2400 · live", font=F["sub"], fill=MUTED, anchor="mm")

    return img


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    frames = []
    N = 56
    hold_tail = 8
    for i in range(N):
        frames.append(render(i / N))
    # hold the final state briefly before looping
    for _ in range(hold_tail):
        frames.append(render(0.98))
    durations = [90] * N + [60] * hold_tail

    # palette-optimize for a small file
    pal_frames = [f.convert("P", palette=Image.ADAPTIVE, colors=128) for f in frames]
    pal_frames[0].save(
        OUT, save_all=True, append_images=pal_frames[1:], loop=0,
        duration=durations, disposal=2, optimize=True,
    )
    size = os.path.getsize(OUT)
    print(f"wrote {OUT} ({size // 1024} KB, {len(frames)} frames)")


if __name__ == "__main__":
    main()
