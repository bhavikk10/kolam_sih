"""Stroke Path Extraction and Primitive Boundary Detection for the Kolam pipeline.

This script implements PoC Steps 8 & 9:
  Step 8 — Trace continuous, non-branching stroke paths along the 1-pixel skeleton.
  Step 9 — Detect primitive boundaries and loop apexes for curve segmentation.

Reads:
  - outputs/local_octagons_results.json (or outputs/dot_detection_results.json)
  - outputs/<stem>_skeleton.png

Writes:
  - outputs/<stem>_segments_overlay.png (color-coded visualization of curve segments)
  - outputs/extracted_paths_results.json (structured JSON data of all path segments)
"""

from __future__ import annotations

import argparse
import colorsys
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class PathSegment:
    segment_id: int
    dot_index: int
    pixel_count: int
    start_point: tuple[int, int]  # (x, y)
    end_point: tuple[int, int]    # (x, y)
    points: list[list[int]]       # list of [x, y] coordinates in trace order
    is_loop: bool
    apex_point: list[int] | None = None


@dataclass
class ImagePathsResult:
    image: str
    dot_count: int
    skeleton_pixel_count: int
    segment_count: int
    segments: list[PathSegment]
    overlay: str


# ---------------------------------------------------------------------------
# Loading previous pipeline stage results
# ---------------------------------------------------------------------------

def load_octagons_results(json_path: Path) -> list[dict]:
    """Load octagon data from previous stage."""
    if not json_path.exists():
        return []
    text = json_path.read_text(encoding="utf-8")
    return json.loads(text)


def load_dots_fallback(json_path: Path) -> list[dict]:
    """Fallback: load dots from dot_detection_results.json."""
    if not json_path.exists():
        return []
    text = json_path.read_text(encoding="utf-8")
    return json.loads(text)


# ---------------------------------------------------------------------------
# Skeleton Graph Decomposition
# ---------------------------------------------------------------------------

NEIGHBORS = [
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1),           (0, 1),
    (1, -1),  (1, 0),  (1, 1),
]


def extract_skeleton_segments(
    skeleton: np.ndarray,
    dot_centers: np.ndarray,
    min_segment_length: int = 6,
) -> list[PathSegment]:
    """Decompose a 1-pixel skeleton into smooth continuous curve segments."""
    h, w = skeleton.shape
    ys, xs = np.nonzero(skeleton)
    skel_set = set(zip(ys, xs))
    
    if not skel_set:
        return []

    # 1. Compute pixel degrees
    degree_map = {}
    for y, x in skel_set:
        deg = sum((y + dy, x + dx) in skel_set for dy, dx in NEIGHBORS)
        degree_map[(y, x)] = deg

    junctions = set(pt for pt, deg in degree_map.items() if deg >= 3)
    regular_pixels = set(pt for pt, deg in degree_map.items() if deg <= 2)

    visited_regular = set()
    raw_paths: list[list[tuple[int, int]]] = []

    # 2. Walk regular branch lines
    for y, x in regular_pixels:
        if (y, x) in visited_regular:
            continue

        forward = [(y, x)]
        visited_regular.add((y, x))

        adj = [(y + dy, x + dx) for dy, dx in NEIGHBORS if (y + dy, x + dx) in skel_set]

        # Walk direction 1
        if len(adj) >= 1:
            curr = adj[0]
            prev = (y, x)
            while curr in regular_pixels and curr not in visited_regular:
                visited_regular.add(curr)
                forward.append(curr)
                next_step = None
                for dy, dx in NEIGHBORS:
                    cand = (curr[0] + dy, curr[1] + dx)
                    if cand in skel_set and cand != prev:
                        next_step = cand
                        break
                if next_step is None:
                    break
                prev = curr
                curr = next_step
            if curr in junctions:
                forward.append(curr)

        # Walk direction 2
        backward = []
        if len(adj) >= 2:
            curr = adj[1]
            prev = (y, x)
            while curr in regular_pixels and curr not in visited_regular:
                visited_regular.add(curr)
                backward.append(curr)
                next_step = None
                for dy, dx in NEIGHBORS:
                    cand = (curr[0] + dy, curr[1] + dx)
                    if cand in skel_set and cand != prev:
                        next_step = cand
                        break
                if next_step is None:
                    break
                prev = curr
                curr = next_step
            if curr in junctions:
                backward.append(curr)

        full_path = list(reversed(backward)) + forward
        if len(full_path) >= min_segment_length:
            raw_paths.append(full_path)

    # 3. Build PathSegment objects
    segments: list[PathSegment] = []
    for idx, path_yx in enumerate(raw_paths):
        pts_xy = [[int(x), int(y)] for y, x in path_yx]
        
        # Associate segment with nearest dot
        mid_idx = len(pts_xy) // 2
        mx, my = pts_xy[mid_idx]
        if len(dot_centers) > 0:
            dists = np.hypot(dot_centers[:, 0] - mx, dot_centers[:, 1] - my)
            nearest_dot = int(np.argmin(dists))
        else:
            nearest_dot = -1

        # Check if segment forms an outer loop (distance between endpoints is small)
        start_pt = pts_xy[0]
        end_pt = pts_xy[-1]
        chord_len = math.hypot(start_pt[0] - end_pt[0], start_pt[1] - end_pt[1])
        is_loop = len(pts_xy) > 60 and chord_len < len(pts_xy) * 0.40

        # Compute loop apex if applicable
        apex_pt = None
        if is_loop:
            arr = np.array(pts_xy, dtype=float)
            p_start = arr[0]
            chord = arr[-1] - p_start
            ch_len = float(np.hypot(chord[0], chord[1]))
            if ch_len > 1e-3:
                normal = np.array([-chord[1], chord[0]]) / ch_len
                dists_chord = np.abs(np.dot(arr - p_start, normal))
            else:
                dists_chord = np.hypot(arr[:, 0] - p_start[0], arr[:, 1] - p_start[1])
            apex_idx = int(np.argmax(dists_chord))
            apex_pt = pts_xy[apex_idx]

        segments.append(
            PathSegment(
                segment_id=idx + 1,
                dot_index=nearest_dot,
                pixel_count=len(pts_xy),
                start_point=(start_pt[0], start_pt[1]),
                end_point=(end_pt[0], end_pt[1]),
                points=pts_xy,
                is_loop=is_loop,
                apex_point=apex_pt,
            )
        )

    return segments


