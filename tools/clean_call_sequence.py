#!/usr/bin/env python3
"""Trim incidental grass from Vision-segmented, user-owned meep frames.

The source frames already contain alpha from Apple's foreground-instance mask.
This pass only intersects that alpha with a conservative hand-authored bird
envelope; it never paints or regenerates anatomy.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def bird_envelope(width: int, height: int) -> np.ndarray:
    # Coordinates are authored against the normalized 680 x 501 call frames.
    sx = width / 680.0
    sy = height / 501.0
    mask = np.zeros((height, width), dtype=np.uint8)

    def point(x: float, y: float) -> tuple[int, int]:
        return round(x * sx), round(y * sy)

    # Only the upright head/neck/breast is used as a soft 2.5D overlay on top
    # of the clean side-profile master.  Omitting the rear half removes the
    # source grass without inventing any replacement pixels.
    cv2.ellipse(mask, point(348, 322), point(136, 178), 1, 0, 360, 255, -1)
    cv2.ellipse(mask, point(318, 209), point(151, 170), 3, 0, 360, 255, -1)
    cv2.ellipse(mask, point(325, 104), point(132, 105), 0, 0, 360, 255, -1)

    # Wide wedge that retains both upper and lower bill through the full call.
    bill = np.array(
        [point(350, 72), point(680, 120), point(680, 292), point(358, 221)],
        dtype=np.int32,
    )
    cv2.fillPoly(mask, [bill], 255)

    return cv2.GaussianBlur(mask, (13, 13), 0)


def composite_preview(image: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    resized = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    alpha = resized[:, :, 3:4].astype(np.float32) / 255.0
    checker = np.full((size[1], size[0], 3), 42, dtype=np.uint8)
    checker[::20, :] = 55
    checker[:, ::20] = 55
    return (
        resized[:, :, :3].astype(np.float32) * alpha
        + checker.astype(np.float32) * (1.0 - alpha)
    ).astype(np.uint8)


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sources = sorted(args.input.glob("frame-*.png"))
    if not sources:
        raise SystemExit(f"No frame PNGs in {args.input}")

    previews: list[np.ndarray] = []
    for source in sources:
        image = cv2.imread(str(source), cv2.IMREAD_UNCHANGED)
        if image is None or image.shape[2] != 4:
            raise SystemExit(f"Could not read RGBA frame: {source}")
        envelope = bird_envelope(image.shape[1], image.shape[0])
        image[:, :, 3] = np.minimum(image[:, :, 3], envelope)

        # Remove tiny detached remnants while preserving the two bill halves.
        binary = np.where(image[:, :, 3] > 8, 255, 0).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
        keep = np.zeros_like(binary)
        for label in range(1, count):
            if stats[label, cv2.CC_STAT_AREA] >= 80:
                keep[labels == label] = 255
        image[:, :, 3] = np.minimum(image[:, :, 3], cv2.GaussianBlur(keep, (3, 3), 0))

        destination = args.output / source.name
        cv2.imwrite(str(destination), image)
        previews.append(composite_preview(image, (340, 250)))

    columns = 4
    rows = (len(previews) + columns - 1) // columns
    sheet = np.full((rows * 250, columns * 340, 3), 30, dtype=np.uint8)
    for index, preview in enumerate(previews):
        row, column = divmod(index, columns)
        sheet[row * 250 : (row + 1) * 250, column * 340 : (column + 1) * 340] = preview
    cv2.imwrite(str(args.output / "contact-sheet.png"), sheet)
    print(f"frames={len(previews)} output={args.output}")


if __name__ == "__main__":
    main()
