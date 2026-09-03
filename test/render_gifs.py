#!/usr/bin/env python3
"""Render the README demo GIFs on a pure white background (headless, virtual clock)."""
import asyncio
import http.server
import math
import os
import subprocess
import threading
from pathlib import Path

from playwright.async_api import async_playwright
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out" / "gifs"
MEDIA = ROOT / "docs" / "media"
FPS = 18
STEP = 1000 / FPS

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def serve():
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8769), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


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
  // soft ground shadow so the bird doesn't float
  const sh = opts.shadow ?? 1;
  if (sh > 0.02) {
    ctx.save();
    ctx.translate(cx, ground + 5);
    ctx.scale(1, 0.20);
    const g = ctx.createRadialGradient(0, 0, 6, 0, 0, 95);
    g.addColorStop(0, `rgba(70,56,44,${0.20 * sh})`);
    g.addColorStop(1, 'rgba(70,56,44,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 95, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  puppet.draw(ctx, { centerX: cx, groundY: ground, width: opts.width ?? Math.round(canvas.width * 0.62), pixelRatio: 1 });
};
0;
"""


def cursor(draw, x, y, pressed=False):
    """A little macOS-style pointer."""
    pts = [(x, y), (x, y + 17), (x + 4.4, y + 13.2), (x + 7.6, y + 20), (x + 10.6, y + 18.6),
           (x + 7.4, y + 12), (x + 12.6, y + 11.6)]
    draw.polygon(pts, fill=(20, 20, 20), outline=(255, 255, 255))


def meep_text(im, t, cx):
    """Comic 'meep!' pops synced to the two call notes (call starts at t0 in scene time)."""
    for onset, dx, dy, size, rot in ((0.62, -105, -12, 30, -9), (1.30, -18, -44, 38, 6)):
        a = 0.0
        if t >= onset:
            local = t - onset
            if local < 0.12:
                a = local / 0.12
            elif local < 0.75:
                a = 1.0
            elif local < 1.05:
                a = 1 - (local - 0.75) / 0.3
        if a <= 0.01:
            continue
        layer = Image.new("RGBA", (170, 80), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        font = ImageFont.truetype(FONT, size)
        d.text((8, 10), "meep!", font=font, fill=(226, 149, 90, int(255 * a)),
               stroke_width=2, stroke_fill=(255, 255, 255, int(255 * a)))
        layer = layer.rotate(rot, expand=True, resample=Image.BICUBIC)
        im.alpha_composite(layer, (int(cx + dx - 40), int(150 + dy)))


async def capture(page, path):
    await page.locator("#c").screenshot(path=str(path))


async def scene_walk(page):
    """Out-and-back walk that loops: walk left, rock, turn, walk back, rock, turn."""
    w, h, bird = 640, 330, 188
    scale = bird / 1600
    speed = 60           # screen px/s
    frames_dir = OUT / "walk"
    frames_dir.mkdir(parents=True, exist_ok=True)
    await page.evaluate(f"resize({w},{h})")
    x = 468.0
    phases = [
        ("walk-left", 2.7), ("rock-left", 1.5), ("turn-right", 0.55),
        ("walk-right", 2.7), ("rock-right", 1.3), ("turn-left", 0.55)
    ]
    index = 0
    for phase, seconds in phases:
        if phase == "walk-left":
            await page.evaluate(f"puppet.setWalkState({{active:true, direction:'left', motion:'walk', speed:{speed/scale}}})")
        elif phase == "walk-right":
            await page.evaluate(f"puppet.setWalkState({{active:true, direction:'right', motion:'walk', speed:{speed/scale}}})")
        elif phase.startswith("rock"):
            side = phase.split("-")[1]
            await page.evaluate(f"puppet.setWalkState({{active:true, direction:'{side}', motion:'rock', speed:0}})")
        elif phase == "turn-right":
            await page.evaluate("puppet.setWalkState({active:true, direction:'right', motion:'turn', speed:0})")
        elif phase == "turn-left":
            await page.evaluate("puppet.setWalkState({active:true, direction:'left', motion:'turn', speed:0})")
        for _ in range(int(seconds * FPS)):
            if phase == "walk-left":
                x -= speed / FPS
            elif phase == "walk-right":
                x += speed / FPS
            await page.evaluate(f"step({STEP})")
            await page.evaluate(f"renderWhite({{centerX:{x:.1f}, width:{bird}}})")
            await capture(page, frames_dir / f"f{index:05d}.png")
            index += 1
    await page.evaluate("puppet.setWalkState({active:false}); puppet.setFacing('left', true)")
    return "walk", frames_dir, index


async def scene_meep(page):
    w, h, bird = 460, 350, 206
    frames_dir = OUT / "meep"
    frames_dir.mkdir(parents=True, exist_ok=True)
    await page.evaluate(f"resize({w},{h})")
    await page.evaluate("puppet.nextActionAt = 1e12")
    total, call_at = 3.2, 0.5
    called = False
    for index in range(int(total * FPS)):
        t = index / FPS
        if not called and t >= call_at:
            await page.evaluate("puppet.playCall()")
            called = True
        await page.evaluate(f"step({STEP})")
        await page.evaluate(f"renderWhite({{width:{bird}}})")
        path = frames_dir / f"f{index:05d}.png"
        await capture(page, path)
        im = Image.open(path).convert("RGBA")
        meep_text(im, t, w / 2)
        im.convert("RGB").save(path)
    return "meep", frames_dir, int(total * FPS)


async def scene_petting(page):
    w, h, bird = 460, 350, 206
    frames_dir = OUT / "petting"
    frames_dir.mkdir(parents=True, exist_ok=True)
    await page.evaluate(f"resize({w},{h})")
    await page.evaluate(
        "puppet.mode='idle'; puppet.action=null; puppet.nextActionAt=1e12;"
        "puppet.pointer={x:0.2,y:0,inside:true}; puppet.pointerMaster={x:760,y:300};"
    )
    total = 4.2
    for index in range(int(total * FPS)):
        t = index / FPS
        # keep the strokes fresh so the pet level stays up and hearts keep coming
        await page.evaluate("const n = performance.now(); puppet.petStrokes=[n,n-200,n-400,n-600];")
        await page.evaluate(f"step({STEP})")
        await page.evaluate(f"renderWhite({{width:{bird}}})")
        path = frames_dir / f"f{index:05d}.png"
        await capture(page, path)
        im = Image.open(path).convert("RGB")
        d = ImageDraw.Draw(im)
        cx = w / 2 + math.sin(t * math.tau * 1.05) * 46 + 14
        cy = h - 34 - 100 + math.sin(t * math.tau * 2.1) * 4
        cursor(d, cx, cy)
        im.save(path)
    return "petting", frames_dir, int(total * FPS)


async def scene_flutter(page):
    w, h, bird = 460, 390, 196
    frames_dir = OUT / "flutter"
    frames_dir.mkdir(parents=True, exist_ok=True)
    await page.evaluate(f"resize({w},{h})")
    ground_rest = h - 34
    lift = 128
    total, drop_at, land_at = 4.1, 1.35, 2.1
    await page.evaluate("puppet.setHeld(true)")
    dropped = landed = False
    for index in range(int(total * FPS)):
        t = index / FPS
        if not dropped and t >= drop_at:
            await page.evaluate("puppet.setHeld(false,{x:0,y:0}); puppet.setFalling(400);")
            dropped = True
        if not landed and t >= land_at:
            await page.evaluate("puppet.setLanded(1300)")
            landed = True
        if t < drop_at:
            ground = ground_rest - lift
            await page.evaluate(f"puppet.setDragVelocity({{x:{math.sin(t*2.6)*380:.0f}, y:0}})")
            shadow = 0.25
        elif t < land_at:
            k = (t - drop_at) / (land_at - drop_at)
            ground = ground_rest - lift * (1 - k * k)
            shadow = 0.25 + 0.75 * k
        else:
            ground = ground_rest
            shadow = 1
        await page.evaluate(f"step({STEP})")
        await page.evaluate(f"renderWhite({{width:{bird}, groundY:{ground:.1f}, shadow:{shadow:.2f}}})")
        path = frames_dir / f"f{index:05d}.png"
        await capture(page, path)
        if t < drop_at + 0.12:
            im = Image.open(path).convert("RGB")
            d = ImageDraw.Draw(im)
            cursor(d, w / 2 + 16, ground - 128)
            im.save(path)
    return "flutter", frames_dir, int(total * FPS)


def to_gif(name, frames_dir, count):
    MEDIA.mkdir(parents=True, exist_ok=True)
    gif = MEDIA / f"{name}.gif"
    palette = frames_dir / "palette.png"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", str(frames_dir / "f%05d.png"),
                    "-vf", "palettegen=stats_mode=diff", str(palette)], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", str(frames_dir / "f%05d.png"),
                    "-i", str(palette), "-lavfi", "paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", str(gif)], check=True)
    print(f"{gif.name}: {count} frames, {gif.stat().st_size/1e6:.2f} MB")


async def main():
    serve()
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 700, "height": 460}, device_scale_factor=1)
        page.on("pageerror", lambda err: print("pageerror:", err))
        await page.goto("http://127.0.0.1:8769/test/harness.html?w=640&h=330")
        for _ in range(80):
            if await page.evaluate("ready()"):
                break
            await asyncio.sleep(0.1)
        await page.evaluate(WHITE_RENDERER)
        await page.evaluate("""
window.resize = (w, h) => { const c = document.querySelector('#c'); c.width = w; c.height = h; };
0;
""")
        for scene in (scene_walk, scene_meep, scene_petting, scene_flutter):
            name, frames_dir, count = await scene(page)
            to_gif(name, frames_dir, count)
        await browser.close()


asyncio.run(main())
