#!/usr/bin/env python3
"""Render the ~12 s Chinese promo video: pomodoro-first storyboard, white bg, real meep audio.

    python3 test/render_promo.py            # 16:9  (1280x720)  -> artifacts/take-a-meep-promo.mp4
    python3 test/render_promo.py vertical   # 9:16  (720x1280)  -> artifacts/take-a-meep-promo-vertical.mp4
"""
import asyncio
import http.server
import math
import os
import subprocess
import sys
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFont
from playwright.async_api import async_playwright

VERTICAL = "vertical" in sys.argv

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out" / ("promo-v" if VERTICAL else "promo")
OUT.mkdir(parents=True, exist_ok=True)
FPS = 30
STEP = 1000 / FPS

if VERTICAL:
    W, H = 720, 1280
    BIRD = 370
    GROUND = H - 230
    CAPTION_Y, CAPTION_SIZE, CAPTION_GAP = 175, 52, 76
    OUT_NAME = "take-a-meep-promo-vertical.mp4"
else:
    W, H = 1280, 720
    BIRD = 290
    GROUND = H - 80
    CAPTION_Y, CAPTION_SIZE, CAPTION_GAP = 96, 46, 62
    OUT_NAME = "take-a-meep-promo.mp4"

SCALE = BIRD / 1600

CJK_TTC = "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"
LATIN = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
INK = (59, 51, 44)
SOFT = (150, 139, 128)
WARM = (214, 138, 78)
FOCUS_C = (241, 189, 130)
BREAK_C = (134, 184, 170)


def sc_index():
    for i in range(6):
        try:
            f = ImageFont.truetype(CJK_TTC, 20, index=i)
            if "SC" in f.getname()[0]:
                return i
        except Exception:
            break
    return 0


SC = sc_index()


def cjk(size):
    return ImageFont.truetype(CJK_TTC, size, index=SC)


def latin(size):
    return ImageFont.truetype(LATIN, size)


def ease(t):
    return t * t * (3 - 2 * t)


def draw_caption(im, lines, t_in):
    a = ease(min(1, max(0, t_in / 0.28)))
    if a <= 0.01:
        return
    font = cjk(CAPTION_SIZE)
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rise = (1 - a) * 14
    for k, text in enumerate(lines):
        w = d.textlength(text, font=font)
        d.text(((W - w) / 2, CAPTION_Y + k * CAPTION_GAP + rise), text, font=font,
               fill=INK + (int(255 * a),))
    im.alpha_composite(layer)


def draw_watermark(im):
    d = ImageDraw.Draw(im)
    f = latin(20)
    text = "Take a Meep"
    w = d.textlength(text, font=f)
    d.text((W - w - 26, H - 40), text, font=f, fill=(185, 175, 164, 255))


def cursor(im, x, y):
    d = ImageDraw.Draw(im)
    pts = [(x, y), (x, y + 21), (x + 5.5, y + 16.5), (x + 9.5, y + 25), (x + 13.2, y + 23.2),
           (x + 9.2, y + 15), (x + 15.7, y + 14.5)]
    d.polygon(pts, fill=(20, 20, 20), outline=(255, 255, 255))


