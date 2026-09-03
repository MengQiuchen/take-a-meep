#!/usr/bin/env python3
"""Crop a transparent PNG to its visible alpha bounds with optional resizing."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--padding", type=int, default=32)
    parser.add_argument("--max-width", type=int, default=1600)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    image = cv2.imread(str(args.input), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        raise SystemExit("input must be an RGBA PNG")

    visible = np.where(image[:, :, 3] > 8, 255, 0).astype(np.uint8)
    coordinates = cv2.findNonZero(visible)
    if coordinates is None:
        raise SystemExit("input has no visible alpha")
    x, y, width, height = cv2.boundingRect(coordinates)
    padding = max(0, args.padding)
    x1 = max(0, x - padding)
    y1 = max(0, y - padding)
    x2 = min(image.shape[1], x + width + padding)
    y2 = min(image.shape[0], y + height + padding)
    crop = image[y1:y2, x1:x2]

    if args.max_width > 0 and crop.shape[1] > args.max_width:
        scale = args.max_width / crop.shape[1]
        crop = cv2.resize(
            crop,
            (args.max_width, max(1, round(crop.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.output), crop)
    print(f"{args.output} {crop.shape[1]}x{crop.shape[0]}")


if __name__ == "__main__":
    main()
