#!/usr/bin/env python3
"""Trim two authentic call pulses from the user-provided reference audio."""

from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def slice_seconds(samples: np.ndarray, rate: int, start: float, end: float) -> np.ndarray:
    return samples[round(start * rate) : round(end * rate)].copy()


def fade(samples: np.ndarray, rate: int, seconds: float = 0.035) -> np.ndarray:
    count = min(len(samples) // 2, max(1, round(rate * seconds)))
    ramp = np.linspace(0.0, 1.0, count, dtype=np.float32)
    samples[:count] *= ramp
    samples[-count:] *= ramp[::-1]
    return samples


def main() -> None:
    args = parse_args()
    with wave.open(str(args.input), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        raw = source.readframes(source.getnframes())
    if channels != 1 or width != 2:
        raise SystemExit("Expected mono 16-bit PCM input")

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    first = fade(slice_seconds(samples, rate, 9.20, 9.78), rate)
    second = fade(slice_seconds(samples, rate, 11.00, 11.48), rate)
    gap = np.zeros(round(rate * 0.16), dtype=np.float32)
    paired = np.concatenate([first, gap, second])
    peak = float(np.max(np.abs(paired))) or 1.0
    paired *= min(1.0, 0.90 * 32767.0 / peak)
    encoded = np.clip(paired, -32768, 32767).astype(np.int16)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(rate)
        destination.writeframes(encoded.tobytes())
    print(f"duration={len(encoded) / rate:.3f}")
    print(args.output)


if __name__ == "__main__":
    main()
