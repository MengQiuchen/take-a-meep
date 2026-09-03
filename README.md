<p align="center">
  <img src="docs/media/icon.png" width="120" alt="Take a Meep app icon" />
</p>

<h1 align="center">Take a Meep</h1>

<p align="center">
  <em>A real-footage American Woodcock who lives in the corner of your Mac,<br/>
  keeps your pomodoro, and <b>meep!</b>s at you when it's time to take a break.</em>
</p>

<p align="center">
  一只住在你 Mac 右下角的<b>实拍丘鹬</b>：替你掐番茄钟，到点仰头 <b>meep meep</b> 两声，<br/>
  然后把整段休息时间用来出门散步——掐着秒、准点走回原位。
</p>

<p align="center">
  <img src="docs/media/walk.gif" width="600" alt="the woodcock walking off and back, doing its signature rock" />
</p>

<p align="center"><sub>
  Every feather is a slice of one public-domain USFWS photograph, re-rigged into a 12-layer puppet.<br/>
  The gait — a few slow steps, stop, rock back and forth — was frame-tracked from real woodcock footage.<br/>
  每一根羽毛都来自同一张 USFWS 公共领域实拍照片；"走几步、停下前后摇摆"的步态逐帧对照真实影像还原。
</sub></p>

## Meet the bird · 见见这只鸟

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/media/meep.gif" width="360" alt="the meep meep call" /><br/>
      <b>It meeps.</b> Focus block done → head thrown back, bill wide open,
      <i>meep meep!</i> Three de-noised takes of the real call, picked at random.<br/>
      <sub>专注结束就仰头大叫两声——三个降噪叫声变体随机播放，不像循环采样。</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/media/petting.gif" width="360" alt="petting the bird, hearts appear" /><br/>
      <b>It likes being petted.</b> Rub its feathers → squinty eyes, fluffed chest,
      little hearts. Keep going and it meeps with joy.<br/>
      <sub>来回摩擦会眯眼、蓬毛、冒爱心；一直摸下去它会开心得叫出声。</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/media/flutter.gif" width="360" alt="carried, dropped, wing flutter, landing" /><br/>
      <b>It can be carried.</b> Pick it up anywhere; legs paddle in protest.
      Drop it from high and it flutters its wings all the way down.<br/>
      <sub>随手拎走，两腿悬空乱蹬；从高处松手会一路扑棱翅膀减速。</sub>
    </td>
    <td align="center">
      <img src="docs/media/chip.png" width="360" alt="the floating timer pill above the bird" /><br/>
      <b>It wears its timer like a thought bubble.</b> Hover to peek, click to pin:
      ⏸ ↺ ■, and a tiny bird-head button that meeps on demand.<br/>
      <sub>悬停看倒计时，单击钉住；尾端的小鸟头按钮点了就叫。</sub>
    </td>
  </tr>
</table>

## What it does · 它会做什么

- 🍅 **Pomodoro, bird-shaped** — double-click the bird: 30 min focus + 5 min break, on repeat (lengths configurable). 双击开始/暂停循环计时。
- 🚶 **Break walks, timed to the millisecond** — the whole break is one out-and-back walk that ends exactly where and when it started. Long break: longer sways, farther turn-around, foraging at the far end. Short break: quicker sways, closer turn-around. 休息散步按时长精确编排、准点回到出发点。
- 🧘 **Focus means focus** — while you work (or pause) it never wanders off; it only preens, probes the ground, looks around, and dozes after 4 quiet minutes. 专注和暂停时绝不出门，只做小动作。
- 🐛 **Curious** — park your cursor in front of its bill and it leans in for an inquisitive peck. 鼠标停在嘴前会好奇地啄一下。
- ☰ **Everything lives in the menu bar** — timer status & controls, focus/break lengths, idle walks, mute, **bird size & opacity**, language (EN / 中文). No windows, no panels. 所有设置都在菜单栏小鸟里。
- 🪶 **Real feathers, real physics** — photo-sliced 2.5D puppet with a stretchy neck, two-bone IK legs and a tail fan; gravity, bounces and wing-flutter when dropped. 实拍羽毛 + 真实步态数据。

## Run it · 跑起来

macOS (Apple Silicon) with Node 20+:

```bash
npm install
npm start            # run it right away
npm run package:mac  # build "Take a Meep.app" (ad-hoc signed, dist/)
```

Or just double-click **`打包并安装到桌面.command`** — it builds the app, installs it to your Desktop and launches it.

## Cheat sheet · 操作速查

| You · 你 | The bird · 鸟 |
|---|---|
| Double-click 双击 | start / pause the cycle 开始 / 暂停计时 |
| Hover 悬停 | timer pill fades in 时间牌浮现 |
| Single click 单击 | pin / unpin the pill, plus a head tilt 钉住/收起时间牌（附赠歪头） |
| Rub back & forth 来回摩擦 | fluff + hearts; keep going → joyful meep 蓬毛冒爱心，摸久了开心大叫 |
| Hold & drag 按住拖动 | carried off, legs pedalling 被拎走，腿乱蹬 |
| Drop from high 高处松手 | wing-flutter descent, crouch landing 扑棱减速，落地蹲一下 |
| Cursor by its bill 鼠标停在嘴前 | inquisitive peck 好奇一啄 |
| Menu-bar bird 菜单栏小鸟 | every setting, one menu 所有设置 |

## How it's made · 怎么做的

The bird is a **photo-driven 2.5D puppet**: 12 layers (skull, stretchy neck, body, near wing, both mandibles, two legs with stretchable tarsi, a fanned tail feather, an eyelid) sliced out of a single public-domain USFWS photograph, driven by a small rig with two-bone leg IK. Walking numbers — 13% body-length sway, 85% head-follow, steps only during the forward surge — come from camera-compensated frame tracking of USFWS walking footage. The whole app is one transparent, always-on-top Electron window plus a tray menu.

完整的技术细节（图层如何切、步态如何测、散步如何按休息时长编排）见 **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**。

## Credits & license · 素材与许可

- **Woodcock photo**: Tiffany Vanwyck / U.S. Fish & Wildlife Service — public domain. **Walking footage** (gait reference): Keith Ramos / USFWS. See [`assets/ATTRIBUTION.md`](assets/ATTRIBUTION.md).
- **Call audio**: recorded by the project owner, de-noised & remixed for this app; not for standalone redistribution.
- **Behaviour references**: Frontiers in Zoology (2014) on head-bobbing & gait; birders' field notes on the woodcock rock.
- **Code**: [MIT](LICENSE). Raw source videos and intermediate frames are deliberately not part of this repository.

<p align="center"><sub>🐦 <i>meep responsibly — take your breaks.</i> · 记得休息。</sub></p>
