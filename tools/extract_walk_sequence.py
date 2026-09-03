#!/usr/bin/env python3
"""Extract an adult woodcock walk loop as fixed-canvas transparent PNGs.

The source clip contains a chick touching the adult's tail.  The mask therefore
uses a hand-shaped adult gate and a small tail patch made from the project's
existing real-footage idle cutout.  No generated bird pixels are introduced.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


SOURCE_CROP = (450, 80, 1_560, 835)
CONTENT_SIZE = (760, 517)
OUTPUT_SIZE = (860, 517)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("idle", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", type=float, default=0.529)
    parser.add_argument("--end", type=float, default=1.565)
    parser.add_argument("--count", type=int, default=16)
    return parser.parse_args()


def largest_seeded_component(mask: np.ndarray, seed: tuple[int, int]) -> np.ndarray:
    binary = np.where(mask > 28, 255, 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count <= 1:
        return binary
    seed_x, seed_y = seed
    selected = int(labels[min(seed_y, labels.shape[0] - 1), min(seed_x, labels.shape[1] - 1)])
    if selected == 0:
        selected = max(range(1, count), key=lambda label: int(stats[label, cv2.CC_STAT_AREA]))
    return np.where(labels == selected, 255, 0).astype(np.uint8)


def fitted_background(crop: np.ndarray, excluded: np.ndarray) -> np.ndarray:
    """Fit the pavement's smooth colour field without using bird pixels."""
    height, width = crop.shape[:2]
    y_grid, x_grid = np.mgrid[0:height:6, 0:width:6]
    sampled_excluded = excluded[::6, ::6] > 0
    x = x_grid[~sampled_excluded].astype(np.float64) / max(1, width - 1)
    y = y_grid[~sampled_excluded].astype(np.float64) / max(1, height - 1)
    design = np.column_stack(
        [
            np.ones_like(x),
            x,
            y,
            x * x,
            x * y,
            y * y,
            x * x * x,
            x * x * y,
            x * y * y,
            y * y * y,
        ]
    )
    source = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)[::6, ::6][~sampled_excluded].astype(np.float64)
    coefficients, *_ = np.linalg.lstsq(design, source, rcond=None)

    full_y, full_x = np.mgrid[0:height, 0:width]
    full_x = full_x.astype(np.float64) / max(1, width - 1)
    full_y = full_y.astype(np.float64) / max(1, height - 1)
    full_design = np.stack(
        [
            np.ones_like(full_x),
            full_x,
            full_y,
            full_x * full_x,
            full_x * full_y,
            full_y * full_y,
            full_x * full_x * full_x,
            full_x * full_x * full_y,
            full_x * full_y * full_y,
            full_y * full_y * full_y,
        ],
        axis=-1,
    )
    predicted_lab = np.clip(full_design @ coefficients, 0, 255).astype(np.uint8)
    return cv2.cvtColor(predicted_lab, cv2.COLOR_LAB2BGR)


