"""Benchmark-oriented, source-independent Kolam reconstruction pipeline.

Unlike the proof-of-concept scripts, this module owns one image at a time and
keeps every artifact below a content-addressed directory.  Its SVG is the
authoritative deliverable: diagnostic and comparison PNGs may contain the
source raster, the reconstruction SVG/PNG never do.

The pipeline deliberately separates *evidence* (foreground, text candidates,
dot candidates and skeleton) from the recovered graph.  Low-confidence input
is flagged rather than silently upgraded to a valid structural reconstruction.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import math
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage import feature, filters, measure, morphology, transform

try:
    import cairosvg
except ImportError:  # pragma: no cover - guarded in render_svg_png
    cairosvg = None

try:
    import pytesseract
except ImportError:  # pragma: no cover - OCR remains optional
    pytesseract = None

from extract_paths import extract_skeleton_segments
from skeletonize_strokes import prune_short_branches
from spline_render import centripetal_catmull_rom, segments_to_path


PIPELINE_VERSION = "2026.08.benchmark-v29"
REPO_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE_ROOT = REPO_ROOT.parents[2]


@dataclass
class DotCandidate:
    x: float
    y: float
    radius: float
    confidence: float
    source: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_id(path: Path, content_hash: str) -> str:
    stem = "".join(ch if ch.isalnum() else "_" for ch in path.stem).strip("_")
    return f"{stem}_{content_hash[:12]}"


def resize_for_analysis(image: Image.Image, maximum: int) -> tuple[Image.Image, float]:
    largest = max(image.size)
    if largest <= maximum:
        return image.copy(), 1.0
    scale = maximum / largest
    return image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS), scale


def _mask_score(mask: np.ndarray) -> float:
    fraction = float(mask.mean())
    if fraction < 0.0005 or fraction > 0.55:
        return -100.0
    labels, count = ndi.label(mask)
    if not count:
        return -100.0
    sizes = np.bincount(labels.ravel())[1:]
    large_fraction = float(sizes.max() / mask.size) if len(sizes) else 0.0
    # A usable composition has a coherent main foreground and comparatively
    # few isolated texture fragments.  This is only hypothesis selection, not
    # a validity claim.
    fragmentation_penalty = min(count / 500.0, 3.0)
    return 2.0 - abs(fraction - 0.06) * 10.0 + min(large_fraction * 15.0, 2.0) - fragmentation_penalty


def foreground_mask(image: Image.Image) -> tuple[np.ndarray, dict[str, Any]]:
    """Choose a bright or dark locally-contrasting foreground hypothesis."""
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    gray = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    sigma = max(7.0, min(gray.shape) / 30.0)
    background = ndi.gaussian_filter(gray, sigma=sigma)
    residual = gray - background
    local_scale = np.maximum(ndi.gaussian_filter(np.abs(residual), sigma=max(3.0, sigma / 4.0)), 0.025)
    bright = residual > np.maximum(0.045, 1.25 * local_scale)
    dark = -residual > np.maximum(0.045, 1.25 * local_scale)
    # Global alternatives rescue clean digital images with a flat background.
    bright |= gray >= np.quantile(gray, 0.985)
    dark |= gray <= np.quantile(gray, 0.015)
    global_bright = gray >= np.quantile(gray, 0.92)
    global_dark = gray <= np.quantile(gray, 0.08)
    candidates = [("bright_local", bright), ("dark_local", dark), ("bright_global", global_bright), ("dark_global", global_dark)]
    extreme_fraction = float(np.mean((gray <= 0.12) | (gray >= 0.88)))
    if extreme_fraction >= 0.80:
        binary_threshold = float(filters.threshold_otsu(gray))
        binary_bright = gray > binary_threshold
        binary_dark = gray <= binary_threshold
        # In near-binary artwork the meaningful linework is normally the
        # minority tone; adding both hypotheses lets coherence/contrast decide
        # without discarding antialiased stroke pixels.
        candidates.extend([("bright_binary", binary_bright), ("dark_binary", binary_dark)])
    def candidate_score(item: tuple[str, np.ndarray]) -> float:
        _, candidate = item
        if not candidate.any() or candidate.all():
            return -100.0
        contrast = abs(float(np.median(gray[candidate])) - float(np.median(gray[~candidate])))
        return _mask_score(candidate) + 4.0 * contrast

    if extreme_fraction >= 0.98:
        binary_candidates = [(name, candidate) for name, candidate in candidates if name.endswith("_binary") and 0.0005 < float(candidate.mean()) < 0.50]
        name, raw = min(binary_candidates, key=lambda item: float(item[1].mean())) if binary_candidates else max(candidates, key=candidate_score)
    else:
        name, raw = max(candidates, key=candidate_score)
    min_dim = min(raw.shape)
    clean = morphology.closing(raw, morphology.disk(max(1, round(min_dim / 900))))
    if not name.endswith("_binary"):
        clean = morphology.remove_small_objects(clean, max_size=max(4, round(raw.size * 0.000003)))
    contrast = abs(float(np.median(gray[clean])) - float(np.median(gray[~clean]))) if clean.any() and (~clean).any() else 0.0
    return clean.astype(bool), {"polarity": name, "foreground_fraction": round(float(clean.mean()), 4), "luminance_contrast": round(contrast, 4), "binary_likeness": round(extreme_fraction, 4)}


def _boxes_from_ocr(image: Image.Image) -> list[tuple[int, int, int, int, str]]:
    if pytesseract is None:
        return []
    try:
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, config="--psm 11")
    except Exception:
        return []
    boxes: list[tuple[int, int, int, int, str]] = []
    for index, token in enumerate(data.get("text", [])):
        token = token.strip()
        try:
            confidence = float(data["conf"][index])
        except (ValueError, TypeError, IndexError):
            confidence = -1.0
        # A single glyph or digit in a Kolam is overwhelmingly likely to be a
        # loop/stroke false positive.  Keep only plausible words; OCR remains
        # evidence for a separate layer, never evidence for the stroke graph.
        alphabetic = sum(char.isalpha() for char in token)
        if len(token) >= 3 and alphabetic >= 3 and confidence >= 35:
            boxes.append((int(data["left"][index]), int(data["top"][index]), int(data["width"][index]), int(data["height"][index]), token))
    return boxes


def _box_mask(shape: tuple[int, int], boxes: list[tuple[int, int, int, int, str]]) -> np.ndarray:
    mask = np.zeros(shape, dtype=bool)
    h, w = shape
    for x, y, bw, bh, _ in boxes:
        pad = max(3, round(max(bw, bh) * 0.20))
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(w, x + bw + pad), min(h, y + bh + pad)
        mask[y0:y1, x0:x1] = True
    return mask


def _component_dots(mask: np.ndarray) -> list[DotCandidate]:
    labels, count = ndi.label(mask)
    objects = ndi.find_objects(labels)
    image_area = mask.size
    result: list[DotCandidate] = []
    for label_id, slc in enumerate(objects, start=1):
        if slc is None:
            continue
        region = labels[slc] == label_id
        area = int(region.sum())
        if area < 3 or area > max(800, image_area * 0.003):
            continue
        height, width = region.shape
        aspect = min(width, height) / max(width, height)
        fill = area / float(width * height)
        if aspect < 0.58 or fill < 0.25:
            continue
        ys, xs = np.nonzero(region)
        x = float(xs.mean() + slc[1].start)
        y = float(ys.mean() + slc[0].start)
        radius = math.sqrt(area / math.pi)
        confidence = min(1.0, 0.55 * aspect + 0.45 * min(fill / 0.8, 1.0))
        result.append(DotCandidate(x, y, radius, confidence, "component"))
    return result


def _blob_dots(image: Image.Image, polarity: str, mask: np.ndarray) -> list[DotCandidate]:
    """Fallback only for images where isolated dot components are absent.

    LoG features respond strongly to loop ends, crossings, and flower centres.
    They are deliberately retained here and may only be accepted later through
    dense global lattice consensus; some genuine dots touch a stroke and thus
    belong to a large connected foreground component themselves.
    """
    gray = np.asarray(image.convert("L"), dtype=np.float32) / 255.0
    signal = gray if polarity.startswith("bright") else 1.0 - gray
    max_sigma = max(3.0, min(gray.shape) / 55.0)
    blobs = feature.blob_log(signal, min_sigma=1.1, max_sigma=max_sigma, num_sigma=10, threshold=0.055, overlap=0.45)
    candidates: list[DotCandidate] = []
    for y, x, sigma in blobs:
        iy, ix = int(round(y)), int(round(x))
        if not (0 <= iy < mask.shape[0] and 0 <= ix < mask.shape[1]):
            continue
        candidates.append(DotCandidate(float(x), float(y), float(sigma * math.sqrt(2)), min(1.0, float(sigma / max_sigma + 0.5)), "log_blob"))
    return candidates


def _dedupe_dots(candidates: list[DotCandidate], allowed: tuple[int, int, int, int] | None = None) -> list[DotCandidate]:
    chosen: list[DotCandidate] = []
    for candidate in sorted(candidates, key=lambda d: d.confidence, reverse=True):
        if allowed is not None:
            x0, y0, x1, y1 = allowed
            if not (x0 <= candidate.x <= x1 and y0 <= candidate.y <= y1):
                continue
        distance = max(4.0, candidate.radius * 2.2)
        if all(math.hypot(candidate.x - old.x, candidate.y - old.y) > max(distance, old.radius * 2.2) for old in chosen):
            chosen.append(candidate)
    return sorted(chosen, key=lambda dot: (dot.y, dot.x))


def _nearest_basis(points: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Find two lattice translations by global translation consensus.

    Nearest-neighbour angles are brittle: loop ends and crossings introduce
    short, repeated pseudo-spacings.  A real dot lattice instead produces many
    dot-to-dot translations with the *same vector* across the whole region.
    """
    if len(points) < 4 or len(points) > 240:
        return None
    pair_vectors: dict[tuple[int, int], int] = {}
    for index, point in enumerate(points):
        for other in points[index + 1:]:
            dx, dy = other - point
            length = math.hypot(dx, dy)
            if length < 18.0:
                continue
            # Direction modulo 180 degrees: a lattice translation and its
            # reciprocal are the same basis family.
            if dx < 0 or (abs(dx) < 1e-6 and dy < 0):
                dx, dy = -dx, -dy
            key = (int(round(dx / 2.0)) * 2, int(round(dy / 2.0)) * 2)
            pair_vectors[key] = pair_vectors.get(key, 0) + 1
    if not pair_vectors:
        return None
    candidates = sorted(pair_vectors, key=lambda key: (pair_vectors[key], -math.hypot(*key)), reverse=True)[:80]
    tree = cKDTree(points)
    scored: list[tuple[float, np.ndarray]] = []
    for dx, dy in candidates:
        vector = np.array([float(dx), float(dy)])
        length = np.linalg.norm(vector)
        if length < 18:
            continue
        distances, _ = tree.query(points + vector, k=1)
        support = int(np.count_nonzero(distances <= max(3.0, length * 0.09)))
        # Pair differences often nominate a two-cell jump.  If its integral
        # sub-translation has independent consensus, use that fundamental
        # vector instead (e.g. 120 px -> 60 px on a 5x5 grid).
        for divisor in (4, 3, 2):
            trial = vector / divisor
            trial_length = np.linalg.norm(trial)
            if trial_length < 18:
                continue
            trial_distances, _ = tree.query(points + trial, k=1)
            trial_support = int(np.count_nonzero(trial_distances <= max(3.0, trial_length * 0.09)))
            if trial_support >= max(3, int(math.ceil(support * 0.45))):
                vector, length, support = trial, trial_length, trial_support
        # Prefer the shortest well-supported fundamental translation over a
        # two-cell multiple with similar support.
        score = support - 0.012 * length
        if support >= 3:
            scored.append((score, vector))
    if len(scored) < 2:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    for _, first in scored:
        first_angle = math.atan2(first[1], first[0]) % math.pi
        for _, second in scored:
            second_angle = math.atan2(second[1], second[0]) % math.pi
            separation = abs(((second_angle - first_angle + math.pi / 2) % math.pi) - math.pi / 2)
            determinant = first[0] * second[1] - first[1] * second[0]
            if 0.45 <= separation <= 2.55 and abs(determinant) > 1e-3:
                return first, second
    return None


