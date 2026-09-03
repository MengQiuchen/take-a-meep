#!/usr/bin/env python3
"""Build the v3 photo puppet (head / body / bill / legs / tail) from the master cut-out.

Every RGB pixel of every layer comes straight from the public-domain USFWS photograph
(`assets/character/idle-v2.png`, 1600x893, bird facing left).  Only alpha masks, a few
cloned strips that stay hidden behind other layers, and the dark mouth interior are
authored here.

Layers (each cropped to its alpha bounds; offsets are recorded in manifest.json):

  body            torso + wings + rump, minus the skull core, the bill and the legs
  head            skull + soft neck tab (drawn over the body).  The bill footprint is
                  painted as dark mouth interior near the gape and transparent beyond.
  bill-upper      upper mandible + a band of forehead feathers at its base
  bill-lower      lower mandible + chin / throat wedge (the jaw)
  leg-a-tarsus    image-left (forward) leg tarsus, extended upward under the belly
  leg-a-foot      its toes
  leg-b-tarsus    image-right (trailing) leg tarsus
  leg-b-foot
  tail-feather    one tail feather sprite; the renderer fans several copies
  eyelid          feather-coloured patch used for blinking / dozing

Usage:
  python3 tools/make_photo_puppet_v3.py assets/character/idle-v2.png assets/character/puppet-v3
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

MASTER = (1600, 893)
W, H = MASTER

# ---------------------------------------------------------------------------
# Hand-authored geometry (master pixel coordinates).
# ---------------------------------------------------------------------------

# Bill edges fitted to the alpha channel: y = a*x + b.
BILL_UPPER_EDGE = (-0.89, 543.0)    # x=100 -> 454, x=300 -> 276
BILL_LOWER_EDGE = (-0.73, 568.0)    # x=100 -> 495, x=300 -> 349
GAPE_LINE = (-0.81, 560.0)          # tomial line between the mandibles (x=300 -> 317)
BILL_TIP = (30.0, 531.0)
BILL_BASE_TOP = (372.0, 212.0)      # forehead feathers start here
BILL_BASE_BOTTOM = (392.0, 289.0)   # chin feathers start here
COMMISSURE = (376.0, 255.0)         # corner of the mouth
UPPER_HINGE = (362.0, 236.0)        # naso-frontal hinge of the upper mandible
LOWER_HINGE = (432.0, 268.0)        # jaw joint, hidden under the cheek
MOUTH_DEPTH = 78.0                  # dark interior reaches this far along the bill
MOUTH_FADE = 30.0

# Skull core (extends past the silhouette on the air side so the fade never touches it).
SKULL = [
    (300, 262), (300, 190), (330, 120), (380, 60), (440, 10), (520, -40), (600, -40), (665, -10),
    (710, 40), (735, 100), (728, 160), (712, 210), (690, 258), (655, 310), (605, 345),
    (545, 365), (485, 368), (440, 350), (410, 322), (392, 296), (372, 262),
]
# Neck tab: soft region that travels with the head and hides the seam.
NECK_TAB = [
    (396, 296), (402, 350), (416, 420), (456, 480), (540, 508), (640, 494), (722, 442),
    (762, 372), (772, 300), (752, 232), (716, 190), (712, 210), (690, 258), (655, 310),
    (605, 345), (545, 365), (485, 368), (440, 350), (410, 322),
]
# Neck stump: body feathers kept underneath the back of the skull, so the neck
# still reads as a neck when the head swings down (preening, probing).
NECK_STUMP = [
    (600, 160), (640, 108), (690, 88), (740, 100), (782, 150), (792, 260), (764, 380),
    (700, 440), (600, 446), (524, 404), (500, 300), (540, 200),
]
HEAD_PIVOT = (615.0, 340.0)
SKULL_HOLE_ERODE = 30
HEAD_FEATHER = 40

# Feather / bare-skin boundary along the belly is derived from the alpha channel
# (bottom of the first opaque run per column) except across the trailing leg's
# attachment, where the lit tarsus touches the dark thigh feathers directly.
BELLY_OVERRIDE = [
    (968, 707), (976, 704), (984, 708), (992, 716), (1000, 726), (1006, 729), (1014, 723),
    (1024, 715), (1034, 709), (1044, 704), (1052, 702),
]
LEG_A = {
    "knee": (748.0, 754.0),          # tarsus exits the dark thigh feathers here
    "ankle": (600.0, 804.0),         # metatarsal joint (foot base)
    "half_width": 23.0,
    "foot": [(268, 790), (586, 780), (650, 790), (702, 812), (704, 850), (640, 870), (430, 870), (268, 836)],
    "toe_tip": (295.0, 812.0),
    "extend": 44,
}
LEG_B = {
    "knee": (1000.0, 718.0),
    "ankle": (918.0, 800.0),
    "half_width": 23.0,
    "foot": [(690, 800), (880, 786), (940, 796), (1004, 816), (1026, 846), (1004, 866),
             (900, 858), (690, 856)],
    "toe_tip": (700.0, 842.0),
    "extend": 44,
}
HIP = (850.0, 655.0)
GROUND_Y = 846.0
BODY_PIVOT = (930.0, 640.0)

TAIL_FEATHER = [(1412, 498), (1500, 516), (1552, 536), (1560, 548), (1546, 558),
                (1500, 552), (1412, 540)]
TAIL_PIVOT = (1398.0, 522.0)
TAIL_EXTEND = 60

EYE = {"center": (520.0, 95.0), "radius": 27.0}


# ---------------------------------------------------------------------------


def poly_mask(points, feather=0.0):
    mask = np.zeros((H, W), dtype=np.float32)
    cv2.fillPoly(mask, [np.array(points, dtype=np.int32)], 1.0)
    if feather > 0:
        mask = soften(mask, feather)
    return mask


def soften(mask, feather):
    """Distance-based soft edge: 1 well inside, 0 well outside, linear across `feather`."""
    binary = (mask > 0.5).astype(np.uint8)
    inside = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    outside = cv2.distanceTransform(1 - binary, cv2.DIST_L2, 5)
    return np.clip(0.5 + (inside - outside) / feather, 0.0, 1.0).astype(np.float32)


def erode(mask, pixels):
    binary = (mask > 0.5).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * pixels + 1, 2 * pixels + 1))
    return cv2.erode(binary, kernel).astype(np.float32)


def dilate(mask, pixels):
    binary = (mask > 0.5).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * pixels + 1, 2 * pixels + 1))
    return cv2.dilate(binary, kernel).astype(np.float32)


def line_y(line, x):
    return line[0] * x + line[1]


def bill_polygon(margin=6.0):
    xs = np.linspace(BILL_TIP[0], BILL_BASE_TOP[0], 40)
    upper = [(x, line_y(BILL_UPPER_EDGE, x) - margin) for x in xs]
    xs2 = np.linspace(BILL_BASE_BOTTOM[0], BILL_TIP[0], 40)
    lower = [(x, line_y(BILL_LOWER_EDGE, x) + margin) for x in xs2]
    base = [(BILL_BASE_TOP[0] + 2, BILL_BASE_TOP[1] - margin), (BILL_BASE_BOTTOM[0] + 3, BILL_BASE_BOTTOM[1] + margin)]
    tip = [(BILL_TIP[0] - 12, BILL_TIP[1] + 2)]
    return [(int(round(x)), int(round(y))) for x, y in upper + base + lower + tip]


def half_plane(line, above=True, offset=0.0):
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    line_ys = line[0] * xs + line[1] + offset
    return (ys < line_ys).astype(np.float32) if above else (ys > line_ys).astype(np.float32)


def below_polyline(points):
    """Mask of pixels below a polyline (x sorted ascending)."""
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    px = np.array([p[0] for p in points], dtype=np.float32)
    py = np.array([p[1] for p in points], dtype=np.float32)
    boundary = np.interp(xs[0], px, py)[None, :]
    return (ys > boundary).astype(np.float32)


def face_side_mask():
    """1 on the feathered side of the bill base line (toward the face), 0 toward the tip."""
    (x0, y0), (x1, y1) = BILL_BASE_TOP, BILL_BASE_BOTTOM
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    # signed distance to the base line; the face lies on the +x side
    nx, ny = (y1 - y0), -(x1 - x0)
    norm = np.hypot(nx, ny)
    nx, ny = nx / norm, ny / norm
    signed = (xs - x0) * nx + (ys - y0) * ny
    return np.clip(0.5 + signed / 4.0, 0.0, 1.0).astype(np.float32)


def bill_axis_distance():
    tip = np.array(BILL_TIP)
    com = np.array(COMMISSURE)
    axis = (tip - com) / np.linalg.norm(tip - com)
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    return (xs - com[0]) * axis[0] + (ys - com[1]) * axis[1]


def rgba_layer(source, alpha):
    layer = source.copy()
    layer[:, :, 3] = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    return layer


def crop_layer(layer, pad=4):
    visible = np.where(layer[:, :, 3] > 2, 255, 0).astype(np.uint8)
    coords = cv2.findNonZero(visible)
    if coords is None:
        raise SystemExit("layer has no visible pixels")
    x, y, w, h = cv2.boundingRect(coords)
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
    return layer[y0:y1, x0:x1], {"x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0)}


def clone_along(source, alpha, region_mask, axis_from, axis_to, extend, band=30.0):
    """Extend a strip beyond `axis_from` (away from `axis_to`) by sliding copies of the
    band just after axis_from.  Used to hide cut edges of legs / tail behind the body."""
    direction = np.array(axis_from, dtype=np.float64) - np.array(axis_to, dtype=np.float64)
    direction /= np.linalg.norm(direction)
    result = source.copy()
    out_alpha = alpha.copy()
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    proj = (xs - axis_from[0]) * direction[0] + (ys - axis_from[1]) * direction[1]
    strip = (region_mask > 0.5) & (proj > -band) & (proj <= 0)
    strip_src = np.zeros_like(source)
    strip_src[strip] = source[strip]
    strip_alpha = np.zeros_like(alpha)
    strip_alpha[strip] = alpha[strip]
    shifts = int(np.ceil(extend / (band - 4)))
    for index in range(1, shifts + 1):
        dx, dy = direction * (band - 4) * index
        matrix = np.array([[1, 0, dx], [0, 1, dy]], dtype=np.float32)
        moved = cv2.warpAffine(strip_src, matrix, MASTER, flags=cv2.INTER_LINEAR)
        moved_alpha = cv2.warpAffine(strip_alpha, matrix, MASTER, flags=cv2.INTER_LINEAR)
        take = moved_alpha > out_alpha
        result[take] = moved[take]
        out_alpha = np.maximum(out_alpha, moved_alpha)
    return result, out_alpha


def leg_corridor(leg, extend_top, extend_bottom, half):
    knee = np.array(leg["knee"])
    ankle = np.array(leg["ankle"])
    axis = (knee - ankle) / np.linalg.norm(knee - ankle)
    normal = np.array([-axis[1], axis[0]])
    top = knee + axis * extend_top
    bottom = ankle - axis * extend_bottom
    corners = [top + normal * half, top - normal * half, bottom - normal * half, bottom + normal * half]
    return [(int(round(x)), int(round(y))) for x, y in corners]


def build_leg(source, alpha, legs_mask, leg):
    band = poly_mask(leg_corridor(leg, 6, 16, leg["half_width"] + 8), feather=1.5)
    tarsus_alpha = alpha * legs_mask * band
    tarsus_src, tarsus_alpha = clone_along(
        source, tarsus_alpha, tarsus_alpha, leg["knee"], leg["ankle"], leg["extend"]
    )
    corridor = poly_mask(leg_corridor(leg, leg["extend"] + 6, 40, leg["half_width"] + 12), feather=1.5)
    tarsus_alpha = tarsus_alpha * corridor
    foot_alpha = alpha * legs_mask * poly_mask(leg["foot"], feather=2.5)
    return rgba_layer(tarsus_src, tarsus_alpha), rgba_layer(source, foot_alpha)


def belly_polyline(alpha):
    """Bottom edge of the feathered body per column, from the alpha channel."""
    points = []
    override_x = [p[0] for p in BELLY_OVERRIDE]
    for x in range(0, W, 4):
        if override_x[0] <= x <= override_x[-1]:
            continue
        column = alpha[:, x] > 0.16
        if not column.any():
            points.append((x, H))
            continue
        # bottom of the lowest opaque run that starts above y=720 (runs starting
        # lower are bare legs / toes hanging below the belly)
        bottom = 0
        y = 0
        while y < H:
            if column[y]:
                start = y
                while y < H and column[y]:
                    y += 1
                if start < 720:
                    bottom = y
            else:
                y += 1
        points.append((x, bottom + 3))
    points.extend((x, y + 3) for x, y in BELLY_OVERRIDE)
    points.sort()
    return points


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    source = cv2.imread(str(args.input), cv2.IMREAD_UNCHANGED)
    if source is None or source.shape[2] != 4:
        raise SystemExit("input must be an RGBA PNG")
    if (source.shape[1], source.shape[0]) != MASTER:
        raise SystemExit(f"expected a {W}x{H} master, got {source.shape[1]}x{source.shape[0]}")
    args.output.mkdir(parents=True, exist_ok=True)
    alpha = source[:, :, 3].astype(np.float32) / 255.0

    # --- bill ---------------------------------------------------------------
    bill = poly_mask(bill_polygon())
    bill_core = alpha * bill
    above_gape = half_plane(GAPE_LINE, above=True, offset=3.0)
    below_gape = half_plane(GAPE_LINE, above=False, offset=-3.0)
    forehead_band = poly_mask(
        [(366, 216), (372, 196), (396, 184), (428, 196), (438, 240), (426, 266), (398, 264), (376, 258)],
        feather=6.0,
    )
    chin_wedge = poly_mask(
        [(374, 252), (392, 296), (404, 326), (446, 350), (470, 300), (458, 262), (412, 254)],
        feather=8.0,
    )
    upper_alpha = np.clip(bill_core * above_gape + alpha * forehead_band, 0, 1)
    lower_alpha = np.clip(bill_core * below_gape + alpha * chin_wedge, 0, 1)

    # --- head ---------------------------------------------------------------
    skull = poly_mask(SKULL)
    tab = poly_mask(NECK_TAB)
    head_region = soften(np.maximum(skull, tab), HEAD_FEATHER)
    head_alpha = alpha * head_region
    head_src = source.copy()
    distance = bill_axis_distance()
    face_side = face_side_mask()
    # Only the lower mandible's footprint (plus the roof of the mouth just above the
    # gape) is painted dark: when the upper mandible lifts, the strip it vacates
    # must show air, not mouth.
    mouth_zone = half_plane(GAPE_LINE, above=False, offset=-7.0)
    bill_inner = erode(bill * (alpha > 0.5), 2) * (1.0 - face_side) * mouth_zone
    mouth_strength = np.clip(1.0 - (distance - MOUTH_DEPTH) / MOUTH_FADE, 0.0, 1.0)
    mouth_alpha = bill_inner * alpha * mouth_strength
    inside_bill = bill > 0.5
    face_keep = alpha * head_region * face_side
    head_alpha = np.where(inside_bill, np.maximum(mouth_alpha, face_keep), head_alpha)
    mouth_colour = np.array([26, 14, 46, 255], dtype=np.float32)       # BGRA deep maroon
    mouth_colour_dark = np.array([10, 5, 16, 255], dtype=np.float32)
    shade = np.clip(distance / MOUTH_DEPTH, 0, 1)[..., None]
    mouth_rgb = (mouth_colour * (1 - shade) + mouth_colour_dark * shade).astype(np.uint8)
    paint = (bill_inner > 0.5)[..., None]
    head_src = np.where(paint, mouth_rgb, head_src)
    head_layer = rgba_layer(head_src, head_alpha)

    # --- legs mask ----------------------------------------------------------
    # Soft only across the feather boundary itself, hard elsewhere, so no ghost
    # outline of the legs survives in the body layer.
    belly = belly_polyline(alpha)
    legs_mask = soften(below_polyline(belly), 4.0) * (alpha > 0.02)

    # --- body ---------------------------------------------------------------
    hole = soften(erode(skull, SKULL_HOLE_ERODE), 24.0)
    hole = hole * (1.0 - poly_mask(NECK_STUMP, feather=36.0))
    body_alpha = alpha * (1.0 - hole) * (1.0 - bill) * (1.0 - legs_mask)
    body_layer = rgba_layer(source, body_alpha)

    # --- legs ---------------------------------------------------------------
    leg_a_tarsus, leg_a_foot = build_leg(source, alpha, legs_mask, LEG_A)
    leg_b_tarsus, leg_b_foot = build_leg(source, alpha, legs_mask, LEG_B)

    # --- tail feather -------------------------------------------------------
    feather_alpha = alpha * poly_mask(TAIL_FEATHER, feather=2.0)
    tail_src, feather_alpha = clone_along(
        source, feather_alpha, feather_alpha, TAIL_FEATHER[0], TAIL_FEATHER[3], TAIL_EXTEND, band=26.0
    )
    tail_layer = rgba_layer(tail_src, feather_alpha)

    # --- eyelid -------------------------------------------------------------
    cx, cy = EYE["center"]
    r = int(EYE["radius"] + 7)
    patch_mask = np.zeros((H, W), dtype=np.float32)
    cv2.ellipse(patch_mask, (int(cx), int(cy)), (r, r), 0, 0, 360, 1.0, -1)
    # Eyelid colour comes from the pale cheek feathers just below the eye.
    shift = np.array([[1, 0, 0], [0, 1, -2.4 * EYE["radius"]]], dtype=np.float32)
    cheek = cv2.warpAffine(source, shift, MASTER, flags=cv2.INTER_LINEAR)
    eyelid = np.zeros_like(source)
    eyelid[patch_mask > 0.5] = cheek[patch_mask > 0.5]
    eyelid_layer = rgba_layer(eyelid, alpha * soften(patch_mask, 4.0))

    layers = {
        "body": body_layer,
        "head": head_layer,
        "bill-upper": rgba_layer(source, upper_alpha),
        "bill-lower": rgba_layer(source, lower_alpha),
        "leg-a-tarsus": leg_a_tarsus,
        "leg-a-foot": leg_a_foot,
        "leg-b-tarsus": leg_b_tarsus,
        "leg-b-foot": leg_b_foot,
        "tail-feather": tail_layer,
        "eyelid": eyelid_layer,
    }
    manifest = {
        "master": {"width": W, "height": H},
        "ground": GROUND_Y,
        "layers": {},
        "pivots": {
            "head": HEAD_PIVOT,
            "upperBill": UPPER_HINGE,
            "lowerBill": LOWER_HINGE,
            "commissure": COMMISSURE,
            "billTip": BILL_TIP,
            "body": BODY_PIVOT,
            "hip": HIP,
            "tail": TAIL_PIVOT,
            "eye": EYE["center"],
            "eyeRadius": EYE["radius"],
        },
        "legs": {
            "a": {"knee": LEG_A["knee"], "ankle": LEG_A["ankle"], "toeTip": LEG_A["toe_tip"]},
            "b": {"knee": LEG_B["knee"], "ankle": LEG_B["ankle"], "toeTip": LEG_B["toe_tip"]},
        },
    }
    for name, layer in layers.items():
        cropped, box = crop_layer(layer)
        cv2.imwrite(str(args.output / f"{name}.png"), cropped)
        manifest["layers"][name] = box
        print(f"{name}: {box}")
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    # ES-module twin so the renderer can import it without fetch() (blocked on file://).
    (args.output / "manifest.js").write_text(
        "// Generated by tools/make_photo_puppet_v3.py - do not edit.\n"
        f"export default {json.dumps(manifest, indent=2)};\n"
    )

    grey = np.full((H, W, 3), 110, dtype=np.uint8)
    tiles = []
    for name, layer in layers.items():
        a = layer[:, :, 3:4].astype(np.float32) / 255.0
        comp = (layer[:, :, :3] * a + grey * (1 - a)).astype(np.uint8)
        cv2.putText(comp, name, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 0), 3)
        tiles.append(cv2.resize(comp, (800, 446)))
    if len(tiles) % 2:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i:i + 2]) for i in range(0, len(tiles), 2)]
    cv2.imwrite(str(args.output / "contact-sheet.png"), np.vstack(rows))
    print(f"puppet written to {args.output}")


if __name__ == "__main__":
    main()
