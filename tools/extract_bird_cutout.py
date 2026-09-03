#!/usr/bin/env python3
"""Extract a foreground bird from a static-camera video frame using a clean background."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("frame", type=Path)
    parser.add_argument("background", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--bbox", default="1050,90,2260,1160", help="x1,y1,x2,y2 in source pixels")
    return parser.parse_args()


def largest_component(mask: np.ndarray) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return mask
    candidates = []
    for label in range(1, count):
        x, y, width, height, area = stats[label]
        score = area + (height * 12) + (width * 3)
        candidates.append((score, label))
    selected = max(candidates)[1]
    return np.where(labels == selected, 255, 0).astype(np.uint8)


def main() -> None:
    args = parse_args()
    frame = cv2.imread(str(args.frame), cv2.IMREAD_COLOR)
    background = cv2.imread(str(args.background), cv2.IMREAD_COLOR)
    if frame is None or background is None:
        raise SystemExit("Could not read frame or background")
    if frame.shape != background.shape:
        raise SystemExit(f"Frame shapes differ: {frame.shape} vs {background.shape}")

    height, width = frame.shape[:2]
    x1, y1, x2, y2 = [int(value) for value in args.bbox.split(",")]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(width, x2), min(height, y2)

    difference = cv2.absdiff(frame, background)
    difference = cv2.cvtColor(difference, cv2.COLOR_BGR2GRAY)
    difference = cv2.GaussianBlur(difference, (5, 5), 0)

    grab_mask = np.full((height, width), cv2.GC_BGD, dtype=np.uint8)
    roi = grab_mask[y1:y2, x1:x2]
    roi[:] = cv2.GC_PR_BGD
    roi_difference = difference[y1:y2, x1:x2]
    roi[roi_difference > 7] = cv2.GC_PR_FGD
    roi[roi_difference > 24] = cv2.GC_FGD

    # Keep a compact sure-foreground seed across the bird's torso. Coordinates
    # are proportional so the script remains useful for other frames of this clip.
    seed_x1 = x1 + round((x2 - x1) * 0.30)
    seed_x2 = x1 + round((x2 - x1) * 0.72)
    seed_y1 = y1 + round((y2 - y1) * 0.24)
    seed_y2 = y1 + round((y2 - y1) * 0.82)
    seed = grab_mask[seed_y1:seed_y2, seed_x1:seed_x2]
    seed_diff = difference[seed_y1:seed_y2, seed_x1:seed_x2]
    seed[seed_diff > 12] = cv2.GC_FGD

    background_model = np.zeros((1, 65), np.float64)
    foreground_model = np.zeros((1, 65), np.float64)
    cv2.grabCut(frame, grab_mask, None, background_model, foreground_model, 7, cv2.GC_INIT_WITH_MASK)

    alpha = np.where(
        (grab_mask == cv2.GC_FGD) | (grab_mask == cv2.GC_PR_FGD),
        255,
        0,
    ).astype(np.uint8)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    alpha = largest_component(alpha)
    alpha = cv2.GaussianBlur(alpha, (5, 5), 0)

    coordinates = cv2.findNonZero(np.where(alpha > 10, 255, 0).astype(np.uint8))
    if coordinates is None:
        raise SystemExit("No foreground found")
    crop_x, crop_y, crop_width, crop_height = cv2.boundingRect(coordinates)
    padding = 28
    crop_x1 = max(0, crop_x - padding)
    crop_y1 = max(0, crop_y - padding)
    crop_x2 = min(width, crop_x + crop_width + padding)
    crop_y2 = min(height, crop_y + crop_height + padding)

    rgba = cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha
    cropped = rgba[crop_y1:crop_y2, crop_x1:crop_x2]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.output), cropped)

    preview = frame.copy()
    preview[alpha < 10] = (24, 24, 24)
    preview_output = args.output.with_name(args.output.stem + "-preview.jpg")
    cv2.imwrite(str(preview_output), preview)
    print(f"sourceSize={width}x{height}")
    print(f"crop={crop_x1},{crop_y1},{crop_x2},{crop_y2}")
    print(args.output)
    print(preview_output)


if __name__ == "__main__":
    main()
