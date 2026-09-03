#!/usr/bin/env python3
"""Split the real-photo master into body and articulated bill layers.

All output RGB pixels come directly from the public-domain USFWS photograph.
Only alpha masks are authored here so the renderer can open the real bill.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


REFERENCE_SIZE = (1600, 893)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def scaled_polygon(points: list[tuple[int, int]], width: int, height: int) -> np.ndarray:
    sx = width / REFERENCE_SIZE[0]
    sy = height / REFERENCE_SIZE[1]
    return np.array([(round(x * sx), round(y * sy)) for x, y in points], dtype=np.int32)


def layer_from_mask(source: np.ndarray, mask: np.ndarray) -> np.ndarray:
    layer = source.copy()
    layer[:, :, 3] = np.minimum(source[:, :, 3], mask)
    return layer


def main() -> None:
    args = parse_args()
    source = cv2.imread(str(args.input), cv2.IMREAD_UNCHANGED)
    if source is None or source.shape[2] != 4:
        raise SystemExit("input must be an RGBA PNG")
    height, width = source.shape[:2]
    args.output.mkdir(parents=True, exist_ok=True)

    # The polygons overlap at the hinge so no transparent crack appears during
    # rotation.  They stop before the cheek to keep the eye/head in the body.
    upper_points = [(418, 244), (410, 303), (31, 525), (17, 510), (25, 489), (378, 258)]
    lower_points = [(412, 286), (414, 336), (42, 548), (27, 530), (31, 512)]
    overall_points = [(421, 240), (417, 339), (42, 552), (14, 531), (19, 486), (376, 250)]

    upper_mask = np.zeros((height, width), dtype=np.uint8)
    lower_mask = np.zeros((height, width), dtype=np.uint8)
    overall_mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(upper_mask, [scaled_polygon(upper_points, width, height)], 255)
    cv2.fillPoly(lower_mask, [scaled_polygon(lower_points, width, height)], 255)
    cv2.fillPoly(overall_mask, [scaled_polygon(overall_points, width, height)], 255)
    upper_mask = cv2.GaussianBlur(upper_mask, (3, 3), 0)
    lower_mask = cv2.GaussianBlur(lower_mask, (3, 3), 0)

    body = source.copy()
    body[:, :, 3] = np.where(overall_mask > 0, 0, source[:, :, 3]).astype(np.uint8)
    upper = layer_from_mask(source, upper_mask)
    lower = layer_from_mask(source, lower_mask)

    # Soft overlapping head/body masks for the walking puppet.  Their seam runs
    # through the feathered shoulder; overlap prevents a crack while allowing
    # the head and neck to glide independently from the rocking torso.
    rows = np.arange(height, dtype=np.float32)
    reference_rows = np.array([0, 220, 420, 590, 700, 893], dtype=np.float32) * (height / 893)
    reference_edges = np.array([770, 735, 665, 555, 90, 0], dtype=np.float32) * (width / 1600)
    edge_by_row = np.interp(rows, reference_rows, reference_edges)[:, None]
    columns = np.arange(width, dtype=np.float32)[None, :]
    feather = max(12.0, 54.0 * width / 1600)
    overlap = 86.0 * width / 1600
    head_weight = np.clip((edge_by_row + overlap - columns) / feather, 0.0, 1.0)
    body_weight = np.clip((columns - (edge_by_row - overlap)) / feather, 0.0, 1.0)
    lower_rows = rows > 720 * height / 893
    head_weight[lower_rows, :] = 0.0
    body_weight[lower_rows, :] = 1.0

    walk_head = source.copy()
    walk_body = source.copy()
    walk_head[:, :, 3] = np.minimum(
        source[:, :, 3],
        np.round(head_weight * 255).astype(np.uint8),
    )
    walk_body[:, :, 3] = np.minimum(
        source[:, :, 3],
        np.round(body_weight * 255).astype(np.uint8),
    )

    cv2.imwrite(str(args.output / "body.png"), body)
    cv2.imwrite(str(args.output / "bill-upper.png"), upper)
    cv2.imwrite(str(args.output / "bill-lower.png"), lower)
    cv2.imwrite(str(args.output / "walk-body.png"), walk_body)
    cv2.imwrite(str(args.output / "walk-head.png"), walk_head)
    print(f"puppet={args.output} size={width}x{height}")


if __name__ == "__main__":
    main()