def draw_chip(im, cx, top, time_str, label, color, t, alpha=1.0):
    """The app's floating timer pill: [⏸ ↺ ■] · pulse · time · label · bird-head."""
    a = int(255 * alpha)
    ph = int(BIRD * 0.185)          # pill height
    pad = int(ph * 0.30)
    btn = int(ph * 0.62)
    gap = int(ph * 0.18)
    tf = latin(int(ph * 0.52))
    lf = latin(int(ph * 0.30))
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    tw = d.textlength(time_str, font=tf)
    lw = d.textlength(label, font=lf)
    pulse_r = int(ph * 0.11)
    width = pad + 3 * btn + 2 * gap + gap + 2 * pulse_r + gap + tw + gap + lw + gap + btn + pad
    x0 = cx - width / 2
    y0 = top
    d.rounded_rectangle([x0, y0, x0 + width, y0 + ph], radius=ph / 2,
                        fill=(29, 26, 24, int(225 * alpha)), outline=(255, 255, 255, int(40 * alpha)), width=2)
    cy = y0 + ph / 2
    x = x0 + pad
    # three round buttons: pause / restart / stop
    for kind in ("pause", "reset", "stop"):
        d.ellipse([x, cy - btn / 2, x + btn, cy + btn / 2],
                  fill=(255, 255, 255, int(18 * alpha)), outline=(255, 255, 255, int(28 * alpha)))
        g = (235, 230, 224, int(200 * alpha))
        bx, by = x + btn / 2, cy
        s = btn * 0.19
        if kind == "pause":
            d.rectangle([bx - s, by - s * 1.25, bx - s * 0.35, by + s * 1.25], fill=g)
            d.rectangle([bx + s * 0.35, by - s * 1.25, bx + s, by + s * 1.25], fill=g)
        elif kind == "reset":
            d.arc([bx - s * 1.25, by - s * 1.25, bx + s * 1.25, by + s * 1.25], 60, 320, fill=g, width=max(2, int(s * 0.5)))
            d.polygon([(bx + s * 1.0, by - s * 1.65), (bx + s * 1.9, by - s * 0.65), (bx + s * 0.35, by - s * 0.55)], fill=g)
        else:
            d.rectangle([bx - s, by - s, bx + s, by + s], fill=g)
        x += btn + gap
    # pulse dot
    x += gap * 0.4
    pulse = 0.55 + 0.45 * math.sin(t * math.tau / 1.8)
    d.ellipse([x, cy - pulse_r, x + 2 * pulse_r, cy + pulse_r],
              fill=color + (int(a * (0.55 + 0.45 * pulse)),))
    x += 2 * pulse_r + gap
    d.text((x, cy - tf.size * 0.56), time_str, font=tf, fill=(247, 241, 232, a))
    x += tw + gap
    d.text((x, cy - lf.size * 0.55), label, font=lf, fill=color + (a,))
    x += lw + gap
    # bird-head meep button
    d.ellipse([x, cy - btn / 2, x + btn, cy + btn / 2],
              fill=(241, 189, 130, int(30 * alpha)), outline=(241, 189, 130, int(80 * alpha)))
    hx, hy = x + btn * 0.62, cy - btn * 0.08
    hr = btn * 0.21
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=FOCUS_C + (a,))
    d.polygon([(hx - hr * 0.6, hy - hr * 0.15), (x + btn * 0.10, hy + hr * 0.45),
               (hx - hr * 0.25, hy + hr * 0.55)], fill=FOCUS_C + (a,))
    d.ellipse([hx + hr * 0.15, hy - hr * 0.55, hx + hr * 0.55, hy - hr * 0.15], fill=(29, 26, 24, a))
    im.alpha_composite(layer)


