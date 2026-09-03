<p align="center">
  <img src="docs/media/icon.png" width="120" alt="Take a Meep app icon" />
</p>

<h1 align="center">Take a Meep</h1>

<p align="center">
  <em>A real-footage American Woodcock who lives in the corner of your Mac,<br/>
  keeps your pomodoro, and <b>meep!</b>s at you when it's time to take a break.</em>
</p>

<p align="center">
  <b>English</b> · <a href="./README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="docs/media/walk.gif" width="600" alt="the woodcock walking off and back, doing its signature rock" />
</p>

<p align="center"><sub>
  Every feather is a slice of one public-domain USFWS photograph, re-rigged into a 12-layer puppet.<br/>
  The gait — a few slow steps, stop, rock back and forth — was frame-tracked from real woodcock footage.
</sub></p>

## Download

**[⬇️ Get Take a Meep for macOS (Apple Silicon)](https://github.com/MengQiuchen/take-a-meep/releases/latest)** — grab the `.dmg`, drag the bird into Applications, done.

> **First launch**: the app is ad-hoc signed (no Apple notarization yet), so macOS will warn you.
> Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** — or run
> `xattr -cr "/Applications/Take a Meep.app"` once in Terminal. After that it opens normally.

## Meet the bird

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/media/meep.gif" width="360" alt="the meep meep call" /><br/>
      <b>It meeps.</b> Focus block done → head thrown back, bill wide open,
      <i>meep meep!</i> Three de-noised takes of the real call, picked at random
      so it never sounds like a sample loop.
    </td>
    <td align="center" width="50%">
      <img src="docs/media/petting.gif" width="360" alt="petting the bird, hearts appear" /><br/>
      <b>It likes being petted.</b> Rub its feathers → squinty eyes, fluffed chest,
      little hearts. Keep going and it meeps with joy.
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/media/flutter.gif" width="360" alt="carried, dropped, wing flutter, landing" /><br/>
      <b>It can be carried.</b> Pick it up anywhere; legs paddle in protest.
      Drop it from high and it flutters its wings all the way down.
    </td>
    <td align="center">
      <img src="docs/media/chip.png" width="360" alt="the floating timer pill above the bird" /><br/>
      <b>It wears its timer like a thought bubble.</b> Hover to peek, click to pin:
      ⏸ ↺ ■, and a tiny bird-head button that meeps on demand.
    </td>
  </tr>
</table>

## What it does

- 🍅 **Pomodoro, bird-shaped** — double-click the bird: 30 min focus + 5 min break, on repeat (lengths configurable).
- 🚶 **Break walks, timed to the millisecond** — the whole break is one out-and-back walk that ends exactly where and when it started. Long break: longer sways, a farther turn-around point, foraging at the far end. Short break: quicker sways, a closer turn-around.
- 🧘 **Focus means focus** — while you work (or pause) it never wanders off; it only preens, probes the ground, looks around, and dozes after 4 quiet minutes.
- 🐛 **Curious** — park your cursor in front of its bill and it leans in for an inquisitive peck.
- ☰ **Everything lives in the menu bar** — timer status & controls, focus/break lengths, idle walks, mute, **bird size & opacity**, language (EN / 中文). No windows, no panels.
- 🪶 **Real feathers, real physics** — photo-sliced 2.5D puppet with a stretchy neck, two-bone IK legs and a tail fan; gravity, bounces and wing-flutter when dropped.

## Run it

macOS (Apple Silicon) with Node 20+:

```bash
npm install
npm start            # run it right away
npm run package:mac  # build "Take a Meep.app" (ad-hoc signed, dist/)
```

Or just double-click **`build-and-install.command`** — it builds the app, installs it to your Desktop and launches it.

## Cheat sheet

| You | The bird |
|---|---|
| Double-click | starts / pauses the cycle |
| Hover | timer pill fades in |
| Single click | pins / unpins the pill (plus a head tilt) |
| Rub back & forth | fluff + hearts; keep going → joyful meep |
| Hold & drag | carried off, legs pedalling |
| Drop from high | wing-flutter descent, crouch landing |
| Cursor by its bill | inquisitive peck |
| Menu-bar bird | every setting, one menu |

## How it's made

The bird is a **photo-driven 2.5D puppet**: 12 layers (skull, stretchy neck, body, near wing, both mandibles, two legs with stretchable tarsi, a fanned tail feather, an eyelid) sliced out of a single public-domain USFWS photograph, driven by a small rig with two-bone leg IK. Walking numbers — 13% body-length sway, 85% head-follow, steps only during the forward surge — come from camera-compensated frame tracking of USFWS walking footage. The whole app is one transparent, always-on-top Electron window plus a tray menu.

Full technical notes (how the layers are cut, how the gait was measured, how break walks are scheduled) live in **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** (in Chinese).

## Credits & license

- **Woodcock photo**: Tiffany Vanwyck / U.S. Fish & Wildlife Service — public domain. **Walking footage** (gait reference): Keith Ramos / USFWS. See [`assets/ATTRIBUTION.md`](assets/ATTRIBUTION.md).
- **Call audio**: recorded by the project owner, de-noised & remixed for this app; not for standalone redistribution.
- **Behaviour references**: Frontiers in Zoology (2014) on head-bobbing & gait; birders' field notes on the woodcock rock.
- **Code**: [MIT](LICENSE). Raw source videos and intermediate frames are deliberately not part of this repository.

<p align="center"><sub>🐦 <i>meep responsibly — take your breaks.</i></sub></p>
