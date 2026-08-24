"""Dot masking and stroke skeletonization for the Kolam pipeline.

This script implements PoC Steps 5 and 6:
  Step 5 — Mask detected dot regions out of the stroke image.
  Step 6 — Skeletonize the remaining Kolam strokes into 1-pixel-wide
           centerlines.

It reads the detection results produced by detect_dots.py and generates:
  - A binary stroke mask with dot regions filled
  - A raw skeleton image
  - A skeleton overlay on the original image
  - A JSON file with skeletonization metadata
"""

from __future__ import annotations

import argparse
import json
import math
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from skimage.morphology import (
    closing,
    opening,
    disk,
    skeletonize,
)


# ---------------------------------------------------------------------------
# Loading previous stage results
# ---------------------------------------------------------------------------


def load_detection_results(json_path: Path) -> list[dict]:
    """Load dot detection results from the JSON file produced by detect_dots.py."""
    text = json_path.read_text(encoding="utf-8")
    return json.loads(text)


def find_result_for_image(results: list[dict], image_path: Path) -> dict | None:
    """Find the detection result entry that matches *image_path*."""
    name = image_path.name
    for result in results:
        if Path(result["image"]).name == name:
            return result
    return None


# ---------------------------------------------------------------------------
# Binary stroke mask creation
# ---------------------------------------------------------------------------


def create_stroke_mask(image: Image.Image, threshold: int) -> np.ndarray:
    """Create a boolean mask of bright (white) foreground pixels.

    Uses the same luminance + min-channel logic as detect_dots so the mask
    is consistent with the previous stage.
    """
    rgb = np.asarray(image.convert("RGB"))
    luminance = (
        0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    )
    min_channel = rgb.min(axis=2)
    mask = (luminance >= threshold) & (min_channel >= threshold - 28)
    return mask


