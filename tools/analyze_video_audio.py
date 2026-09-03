#!/usr/bin/env python3
"""Extract mono audio, draw its envelope, and report separated transient peaks."""

from __future__ import annotations

import argparse
import wave
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    container = av.open(str(args.input))
    if not container.streams.audio:
        raise SystemExit("No audio stream found")

    sample_rate = 22_050
    resampler = av.AudioResampler(format="s16", layout="mono", rate=sample_rate)
    chunks: list[np.ndarray] = []
    for decoded in container.decode(audio=0):
        converted = resampler.resample(decoded)
        for frame in converted:
            chunks.append(frame.to_ndarray().reshape(-1).astype(np.int16))
    container.close()
    if not chunks:
        raise SystemExit("Audio stream decoded to zero samples")

    samples = np.concatenate(chunks)
    with wave.open(str(args.output), "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(sample_rate)
        destination.writeframes(samples.tobytes())

    normalized = samples.astype(np.float32) / 32768.0
    window = max(1, int(sample_rate * 0.025))
    hop = max(1, int(sample_rate * 0.010))
    usable = len(normalized) - window
    starts = np.arange(0, max(1, usable), hop)
    rms = np.array([np.sqrt(np.mean(normalized[start : start + window] ** 2)) for start in starts])
    times = starts / sample_rate
    threshold = max(float(np.percentile(rms, 87)), float(rms.max() * 0.36))

    candidates: list[int] = []
    for index in range(1, len(rms) - 1):
        if rms[index] >= threshold and rms[index] >= rms[index - 1] and rms[index] >= rms[index + 1]:
            candidates.append(index)
    peaks: list[int] = []
    minimum_gap = int(0.34 / 0.010)
    for candidate in sorted(candidates, key=lambda item: rms[item], reverse=True):
        if all(abs(candidate - existing) >= minimum_gap for existing in peaks):
            peaks.append(candidate)
    peaks.sort()

    duration = len(samples) / sample_rate
    print(f"duration={duration:.3f}")
    print(f"sampleRate={sample_rate}")
    print(f"peakRMS={float(rms.max()):.4f}")
    print("peaks=" + ",".join(f"{times[index]:.3f}" for index in peaks))
    print(args.output)

    image_width = 1500
    image_height = 420
    margin = 48
    image = Image.new("RGB", (image_width, image_height), (22, 22, 24))
    draw = ImageDraw.Draw(image)
    plot_width = image_width - margin * 2
    plot_height = image_height - margin * 2
    draw.rectangle((margin, margin, margin + plot_width, margin + plot_height), outline=(70, 70, 76), width=1)

    if rms.max() > 0:
        envelope = rms / rms.max()
        for x in range(plot_width):
            source_index = min(len(envelope) - 1, int(x / max(1, plot_width - 1) * (len(envelope) - 1)))
            amplitude = float(envelope[source_index])
            y = margin + plot_height - round(amplitude * plot_height)
            draw.line((margin + x, margin + plot_height, margin + x, y), fill=(211, 154, 112))

    for peak_index in peaks:
        x = margin + round(times[peak_index] / max(duration, 0.001) * plot_width)
        draw.line((x, margin, x, margin + plot_height), fill=(247, 198, 92), width=2)
        draw.text((x + 4, margin + 4), f"{times[peak_index]:.2f}", fill=(255, 232, 178))

    for second in range(0, int(duration) + 1, 2):
        x = margin + round(second / max(duration, 0.001) * plot_width)
        draw.line((x, margin + plot_height, x, margin + plot_height + 5), fill=(150, 150, 156))
        draw.text((x - 8, margin + plot_height + 9), f"{second}s", fill=(190, 190, 196))

    waveform_output = args.output.with_name(args.output.stem + "-waveform.png")
    image.save(waveform_output)
    print(waveform_output)


if __name__ == "__main__":
    main()
