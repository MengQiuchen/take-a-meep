#!/usr/bin/env python3
"""Load the real renderer (index.html + app.js) headlessly with a stubbed desktop bridge."""
import asyncio, http.server, os, threading, json
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"; OUT.mkdir(exist_ok=True)

STUB = """
window.__ipc = [];
window.__walkListeners = []; window.__dragListeners = []; window.__trayListeners = [];
window.meepDesktop = {
  setExpanded: async (e) => { window.__ipc.push(['set-expanded', e]); return e; },
  hideWindow: () => window.__ipc.push(['hide']),
  updateTimerState: (s) => window.__ipc.push(['timer', s]),
  notifyAlarm: () => window.__ipc.push(['alarm']),
  setLanguage: (l) => window.__ipc.push(['lang', l]),
  startWalk: async () => { window.__ipc.push(['start-walk']); return true; },
  cancelWalk: async () => { window.__ipc.push(['cancel-walk']); return true; },
  dragStart: async (p) => { window.__ipc.push(['drag-start', p]); return true; },
  dragMove: (p) => window.__ipc.push(['drag-move', p]),
  dragEnd: async (r) => { window.__ipc.push(['drag-end', r]); return true; },
  onWalkState: (cb) => { window.__walkListeners.push(cb); return () => {}; },
  onDragState: (cb) => { window.__dragListeners.push(cb); return () => {}; },
  onTrayAction: (cb) => { window.__trayListeners.push(cb); return () => {}; },
};
"""

def serve():
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

