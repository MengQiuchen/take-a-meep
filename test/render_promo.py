#!/usr/bin/env python3
"""Render the ~11 s Chinese promo video: white background, captions, real meep audio.

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
    BIRD = 380
    GROUND = H - 210
    CAPTION_Y, CAPTION_SIZE, CAPTION_GAP = 190, 52, 76
    OUT_NAME = "take-a-meep-promo-vertical.mp4"
else:
    W, H = 1280, 720
    BIRD = 300
    GROUND = H - 96
    CAPTION_Y, CAPTION_SIZE, CAPTION_GAP = 118, 46, 62
    OUT_NAME = "take-a-meep-promo.mp4"

SCALE = BIRD / 1600

CJK_TTC = "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"
LATIN = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
INK = (59, 51, 44)
SOFT = (150, 139, 128)
WARM = (214, 138, 78)


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
    """Fading, gently rising caption lines, centred."""
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


def meep_pop(im, t, onsets):
    """Comic meep! near the bird's thrown-back head."""
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
        im.alpha_composite(layer, (int(W / 2 - BIRD * 0.72 + k * BIRD * 0.44),
                                   int(bird_top - BIRD * 0.52 + (0 if k == 0 else -BIRD * 0.2))))
    return


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
if VERTICAL:
    SCENES = [
        ("walk", ("你的 Mac 右下角", "住进了一只鸟"), 1.9),
        ("rock", ("实拍丘鹬", "走路都在摇摆"), 1.7),
        ("meep", ("到点 meep 两声", "喊你休息"), 2.3),
        ("pet", ("无聊可以摸摸它",), 1.8),
        ("flutter", ("还能拎起来玩", "它会扑棱"), 2.2),
        ("card", None, 1.8),
    ]
else:
    SCENES = [
        ("walk", ("你的 Mac 右下角，住进了一只鸟",), 1.9),
        ("rock", ("实拍丘鹬，走路都在摇摆",), 1.7),
        ("meep", ("到点 meep 两声，喊你休息",), 2.3),
        ("pet", ("无聊可以摸摸它",), 1.8),
        ("flutter", ("还能拎起来玩，它会扑棱",), 2.2),
        ("card", None, 1.8),
    ]
MEEP_AUDIO_AT = None
END_MEEP_AT = None


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
    txt2 = "你的桌面摸鱼搭子 · 开源免费"
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
        walk_speed = BIRD * 0.29   # px/s on screen
        for name, caption, seconds in SCENES:
            frames = int(seconds * FPS)
            if name == "walk":
                await page.evaluate(f"puppet.setFacing('left', true); puppet.setWalkState({{active:true, direction:'left', motion:'walk', speed:{walk_speed/SCALE}}})")
                x = W / 2 + walk_speed * seconds * 0.72
            elif name == "rock":
                await page.evaluate("puppet.setWalkState({active:true, direction:'left', motion:'rock', speed:0})")
            elif name == "meep":
                await page.evaluate("puppet.setWalkState({active:false}); puppet.nextActionAt=1e12;")
                called = False
            elif name == "pet":
                await page.evaluate(
                    "puppet.mode='idle'; puppet.action=null; puppet.callStartedAt=null; puppet.nextActionAt=1e12;"
                    "puppet.pointer={x:0.2,y:0,inside:true}; puppet.pointerMaster={x:760,y:300}; puppet.hearts=[]; puppet.nextHeartAt=0;"
                )
            elif name == "flutter":
                await page.evaluate("puppet.petLevel=0; puppet.petStrokes=[]; puppet.pointer={x:0,y:0,inside:false}; puppet.setHeld(true)")
                dropped = landed = False
            for f in range(frames):
                t = f / FPS
                fade = min(1, (f + 1) / 4, (frames - f) / 4)
                if name == "card":
                    im = draw_card(t, icon)
                    if END_MEEP_AT is None:
                        END_MEEP_AT = clock + 0.45
                else:
                    opts = {"width": BIRD, "groundY": GROUND, "centerX": W / 2, "shadow": 1}
                    if name == "walk":
                        x -= walk_speed / FPS
                        opts["centerX"] = x
                    elif name == "meep":
                        if not called and t >= 0.3:
                            await page.evaluate("puppet.playCall()")
                            called = True
                            MEEP_AUDIO_AT = clock + 0.3
                    elif name == "pet":
                        await page.evaluate("const n=performance.now(); puppet.petStrokes=[n,n-180,n-360,n-540];")
                    elif name == "flutter":
                        drop_at, land_at = 0.7, 1.35
                        lift = int(BIRD * 0.5)
                        if not dropped and t >= drop_at:
                            await page.evaluate("puppet.setHeld(false,{x:0,y:0}); puppet.setFalling(400);")
                            dropped = True
                        if not landed and t >= land_at:
                            await page.evaluate("puppet.setLanded(1300)")
                            landed = True
                        if t < drop_at:
                            opts["groundY"] = GROUND - lift
                            opts["shadow"] = 0.25
                            await page.evaluate(f"puppet.setDragVelocity({{x:{math.sin(t*2.8)*400:.0f}, y:0}})")
                        elif t < land_at:
                            k = (t - drop_at) / (land_at - drop_at)
                            opts["groundY"] = GROUND - lift * (1 - k * k)
                            opts["shadow"] = 0.25 + 0.75 * k
                    await page.evaluate(f"step({STEP})")
                    await page.evaluate(f"renderWhite({{width:{opts['width']}, groundY:{opts['groundY']}, centerX:{opts['centerX']}, shadow:{opts['shadow']}}})")
                    path = OUT / "frame.png"
                    await page.locator("#c").screenshot(path=str(path))
                    im = Image.open(path).convert("RGBA")
                    if caption:
                        draw_caption(im, caption, t)
                    if name == "meep" and called:
                        meep_pop(im, t, [0.3 + 0.035, 0.3 + 0.742])
                    if name == "pet":
                        cx = W / 2 + math.sin(t * math.tau * 1.05) * BIRD * 0.21 + BIRD * 0.07
                        cy = GROUND - BIRD * 0.5 + math.sin(t * math.tau * 2.1) * 5
                        cursor(im, cx, cy)
                    if name == "flutter" and t < 0.78:
                        cursor(im, W / 2 + BIRD * 0.075, GROUND - int(BIRD * 0.5) - BIRD * 0.6)
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
