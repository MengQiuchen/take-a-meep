#!/usr/bin/env python3
"""Create the macOS app icon from the authorized real-bird cutout.

Layout follows the Big Sur icon grid: a 824x824 squircle centred on a 1024
canvas, warm dawn-sky gradient, soft ground, and the woodcock standing on it.
Writes MeepBird-1024.png plus the full .iconset; runs `iconutil` when it is
available (macOS) to produce MeepBird.icns.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

CANVAS = 1024
GRID = 824                      # Apple icon grid square
RADIUS = 186                    # its corner radius
INSET = (CANVAS - GRID) // 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="bird cutout (RGBA)")
    parser.add_argument("output", type=Path, help="assets/icon directory")
    return parser.parse_args()


def squircle_mask(size: int, inset: int, radius: int, supersample: int = 4) -> Image.Image:
    big = size * supersample
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset * supersample, inset * supersample, big - inset * supersample, big - inset * supersample),
        radius=radius * supersample,
        fill=255,
    )
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def dawn_background() -> Image.Image:
    """Warm dawn gradient with a soft sun glow, like the bird's woodland at first light."""
    yy, xx = np.mgrid[0:CANVAS, 0:CANVAS].astype(np.float32)
    v = yy / CANVAS
    # Sky: pale cream -> apricot -> toasted orange.
    stops = [
        (0.00, (252, 238, 214)),
        (0.42, (248, 205, 146)),
        (0.74, (232, 160, 96)),
        (1.00, (196, 116, 62)),
    ]
    rgb = np.zeros((CANVAS, CANVAS, 3), dtype=np.float32)
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        span = np.clip((v - p0) / (p1 - p0), 0, 1)
        band = (v >= p0) & (v <= p1)
        for channel in range(3):
            seg = c0[channel] + (c1[channel] - c0[channel]) * span
            rgb[..., channel] = np.where(band, seg, rgb[..., channel])
    rgb[v > 1.0] = stops[-1][1]
    # Low sun glow behind the bird.
    glow = np.exp(-(((xx - 388) / 300) ** 2 + ((yy - 596) / 250) ** 2))
    rgb += glow[..., None] * np.array([46, 30, 6], dtype=np.float32)
    # Gentle vignette so the corners sit back.
    cx, cy = CANVAS / 2, CANVAS / 2
    r = np.sqrt(((xx - cx) / (CANVAS * 0.62)) ** 2 + ((yy - cy) / (CANVAS * 0.62)) ** 2)
    rgb *= (1 - 0.16 * np.clip(r - 0.55, 0, 1))[..., None]
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


def prepare_bird(source: Path) -> Image.Image:
    bird = Image.open(source).convert("RGBA")
    box = bird.getchannel("A").getbbox()
    if box:
        bird = bird.crop(box)
    bird.thumbnail((610, 498), Image.Resampling.LANCZOS)
    return bird


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    art = dawn_background()
    draw = ImageDraw.Draw(art)

    # Ground: darker warm band with a hint of texture.
    ground_top = 758
    ground = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(ground)
    gd.rectangle((0, ground_top, CANVAS, CANVAS), fill=(146, 84, 48, 255))
    gd.rectangle((0, ground_top, CANVAS, ground_top + 14), fill=(170, 100, 56, 255))
    ground = ground.filter(ImageFilter.GaussianBlur(3))
    art.alpha_composite(ground)

    bird = prepare_bird(args.source)
    bird_x = (CANVAS - bird.width) // 2 + 18
    bird_y = ground_top - bird.height + 52     # feet just past the ground line

    # Soft contact shadow.
    shadow = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(shadow).ellipse(
        (bird_x + 40, ground_top - 6, bird_x + bird.width - 20, ground_top + 66),
        fill=110,
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    art.alpha_composite(Image.merge("RGBA", [
        Image.new("L", (CANVAS, CANVAS), 30),
        Image.new("L", (CANVAS, CANVAS), 14),
        Image.new("L", (CANVAS, CANVAS), 8),
        shadow,
    ]))

    # A whisper of back-light around the bird so it pops off the sky.
    halo = Image.new("L", (CANVAS, CANVAS), 0)
    halo.paste(bird.getchannel("A"), (bird_x, bird_y))
    halo = halo.filter(ImageFilter.GaussianBlur(16))
    art.alpha_composite(Image.merge("RGBA", [
        Image.new("L", (CANVAS, CANVAS), 255),
        Image.new("L", (CANVAS, CANVAS), 244),
        Image.new("L", (CANVAS, CANVAS), 214),
        halo.point(lambda a: a * 0.5),
    ]))

    art.alpha_composite(bird, (bird_x, bird_y))

    # Clip to the squircle, add a soft inner top highlight and a hairline edge.
    mask = squircle_mask(CANVAS, INSET, RADIUS)
    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    icon.paste(art, (0, 0), mask)

    edge = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        (INSET + 1, INSET + 1, CANVAS - INSET - 1, CANVAS - INSET - 1),
        radius=RADIUS,
        outline=(255, 252, 244, 70),
        width=3,
    )
    icon.alpha_composite(edge.filter(ImageFilter.GaussianBlur(1)))

    master = args.output / "MeepBird-1024.png"
    icon.save(master)

    iconset = args.output / "MeepBird.iconset"
    iconset.mkdir(exist_ok=True)
    for points in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            pixels = points * scale
            suffix = "" if scale == 1 else "@2x"
            icon.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
                iconset / f"icon_{points}x{points}{suffix}.png"
            )

    if shutil.which("iconutil"):
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(args.output / "MeepBird.icns")],
            check=True,
        )
        print(f"icon + icns written to {args.output}")
    else:
        print(f"iconset written to {args.output} (run `npm run icon` on macOS for the .icns)")


if __name__ == "__main__":
    main()