def meep_pop(im, t, onsets):
    bird_top = GROUND - BIRD * 0.56
    for k, onset in enumerate(onsets):
        local = t - onset
        if local < 0:
            continue
        a = min(1, local / 0.1) * (1 if local < 0.55 else max(0, 1 - (local - 0.55) / 0.3))
        if a <= 0.01:
            continue
        size = int(BIRD * (0.155 if k == 0 else 0.195))
        layer = Image.new("RGBA", (340, 150), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        f = latin(size)
        d.text((14, 16), "meep!", font=f, fill=WARM + (int(255 * a),),
               stroke_width=3, stroke_fill=(255, 255, 255, int(255 * a)))
        layer = layer.rotate(-8 if k == 0 else 6, expand=True, resample=Image.BICUBIC)
        im.alpha_composite(layer, (int(W / 2 - BIRD * 0.78 + k * BIRD * 0.40),
                                   int(bird_top - BIRD * 0.30 + (0 if k == 0 else -BIRD * 0.2))))


WHITE_RENDERER = """
window.renderWhite = (opts) => {
  opts = opts || {};
  const canvas = document.querySelector('#c');
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const ground = opts.groundY ?? (canvas.height - 34);
  const cx = opts.centerX ?? canvas.width / 2;
  const sh = opts.shadow ?? 1;
  if (sh > 0.02) {
    ctx.save();
    ctx.translate(cx, ground + 6);
    ctx.scale(1, 0.2);
    const g = ctx.createRadialGradient(0, 0, 8, 0, 0, 170);
    g.addColorStop(0, `rgba(70,56,44,${0.20 * sh})`);
    g.addColorStop(1, 'rgba(70,56,44,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 170, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  puppet.draw(ctx, { centerX: cx, groundY: ground, width: opts.width, pixelRatio: 1 });
};
0;
"""

# ---------------------------------------------------------------- storyboard
# Pomodoro first: focus countdown -> hits zero, meep -> break walk -> next round.
if VERTICAL:
    SCENES = [
        ("focus",     ("像番茄钟一样专注", "一只鸟替你计时"), 2.0),
        ("alarm",     ("到点 meep 两声", "提醒你休息"), 2.7),
        ("breakwalk", ("休息时间出门散步", "掐着秒准点回来"), 2.5),
        ("resume",    ("回来自动开始", "下一轮专注"), 1.6),
        ("pet",       ("累了还可以摸摸它",), 1.6),
        ("card",      None, 1.8),
    ]
else:
    SCENES = [
        ("focus",     ("像番茄钟一样专注，一只鸟替你计时",), 2.0),
        ("alarm",     ("到点 meep 两声，提醒你休息",), 2.7),
        ("breakwalk", ("休息时间出门散步，掐着秒准点回来",), 2.5),
        ("resume",    ("回来自动开始下一轮专注",), 1.6),
        ("pet",       ("累了还可以摸摸它",), 1.6),
        ("card",      None, 1.8),
    ]
MEEP_AUDIO_AT = None
END_MEEP_AT = None
CALL_AT = 0.95        # inside the alarm scene, after the countdown hits zero


def draw_card(t, icon):
    im = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    a = ease(min(1, t / 0.4))
    card = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    if VERTICAL:
        isz, iy, ty, sy, uy, ry = 200, 330, 578, 672, 745, 830
        tfs, sfs, ufs, rfs = 58, 36, 25, 28
    else:
        isz, iy, ty, sy, uy, ry = 168, 170, 372, 462, 528, 600
        tfs, sfs, ufs, rfs = 58, 34, 27, 26
    icon_r = icon.resize((isz, isz), Image.LANCZOS)
    card.alpha_composite(icon_r, (W // 2 - isz // 2, iy))
    d = ImageDraw.Draw(card)
    f1 = latin(tfs)
    txt = "Take a Meep"
    d.text(((W - d.textlength(txt, font=f1)) / 2, ty), txt, font=f1, fill=INK)
    f2 = cjk(sfs)
    txt2 = "高效休息的桌面番茄钟 · 开源免费"
    d.text(((W - d.textlength(txt2, font=f2)) / 2, sy), txt2, font=f2, fill=(110, 100, 90))
    f3 = latin(ufs)
    txt3 = "github.com/MengQiuchen/take-a-meep"
    d.text(((W - d.textlength(txt3, font=f3)) / 2, uy), txt3, font=f3, fill=WARM)
    f4 = cjk(rfs)
    txt4 = "记得休息。"
    d.text(((W - d.textlength(txt4, font=f4)) / 2, ry), txt4, font=f4, fill=SOFT)
    card.putalpha(card.getchannel("A").point(lambda v: int(v * a)))
    im.alpha_composite(card)
    return im


async def render():
    global MEEP_AUDIO_AT, END_MEEP_AT
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8774), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    icon = Image.open(ROOT / "docs" / "media" / "icon.png").convert("RGBA")

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        page.on("pageerror", lambda e: print("pageerror:", e))
        await page.goto(f"http://127.0.0.1:8774/test/harness.html?w={W}&h={H}")
        for _ in range(80):
            if await page.evaluate("ready()"):
                break
            await asyncio.sleep(0.1)
        await page.evaluate(WHITE_RENDERER)

        index = 0
        clock = 0.0
        walk_speed = BIRD * 0.30
        chip_top_rest = GROUND - BIRD * 0.56 - BIRD * 0.32
        for name, caption, seconds in SCENES:
            frames = int(seconds * FPS)
            if name == "focus":
                await page.evaluate("puppet.mode='idle'; puppet.nextActionAt=1e12; puppet.setFacing('left', true)")
            elif name == "alarm":
                called = False
            elif name == "breakwalk":
                await page.evaluate(f"puppet.setWalkState({{active:true, direction:'left', motion:'walk', speed:{walk_speed/SCALE}}})")
                x = W / 2 + walk_speed * seconds * 0.52
            elif name == "resume":
                await page.evaluate(
                    "puppet.setWalkState({active:false}); puppet.setFacing('left', true); puppet.nextActionAt=1e12;"
                    "puppet.cancelAction(); puppet.action={name:'wakeup', startedAt: performance.now(), duration: 900};"
                )
            elif name == "pet":
                await page.evaluate(
                    "puppet.mode='idle'; puppet.action=null; puppet.callStartedAt=null; puppet.nextActionAt=1e12;"
                    "puppet.pointer={x:0.2,y:0,inside:true}; puppet.pointerMaster={x:760,y:300}; puppet.hearts=[]; puppet.nextHeartAt=0;"
                )
            for f in range(frames):
                t = f / FPS
                fade = min(1, (f + 1) / 4, (frames - f) / 4)
                chip = None      # (time, label, colour, cx)
                if name == "card":
                    im = draw_card(t, icon)
                    if END_MEEP_AT is None:
                        END_MEEP_AT = clock + 0.45
                else:
                    opts_center = W / 2
                    ground = GROUND
                    shadow = 1
                    if name == "focus":
                        # a quiet focus block, timer ticking down
                        chip = (f"24:{59 - int(t) % 60:02d}", "FOCUS", FOCUS_C, W / 2)
                    elif name == "alarm":
                        remain = max(0, 3 - int(t / 0.3))
                        if t < CALL_AT:
                            chip = (f"00:0{remain}", "FOCUS", FOCUS_C, W / 2)
                        else:
                            chip = ("00:00", "FOCUS", FOCUS_C, W / 2)
                        if not called and t >= CALL_AT:
                            await page.evaluate("puppet.playCall()")
                            called = True
                            # The call animation opens the bill 0.10 s after playCall();
                            # the wav's first note starts 0.035 s in — offset the audio
                            # so sound and gape land on the same frame.
                            MEEP_AUDIO_AT = clock + 0.065
                        if t > seconds - 0.35:
                            chip = ("05:00", "BREAK", BREAK_C, W / 2)
                    elif name == "breakwalk":
                        x -= walk_speed / FPS
                        opts_center = x
                        chip = (f"04:{59 - int(t) % 60:02d}", "BREAK", BREAK_C, x)
                    elif name == "resume":
                        chip = (f"29:{59 - int(t) % 60:02d}", "FOCUS", FOCUS_C, W / 2)
                    elif name == "pet":
                        await page.evaluate("const n=performance.now(); puppet.petStrokes=[n,n-180,n-360,n-540];")
                    await page.evaluate(f"step({STEP})")
                    await page.evaluate(f"renderWhite({{width:{BIRD}, groundY:{ground}, centerX:{opts_center}, shadow:{shadow}}})")
                    path = OUT / "frame.png"
                    await page.locator("#c").screenshot(path=str(path))
                    im = Image.open(path).convert("RGBA")
                    if chip:
                        tm, lb, colr, ccx = chip
                        draw_chip(im, ccx, chip_top_rest, tm, lb, colr, clock)
                    if caption:
                        draw_caption(im, caption, t)
                    if name == "alarm" and called:
                        # match the bill-open onsets of the call animation
                        meep_pop(im, t, [CALL_AT + 0.10, CALL_AT + 0.78])
                    if name == "pet":
                        cx = W / 2 + math.sin(t * math.tau * 1.05) * BIRD * 0.21 + BIRD * 0.07
                        cy = GROUND - BIRD * 0.5 + math.sin(t * math.tau * 2.1) * 5
                        cursor(im, cx, cy)
                    draw_watermark(im)
                if fade < 1:
                    white = Image.new("RGBA", (W, H), (255, 255, 255, 255))
                    im = Image.blend(white, im, fade)
                im.convert("RGB").save(OUT / f"v{index:05d}.png")
                index += 1
                clock += 1 / FPS
        await browser.close()
    return index


def build_audio(total_frames):
    sr = 22050
    total = total_frames / FPS
    track = np.zeros(int(total * sr) + sr, dtype=np.float64)
    pair, _ = sf.read(ROOT / "assets" / "audio" / "meep-pair.wav")
    if MEEP_AUDIO_AT is not None:
        s = int(MEEP_AUDIO_AT * sr)
        track[s:s + len(pair)] += pair * 0.95
    if END_MEEP_AT is not None:
        single = pair[: int(0.5 * sr)].copy()
        n = int(0.06 * sr)
        single[-n:] *= np.linspace(1, 0, n)
        s = int(END_MEEP_AT * sr)
        track[s:s + len(single)] += single * 0.8
    track = track[: int(total * sr)]
    peak = np.abs(track).max()
    if peak > 0.98:
        track *= 0.98 / peak
    sf.write(OUT / "promo-audio.wav", (track * 32767).astype(np.int16), sr)


def encode():
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-framerate", str(FPS), "-i", str(OUT / "v%05d.png"),
        "-i", str(OUT / "promo-audio.wav"),
        "-c:v", "libx264", "-crf", "19", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
        str(ROOT / "artifacts" / OUT_NAME)
    ], check=True)


total = asyncio.run(render())
build_audio(total)
encode()
out = ROOT / "artifacts" / OUT_NAME
print(f"promo: {total} frames = {total/FPS:.1f}s, {out.stat().st_size/1e6:.2f} MB, meep@{MEEP_AUDIO_AT:.2f}s end@{END_MEEP_AT:.2f}s -> {out.name}")