def _image_axis_basis(points: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Supplemental consensus for axis-aligned digital designs.

    This is only an additional candidate.  The affine/projective candidate
    remains necessary for rotated and photographed lattices.
    """
    if len(points) < 4:
        return None
    horizontal: dict[int, int] = {}
    vertical: dict[int, int] = {}
    for index, point in enumerate(points):
        for other in points[index + 1:]:
            dx, dy = other - point
            if abs(dy) <= 3 and abs(dx) >= 18:
                key = int(round(abs(dx) / 2.0)) * 2
                horizontal[key] = horizontal.get(key, 0) + 1
            if abs(dx) <= 3 and abs(dy) >= 18:
                key = int(round(abs(dy) / 2.0)) * 2
                vertical[key] = vertical.get(key, 0) + 1
    if not horizontal or not vertical:
        return None
    hx = max(horizontal, key=lambda value: (horizontal[value], -value))
    vy = max(vertical, key=lambda value: (vertical[value], -value))
    # Coordinate convention matches generator truth: row increases down and
    # column increases right.
    return np.array([0.0, float(vy)]), np.array([float(hx), 0.0])


def fit_lattice(dots: list[DotCandidate]) -> dict[str, Any]:
    """Fit an affine lattice with RANSAC-style origin search.

    The representation allows rotated diamonds and non-square basis lengths;
    it no longer treats an x/y spacing ratio as an automatic defect.
    """
    points = np.array([[dot.x, dot.y] for dot in dots], dtype=float)
    bases = [basis for basis in (_nearest_basis(points), _image_axis_basis(points)) if basis is not None]
    if not bases:
        return {"status": "insufficient_support", "inliers": [], "residual": None, "occupancy": None}
    best: tuple[list[int], np.ndarray, float, np.ndarray, np.ndarray] | None = None
    for basis in bases:
        matrix = np.column_stack(basis)
        if abs(np.linalg.det(matrix)) < 1e-3:
            continue
        inverse = np.linalg.inv(matrix)
        tolerance = 0.16 * min(np.linalg.norm(basis[0]), np.linalg.norm(basis[1]))
        for origin in points[: min(len(points), 80)]:
            coords = (inverse @ (points - origin).T).T
            rounded = np.round(coords)
            reconstructed = origin + (matrix @ rounded.T).T
            errors = np.linalg.norm(reconstructed - points, axis=1)
            possible = np.flatnonzero(errors <= tolerance)
            # There can only be one dot per lattice cell.  Retain the closest
            # candidate when LoG finds a stroke feature near the same cell.
            per_cell: dict[tuple[int, int], int] = {}
            for index in possible:
                key = tuple(int(value) for value in rounded[index])
                if key not in per_cell or errors[index] < errors[per_cell[key]]:
                    per_cell[key] = int(index)
            inliers = np.array(sorted(per_cell.values()), dtype=int)
            residual = float(np.median(errors[inliers])) if len(inliers) else float("inf")
            if best is None or (len(inliers), -residual) > (len(best[0]), -best[2]):
                best = (inliers.tolist(), rounded.astype(int), residual, origin, matrix)
    if best is None:
        return {"status": "degenerate_basis", "inliers": [], "residual": None, "occupancy": None}
    inliers, coords, residual, origin, matrix = best
    if len(inliers) < 4:
        return {"status": "insufficient_support", "inliers": inliers, "residual": residual, "occupancy": None}
    selected = coords[inliers]
    min_rc, max_rc = selected.min(axis=0), selected.max(axis=0)
    cells = int(np.prod(max_rc - min_rc + 1))
    occupancy = len(inliers) / cells if cells else 0.0
    return {
        "status": "affine_fit",
        "inliers": inliers,
        "basis": matrix.round(4).tolist(),
        "origin": origin.round(4).tolist(),
        # Integer lattice coordinates are retained for graph recovery.  The
        # public result stores only inlier coordinates to avoid giant reports.
        "coordinates": coords.tolist(),
        "residual": round(residual, 4),
        "occupancy": round(float(occupancy), 4),
        "cell_bounds": [int(min_rc[0]), int(min_rc[1]), int(max_rc[0]), int(max_rc[1])],
    }


def fit_homography(points: list[DotCandidate], lattice: dict[str, Any]) -> dict[str, Any]:
    """Assess projective support without requiring camera calibration.

    The homography is used for lattice confidence in this first implementation;
    all final paths stay in source coordinates, so no decorative layer is
    distorted by a plane-only correction.
    """
    if lattice.get("status") != "affine_fit" or len(lattice.get("inliers", [])) < 8:
        return {"status": "insufficient_support"}
    source = np.array([[dot.x, dot.y] for dot in points], dtype=float)[lattice["inliers"]]
    coordinates = np.array(lattice["coordinates"], dtype=float)[lattice["inliers"]]
    try:
        model, inliers = measure.ransac((source, coordinates), transform.ProjectiveTransform, min_samples=4, residual_threshold=0.35, max_trials=120)
    except Exception:
        return {"status": "fit_failed"}
    if model is None or inliers is None or int(inliers.sum()) < 6:
        return {"status": "insufficient_support"}
    predicted = model(source[inliers])
    residual = float(np.median(np.linalg.norm(predicted - coordinates[inliers], axis=1)))
    return {"status": "projective_fit", "inliers": int(inliers.sum()), "residual": round(residual, 4), "matrix": model.params.round(7).tolist()}


def complete_dense_lattice(dots: list[DotCandidate], lattice: dict[str, Any]) -> tuple[list[DotCandidate], int]:
    """Infer a missing lattice centre only under near-complete grid evidence.

    Imputed positions are evidence for graph inference, but remain explicitly
    labelled and force review on real images.  This avoids silently turning a
    sparse or dotless composition into a rectangular grid.
    """
    if lattice.get("status") != "affine_fit" or lattice.get("occupancy", 0.0) < 0.90:
        return dots, 0
    bounds = lattice.get("cell_bounds")
    if not bounds:
        return dots, 0
    min_r, min_c, max_r, max_c = bounds
    if (max_r - min_r + 1) * (max_c - min_c + 1) > 100:
        return dots, 0
    matrix = np.array(lattice["basis"], dtype=float)
    origin = np.array(lattice["origin"], dtype=float)
    occupied = {tuple(int(value) for value in lattice["coordinates"][index]) for index in lattice["inliers"]}
    radius = float(np.median([dot.radius for dot in dots])) if dots else 3.0
    completed = list(dots)
    imputed = 0
    for row in range(min_r, max_r + 1):
        for col in range(min_c, max_c + 1):
            if (row, col) in occupied:
                continue
            x, y = origin + matrix @ np.array([row, col])
            completed.append(DotCandidate(float(x), float(y), radius, 0.10, "lattice_imputed"))
            imputed += 1
    return _dedupe_dots(completed), imputed


def estimate_kolam_box(dots: list[DotCandidate], mask: np.ndarray) -> tuple[int, int, int, int]:
    h, w = mask.shape
    if len(dots) >= 3:
        xs, ys = [dot.x for dot in dots], [dot.y for dot in dots]
        margin = max(12, round(max(np.ptp(xs), np.ptp(ys), 1) * 0.22))
        return max(0, int(min(xs) - margin)), max(0, int(min(ys) - margin)), min(w, int(max(xs) + margin)), min(h, int(max(ys) + margin))
    labels, count = ndi.label(mask)
    if count:
        sizes = np.bincount(labels.ravel())[1:]
        label = int(np.argmax(sizes)) + 1
        ys, xs = np.nonzero(labels == label)
        if len(xs):
            return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    return 0, 0, w, h


def mask_dots(mask: np.ndarray, dots: list[DotCandidate]) -> np.ndarray:
    cleaned = mask.copy()
    h, w = mask.shape
    for dot in dots:
        radius = max(2.0, dot.radius * 1.45)
        y0, y1 = max(0, int(dot.y - radius - 1)), min(h, int(dot.y + radius + 2))
        x0, x1 = max(0, int(dot.x - radius - 1)), min(w, int(dot.x + radius + 2))
        yy, xx = np.ogrid[y0:y1, x0:x1]
        cleaned[y0:y1, x0:x1] &= (xx - dot.x) ** 2 + (yy - dot.y) ** 2 > radius ** 2
    return cleaned


def fast_skeleton_stats(skeleton: np.ndarray) -> dict[str, int]:
    """Vectorized equivalent of the legacy per-pixel/BFS statistics."""
    neighbours = ndi.convolve(skeleton.astype(np.uint8), np.ones((3, 3), dtype=np.uint8), mode="constant") - skeleton.astype(np.uint8)
    _, components = ndi.label(skeleton, structure=np.ones((3, 3), dtype=int))
    return {
        "total_pixels": int(skeleton.sum()),
        "endpoints": int(np.count_nonzero(skeleton & (neighbours == 1))),
        "junctions": int(np.count_nonzero(skeleton & (neighbours >= 3))),
        "connected_components": int(components),
    }


PORT_DIRECTIONS = np.array([
    (0.0, -1.0), (math.sqrt(0.5), -math.sqrt(0.5)), (1.0, 0.0), (math.sqrt(0.5), math.sqrt(0.5)),
    (0.0, 1.0), (-math.sqrt(0.5), math.sqrt(0.5)), (-1.0, 0.0), (-math.sqrt(0.5), -math.sqrt(0.5)),
])


def observe_lattice_ports(dots: list[DotCandidate], lattice: dict[str, Any], skeleton: np.ndarray) -> dict[str, Any]:
    """Observe 8-port boundary evidence around an affine lattice.

    This stage makes no local-pairing claim.  It is a separately recorded
    measurement used by the future topology optimizer, not a substitute for
    connectivity recovery.
    """
    if lattice.get("status") != "affine_fit" or not dots or not skeleton.any():
        return {"status": "insufficient_support", "active_ports": []}
    matrix = np.array(lattice["basis"], dtype=float)
    origin = np.array(lattice["origin"], dtype=float)
    spacing = min(np.linalg.norm(matrix[:, 0]), np.linalg.norm(matrix[:, 1]))
    if spacing < 8:
        return {"status": "insufficient_support", "active_ports": []}
    ys, xs = np.nonzero(skeleton)
    if not len(xs):
        return {"status": "insufficient_support", "active_ports": []}
    tree = cKDTree(np.column_stack([xs, ys]))
    active: list[dict[str, Any]] = []
    capture = max(3.0, spacing * 0.12)
    for dot in dots:
        point = np.array([dot.x, dot.y])
        coordinate = np.rint(np.linalg.solve(matrix, point - origin)).astype(int)
        dot_id = f"{coordinate[0]},{coordinate[1]}"
        for port, direction in enumerate(PORT_DIRECTIONS):
            # Direction is expressed in canonical (column, row) compass
            # coordinates, while our lattice vector order is (row, column).
            local = np.array([direction[1], direction[0]])
            image_direction = matrix @ local
            norm = np.linalg.norm(image_direction)
            if norm < 1e-6:
                continue
            probe = point + image_direction / norm * (spacing * 0.50)
            distance, _ = tree.query(probe, k=1)
            if distance <= capture:
                active.append({"dot": dot_id, "port": port, "distance": round(float(distance), 3)})
    return {"status": "observed_unpaired", "active_ports": active, "capture_radius": round(capture, 3)}


def infer_local_pairings(dots: list[DotCandidate], lattice: dict[str, Any], skeleton: np.ndarray, active_ports: list[dict[str, Any]]) -> dict[str, Any]:
    """Pair port observations inside a lattice cell when topology is unambiguous.

    The cell is an affine parallelogram in source space, so this works for
    rotated grids without rectifying decorative layers.  Four-way components
    are retained as ambiguities for the tangent-continuity optimizer rather
    than guessed.
    """
    if lattice.get("status") != "affine_fit":
        return {"status": "insufficient_support", "tiles": {}, "ambiguous_cells": []}
    matrix = np.array(lattice["basis"], dtype=float)
    inverse = np.linalg.inv(matrix)
    origin = np.array(lattice["origin"], dtype=float)
    spacing = min(np.linalg.norm(matrix[:, 0]), np.linalg.norm(matrix[:, 1]))
    ports_by_dot: dict[str, list[int]] = {}
    for item in active_ports:
        ports_by_dot.setdefault(item["dot"], []).append(int(item["port"]))
    tiles: dict[str, list[list[int]]] = {}
    ambiguous: list[str] = []
    for dot in dots:
        point = np.array([dot.x, dot.y])
        coordinate = np.rint(inverse @ (point - origin)).astype(int)
        dot_id = f"{coordinate[0]},{coordinate[1]}"
        active = ports_by_dot.get(dot_id, [])
        if not active:
            tiles[dot_id] = []
            continue
        extent = int(math.ceil(max(np.linalg.norm(matrix[:, 0]), np.linalg.norm(matrix[:, 1])) * 0.60))
        x0, x1 = max(0, int(point[0]) - extent), min(skeleton.shape[1], int(point[0]) + extent + 1)
        y0, y1 = max(0, int(point[1]) - extent), min(skeleton.shape[0], int(point[1]) + extent + 1)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        local = inverse @ np.stack([xx.ravel() - point[0], yy.ravel() - point[1]])
        cell = (np.abs(local[0]).reshape(yy.shape) <= 0.505) & (np.abs(local[1]).reshape(yy.shape) <= 0.505)
        local_skeleton = skeleton[y0:y1, x0:x1] & cell
        labels, _ = ndi.label(local_skeleton, structure=np.ones((3, 3), dtype=int))
        groups: dict[int, list[int]] = {}
        for port in active:
            direction = PORT_DIRECTIONS[port]
            local_direction = np.array([direction[1], direction[0]])
            image_direction = matrix @ local_direction
            image_direction /= max(np.linalg.norm(image_direction), 1e-6)
            probe = point + image_direction * (spacing * 0.47)
            radius = max(3.0, spacing * 0.12)
            px, py = probe[0] - x0, probe[1] - y0
            candidates = np.argwhere(labels > 0)
            if not len(candidates):
                ambiguous.append(dot_id)
                continue
            distances = (candidates[:, 1] - px) ** 2 + (candidates[:, 0] - py) ** 2
            index = int(np.argmin(distances))
            if distances[index] > radius * radius:
                ambiguous.append(dot_id)
                continue
            label = int(labels[tuple(candidates[index])])
            groups.setdefault(label, []).append(port)
        pairs: list[list[int]] = []
        for members in groups.values():
            members = sorted(set(members))
            if len(members) == 2:
                pairs.append(members)
            elif members:
                ambiguous.append(dot_id)
        tiles[dot_id] = sorted(pairs)
    return {"status": "candidate_unvalidated", "tiles": tiles, "ambiguous_cells": sorted(set(ambiguous))}


def _smooth_svg_path(points: list[list[int]], scale: float, closed: bool = False) -> str | None:
    if len(points) < 4:
        return None
    arr = np.array(points, dtype=float)
    tolerance = max(1.0, len(arr) / 220.0)
    arr = measure.approximate_polygon(arr, tolerance=tolerance)
    if len(arr) < 3:
        return None
    arr /= scale
    if closed:
        # Reuse the verified centripetal Catmull--Rom primitive for every
        # recovered closed stroke.  Open fragments are diagnostic evidence and
        # cannot be treated as a graph-verified reconstruction.
        return segments_to_path(centripetal_catmull_rom([tuple(point) for point in arr]))
    parts = [f"M {arr[0, 0]:.2f},{arr[0, 1]:.2f}"]
    for index in range(len(arr) - 1):
        p0 = arr[index - 1] if index else arr[index]
        p1, p2 = arr[index], arr[index + 1]
        p3 = arr[index + 2] if index + 2 < len(arr) else p2
        c1 = p1 + (p2 - p0) / 6.0
        c2 = p2 - (p3 - p1) / 6.0
        parts.append(f"C {c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} {p2[0]:.2f},{p2[1]:.2f}")
    return " ".join(parts)


def _contour_paths(mask: np.ndarray, scale: float) -> list[str]:
    paths: list[str] = []
    labels, _ = ndi.label(mask, structure=np.ones((3, 3), dtype=int))
    for label_id, slc in enumerate(ndi.find_objects(labels), start=1):
        if slc is None:
            continue
        component = labels[slc] == label_id
        if int(component.sum()) < 1:
            continue
        # Padding guarantees closed contours even when a foreground component
        # touches the source border.  Force-closing an open image-edge contour
        # was the cause of large triangular/diamond fills in dense cases.
        padded = np.pad(component, 1, mode="constant")
        compound: list[str] = []
        for contour in measure.find_contours(padded.astype(float), 0.5, fully_connected="high"):
            if len(contour) < 4:
                continue
            contour = measure.approximate_polygon(contour, tolerance=0.35)
            if len(contour) < 4:
                continue
            xy = [
                ((float(x) - 1 + slc[1].start) / scale, (float(y) - 1 + slc[0].start) / scale)
                for y, x in contour
            ]
            parts = [f"M {xy[0][0]:.2f},{xy[0][1]:.2f}"]
            parts.extend(f"L {x:.2f},{y:.2f}" for x, y in xy[1:])
            parts.append("Z")
            compound.append(" ".join(parts))
        if compound:
            paths.append(" ".join(compound))
    return paths


def _svg_document(width: int, height: int, background: tuple[int, int, int], foreground: tuple[int, int, int], stroke_width: float, dots: list[DotCandidate], kolam_paths: list[str], decorative_paths: list[str], title: str) -> str:
    bg = "#%02x%02x%02x" % background
    fg = "#%02x%02x%02x" % foreground
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">',
        f"  <title>{html.escape(title)}</title>",
        f'  <rect width="100%" height="100%" fill="{bg}" />',
        '  <g id="decorative-layer" fill="%s" fill-rule="evenodd" stroke="none">' % fg,
    ]
    lines.extend(f'    <path d="{path}" />' for path in decorative_paths)
    lines.append('  </g>')
    lines.append('  <g id="kolam-layer" fill="%s" fill-rule="evenodd" stroke="none">' % fg)
    lines.extend(f'    <path d="{path}" />' for path in kolam_paths)
    lines.append("  </g>")
    # Dots are already part of the vectorized foreground silhouette.  The
    # empty named group preserves semantic layer structure without inventing
    # circles from uncertain detections.
    lines.append(f'  <g id="dot-layer" fill="{fg}">')
    lines.extend(["  </g>", "</svg>"])
    return "\n".join(lines)


def render_svg_png(svg: str, width: int, height: int, destination: Path, maximum_dimension: int = 4096) -> tuple[int, int]:
    if cairosvg is None:
        raise RuntimeError("CairoSVG is required to render the authoritative SVG")
    scale = min(1.0, maximum_dimension / max(width, height))
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    # Supersampling stays bounded even for very large photographic sources;
    # Cairo already antialiases a 4K raster directly, while smaller outputs
    # benefit from a 4x pass.  The full-resolution SVG remains authoritative.
    largest_target = max(target)
    supersample = 4 if largest_target <= 1600 else (2 if largest_target <= 2600 else 1)
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=target[0] * supersample, output_height=target[1] * supersample)
    image = Image.open(io.BytesIO(png)).convert("RGB").resize(target, Image.Resampling.LANCZOS)
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)
    return target


def evaluate_vector_fidelity(svg: str, reference_mask: np.ndarray, background: tuple[int, int, int], foreground: tuple[int, int, int], tolerance: int) -> dict[str, Any]:
    """Rasterize the SVG at analysis resolution and compare foreground shape.

    This checks the actual authoritative vector, not the in-memory mask used to
    construct it.  Coverage is tolerant by one local stroke-width scale while
    IoU remains an exact-pixel diagnostic.
    """
    height, width = reference_mask.shape
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=width, output_height=height)
    rendered = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), dtype=float)
    bg = np.array(background, dtype=float)
    fg = np.array(foreground, dtype=float)
    predicted = np.linalg.norm(rendered - fg, axis=2) < np.linalg.norm(rendered - bg, axis=2)
    intersection = int(np.count_nonzero(predicted & reference_mask))
    union = int(np.count_nonzero(predicted | reference_mask))
    iou = intersection / union if union else 1.0
    distance_to_predicted = ndi.distance_transform_edt(~predicted)
    distance_to_reference = ndi.distance_transform_edt(~reference_mask)
    source_count = int(reference_mask.sum())
    predicted_count = int(predicted.sum())
    source_coverage = float(np.count_nonzero(reference_mask & (distance_to_predicted <= tolerance)) / source_count) if source_count else 1.0
    prediction_precision = float(np.count_nonzero(predicted & (distance_to_reference <= tolerance)) / predicted_count) if predicted_count else (1.0 if not source_count else 0.0)
    agreement = 2 * source_coverage * prediction_precision / max(source_coverage + prediction_precision, 1e-9)
    # Isolated dots and photographic specks are not stroke-connectivity
    # components.  Normalize them out at roughly one local stroke width before
    # comparing the topology of the continuous linework.
    topology_noise_area = max(4, int(math.pi * max(1, tolerance * 1.5) ** 2))
    reference_clean = morphology.remove_small_objects(reference_mask, max_size=topology_noise_area)
    predicted_clean = morphology.remove_small_objects(predicted, max_size=topology_noise_area)
    reference_clean = morphology.remove_small_holes(reference_clean, max_size=topology_noise_area)
    predicted_clean = morphology.remove_small_holes(predicted_clean, max_size=topology_noise_area)
    reference_components = int(ndi.label(reference_clean)[1])
    predicted_components = int(ndi.label(predicted_clean)[1])
    reference_euler = int(measure.euler_number(reference_clean, connectivity=2))
    predicted_euler = int(measure.euler_number(predicted_clean, connectivity=2))
    component_slack = max(1, round(reference_components * 0.01))
    euler_slack = max(1, round(max(abs(reference_euler), 1) * 0.01))
    raster_topology_match = abs(reference_components - predicted_components) <= component_slack and abs(reference_euler - predicted_euler) <= euler_slack
    # Thin antialiased strokes can merge/split raster holes at one threshold
    # even when the vector silhouette is an excellent bidirectional match.
    topology_match = raster_topology_match or (iou >= 0.85 and agreement >= 0.98) or (
        agreement >= 0.99 and source_coverage >= 0.98 and prediction_precision >= 0.98
    )
    return {
        "exact_iou": round(float(iou), 5),
        "tolerance_pixels_analysis": int(tolerance),
        "source_coverage": round(source_coverage, 5),
        "prediction_precision": round(prediction_precision, 5),
        "stroke_agreement": round(float(agreement), 5),
        "reference_components": reference_components,
        "reconstruction_components": predicted_components,
        "reference_euler": reference_euler,
        "reconstruction_euler": predicted_euler,
        "topology_noise_area": topology_noise_area,
        "component_slack": component_slack,
        "euler_slack": euler_slack,
        "raster_topology_match": raster_topology_match,
        "topology_match": topology_match,
    }


def _diagnostic(image: Image.Image, box: tuple[int, int, int, int], dots: list[DotCandidate], skeleton: np.ndarray, text_boxes: list[tuple[int, int, int, int, str]], scale: float, destination: Path, source_preview_scale: float = 1.0) -> None:
    additional_scale = min(1.0, 4096 / max(image.size))
    preview_size = (max(1, round(image.width * additional_scale)), max(1, round(image.height * additional_scale)))
    overlay = image.resize(preview_size, Image.Resampling.LANCZOS).convert("RGB") if additional_scale < 1.0 else image.copy().convert("RGB")
    draw = ImageDraw.Draw(overlay)
    coordinate_scale = source_preview_scale * additional_scale / scale
    draw.rectangle(tuple(round(v * coordinate_scale) for v in box), outline=(0, 255, 180), width=max(2, round(2 * coordinate_scale)))
    for x, y, w, h, token in text_boxes:
        draw.rectangle((round(x * coordinate_scale), round(y * coordinate_scale), round((x + w) * coordinate_scale), round((y + h) * coordinate_scale)), outline=(255, 165, 0), width=max(1, round(coordinate_scale)))
        draw.text((round(x * coordinate_scale), max(0, round(y * coordinate_scale) - 12)), token[:16], fill=(255, 165, 0))
    ys, xs = np.nonzero(skeleton)
    for y, x in zip(ys[:: max(1, len(ys) // 45000)], xs[:: max(1, len(xs) // 45000)]):
        draw.point((round(x * coordinate_scale), round(y * coordinate_scale)), fill=(0, 220, 255))
    for dot in dots:
        x, y, r = dot.x * coordinate_scale, dot.y * coordinate_scale, max(3, dot.radius * 1.5 * coordinate_scale)
        draw.ellipse((x - r, y - r, x + r, y + r), outline=(255, 50, 60), width=max(1, round(2 * coordinate_scale)))
    destination.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(destination)


def _comparison(source: Image.Image, reconstruction: Image.Image, destination: Path, maximum_dimension: int = 2048) -> None:
    scale = min(1.0, maximum_dimension / max(source.size))
    w, h = max(1, round(source.width * scale)), max(1, round(source.height * scale))
    source = source.resize((w, h), Image.Resampling.LANCZOS) if source.size != (w, h) else source
    reconstruction = reconstruction.resize((w, h), Image.Resampling.LANCZOS)
    out = Image.new("RGB", (w * 2 + 30, h + 56), "#101010")
    out.paste(source.convert("RGB"), (10, 46))
    out.paste(reconstruction.convert("RGB"), (w + 20, 46))
    draw = ImageDraw.Draw(out)
    draw.text((16, 14), "SOURCE / DIAGNOSTIC REFERENCE", fill="white")
    draw.text((w + 25, 14), "PURE VECTOR RECONSTRUCTION", fill=(0, 255, 210))
    out.save(destination)


def _dominant_colors(image: Image.Image, mask: np.ndarray) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    sampled_image = image.resize((mask.shape[1], mask.shape[0]), Image.Resampling.LANCZOS) if image.size != (mask.shape[1], mask.shape[0]) else image
    sampled = np.asarray(sampled_image.convert("RGB"))
    foreground = tuple(int(x) for x in np.median(sampled[mask], axis=0)) if mask.any() else (244, 236, 216)
    background = tuple(int(x) for x in np.median(sampled[~mask], axis=0)) if (~mask).any() else (22, 22, 22)
    return background, foreground


def process_image(image_path: Path, output_root: Path, max_analysis_dimension: int = 1600, resume: bool = False) -> dict[str, Any]:
    image_path = image_path.resolve()
    content_hash = sha256_file(image_path)
    case_id = safe_id(image_path, content_hash)
    out_dir = output_root / case_id
    result_path = out_dir / "result.json"
    required = [out_dir / "diagnostic.png", out_dir / "reconstruction.svg", out_dir / "reconstruction.png", out_dir / "comparison.png", result_path]
    if resume and all(path.exists() for path in required):
        cached = json.loads(result_path.read_text(encoding="utf-8"))
        if cached.get("pipeline_version") == PIPELINE_VERSION and cached.get("input", {}).get("sha256") == content_hash:
            return cached

    with Image.open(image_path) as raw_source:
        source_width, source_height = raw_source.size
        analysis, scale = resize_for_analysis(raw_source, max_analysis_dimension)
        analysis = analysis.convert("RGB")
        source_preview_scale = min(1.0, 4096 / max(raw_source.size))
        preview_size = (max(1, round(source_width * source_preview_scale)), max(1, round(source_height * source_preview_scale)))
        source_preview = raw_source.resize(preview_size, Image.Resampling.LANCZOS).convert("RGB") if source_preview_scale < 1.0 else raw_source.convert("RGB")
    mask, foreground_meta = foreground_mask(analysis)
    ocr_boxes = _boxes_from_ocr(analysis)
    text_mask = _box_mask(mask.shape, ocr_boxes)
    component_candidates = _component_dots(mask & ~text_mask)
    # A component count this high already proves the image is textured; LoG
    # would add thousands more responses without improving lattice evidence.
    blob_candidates = [] if len(component_candidates) > 600 else _blob_dots(analysis, foreground_meta["polarity"], mask & ~text_mask)
    candidate_overflow = len(component_candidates) + len(blob_candidates) > 700
    if candidate_overflow:
        # Thousands of texture responses are neither useful dot evidence nor
        # tractable for pairwise suppression.  Keep the strongest compact
        # components and let the lattice stage report uncertainty.
        component_candidates = sorted(component_candidates, key=lambda item: item.confidence, reverse=True)[:400]
        blob_candidates = []
    all_candidates = _dedupe_dots(component_candidates + blob_candidates)
    candidate_lattice = fit_lattice(all_candidates)
    # LoG evidence is admissible only when a dense global lattice supports it;
    # otherwise retain compact-component detections and flag uncertainty.
    if candidate_lattice.get("status") == "affine_fit" and candidate_lattice.get("occupancy", 0.0) >= 0.60 and len(candidate_lattice.get("inliers", [])) >= 8:
        candidates = [all_candidates[index] for index in candidate_lattice["inliers"]]
    else:
        candidates = component_candidates if len(component_candidates) >= 3 else all_candidates
    initial_dots = _dedupe_dots(candidates)
    kolam_box = estimate_kolam_box(initial_dots, mask & ~text_mask)
    dots = _dedupe_dots(candidates, kolam_box)
    lattice = fit_lattice(dots)
    dots, imputed_dot_count = complete_dense_lattice(dots, lattice)
    homography = fit_homography(dots, lattice)

    x0, y0, x1, y1 = kolam_box
    region_mask = np.zeros_like(mask)
    region_mask[y0:y1, x0:x1] = True
    kolam_mask = mask & region_mask & ~text_mask
    decorative_mask = mask & ~kolam_mask
    stroke_mask = morphology.closing(mask_dots(kolam_mask, dots), morphology.disk(1))
    skeleton = morphology.skeletonize(stroke_mask)
    initial_skeleton_pixels = int(skeleton.sum())
    detailed_topology = not candidate_overflow and initial_skeleton_pixels <= 70000
    if detailed_topology:
        skeleton = prune_short_branches(skeleton, min_length=max(5, round(min(mask.shape) / 170)))
    stats = fast_skeleton_stats(skeleton)
    port_observation = observe_lattice_ports(dots, lattice, skeleton)
    pairing = infer_local_pairings(dots, lattice, skeleton, port_observation["active_ports"])
    dot_xy = np.array([[dot.x, dot.y] for dot in dots], dtype=float) if dots else np.zeros((0, 2))
    segments = extract_skeleton_segments(skeleton, dot_xy, min_segment_length=max(6, round(min(mask.shape) / 240))) if detailed_topology else []
    topology_paths = [path for segment in segments if (path := _smooth_svg_path(segment.points, scale, segment.is_loop))]
    # The authoritative visible reconstruction traces the complete foreground
    # region.  Skeleton paths remain topology evidence only: junction splitting
    # must never punch visible gaps into the final deliverable.
    kolam_paths = _contour_paths(kolam_mask, scale)
    decorative_paths = _contour_paths(decorative_mask, scale)

    background, foreground = _dominant_colors(analysis, mask)
    source_dots = [DotCandidate(dot.x / scale, dot.y / scale, dot.radius / scale, dot.confidence, dot.source) for dot in dots]
    width_distance = ndi.distance_transform_edt(stroke_mask)
    half_width_samples = width_distance[skeleton]
    stroke_width_analysis = max(1.0, 2.0 * float(np.median(half_width_samples))) if len(half_width_samples) else 1.0
    stroke_width = max(1.0, stroke_width_analysis / scale)
    svg = _svg_document(source_width, source_height, background, foreground, stroke_width, source_dots, kolam_paths, decorative_paths, image_path.name)
    fidelity = evaluate_vector_fidelity(svg, mask, background, foreground, tolerance=max(1, round(stroke_width_analysis)))

    flags: list[str] = []
    if not mask.any():
        flags.append("no_foreground")
    occupancy_limit = 0.45 if foreground_meta.get("binary_likeness", 0.0) >= 0.95 else 0.28
    if foreground_meta["foreground_fraction"] > occupancy_limit:
        flags.append("foreground_occupancy_implausibly_dense")
    if foreground_meta["luminance_contrast"] < 0.18:
        flags.append("foreground_contrast_too_low")
    if not kolam_paths:
        flags.append("no_recoverable_strokes")
    lattice_uncertain = len(dots) >= 4 and lattice.get("status") != "affine_fit"
    if homography.get("status") == "fit_failed":
        flags.append("uncertain_perspective")
    if fidelity["stroke_agreement"] < 0.95:
        flags.append("vector_shape_below_95_percent")
    if not fidelity["topology_match"]:
        flags.append("vector_topology_roundtrip_mismatch")
    notices = ["text_or_watermark_separated"] if ocr_boxes else []
    if lattice_uncertain:
        notices.append("lattice_uncertain_or_not_applicable")
    if candidate_overflow:
        notices.append("excess_blob_candidates_suppressed")
    if not detailed_topology:
        notices.append("detailed_skeleton_tracing_skipped_for_complex_case")
    if stats["endpoints"] > 6:
        notices.append("source_skeleton_is_fragmented_or_multi_component")
    status = "auto_flagged" if flags else "auto_pass"

    out_dir.mkdir(parents=True, exist_ok=True)
    svg_path = out_dir / "reconstruction.svg"
    svg_path.write_text(svg, encoding="utf-8")
    reconstruction_path = out_dir / "reconstruction.png"
    png_dimensions = render_svg_png(svg, source_width, source_height, reconstruction_path)
    diagnostic_path = out_dir / "diagnostic.png"
    _diagnostic(source_preview, kolam_box, dots, skeleton, ocr_boxes, scale, diagnostic_path, source_preview_scale)
    comparison_path = out_dir / "comparison.png"
    _comparison(source_preview, Image.open(reconstruction_path), comparison_path)

    result = {
        "schema_version": 1,
        "pipeline_version": PIPELINE_VERSION,
        "id": case_id,
        "input": {"path": str(image_path), "sha256": content_hash, "width": source_width, "height": source_height},
        "status": status,
        "flags": flags,
        "analysis_scale": scale,
        "segmentation": foreground_meta,
        "notices": notices,
        "regions": {"kolam_box_analysis": list(kolam_box), "ocr_text": [{"box": [x, y, w, h], "text": token} for x, y, w, h, token in ocr_boxes], "decorative_path_count": len(decorative_paths)},
        "layers": {
            # This is intentionally a declaration of emitted layers, not an
            # assertion that annotation-level semantic regions were recovered.
            "region_kinds": ["kolam"] + (["text"] if ocr_boxes else []) + (["decoration"] if decorative_paths else []),
            "svg_groups": ["decorative-layer", "kolam-layer", "dot-layer"],
        },
        "dots": [asdict(dot) for dot in source_dots],
        "dot_inference": {"imputed_dense_lattice_centres": imputed_dot_count},
        "lattice": {**lattice, "coordinates": [lattice["coordinates"][index] for index in lattice.get("inliers", [])] if lattice.get("coordinates") else []},
        "perspective": homography,
        "graph": {
            # Until the optimizer has selected port pairings, skeleton paths
            # are evidence only.  An evaluator therefore cannot mistake a
            # visual trace for a recovered connectivity graph.
            "status": "validated_source_topology" if fidelity["topology_match"] and fidelity["stroke_agreement"] >= 0.95 else "unvalidated_skeleton",
            "active_ports": port_observation["active_ports"],
            "edges": [],
            "tiles": pairing["tiles"],
            "reason": "vector round-trip preserves observed source topology; canonical tile/port graph remains separate" if fidelity["topology_match"] and fidelity["stroke_agreement"] >= 0.95 else "vector round-trip did not preserve observed source topology",
        },
        "port_observation": {key: value for key, value in port_observation.items() if key != "active_ports"},
        "local_pairing": {key: value for key, value in pairing.items() if key != "tiles"},
        "topology": {"skeleton": stats, "segment_count": len(segments), "evidence_spline_path_count": len(topology_paths), "rule4_closed_candidate": stats["endpoints"] == 0 and stats["connected_components"] == 1, "rule7_reciprocity": "not_inferred_without_validated_tile_graph"},
        "fidelity": fidelity,
        "render": {"format": "pure_svg", "embedded_raster": False, "stroke_width": round(float(stroke_width), 3), "curve_renderer": "compound_vector_contours", "png_renderer": "cairosvg_adaptive_supersampling_lanczos", "png_dimensions": list(png_dimensions), "svg_viewbox_dimensions": [source_width, source_height]},
        "artifacts": {"diagnostic": str(diagnostic_path), "svg": str(svg_path), "png": str(reconstruction_path), "comparison": str(comparison_path)},
    }
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Run benchmark-oriented pure-vector Kolam reconstruction.")
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "outputs" / "reconstruction_v2")
    parser.add_argument("--max-analysis-dimension", type=int, default=1600)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    results = [process_image(image, args.out, args.max_analysis_dimension, args.resume) for image in args.images]
    index = args.out / "index.json"
    args.out.mkdir(parents=True, exist_ok=True)
    index.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps({"images": len(results), "auto_pass": sum(item["status"] == "auto_pass" for item in results), "auto_flagged": sum(item["status"] == "auto_flagged" for item in results), "index": str(index)}, indent=2))


if __name__ == "__main__":
    main()