# ---------------------------------------------------------------------------
# Visualization
# ---------------------------------------------------------------------------

def draw_segments_overlay(
    image: Image.Image,
    segments: list[PathSegment],
    dot_centers: np.ndarray,
    output_path: Path,
) -> None:
    """Draw all extracted curve segments in distinct colors over the image."""
    overlay = image.copy()
    draw = ImageDraw.Draw(overlay)

    # Generate distinct HSV colors for each segment
    num_segs = max(1, len(segments))
    for i, seg in enumerate(segments):
        rgb = colorsys.hsv_to_rgb(i / num_segs, 0.95, 1.0)
        color = tuple(int(c * 255) for c in rgb)
        
        for pt in seg.points:
            x, y = pt[0], pt[1]
            draw.rectangle([x - 1, y - 1, x + 1, y + 1], fill=color)
        
        # Mark apex if available
        if seg.apex_point is not None:
            ax, ay = seg.apex_point[0], seg.apex_point[1]
            draw.ellipse([ax - 3, ay - 3, ax + 3, ay + 3], fill="#ffffff", outline=color)

    # Draw dot centers
    for idx, pt in enumerate(dot_centers):
        cx, cy = int(pt[0]), int(pt[1])
        draw.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill="#ffffff", outline="#000000", width=2)
        draw.text((cx + 6, cy - 6), f"D{idx}", fill="#ffff00")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(output_path)


# ---------------------------------------------------------------------------
# Pipeline Execution
# ---------------------------------------------------------------------------

def process_paths_for_image(
    image_path: Path,
    output_dir: Path,
) -> ImagePathsResult | None:
    stem = image_path.stem
    print(f"\nProcessing Paths for {image_path.name} ...")

    # 1. Load skeleton image
    skeleton_path = output_dir / f"{stem}_skeleton.png"
    if not skeleton_path.exists():
        print(f"  [ERROR] Skeleton file {skeleton_path} not found. Run skeletonize_strokes.py first.")
        return None

    skel_img = Image.open(skeleton_path).convert("L")
    skeleton = np.asarray(skel_img) > 128
    skel_pixel_count = int(skeleton.sum())

    # 2. Load dot locations
    oct_json = output_dir / "local_octagons_results.json"
    dot_json = output_dir / "dot_detection_results.json"
    
    dot_centers_list: list[list[float]] = []
    if oct_json.exists():
        oct_data = load_octagons_results(oct_json)
        for entry in oct_data:
            if Path(entry["image"]).stem == stem:
                dot_centers_list = [[o["dot_x"], o["dot_y"]] for o in entry.get("octagons", [])]
                break
    
    if not dot_centers_list and dot_json.exists():
        dot_data = load_dots_fallback(dot_json)
        for entry in dot_data:
            if Path(entry["image"]).stem == stem:
                dot_centers_list = [[d["x"], d["y"]] for d in entry.get("dots", [])]
                break

    dot_centers = np.array(dot_centers_list) if dot_centers_list else np.zeros((0, 2))

    # 3. Extract segments
    segments = extract_skeleton_segments(skeleton, dot_centers)
    print(f"  dots loaded:                 {len(dot_centers)}")
    print(f"  skeleton pixels:             {skel_pixel_count}")
    print(f"  curve segments extracted:    {len(segments)}")

    # 4. Visualization
    orig_img = Image.open(image_path).convert("RGB")
    overlay_path = output_dir / f"{stem}_segments_overlay.png"
    draw_segments_overlay(orig_img, segments, dot_centers, overlay_path)
    print(f"  segments overlay:            {overlay_path}")

    return ImagePathsResult(
        image=str(image_path),
        dot_count=len(dot_centers),
        skeleton_pixel_count=skel_pixel_count,
        segment_count=len(segments),
        segments=segments,
        overlay=str(overlay_path),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract continuous stroke paths from skeleton.")
    parser.add_argument("images", nargs="+", type=Path, help="Paths to Kolam images.")
    parser.add_argument("--output-dir", type=Path, default=Path("outputs"), help="Directory for outputs.")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    all_results: list[dict] = []

    for image_path in args.images:
        res = process_paths_for_image(image_path, args.output_dir)
        if res is not None:
            all_results.append(asdict(res))

    json_path = args.output_dir / "extracted_paths_results.json"
    json_path.write_text(json.dumps(all_results, indent=2), encoding="utf-8")
    print(f"\njson saved to: {json_path}")


if __name__ == "__main__":
    main()
