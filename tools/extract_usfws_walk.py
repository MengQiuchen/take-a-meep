#!/usr/bin/env python3
"""Extract a clean, fixed-canvas American woodcock walk loop.

Source: Keith Ramos / U.S. Fish & Wildlife Service, via Wikimedia Commons.
The source page identifies the footage as CC BY 2.0 and a USFWS public-domain
work.  The camera follows one bird, so this script uses a stable hand-authored
trimap plus GrabCut instead of static-background subtraction.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


OUTPUT_SIZE = (820, 520)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", type=float, default=3.60)
    parser.add_argument("--end", type=float, default=4.64)
    parser.add_argument("--count", type=int, default=24)
    return parser.parse_args()


def largest_components(alpha: np.ndarray) -> np.ndarray:
    binary = np.where(alpha > 28, 255, 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count <= 1:
        return binary

    # The torso is the largest component.  Keep it plus small components in the
    # foot/bill regions so fine toes and a temporarily disconnected bill survive.
    torso_label = max(range(1, count), key=lambda label: int(stats[label, cv2.CC_STAT_AREA]))
    kept = labels == torso_label
    for label in range(1, count):
        if label == torso_label:
            continue
        x, y, width, height, area = stats[label]
        in_detail_region = (y > 610 and 620 < x < 1_080) or (x > 970 and 380 < y < 680)
        if in_detail_region and area >= 10:
            kept |= labels == label
    return np.where(kept, 255, 0).astype(np.uint8)


def make_grabcut_mask(frame: np.ndarray) -> np.ndarray:
    height, width = frame.shape[:2]
    mask = np.full((height, width), cv2.GC_BGD, dtype=np.uint8)

    # The source camera tracks the bird closely, keeping this silhouette stable.
    # The outer gate deliberately ends before the long cast shadow.
    gate = np.array(
        [
            (475, 545),
            (520, 470),
            (625, 405),
            (760, 365),
            (925, 370),
            (1_025, 405),
            (1_085, 480),
            (1_205, 590),
            (1_170, 635),
            (1_055, 650),
            (1_005, 725),
            (920, 770),
            (835, 742),
            (760, 775),
            (665, 730),
            (560, 675),
            (485, 610),
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(mask, [gate], cv2.GC_PR_BGD)

    # Conservative sure-foreground seeds: they never touch the silhouette edge.
    cv2.ellipse(mask, (790, 568), (208, 132), -3, 0, 360, cv2.GC_FGD, -1)
    cv2.ellipse(mask, (950, 470), (79, 84), -12, 0, 360, cv2.GC_FGD, -1)
    back = np.array(
        [(565, 535), (650, 438), (800, 394), (922, 414), (962, 482), (780, 510)],
        dtype=np.int32,
    )
    cv2.fillPoly(mask, [back], cv2.GC_FGD)
    cv2.line(mask, (1_003, 486), (1_157, 595), cv2.GC_FGD, 13)
    cv2.line(mask, (744, 662), (760, 734), cv2.GC_FGD, 12)
    cv2.line(mask, (910, 661), (970, 727), cv2.GC_FGD, 12)

    background_model = np.zeros((1, 65), np.float64)
    foreground_model = np.zeros((1, 65), np.float64)
    cv2.grabCut(
        frame,
        mask,
        None,
        background_model,
        foreground_model,
        8,
        cv2.GC_INIT_WITH_MASK,
    )

    hard_alpha = np.where(
        (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD),
        255,
        0,
    ).astype(np.uint8)
    hard_alpha = cv2.morphologyEx(hard_alpha, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    hard_alpha = cv2.morphologyEx(hard_alpha, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    hard_alpha = largest_components(hard_alpha)

    # Keep a crisp centre and a two-pixel soft feather edge.
    contracted = cv2.erode(hard_alpha, np.ones((3, 3), np.uint8), iterations=1)
    softened = cv2.GaussianBlur(hard_alpha, (5, 5), 0)
    alpha = np.maximum(contracted, softened)
    return alpha


def place_on_canvas(frame: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    coordinates = cv2.findNonZero(np.where(alpha > 12, 255, 0).astype(np.uint8))
    if coordinates is None:
        raise RuntimeError("No bird foreground found")
    x, y, width, height = cv2.boundingRect(coordinates)
    padding = 12
    x1 = max(0, x - padding)
    y1 = max(0, y - padding)
    x2 = min(frame.shape[1], x + width + padding)
    y2 = min(frame.shape[0], y + height + padding)

    crop = cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2BGRA)
    crop[:, :, 3] = alpha[y1:y2, x1:x2]
    target_height = 455
    scale = target_height / max(1, crop.shape[0])
    resized = cv2.resize(
        crop,
        (max(1, round(crop.shape[1] * scale)), target_height),
        interpolation=cv2.INTER_AREA,
    )

    canvas = np.zeros((OUTPUT_SIZE[1], OUTPUT_SIZE[0], 4), dtype=np.uint8)
    destination_x = (OUTPUT_SIZE[0] - resized.shape[1]) // 2
    destination_y = OUTPUT_SIZE[1] - resized.shape[0] - 18
    destination_x = max(0, destination_x)
    copy_width = min(resized.shape[1], OUTPUT_SIZE[0] - destination_x)
    canvas[
        destination_y : destination_y + resized.shape[0],
        destination_x : destination_x + copy_width,
    ] = resized[:, :copy_width]
    return canvas


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise SystemExit(f"Could not open {args.video}")

    timestamps = np.linspace(args.start, args.end, max(8, args.count), endpoint=False)
    written = 0
    previews: list[np.ndarray] = []
    for timestamp in timestamps:
        capture.set(cv2.CAP_PROP_POS_MSEC, float(timestamp * 1_000))
        ok, frame = capture.read()
        if not ok:
            continue
        alpha = make_grabcut_mask(frame)
        canvas = place_on_canvas(frame, alpha)
        destination = args.output / f"frame-{written:02d}.png"
        cv2.imwrite(str(destination), canvas)

        preview = np.full((260, 410, 3), 28, dtype=np.uint8)
        small = cv2.resize(canvas, (410, 260), interpolation=cv2.INTER_AREA)
        source_alpha = small[:, :, 3:4].astype(np.float32) / 255.0
        checker = np.full_like(preview, 52)
        checker[::24, :] = 64
        checker[:, ::24] = 64
        preview[:] = (
            small[:, :, :3].astype(np.float32) * source_alpha
            + checker.astype(np.float32) * (1 - source_alpha)
        ).astype(np.uint8)
        previews.append(preview)
        print(f"{destination.name} {timestamp:.3f}s")
        written += 1
    capture.release()

    columns = 4
    rows = (len(previews) + columns - 1) // columns
    sheet = np.full((rows * 260, columns * 410, 3), 24, dtype=np.uint8)
    for index, preview in enumerate(previews):
        row, column = divmod(index, columns)
        sheet[row * 260 : (row + 1) * 260, column * 410 : (column + 1) * 410] = preview
    cv2.imwrite(str(args.output / "contact-sheet.png"), sheet)
    print(f"frames={written}")


if __name__ == "__main__":
    main()