async def main():
    serve()
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 220, "height": 172}, device_scale_factor=2)
        await ctx.add_init_script(STUB)
        page = await ctx.new_page()
        page.on("console", lambda m: print("console:", m.type, m.text))
        page.on("pageerror", lambda e: (errors.append(str(e)), print("PAGEERROR:", e)))
        await page.goto("http://127.0.0.1:8766/src/renderer/index.html")
        await page.wait_for_timeout(1500)
        ready = await page.evaluate("window.__meepPuppetReady && window.__meepPuppetReady()")
        print("puppet ready:", ready)
        no_panel = await page.evaluate("!document.querySelector('.timer-panel') && !document.querySelector('#focusSelect')")
        print("no panel in window:", no_panel)
        await page.screenshot(path=str(OUT / "app-idle.png"))
        # meep test (the renderer exposes a hook; alarm UI is just the caption now)
        await page.evaluate("window.__meepTriggerAlarm()")
        await page.wait_for_timeout(230)
        await page.screenshot(path=str(OUT / "app-call.png"))
        await page.wait_for_timeout(1600)
        # single click = just a head tilt, nothing opens
        await page.click("#birdCanvas", position={"x": 110, "y": 100})
        await page.wait_for_timeout(300)
        print("body class after click:", await page.evaluate("document.body.className"))
        # walk state from 'main'
        await page.evaluate("window.__walkListeners.forEach(cb => cb({active:true, direction:'left', motion:'walk', speed:64, startedAt: Date.now()}))")
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(OUT / "app-walk.png"))
        await page.evaluate("window.__walkListeners.forEach(cb => cb({active:true, direction:'left', motion:'rock', speed:0, startedAt: Date.now()}))")
        await page.wait_for_timeout(500)
        await page.evaluate("window.__walkListeners.forEach(cb => cb({active:false, direction:'left', reason:'complete'}))")
        await page.wait_for_timeout(300)
        # drag: press on bird, move, release
        canvas = await page.query_selector("#birdCanvas")
        box = await canvas.bounding_box()
        sx, sy = box["x"] + 180, box["y"] + 100
        await page.mouse.move(sx, sy)
        await page.mouse.down()
        for i in range(1, 8):
            await page.mouse.move(sx - i * 12, sy - i * 6)
            await page.wait_for_timeout(30)
        # main would answer with held state
        await page.evaluate("window.__dragListeners.forEach(cb => cb({phase:'held'}))")
        await page.wait_for_timeout(400)
        await page.screenshot(path=str(OUT / "app-held.png"))
        await page.mouse.up()
        await page.evaluate("window.__dragListeners.forEach(cb => cb({phase:'falling'}))")
        await page.wait_for_timeout(200)
        await page.evaluate("window.__dragListeners.forEach(cb => cb({phase:'landed', impact: 1500}))")
        await page.wait_for_timeout(150)
        await page.screenshot(path=str(OUT / "app-landed.png"))
        await page.wait_for_timeout(1500)
        ipc = await page.evaluate("window.__ipc")
        kinds = [k[0] for k in ipc]
        print("ipc kinds:", sorted(set(kinds)))
        print("drag-start sent:", 'drag-start' in kinds, "drag-move count:", kinds.count('drag-move'), "drag-end:", 'drag-end' in kinds)
        print("body class now:", await page.evaluate("document.body.className"))
        # petting: rub back and forth over the feathers until the happy meep
        box = await canvas.bounding_box()
        rx, ry = box["x"] + box["width"] * 0.51, box["y"] + box["height"] - 60
        pet_meeped = False
        flip = 1
        for _ in range(85):
            flip = -flip
            await page.mouse.move(rx + flip * 22, ry)
            await page.wait_for_timeout(80)
            if await page.evaluate("document.body.classList.contains('alarming')"):
                pet_meeped = True
                break
        print("pet meeped:", pet_meeped)
        await page.screenshot(path=str(OUT / "app-petmeep.png"))
        # tray-driven settings: switch language, set focus length
        await page.evaluate("window.__trayListeners.forEach(cb => cb({type:'set-language', value:'zh'}))")
        await page.wait_for_timeout(150)
        print("zh hint:", await page.evaluate("document.querySelector('#idleHint').textContent"))
        await page.evaluate("window.__trayListeners.forEach(cb => cb({type:'set-language', value:'en'}))")
        await page.evaluate("window.__trayListeners.forEach(cb => cb({type:'set-focus', value:25}))")
        await page.wait_for_timeout(150)
        # hover reveal: unpin (the earlier click pinned it), pointer off = hidden, on = shown
        await page.click("#birdCanvas", position={"x": 110, "y": 100})
        await page.wait_for_timeout(2000)   # also lets the pet-meep 'alarming' flash expire
        await page.mouse.move(110, 2)
        await page.wait_for_timeout(400)
        print("chip off-hover opacity:", await page.evaluate("getComputedStyle(document.querySelector('#timerChip')).opacity"))
        await page.mouse.move(110, 100)
        await page.wait_for_timeout(400)
        print("chip hover opacity:", await page.evaluate("getComputedStyle(document.querySelector('#timerChip')).opacity"))
        # the chip's bird-head button meeps on demand
        await page.click("#chipMeep")
        await page.wait_for_timeout(250)
        print("meep button ->", await page.evaluate("document.body.classList.contains('alarming')"))
        await page.screenshot(path=str(OUT / "app-meep-button.png"))
        await page.wait_for_timeout(1800)
        # opacity setting ghosts the bird when the pointer is away
        await page.evaluate("window.__trayListeners.forEach(cb => cb({type:'set-bird-opacity', value:0.55}))")
        await page.mouse.move(110, 2)
        await page.wait_for_timeout(500)
        print("ghost opacity:", await page.evaluate("getComputedStyle(document.querySelector('#birdCanvas')).opacity"))
        await page.screenshot(path=str(OUT / "app-ghost.png"))
        await page.evaluate("window.__trayListeners.forEach(cb => cb({type:'set-bird-opacity', value:1}))")
        # double-click starts the timer -> chip shows the countdown while hovered
        await page.click("#birdCanvas", position={"x": 110, "y": 100})
        await page.wait_for_timeout(70)
        await page.click("#birdCanvas", position={"x": 110, "y": 100})
        await page.wait_for_timeout(400)
        chip = await page.evaluate("""(() => {
            const rect = document.querySelector('#timerChip').getBoundingClientRect();
            const stage = document.querySelector('#birdCanvas').getBoundingClientRect();
            return {opacity: getComputedStyle(document.querySelector('#timerChip')).opacity,
                    h: Math.round(rect.height), w: Math.round(rect.width),
                    bottom: Math.round(rect.bottom), stageTop: Math.round(stage.top),
                    time: document.querySelector('#chipTime').textContent,
                    row: getComputedStyle(document.querySelector('.chip-controls')).flexDirection};
        })()""")
        print("chip:", chip)
        await page.screenshot(path=str(OUT / "app-chip.png"))
        await browser.close()
    print("errors:", errors)

asyncio.run(main())