def adult_alpha(crop: np.ndarray) -> np.ndarray:
    height, width = crop.shape[:2]
    mask = np.full((height, width), cv2.GC_BGD, dtype=np.uint8)

    # Coordinates below are relative to SOURCE_CROP.  This broad silhouette
    # includes the adult's bill, body and feet while stopping before the chick.
    gate = np.array(
        [
            (60, 590),
            (90, 420),
            (340, 95),
            (555, 45),
            (775, 90),
            (970, 185),
            (1_050, 305),
            (1_025, 455),
            (980, 560),
            (990, 710),
            (750, 750),
            (450, 720),
            (230, 650),
        ],
        dtype=np.int32,
    )
    adult_region = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(adult_region, [gate], 255)

    # Exclude both birds when fitting the pavement.  A colour-field difference
    # gives GrabCut precise seeds without marking tan background as foreground.
    fit_exclusion = np.zeros_like(adult_region)
    cv2.ellipse(fit_exclusion, (650, 400), (545, 355), 0, 0, 360, 255, -1)
    cv2.rectangle(fit_exclusion, (870, 205), (width - 1, 710), 255, -1)
    background = fitted_background(crop, fit_exclusion)
    crop_lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).astype(np.float32)
    background_lab = cv2.cvtColor(background, cv2.COLOR_BGR2LAB).astype(np.float32)
    difference = np.linalg.norm(crop_lab - background_lab, axis=2)
    difference = cv2.GaussianBlur(difference, (5, 5), 0)

    mask[adult_region > 0] = cv2.GC_PR_BGD
    mask[(adult_region > 0) & (difference > 10.5)] = cv2.GC_PR_FGD
    mask[(adult_region > 0) & (difference > 25.0)] = cv2.GC_FGD

    # Conditional seeds guarantee that torso, head, bill and feet survive while
    # never forcing a halo of pavement into the result.
    seed_region = np.zeros_like(adult_region)
    cv2.ellipse(seed_region, (610, 370), (260, 205), -5, 0, 360, 255, -1)
    cv2.ellipse(seed_region, (430, 220), (95, 105), -18, 0, 360, 255, -1)
    cv2.line(seed_region, (120, 500), (420, 250), 255, 28)
    cv2.rectangle(seed_region, (410, 515), (890, 680), 255, -1)
    mask[(seed_region > 0) & (difference > 15.0)] = cv2.GC_FGD

    background_model = np.zeros((1, 65), np.float64)
    foreground_model = np.zeros((1, 65), np.float64)
    cv2.grabCut(crop, mask, None, background_model, foreground_model, 5, cv2.GC_INIT_WITH_MASK)
    alpha = np.where(
        (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD),
        255,
        0,
    ).astype(np.uint8)

    # Below the belly, keep photographed feet and their slim contact shadow but
    # reject light pavement fragments that GraphCut can attach to the toes.
    foreground_l = crop_lab[:, :, 0]
    background_l = background_lab[:, :, 0]
    darkness = background_l - foreground_l
    lower_y = np.arange(height, dtype=np.int32)[:, None] > 500
    alpha[lower_y & (darkness < 18.0)] = 0

    # A second, soft gate removes the touching chick while keeping the rounded
    # rump.  The replacement tail is composited behind this edge below.
    soft_gate = np.zeros_like(alpha)
    adult_only = np.array(
        [
            (50, 590),
            (90, 400),
            (335, 80),
            (565, 35),
            (790, 75),
            (950, 175),
            (1_015, 275),
            (1_018, 365),
            (995, 455),
            (960, 545),
            (970, 705),
            (720, 750),
            (430, 715),
            (210, 650),
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(soft_gate, [adult_only], 255)
    soft_gate = cv2.GaussianBlur(soft_gate, (17, 17), 0)
    alpha = cv2.min(alpha, soft_gate)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    alpha = largest_seeded_component(alpha, (615, 365))
    return cv2.GaussianBlur(alpha, (5, 5), 0)


def make_tail_patch(idle_path: Path) -> np.ndarray:
    idle = cv2.imread(str(idle_path), cv2.IMREAD_UNCHANGED)
    if idle is None or idle.shape[2] != 4:
        raise SystemExit("Could not read RGBA idle cutout")
    tail = idle[245:501, 0:235].copy()
    tail = cv2.flip(tail, 1)
    tail = cv2.resize(tail, (185, 140), interpolation=cv2.INTER_AREA)

    # Match the warmer, darker source clip while retaining photographed feather
    # detail.  Alpha is softened so the join disappears at desktop size.
    grayscale = cv2.cvtColor(tail[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
    tail[:, :, 0] = np.clip(grayscale * 0.32, 0, 255).astype(np.uint8)
    tail[:, :, 1] = np.clip(grayscale * 0.38, 0, 255).astype(np.uint8)
    tail[:, :, 2] = np.clip(grayscale * 0.49, 0, 255).astype(np.uint8)
    tail[:, :, 3] = cv2.GaussianBlur(tail[:, :, 3], (9, 9), 0)
    return tail


def alpha_composite(destination: np.ndarray, overlay: np.ndarray, x: int, y: int) -> None:
    height, width = overlay.shape[:2]
    target = destination[y : y + height, x : x + width]
    source_alpha = overlay[:, :, 3:4].astype(np.float32) / 255.0
    target_alpha = target[:, :, 3:4].astype(np.float32) / 255.0
    combined_alpha = source_alpha + target_alpha * (1.0 - source_alpha)
    safe_alpha = np.maximum(combined_alpha, 1e-6)
    color = (
        overlay[:, :, :3].astype(np.float32) * source_alpha
        + target[:, :, :3].astype(np.float32) * target_alpha * (1.0 - source_alpha)
    ) / safe_alpha
    target[:, :, :3] = np.clip(color, 0, 255).astype(np.uint8)
    target[:, :, 3:4] = np.clip(combined_alpha * 255.0, 0, 255).astype(np.uint8)


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise SystemExit("Could not open video")

    tail = make_tail_patch(args.idle)
    timestamps = np.linspace(args.start, args.end, max(1, args.count), endpoint=False)
    crop_x1, crop_y1, crop_x2, crop_y2 = SOURCE_CROP
    written = 0
    for timestamp in timestamps:
        capture.set(cv2.CAP_PROP_POS_MSEC, float(timestamp * 1_000))
        ok, frame = capture.read()
        if not ok:
            continue
        crop = frame[crop_y1:crop_y2, crop_x1:crop_x2]
        alpha = adult_alpha(crop)
        rgba = cv2.cvtColor(crop, cv2.COLOR_BGR2BGRA)
        rgba[:, :, 3] = alpha
        rgba = cv2.resize(rgba, CONTENT_SIZE, interpolation=cv2.INTER_AREA)

        canvas = np.zeros((OUTPUT_SIZE[1], OUTPUT_SIZE[0], 4), dtype=np.uint8)
        # Replacement tail sits behind the real body and follows its small
        # vertical rocking movement through the source frame itself.
        alpha_composite(canvas, tail, 615, 280)
        alpha_composite(canvas, rgba, 0, 0)
        destination = args.output / f"frame-{written:02d}.png"
        cv2.imwrite(str(destination), canvas)
        print(f"{destination.name} {timestamp:.3f}s")
        written += 1

    capture.release()
    print(f"frames={written}")


if __name__ == "__main__":
    main()
