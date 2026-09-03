#!/usr/bin/env python3
"""Sample a local video into timestamped PNGs and a compact contact sheet."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float)
    return parser.parse_args()


def fit(frame: np.ndarray, width: int, height: int) -> np.ndarray:
    source_height, source_width = frame.shape[:2]
    scale = min(width / source_width, height / source_height)
    resized = cv2.resize(
        frame,
        (max(1, round(source_width * scale)), max(1, round(source_height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    canvas = np.full((height, width, 3), 22, dtype=np.uint8)
    y = (height - resized.shape[0]) // 2
    x = (width - resized.shape[1]) // 2
    canvas[y : y + resized.shape[0], x : x + resized.shape[1]] = resized
    return canvas


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(args.input))
    if not capture.isOpened():
        raise SystemExit(f"Could not open {args.input}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_total = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = frame_total / fps
    start_seconds = max(0.0, min(args.start, duration))
    end_seconds = duration if args.end is None else max(start_seconds, min(args.end, duration))
    start_frame = min(frame_total - 1, round(start_seconds * fps))
    end_frame = min(frame_total - 1, round(end_seconds * fps))
    available_frames = max(1, end_frame - start_frame + 1)
    sample_count = max(4, min(args.count, available_frames))
    frame_indices = np.linspace(start_frame, end_frame, sample_count, dtype=int)

    print(f"duration={duration:.3f}")
    print(f"size={width}x{height}")
    print(f"fps={fps:.3f}")
    print(f"frames={frame_total}")
    print(f"window={start_seconds:.3f}..{end_seconds:.3f}")

    thumbnails: list[tuple[np.ndarray, int, float]] = []
    for sample_index, frame_index in enumerate(frame_indices):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(frame_index))
        ok, frame = capture.read()
        if not ok:
            continue
        timestamp = frame_index / fps
        filename = f"sample-{sample_index:02d}-{timestamp:06.2f}s.png"
        cv2.imwrite(str(args.output / filename), frame)
        thumbnails.append((fit(frame, 320, 180), sample_index, timestamp))
        print(filename)
    capture.release()

    columns = 4
    rows = (len(thumbnails) + columns - 1) // columns
    label_height = 28
    sheet = np.full((rows * (180 + label_height), columns * 320, 3), 22, dtype=np.uint8)
    for position, (thumbnail, sample_index, timestamp) in enumerate(thumbnails):
        row = position // columns
        column = position % columns
        x = column * 320
        y = row * (180 + label_height)
        sheet[y : y + 180, x : x + 320] = thumbnail
        cv2.putText(
            sheet,
            f"{sample_index:02d}   {timestamp:.2f}s",
            (x + 9, y + 199),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (244, 244, 244),
            1,
            cv2.LINE_AA,
        )

    contact_sheet = args.output / "contact-sheet.png"
    cv2.imwrite(str(contact_sheet), sheet)
    print(contact_sheet.name)


if __name__ == "__main__":
    main()
