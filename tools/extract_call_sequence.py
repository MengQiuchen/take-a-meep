#!/usr/bin/env python3
"""Build a fixed-canvas transparent PNG sequence for one woodcock call."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("background", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", type=float, default=9.18)
    parser.add_argument("--end", type=float, default=9.68)
    parser.add_argument("--count", type=int, default=16)
    return parser.parse_args()


def largest_component(mask: np.ndarray) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return mask
    best_label = max(
        range(1, count),
        key=lambda label: int(stats[label, cv2.CC_STAT_AREA])
        + int(stats[label, cv2.CC_STAT_HEIGHT]) * 12
        + int(stats[label, cv2.CC_STAT_WIDTH]) * 3,
    )
    return np.where(labels == best_label, 255, 0).astype(np.uint8)


def foreground_alpha(frame: np.ndarray, background: np.ndarray) -> np.ndarray:
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = 1_050, 90, min(width, 2_260), min(height, 1_160)
    difference = cv2.absdiff(frame, background)
    difference = cv2.cvtColor(difference, cv2.COLOR_BGR2GRAY)
    difference = cv2.GaussianBlur(difference, (5, 5), 0)

    grab_mask = np.full((height, width), cv2.GC_BGD, dtype=np.uint8)
    roi = grab_mask[y1:y2, x1:x2]
    roi[:] = cv2.GC_PR_BGD
    roi_difference = difference[y1:y2, x1:x2]
    roi[roi_difference > 7] = cv2.GC_PR_FGD
    roi[roi_difference > 23] = cv2.GC_FGD

    torso = grab_mask[340:1_030, 1_180:1_850]
    torso_difference = difference[340:1_030, 1_180:1_850]
    torso[torso_difference > 11] = cv2.GC_FGD

    background_model = np.zeros((1, 65), np.float64)
    foreground_model = np.zeros((1, 65), np.float64)
    cv2.grabCut(frame, grab_mask, None, background_model, foreground_model, 6, cv2.GC_INIT_WITH_MASK)
    alpha = np.where(
        (grab_mask == cv2.GC_FGD) | (grab_mask == cv2.GC_PR_FGD),
        255,
        0,
    ).astype(np.uint8)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    alpha = largest_component(alpha)
    return cv2.GaussianBlur(alpha, (5, 5), 0)


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    background = cv2.imread(str(args.background), cv2.IMREAD_COLOR)
    if background is None:
        raise SystemExit("Could not read clean background")
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise SystemExit("Could not open video")

    timestamps = np.linspace(args.start, args.end, max(4, args.count))
    # Keep the exact same crop as the idle texture so the 3D plane does not jump.
    crop_x1, crop_y1, crop_x2, crop_y2 = 1_099, 260, 2_099, 997
    output_size = (680, 501)
    written = 0
    for index, timestamp in enumerate(timestamps):
        capture.set(cv2.CAP_PROP_POS_MSEC, float(timestamp * 1_000))
        ok, frame = capture.read()
        if not ok:
            continue
        alpha = foreground_alpha(frame, background)
        rgba = cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA)
        rgba[:, :, 3] = alpha
        cropped = rgba[crop_y1:crop_y2, crop_x1:crop_x2]
        resized = cv2.resize(cropped, output_size, interpolation=cv2.INTER_AREA)
        destination = args.output / f"frame-{written:02d}.png"
        cv2.imwrite(str(destination), resized)
        print(f"{destination.name} {timestamp:.3f}s")
        written += 1
    capture.release()
    print(f"frames={written}")


if __name__ == "__main__":
    main()
