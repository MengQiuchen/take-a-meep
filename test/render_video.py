#!/usr/bin/env python3
"""Render a preview video of the puppet's behaviours (30 fps) with headless Chromium."""
import asyncio
import http.server
import os
import subprocess
import threading
from pathlib import Path

from playwright.async_api import async_playwright
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out" / "video"
OUT.mkdir(parents=True, exist_ok=True)
FPS = 30
STEP = 1000 / FPS


def serve():
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8767), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


SCENES = [
    ("idle", "puppet.mode='idle'; puppet.nextActionAt=1e12;", 1.2),
    ("meep meep (timer done)", "puppet.playCall();", 2.0),
    ("look around", "puppet.action={name:'look', startedAt: performance.now(), duration: 2600, data:{side:1,pokes:4,cycles:5,leg:'b'}};", 2.8),
    ("walk: body sways, head glides on the neck", "puppet.setWalkState({active:true, direction:'left', motion:'walk', speed: 48/0.10625});", 3.6),
    ("stop and rock", "puppet.setWalkState({active:true, direction:'left', motion:'rock', speed: 0});", 2.2),
    ("turn", "puppet.setWalkState({active:true, direction:'right', motion:'turn', speed: 0});", 0.6),
    ("walk back", "puppet.setWalkState({active:true, direction:'right', motion:'walk', speed: 48/0.10625});", 2.6),
    ("settle", "puppet.setWalkState({active:false}); puppet.setFacing('left'); puppet.nextActionAt=1e12;", 1.4),
    ("preen", "puppet.action={name:'preen', startedAt: performance.now(), duration: 2800, data:{side:1,pokes:4,cycles:5,leg:'b'}};", 3.0),
    ("probe the ground", "puppet.action={name:'probe', startedAt: performance.now(), duration: 2900, data:{side:1,pokes:4,cycles:5,leg:'b'}};", 3.1),
    ("leg stretch", "puppet.action={name:'stretch', startedAt: performance.now(), duration: 2300, data:{side:1,pokes:4,cycles:5,leg:'b'}};", 2.5),
    ("shake", "puppet.action={name:'shake', startedAt: performance.now(), duration: 900, data:{side:1,pokes:4,cycles:5,leg:'b'}};", 1.3),
    ("head tilt (pointer nearby)", "puppet.pointer={x:0.3,y:-0.4,inside:true}; puppet.action={name:'tilt', startedAt: performance.now(), duration: 1800, data:{side:1,pokes:4,cycles:5,leg:'b'}};", 2.0),
    ("petting: rub back and forth", "puppet.mode='idle'; puppet.action=null; puppet.pointer={x:0.2,y:0,inside:true}; puppet.pointerMaster={x:760,y:300}; puppet.petLevel=1; puppet.petStrokes=[performance.now(),performance.now(),performance.now(),performance.now()]; puppet.nextHeartAt=0;", 3.4),
    ("peck at a still pointer", "puppet.petLevel=0; puppet.petStrokes=[]; puppet.peckAction={startedAt: performance.now(), target:{x:210,y:560}, pecks:2};", 1.9),
    ("picked up (drag)", "puppet.pointer={x:0,y:0,inside:false}; puppet.setHeld(true); puppet.setDragVelocity({x:-500,y:0});", 2.4),
    ("dropped from high: wing flutter", "puppet.setHeld(false,{x:0,y:0}); puppet.setFalling(400);", 1.4),
    ("landed", "puppet.setLanded(1300);", 1.8),
    ("dozing (4 min idle)", "puppet.lastInteractionAt = performance.now() - 241000; puppet.mode='idle';", 3.2),
    ("wake up", "puppet.touch();", 1.5),
]


async def main():
    serve()
    vw, vh = 640, 420
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": vw, "height": vh}, device_scale_factor=1)
        page.on("pageerror", lambda err: print("pageerror:", err))
        await page.goto(f"http://127.0.0.1:8767/test/harness.html?w={vw}&h={vh}")
        for _ in range(60):
            if await page.evaluate("ready()"):
                break
            await asyncio.sleep(0.1)
        index = 0
        for label, script, seconds in SCENES:
            await page.evaluate(script)
            frames = int(seconds * FPS)
            for _ in range(frames):
                await page.evaluate(f"step({STEP})")
                await page.evaluate("renderFrame({})")
                path = OUT / f"f{index:05d}.png"
                await page.locator("#c").screenshot(path=str(path))
                im = Image.open(path).convert("RGB")
                d = ImageDraw.Draw(im)
                d.rectangle((0, 0, vw, 26), fill=(24, 24, 24))
                d.text((10, 7), label, fill=(255, 220, 140))
                im.save(path)
                index += 1
        await browser.close()
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", str(OUT / "f%05d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", str(ROOT / "artifacts" / "meep-bird-behaviours.mp4")
    ], check=True)
    print("video written", index, "frames")


asyncio.run(main())
