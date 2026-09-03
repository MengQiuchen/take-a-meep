#!/usr/bin/env python3
"""Render the puppet through its behaviours in headless Chromium and save contact sheets."""
import asyncio
import http.server
import json
import os
import sys
import threading
from pathlib import Path

from playwright.async_api import async_playwright
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
OUT.mkdir(exist_ok=True)


def serve():
    handler = http.server.SimpleHTTPRequestHandler
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def capture(page, label, script, ms_list, sheet_name, cols=4, width=None):
    frames = []
    await page.evaluate(script)
    for ms in ms_list:
        await page.evaluate(f"step({ms})")
        await page.evaluate(f"renderFrame({{width: {width if width else 'undefined'}}})")
        path = OUT / f"_frame.png"
        await page.locator("#c").screenshot(path=str(path))
        frames.append((ms, Image.open(path).convert("RGB")))
    w, h = frames[0][1].size
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w, rows * (h + 16)), (30, 30, 30))
    d = ImageDraw.Draw(sheet)
    total = 0
    for i, (ms, im) in enumerate(frames):
        total += ms
        x, y = (i % cols) * w, (i // cols) * (h + 16)
        sheet.paste(im, (x, y))
        d.text((x + 4, y + h + 2), f"{label} +{total} ms", fill=(255, 255, 0))
    sheet.save(OUT / sheet_name)
    print("saved", sheet_name)


async def main():
    serve()
    big = os.environ.get("BIG") == "1"
    vw, vh = (760, 520) if big else (440, 330)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": vw, "height": vh}, device_scale_factor=2 if not big else 1)
        page.on("console", lambda msg: print("console:", msg.text))
        page.on("pageerror", lambda err: print("pageerror:", err))
        await page.goto(f"http://127.0.0.1:8765/test/harness.html?w={vw}&h={vh}")
        for _ in range(60):
            if await page.evaluate("ready()"):
                break
            await asyncio.sleep(0.1)
        assert await page.evaluate("ready()"), "puppet failed to load"
        which = sys.argv[1:] or ["rest", "call", "walk", "rock", "idle", "held", "probe"]

        if "rest" in which:
            await capture(page, "rest", "puppet.mode='idle'; puppet.nextActionAt=1e12;", [16] * 4 + [500] * 4, "rest.png")
        if "call" in which:
            await capture(page, "call", "puppet.playCall();", [16, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 300], "call.png", cols=6)
        if "walk" in which:
            await capture(page, "walk",
                          "puppet.setWalkState({active:true, direction:'left', motion:'walk', speed: 64/0.10625});",
                          [16] + [70] * 23, "walk.png", cols=6)
            await capture(page, "walk-right",
                          "puppet.setWalkState({active:true, direction:'right', motion:'walk', speed: 64/0.10625}); puppet.currentFacing=-1;",
                          [16] + [70] * 11, "walk-right.png", cols=6)
        if "rock" in which:
            await capture(page, "rock",
                          "puppet.setWalkState({active:true, direction:'left', motion:'rock', speed: 0});",
                          [16] + [60] * 17, "rock.png", cols=6)
        if "idle" in which:
            for name in ["look", "preen", "probe", "stretch", "shake", "tilt", "rock"]:
                await capture(page, name,
                              f"puppet.setWalkState({{active:false}}); puppet.mode='idle'; puppet.pointer={{x:0.4,y:-0.3,inside:true}}; puppet.action={{name:'{name}', startedAt: puppet.lastTime, duration: 2800, data:{{side:1, pokes:4, cycles:5, leg:'b'}}}};",
                              [16] + [150] * 17, f"idle-{name}.png", cols=6)
        if "pet" in which:
            await capture(page, "pet",
                          "puppet.mode='idle'; puppet.action=null; puppet.pointer={x:0.2,y:0,inside:true}; puppet.pointerMaster={x:760,y:300}; puppet.petLevel=1; puppet.petStrokes=[puppet.lastTime,puppet.lastTime,puppet.lastTime,puppet.lastTime]; puppet.nextHeartAt=0;",
                          [16] + [120] * 17, "pet.png", cols=6)
            await capture(page, "peck",
                          "puppet.mode='idle'; puppet.action=null; puppet.petLevel=0; puppet.petStrokes=[]; puppet.peckAction={startedAt: puppet.lastTime, target:{x:210,y:560}, pecks:2};",
                          [16] + [70] * 23, "peck.png", cols=6)
        if "fall-high" in which:
            await capture(page, "flutter",
                          "puppet.setHeld(true); puppet.setHeld(false,{x:0,y:0}); puppet.setFalling(400);",
                          [16] + [50] * 17, "flutter.png", cols=6)
        if "held" in which:
            await capture(page, "held", "puppet.setHeld(true); puppet.setDragVelocity({x:-600,y:0});", [16] + [90] * 11, "held.png", cols=6)
            await capture(page, "fall", "puppet.setHeld(false, {x:0,y:0}); puppet.setFalling();", [16] + [90] * 5, "fall.png", cols=6)
            await capture(page, "landed", "puppet.setLanded(1200);", [16] + [60] * 17, "landed.png", cols=6)
        await browser.close()


asyncio.run(main())