def create_stroke_mask_adaptive(image: Image.Image) -> np.ndarray:
    """Create a stroke mask using adaptive local statistics.

    Used for camera images where a single global threshold is unreliable.
    The mask keeps pixels that are significantly brighter than their local
    neighbourhood.
    """
    gray = np.asarray(image.convert("L"), dtype=float)
    # Box mean over a large window gives the local background level.
    radius = max(15, min(gray.shape) // 20)
    padded = np.pad(gray, ((radius, radius), (radius, radius)), mode="edge")
    integral = np.pad(padded, ((1, 0), (1, 0)), mode="constant").cumsum(axis=0).cumsum(axis=1)
    size = radius * 2 + 1
    local_mean = (
        integral[size:, size:]
        - integral[:-size, size:]
        - integral[size:, :-size]
        + integral[:-size, :-size]
    ) / float(size * size)
    # Pixels well above the local mean are foreground.
    offset = 25.0
    mask = gray > (local_mean + offset)
    return mask


# ---------------------------------------------------------------------------
# Dot masking
# ---------------------------------------------------------------------------


def mask_dots(
    stroke_mask: np.ndarray,
    dots: list[dict],
    grid_spacing: float,
) -> np.ndarray:
    """Erase detected dot regions from the stroke mask.

    Each dot is covered by a filled circle whose radius is derived from the
    dot's bounding box plus a small margin proportional to the grid spacing.
    The circle is painted *black* (False) to remove the dot entirely.

    This prevents isolated dots from producing ghost 1-pixel skeleton
    artifacts.  The surrounding strokes remain intact because strokes are
    wider than the dot and extend beyond the erased circle.
    """
    masked = stroke_mask.copy()
    height, width = masked.shape

    for dot in dots:
        cx = dot["x"]
        cy = dot["y"]
        # Radius: half of the dot's largest dimension + a small margin.
        dot_radius = max(dot["width"], dot["height"]) / 2.0
        margin = max(1.0, grid_spacing * 0.04)
        radius = dot_radius + margin
        r_int = int(math.ceil(radius))

        # Erase the circular dot region.
        y_min = max(0, int(cy) - r_int)
        y_max = min(height, int(cy) + r_int + 1)
        x_min = max(0, int(cx) - r_int)
        x_max = min(width, int(cx) + r_int + 1)

        ys, xs = np.ogrid[y_min:y_max, x_min:x_max]
        dist_sq = (xs - cx) ** 2 + (ys - cy) ** 2
        masked[y_min:y_max, x_min:x_max] &= dist_sq > radius * radius

    return masked


# ---------------------------------------------------------------------------
# Morphological cleanup
# ---------------------------------------------------------------------------


def clean_stroke_mask(
    mask: np.ndarray,
    close_radius: int = 2,
    open_radius: int = 1,
) -> np.ndarray:
    """Clean the stroke mask using morphological operations.

    1. Closing fills small hairline gaps and holes.
    2. Opening removes isolated noise pixels.
    """
    cleaned = mask
    if close_radius > 0:
        cleaned = closing(cleaned, footprint=disk(close_radius))
    if open_radius > 0:
        cleaned = opening(cleaned, footprint=disk(open_radius))
    return cleaned


# ---------------------------------------------------------------------------
# Skeletonization
# ---------------------------------------------------------------------------


def skeletonize_mask(mask: np.ndarray) -> np.ndarray:
    """Reduce the binary stroke mask to a 1-pixel-wide skeleton."""
    return skeletonize(mask).astype(bool)


# ---------------------------------------------------------------------------
# Branch pruning
# ---------------------------------------------------------------------------


def _neighbor_count(skeleton: np.ndarray, y: int, x: int) -> int:
    """Count the number of True 8-connected neighbours of (y, x)."""
    h, w = skeleton.shape
    count = 0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and skeleton[ny, nx]:
                count += 1
    return count


def find_endpoints(skeleton: np.ndarray) -> list[tuple[int, int]]:
    """Return coordinates of skeleton pixels that have exactly 1 neighbour."""
    endpoints: list[tuple[int, int]] = []
    ys, xs = np.nonzero(skeleton)
    for y, x in zip(ys, xs):
        if _neighbor_count(skeleton, int(y), int(x)) == 1:
            endpoints.append((int(y), int(x)))
    return endpoints


def _trace_branch(
    skeleton: np.ndarray,
    start_y: int,
    start_x: int,
) -> list[tuple[int, int]]:
    """Trace a branch from an endpoint until a junction (>2 neighbours) or
    another endpoint is reached.  Returns the list of pixels in the branch
    (including the start, excluding the junction pixel itself).
    """
    h, w = skeleton.shape
    path: list[tuple[int, int]] = [(start_y, start_x)]
    visited = {(start_y, start_x)}
    y, x = start_y, start_x

    while True:
        neighbors: list[tuple[int, int]] = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ny, nx = y + dy, x + dx
                if (
                    0 <= ny < h
                    and 0 <= nx < w
                    and skeleton[ny, nx]
                    and (ny, nx) not in visited
                ):
                    neighbors.append((ny, nx))

        if len(neighbors) == 0:
            # Dead end.
            break
        if len(neighbors) >= 2:
            # Reached a junction — stop (don't include junction in branch).
            break

        ny, nx = neighbors[0]
        visited.add((ny, nx))
        path.append((ny, nx))
        y, x = ny, nx

        # If the new pixel is also an endpoint in the original skeleton we
        # keep it in the path and stop.
        if _neighbor_count(skeleton, y, x) <= 1:
            break

    return path


def prune_short_branches(
    skeleton: np.ndarray,
    min_length: int = 8,
    max_iterations: int = 5,
) -> np.ndarray:
    """Iteratively remove dangling branches shorter than *min_length* pixels.

    Short spurs are common artifacts from corners, dot-mask boundaries,
    and morphological noise.
    """
    pruned = skeleton.copy()
    for _ in range(max_iterations):
        endpoints = find_endpoints(pruned)
        if not endpoints:
            break
        removed_any = False
        for ey, ex in endpoints:
            if not pruned[ey, ex]:
                continue
            branch = _trace_branch(pruned, ey, ex)
            if len(branch) < min_length:
                for by, bx in branch:
                    pruned[by, bx] = False
                removed_any = True
        if not removed_any:
            break
    return pruned


def remove_small_components(
    skeleton: np.ndarray,
    min_size: int = 10,
) -> np.ndarray:
    """Remove connected components with fewer than *min_size* pixels.

    Eliminates tiny fragments from ghost dots, watermark text, and
    morphological noise that survived branch pruning.
    """
    from scipy.ndimage import label as scipy_label

    labeled, num_components = scipy_label(skeleton, structure=np.ones((3, 3)))
    cleaned = skeleton.copy()
    for i in range(1, num_components + 1):
        component_mask = labeled == i
        if component_mask.sum() < min_size:
            cleaned[component_mask] = False
    return cleaned


# ---------------------------------------------------------------------------
# Skeleton statistics
# ---------------------------------------------------------------------------


def skeleton_stats(skeleton: np.ndarray) -> dict:
    """Compute basic skeleton statistics for diagnostics."""
    total_pixels = int(skeleton.sum())

    # Count endpoints and junctions.
    endpoints = 0
    junctions = 0
    ys, xs = np.nonzero(skeleton)
    for y, x in zip(ys, xs):
        n = _neighbor_count(skeleton, int(y), int(x))
        if n == 1:
            endpoints += 1
        elif n >= 3:
            junctions += 1

    # Count connected components via BFS.
    h, w = skeleton.shape
    visited = np.zeros_like(skeleton, dtype=bool)
    components = 0
    for y, x in zip(ys, xs):
        if visited[y, x]:
            continue
        components += 1
        queue: deque[tuple[int, int]] = deque([(int(y), int(x))])
        visited[y, x] = True
        while queue:
            cy, cx = queue.popleft()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    ny, nx = cy + dy, cx + dx
                    if (
                        0 <= ny < h
                        and 0 <= nx < w
                        and skeleton[ny, nx]
                        and not visited[ny, nx]
                    ):
                        visited[ny, nx] = True
                        queue.append((ny, nx))

    return {
        "total_pixels": total_pixels,
        "endpoints": endpoints,
        "junctions": junctions,
        "connected_components": components,
    }


# ---------------------------------------------------------------------------
# Visualization
# ---------------------------------------------------------------------------


def save_mask_image(mask: np.ndarray, output_path: Path) -> None:
    """Save a boolean mask as a white-on-black PNG."""
    img = Image.fromarray((mask.astype(np.uint8) * 255))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(output_path)


def draw_skeleton_overlay(
    image: Image.Image,
    skeleton: np.ndarray,
    dots: list[dict],
    output_path: Path,
) -> None:
    """Draw the skeleton in bright cyan over the original image, with dot
    centers marked in red for reference."""
    overlay = image.copy().convert("RGB")
    draw = ImageDraw.Draw(overlay)

    # Draw skeleton pixels.
    ys, xs = np.nonzero(skeleton)
    for y, x in zip(ys, xs):
        # Use a 1-pixel dot; for visibility on large images draw a small cross.
        draw.point((int(x), int(y)), fill=(0, 255, 200))

    # Mark dot centers.
    for dot in dots:
        cx, cy = dot["x"], dot["y"]
        r = 4
        draw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            outline=(255, 60, 60),
            width=2,
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(output_path)


# ---------------------------------------------------------------------------
# Per-image pipeline
# ---------------------------------------------------------------------------


def process_image(
    image_path: Path,
    detection: dict,
    args: argparse.Namespace,
) -> dict:
    """Run the full dot-masking and skeletonization pipeline for one image."""
    image = Image.open(image_path).convert("RGB")
    dots = detection["dots"]
    grid = detection["grid"]

    # Determine grid spacing (average of x and y spacing).
    spacing_x = grid.get("spacing_x", 0)
    spacing_y = grid.get("spacing_y", 0)
    grid_spacing = (spacing_x + spacing_y) / 2.0 if (spacing_x + spacing_y) > 0 else 40.0

    # --- Step 5: Create stroke mask and mask out dots -----------------------

    threshold = detection.get("threshold")
    detector = detection.get("detector", "classic")

    if threshold is not None and detector != "camera":
        stroke_mask = create_stroke_mask(image, threshold)
    else:
        # Camera images: use adaptive masking.
        stroke_mask = create_stroke_mask_adaptive(image)

    dot_masked = mask_dots(stroke_mask, dots, grid_spacing)

    # --- Morphological cleanup ----------------------------------------------

    # Scale morphological radii to image size / grid spacing.
    close_r = max(1, int(round(grid_spacing * 0.04)))
    open_r = max(1, int(round(grid_spacing * 0.02)))
    cleaned = clean_stroke_mask(dot_masked, close_radius=close_r, open_radius=open_r)

    # --- Step 6: Skeletonize ------------------------------------------------

    raw_skeleton = skeletonize_mask(cleaned)

    # Prune short dangling branches.
    prune_len = max(5, int(round(grid_spacing * 0.15)))
    skeleton = prune_short_branches(raw_skeleton, min_length=prune_len)

    # Remove tiny disconnected components (ghost dots, watermark fragments).
    min_comp = max(10, int(round(grid_spacing * 0.3)))
    skeleton = remove_small_components(skeleton, min_size=min_comp)

    # --- Save outputs -------------------------------------------------------

    stem = image_path.stem
    out = args.output_dir

    mask_path = out / f"{stem}_stroke_mask.png"
    skel_path = out / f"{stem}_skeleton.png"
    overlay_path = out / f"{stem}_skeleton_overlay.png"

    save_mask_image(cleaned, mask_path)
    save_mask_image(skeleton, skel_path)
    draw_skeleton_overlay(image, skeleton, dots, overlay_path)

    stats = skeleton_stats(skeleton)

    return {
        "image": str(image_path),
        "detector": detector,
        "threshold": threshold,
        "dot_count": len(dots),
        "grid_spacing": round(grid_spacing, 2),
        "morphology": {"close_radius": close_r, "open_radius": open_r},
        "prune_min_length": prune_len,
        "skeleton": stats,
        "outputs": {
            "stroke_mask": str(mask_path),
            "skeleton": str(skel_path),
            "skeleton_overlay": str(overlay_path),
        },
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Mask Kolam dots and skeletonize strokes (PoC Steps 5-6)."
    )
    parser.add_argument("images", nargs="+", type=Path, help="Input Kolam image(s).")
    parser.add_argument(
        "--detection-json",
        type=Path,
        default=Path("outputs/dot_detection_results.json"),
        help="Path to dot_detection_results.json from the previous stage.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("outputs"),
        help="Directory for output files.",
    )
    args = parser.parse_args()

    # Load previous detection results.
    if not args.detection_json.exists():
        print(f"Error: detection results not found at {args.detection_json}")
        print("Run detect_dots.py first.")
        raise SystemExit(1)

    detections = load_detection_results(args.detection_json)

    results: list[dict] = []
    for image_path in args.images:
        detection = find_result_for_image(detections, image_path)
        if detection is None:
            print(f"Warning: no detection results for {image_path.name}, skipping.")
            continue

        print(f"\nProcessing {image_path.name} ...")
        result = process_image(image_path, detection, args)
        results.append(result)

        stats = result["skeleton"]
        print(f"  detector:    {result['detector']}")
        print(f"  grid spacing: {result['grid_spacing']}")
        print(f"  skeleton pixels:      {stats['total_pixels']}")
        print(f"  endpoints:            {stats['endpoints']}")
        print(f"  junctions:            {stats['junctions']}")
        print(f"  connected components: {stats['connected_components']}")
        print(f"  stroke mask: {result['outputs']['stroke_mask']}")
        print(f"  skeleton:    {result['outputs']['skeleton']}")
        print(f"  overlay:     {result['outputs']['skeleton_overlay']}")

    # Save combined results.
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / "skeletonization_results.json"
    json_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\njson: {json_path}")


if __name__ == "__main__":
    main()
