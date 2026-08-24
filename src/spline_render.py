"""Option 2.1b rendering: one global centripetal Catmull-Rom spline per stroke.

Replaces the per-edge cubic Bezier rendering (2.1a) used by generate_novel.

Design (per the brief):
  1. PEN ORDER: strokes are traced by following port-to-port reciprocity edge
     by edge (tile pairings), never in solver/MRV/backtracking placement order.
  2. CENTRIPETAL Catmull-Rom (alpha = 0.5), never uniform -- uniform
     parametrization produces loops/cusps exactly where tile-boundary points
     and interior points are unevenly spaced.
  3. FIT ONCE on the fundamental-domain representative of each stroke orbit,
     then REPLICATE via the exact rotation/reflection transforms used for tile
     replication, so all symmetry copies stay bit-identical and seams never
     reappear.
  4. OUTPUT: one continuous SVG path string per stroke (cubic Bezier commands)
     -- exactly what getTotalLength()/stroke-dasharray animation needs.
  5. REGRESSION: verify rule 4 (closure) and rule 7 (reciprocity) still hold
     on the fitted spline geometry, and that smoothing introduced no gaps or
     spurious self-intersections.
"""

from __future__ import annotations

import math
from collections import Counter

from kolam_grammar import RECIPROCAL_PORT, bezier_for_edge
from hand_curves import hand_bezier_for_edge, get_compound_motif_type
from wfc_engine import _GROUP, _PORT_DIRECTION_DELTAS as DELTA, verify_assignment


# ---------------------------------------------------------------------------
# 1. Pen-order stroke tracing (port-to-port, tile-pairing following)
# ---------------------------------------------------------------------------

def trace_strokes(full: dict, size: int) -> list[dict]:
    """Trace every continuous stroke in pen order.

    Each dot's tile is a set of port pairs (e.g. STRAIGHT_EW = [[2,6]]).
    A strand that arrives at a dot through port p must leave through the
    paired port.  Following the pairings traces exactly what the pen draws
    (crossings are visited once per strand).  Returns a list of strokes,
    each {"steps": [(cell, arrive_port, leave_port, next_cell), ...]} forming
    a closed loop.
    """
    pairs: dict[tuple[int, int], dict[int, int]] = {}
    for cell, tile in full.items():
        d: dict[int, int] = {}
        for pr in tile:
            a, b = sorted(pr)
            d[a] = b
            d[b] = a
        pairs[cell] = d

    used: set[tuple[tuple[int, int], int]] = set()
    strokes: list[dict] = []
    for cell in full:
        for p in pairs[cell]:
            if (cell, p) in used:
                continue
            steps = []
            c, pin = cell, p
            while (c, pin) not in used:
                used.add((c, pin))
                q = pairs[c][pin]
                used.add((c, q))
                dr, dc = DELTA[q]
                nxt = (c[0] + dr, c[1] + dc)
                if not (0 <= nxt[0] < size and 0 <= nxt[1] < size):
                    break
                steps.append((c, pin, q, nxt))
                c = nxt
                pin = RECIPROCAL_PORT[q]
            if steps:
                strokes.append({"steps": steps})
    return strokes


def split_stroke_at_revisits(stroke: dict) -> list[dict]:
    """Split a traced loop into simple closed loops at revisited dots.

    A 2-pair tile lets a single traced loop pass through the same dot twice
    (once per strand). The centripetal spline then pinches into a spurious
    near-dot self-intersection. Cutting the loop at each revisited cell yields
    several closed loops that only *touch* at the crossing dot -- a legitimate
    kolam crossing instead of a spurious self-crossing. Each piece is a closed
    cycle in trace order, so rule-4 closure is preserved.
    """
    steps = stroke["steps"]
    n = len(steps)
    if n < 3:
        return [stroke]

    # find first cell that appears more than once in the step sequence
    seen: dict[tuple[int, int], int] = {}
    cut = None
    for i, s in enumerate(steps):
        c = s[0]
        if c in seen:
            cut = (seen[c], i)
            break
        seen[c] = i
    if cut is None:
        return [stroke]

    p, q = cut
    # sub-cycle A: steps[p..q-1] (starts and ends at cell c)
    a = steps[p:q]
    # sub-cycle B: steps[q..n-1] + steps[0..p-1] (also starts and ends at c)
    b = steps[q:] + steps[:p]
    pieces = [{"steps": a}, {"steps": b}]
    out: list[dict] = []
    for piece in pieces:
        out.extend(split_stroke_at_revisits(piece))
    return out


def stroke_cells(stroke: dict) -> set[tuple[int, int]]:
    return {s[0] for s in stroke["steps"]} | {s[3] for s in stroke["steps"]}


def _port_angle(port: int) -> float:
    """Compass angle in degrees for a port index (N=0, NE=45, ..., NW=315)."""
    return port * 45.0


def stroke_turn_stats(full: dict, size: int) -> dict:
    """Average turn angle across every joint of every traced stroke.

    At each step the stroke arrives through `pin` and leaves through `q`
    (the tile's pairing). The turn angle is the smallest angle between the
    incoming direction (reciprocal of pin) and the outgoing direction (q).
    Lower average = curves that flow straighter (the directional-continuity
    target). This is purely topological (port indices), independent of the
    spline geometry.
    """
    strokes = trace_strokes(full, size)
    joints = []
    per_stroke = []
    for st in strokes:
        angles = []
        for (_c, pin, q, _nxt) in st["steps"]:
            a = _port_angle(RECIPROCAL_PORT[pin])
            b = _port_angle(q)
            diff = abs(a - b)
            angles.append(min(diff, 360.0 - diff))
        if angles:
            joints.extend(angles)
            per_stroke.append(sum(angles) / len(angles))
    return {
        "strokes": len(strokes),
        "joints": len(joints),
        "mean_turn_deg": round(sum(joints) / len(joints), 2) if joints else 0.0,
        "per_stroke_mean_deg": [round(v, 2) for v in per_stroke],
    }


# ---------------------------------------------------------------------------
# 2. Raw points + centripetal Catmull-Rom (alpha = 0.5) -> cubic Bezier
# ---------------------------------------------------------------------------

def _eval_bezier(bez: dict, t: float) -> tuple[float, float]:
    p0, p1, p2, p3 = bez["P0"], bez["P1"], bez["P2"], bez["P3"]
    mt = 1.0 - t
    x = (mt ** 3) * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + (t ** 3) * p3[0]
    y = (mt ** 3) * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + (t ** 3) * p3[1]
    return (x, y)


def stroke_raw_points(
    stroke: dict,
    dot_xy: dict,
    spacing: float,
    samples_per_edge: int = 5,
    bow: float = 0.0,
    wide_map: dict | None = None,
    s_curve: float = 0.0,
    turn_scale: float = 1.0,
    use_hand_curves: bool = True,
    full: dict | None = None,
) -> list[tuple[float, float]]:
    """Concatenate each edge's raw curve points in trace order (closed loop).

    Pass-through steps ((leave_port - arrive_port) % 8 == 4, i.e. the strand
    runs straight across the dot -- connector-family tiles and boundary
    pass-throughs) get the guaranteed `s_curve` S-curve floor so they can
    never render dead straight (Prompt-4-P2).

    Turn steps (all non-pass-through steps, i.e. curve-family tiles) get the
    `turn_scale` sweep multiplier on BOTH of the step's edges (the incoming
    edge, rendered at the previous dot, and the outgoing edge), so the two
    S-curves meeting at the dot form a full petal around it (Prompt-4-P3).

    When `use_hand_curves=True` (default), the standard gap-1/2/3/4 edges
    use hand_bezier_for_edge (hand-authored control-point templates) instead
    of the fully parametric bezier_for_edge.  The wide embracing-arc paths
    still use bezier_for_edge (wide=True) regardless.
    """
    import math as _math
    tvals = [i / (samples_per_edge - 1) for i in range(samples_per_edge)]
    turn_edges: set[tuple[tuple[int, int], int]] = set()
    for (a, pin, q, b) in stroke["steps"]:
        if (q - pin) % 8 != 4:
            turn_edges.add((a, q))
            turn_edges.add((b, RECIPROCAL_PORT[q]))
    pts: list[tuple[float, float]] = []
    for (a, _pin_a, q, b) in stroke["steps"]:
        wide = bool(wide_map and (wide_map.get(a) or wide_map.get(b)))
        straight = (q - _pin_a) % 8 == 4
        ts = turn_scale if (a, q) in turn_edges else 1.0

        if use_hand_curves and not wide:
            # Compute bow side deterministically from midpoint grid position
            x1, y1 = dot_xy[a][0], dot_xy[a][1]
            x2, y2 = dot_xy[b][0], dot_xy[b][1]
            mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            dx, dy = x2 - x1, y2 - y1
            horizontal = abs(dx) >= abs(dy)
            key = round(my / spacing) if horizontal else round(mx / spacing)
            side = 1.0 if (key % 2 == 0) else -1.0
            # Determine if cell a or b is a compound tile motif
            tile_a = full.get(a, []) if full is not None else []
            comp_type = get_compound_motif_type(tile_a)
            bez = hand_bezier_for_edge(
                x1, y1, q,
                x2, y2, RECIPROCAL_PORT[q], spacing,
                bow=bow, wide=False,
                s_curve=s_curve if straight else 0.0,
                turn_scale=ts,
                side=side,
                compound_type=comp_type,
            )
        else:
            bez = bezier_for_edge(
                dot_xy[a][0], dot_xy[a][1], q,
                dot_xy[b][0], dot_xy[b][1], RECIPROCAL_PORT[q], spacing,
                bow=bow, wide=wide,
                s_curve=s_curve if straight else 0.0,
                turn_scale=ts,
            )
        for t in tvals:
            pts.append(_eval_bezier(bez, t))
    return pts


def centripetal_catmull_rom(
    pts: list[tuple[float, float]],
    alpha: float = 0.5,
) -> list[tuple[tuple[float, float], ...]]:
    """Fit ONE closed centripetal Catmull-Rom spline through pts.

    Returns cubic Bezier segments [(P0, P1, P2, P3), ...] (periodic wrap).
    alpha = 0.5 is the centripetal parametrisation: chord length ** 0.5,
    which is C1 even when the points are unevenly spaced.
    """
    n = len(pts)
    if n < 3:
        return []
    ext = [pts[-1]] + list(pts) + [pts[0], pts[1]]
    t = [0.0]
    for i in range(len(ext) - 1):
        dx = ext[i + 1][0] - ext[i][0]
        dy = ext[i + 1][1] - ext[i][1]
        t.append(t[-1] + (dx * dx + dy * dy) ** (alpha / 2.0))

    segments = []
    for i in range(n):
        s = 1 + i          # index of P_i in ext
        e = 2 + i          # index of P_{i+1} (wraps to P_0)
        p0 = ext[s]
        p3 = ext[e]
        # central-difference tangents in the centripetal parametrisation
        dt0 = t[s + 1] - t[s - 1]
        dt3 = t[e + 1] - t[e - 1]
        m0 = ((ext[s + 1][0] - ext[s - 1][0]) / dt0,
              (ext[s + 1][1] - ext[s - 1][1]) / dt0)
        m3 = ((ext[e + 1][0] - ext[e - 1][0]) / dt3,
              (ext[e + 1][1] - ext[e - 1][1]) / dt3)
        h = t[e] - t[s]
        p1 = (p0[0] + m0[0] * h / 3.0, p0[1] + m0[1] * h / 3.0)
        p2 = (p3[0] - m3[0] * h / 3.0, p3[1] - m3[1] * h / 3.0)
        segments.append((p0, p1, p2, p3))
    return segments


def segments_to_path(segments: list) -> str:
    """One continuous SVG path string from cubic Bezier segments."""
    if not segments:
        return ""
    p0 = segments[0][0]
    parts = [f"M {p0[0]:.6f} {p0[1]:.6f}"]
    for (c0, c1, c2, c3) in segments:
        parts.append(f"C {c1[0]:.6f} {c1[1]:.6f} "
                     f"{c2[0]:.6f} {c2[1]:.6f} "
                     f"{c3[0]:.6f} {c3[1]:.6f}")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# 3. Fit-once-then-replicate (fundamental-domain orbits)
# ---------------------------------------------------------------------------

def point_transform_for(tf, m: int, margin: float, spacing: float):
    """Rigid point transform (rotation/reflection about grid centre) induced
    by a group cell-transform tf: (r, c) -> (r', c')."""
    def f(x: float, y: float) -> tuple[float, float]:
        r = (y - margin) / spacing
        c = (x - margin) / spacing
        r2, c2 = tf(r, c, m)
        return (margin + c2 * spacing, margin + r2 * spacing)
    return f


def _canonical_cellset(cells, size: int, symmetry: str):
    m = size // 2
    best = None
    for tf, _perm in _GROUP[symmetry].values():
        im = tuple(sorted(tf(r, c, m) for (r, c) in cells))
        if best is None or im < best:
            best = im
    return best


def _find_group_transform(rep_cells, cells, size: int, symmetry: str):
    """Return the group cell-transform mapping rep_cells onto cells."""
    m = size // 2
    target = set(cells)
    for tf, _perm in _GROUP[symmetry].values():
        if {tf(r, c, m) for (r, c) in rep_cells} == target:
            return tf
    return None


def render_spline_paths(
    full: dict,
    size: int,
    symmetry: str,
    dot_xy: dict,
    spacing: float,
    margin: float,
    bow: float = 0.0,
    wide_map: dict | None = None,
    s_curve: float = 0.0,
    turn_scale: float = 1.0,
) -> tuple[list[str], dict]:
    """Fit one spline per fundamental-domain stroke orbit, replicate copies.

    Returns (svg_path_strings, meta) -- one path string per stroke copy.

    `wide_map` maps a grid cell (r, c) -> truthy when that cell's tile was
    chosen in its wide-footprint variant; edges incident on a wide cell get
    the wide embracing-arc control points. `meta["cells_per_path"]` records
    the ordered list of full-grid cells each emitted path passes through so
    callers can map a specific path back to the cells whose wide flag caused
    its sweep (used by the verified fallback in render_spline_paths_verified).

    `s_curve` (fraction of spacing) is the guaranteed S-curve floor for
    pass-through steps (Prompt-4-P2), applied through stroke_raw_points.
    `turn_scale` (>= 1, Prompt-4-P3) amplifies the sweep on turn edges
    (curve-family dot-enclosure tiles), forwarded to stroke_raw_points.
    """
    m = size // 2
    strokes = trace_strokes(full, size)
    # Split loops at revisited dots so a 2-pair tile renders as two paths that
    # cross at the dot (legitimate) instead of one path that spuriously
    # self-intersects next to it.
    strokes = [p for s in strokes for p in split_stroke_at_revisits(s)]

    # group strokes into symmetry orbits by canonical cell-set
    groups: dict[tuple, list[dict]] = {}
    for st in strokes:
        key = _canonical_cellset(stroke_cells(st), size, symmetry)
        groups.setdefault(key, []).append(st)

    paths: list[str] = []
    meta = {"strokes": len(strokes), "orbits": len(groups), "copies": 0,
            "points_per_stroke": [], "segments_per_stroke": [],
            "cells_per_path": []}
    for key, group in groups.items():
        rep = group[0]
        rep_cells = stroke_cells(rep)
        pts = stroke_raw_points(rep, dot_xy, spacing, bow=bow,
                                wide_map=wide_map, s_curve=s_curve,
                                turn_scale=turn_scale, full=full)
        segments = centripetal_catmull_rom(pts)
        meta["points_per_stroke"].append(len(pts))
        meta["segments_per_stroke"].append(len(segments))
        for st in group:
            tf = _find_group_transform(rep_cells, stroke_cells(st), size, symmetry)
            if tf is None:
                transformed = segments
            else:
                ptf = point_transform_for(tf, m, margin, spacing)
                transformed = [
                    tuple(ptf(px, py) for (px, py) in seg) for seg in segments
                ]
            paths.append(segments_to_path(transformed))
            meta["copies"] += 1
            meta["cells_per_path"].append(sorted(stroke_cells(st)))
    return paths, meta


def _fundamental_origin_map(size: int, symmetry: str) -> dict[tuple[int, int], tuple[int, int]]:
    """full-grid cell -> its fundamental-domain origin cell (reverse orbit)."""
    from wfc_engine import fundamental_orbit
    origin: dict[tuple[int, int], tuple[int, int]] = {}
    for f_cell, orbit in fundamental_orbit(size, symmetry).items():
        for (image, _perm) in orbit:
            origin[image] = f_cell
    return origin


def render_spline_paths_verified(
    full: dict,
    size: int,
    symmetry: str,
    dot_xy: dict,
    spacing: float,
    margin: float,
    bow: float = 0.0,
    wide_map: dict | None = None,
    s_curve: float = 0.0,
    turn_scale: float = 1.0,
    max_iterations: int = 6,
) -> tuple[list[str], dict, dict]:
    """Spline render with a guaranteed-clean wide-footprint fallback.

    Renders with the wide embracing-arc geometry, then detects any path with a
    *spurious* self-intersection (one that the tight geometry would not have)
    and flips the responsible fundamental cells from wide back to tight. The
    flip is targeted: `meta["cells_per_path"]` maps each offending path back to
    the full-grid cells it passes through, which are mapped to their
    fundamental origins and demoted. Re-renders and repeats until every path
    is clean or no more demotions are possible (bounded by max_iterations).

    `s_curve` (fraction of spacing) is the guaranteed S-curve floor for
    pass-through steps (Prompt-4-P2) and `turn_scale` (>= 1, Prompt-4-P3)
    amplifies the turn-edge sweep; both are forwarded to render_spline_paths.

    Returns (svg_path_strings, meta, wide_map_after). Crossing *between*
    distinct strands is intended and is never a trigger for demotion.
    """
    # Use the same detector as verify_spline_output so the demotion decision
    # and the acceptance gate cannot disagree (sampling + strict orientation
    # test, no near-tangent rejection, no uniform resampling).
    from wfc_engine import fundamental_orbit
    origin = _fundamental_origin_map(size, symmetry)
    orbits = fundamental_orbit(size, symmetry)
    wm = dict(wide_map or {})
    for _ in range(max_iterations):
        paths, meta = render_spline_paths(
            full, size, symmetry, dot_xy, spacing, margin,
            bow=bow, wide_map=wm, s_curve=s_curve, turn_scale=turn_scale,
        )
        demote: set[tuple[int, int]] = set()
        for idx, d in enumerate(paths):
            cells = meta["cells_per_path"][idx]
            wide_cells = [c for c in cells if wm.get(c)]
            if not wide_cells:
                continue
            pts = _path_to_samples(d, steps_per_segment=4)
            if len(pts) < 4 or _self_intersection_count(pts) == 0:
                continue
            for c in wide_cells:
                demote.add(origin.get(c, c))
        if not demote:
            return paths, meta, wm
        # demote the WHOLE orbit of every flagged fundamental cell: the spline
        # is fit once over the whole stroke, so a wide cell anywhere on the
        # stroke changes the entire curve -- the copy's cell list only reveals
        # orbit membership, so all images must go tight together.
        for f in demote:
            for (image, _perm) in orbits.get(f, [(f, None)]):
                wm.pop(image, None)
    # final pass after the demotion bound; accept the last clean state
    paths, meta = render_spline_paths(
        full, size, symmetry, dot_xy, spacing, margin,
        bow=bow, wide_map=wm, s_curve=s_curve, turn_scale=turn_scale,
    )
    return paths, meta, wm


# ---------------------------------------------------------------------------
# 4. SVG / PNG output for whole-path rendering
# ---------------------------------------------------------------------------

def render_svg_paths(
    width: int, height: int, paths: list[str],
    dots: list[tuple[float, float]], title: str, out_path,
) -> None:
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" style="background-color: #161616;">',
        f'  <title>{title}</title>',
        f'  <g fill="none" stroke="#f4ecd8" stroke-width="9" '
        f'stroke-linecap="round" stroke-linejoin="round">',
    ]
    for d in paths:
        lines.append(f'    <path d="{d}" />')
    lines.append('  </g>')
    lines.append('  <!-- Dot Lattice Grid -->')
    lines.append('  <g fill="#f4ecd8">')
    for cx, cy in dots:
        lines.append(f'    <circle cx="{cx:.2f}" cy="{cy:.2f}" r="6" />')
    lines.append('  </g>')
    lines.append('</svg>')
    import pathlib
    p = pathlib.Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(lines), encoding="utf-8")


def render_png_paths(
    width: int, height: int, paths: list[str],
    dots: list[tuple[float, float]], out_path,
) -> None:
    import pathlib
    p = pathlib.Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        # Preferred: render the literal SVG path via cairosvg (round caps/joins,
        # matches browser SVG exactly). Falls back to supersampled PIL below.
        import cairosvg
        lines = _svg_lines(width, height, paths, dots)
        cairosvg.svg2png(bytestring=("\n".join(lines)).encode("utf-8"),
                         write_to=str(p),
                         output_width=width, output_height=height)
        return
    except Exception:
        pass

    from PIL import Image, ImageDraw

    # Supersample fallback: rasterize the fitted path at 4x with dense sampling
    # and round joints, then LANCZOS-downsample. PIL's ImageDraw.line is not
    # anti-aliased and uses butt joints; at 24 samples/segment it produced a
    # serrated edge even though the underlying spline is C1-smooth. Drawing at
    # 4x with 240 steps/segment + joint="curve" removes that rasterization
    # artifact while keeping the exact same path geometry.
    SS = 4
    steps = 80
    W, H = width * SS, height * SS
    img = Image.new("RGB", (W, H), "#161616")
    draw = ImageDraw.Draw(img)
    for d in paths:
        pts = _path_to_samples(d, steps_per_segment=steps)
        scaled = [(x * SS, y * SS) for x, y in pts]
        draw.line(scaled, fill="#f4ecd8", width=8 * SS, joint="curve")
    for cx, cy in dots:
        r = 6 * SS
        draw.ellipse([cx * SS - r, cy * SS - r, cx * SS + r, cy * SS + r],
                     fill="#f4ecd8")
    img = img.resize((width, height), Image.LANCZOS)
    img.save(p)


def _svg_lines(
    width: int, height: int, paths: list[str],
    dots: list[tuple[float, float]],
) -> list[str]:
    """SVG source lines for a set of whole-path stroke strings + dot lattice."""
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" style="background-color: #161616;">',
        f'  <g fill="none" stroke="#f4ecd8" stroke-width="9" '
        f'stroke-linecap="round" stroke-linejoin="round">',
    ]
    for d in paths:
        lines.append(f'    <path d="{d}" />')
    lines.append('  </g>')
    lines.append('  <g fill="#f4ecd8">')
    for cx, cy in dots:
        lines.append(f'    <circle cx="{cx:.2f}" cy="{cy:.2f}" r="6" />')
    lines.append('  </g>')
    lines.append('</svg>')
    return lines


def _path_to_samples(d: str, steps_per_segment: int = 24):
    import re
    tokens = re.findall(r"[MC]|[-\d.]+", d)
    pts = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == "M":
            x, y = float(tokens[i + 1]), float(tokens[i + 2])
            pts.append((x, y))
            cur = (x, y)
            i += 3
        elif tok == "C":
            c1 = (float(tokens[i + 1]), float(tokens[i + 2]))
            c2 = (float(tokens[i + 3]), float(tokens[i + 4]))
            c3 = (float(tokens[i + 5]), float(tokens[i + 6]))
            for k in range(1, steps_per_segment + 1):
                t = k / steps_per_segment
                mt = 1 - t
                x = (mt ** 3) * cur[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t ** 3 * c3[0]
                y = (mt ** 3) * cur[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t ** 3 * c3[1]
                pts.append((x, y))
            cur = c3
            i += 7
        else:
            break
    return pts


# ---------------------------------------------------------------------------
# 5. Regression: rule 4 (closure), rule 7 (reciprocity) on the spline output
# ---------------------------------------------------------------------------

def _seg_intersect(p1, p2, p3, p4) -> bool:
    """True if segments p1-p2 and p3-p4 properly intersect."""
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1 = orient(p3, p4, p1)
    d2 = orient(p3, p4, p2)
    d3 = orient(p1, p2, p3)
    d4 = orient(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def _self_intersection_count(pts: list[tuple[float, float]]) -> int:
    """Vectorised all-pairs proper-intersection count for a closed polyline.

    Same orientation test as `_seg_intersect` (strict `>0` signs), same
    adjacency / shared-vertex skips as the original O(n^2) Python loop, but
    evaluated with numpy in per-row chunks so large strokes (21x21 ->
    ~7680 sampled points, 29M pairs) never materialise giant arrays in
    memory. Returns the number of spurious self-intersections.
    """
    import numpy as np

    n = len(pts)
    if n < 5:
        return 0
    P = np.asarray(pts, dtype=np.float64)          # (n, 2)
    A = P[:-1]                                     # segment starts  (n-1, 2)
    B = P[1:]                                      # segment ends
    # closed loop: last segment wraps pts[n-1] -> pts[0]
    A = np.vstack([A, P[-1:]])
    B = np.vstack([B, P[:1]])

    total = 0
    ROW = 512                                       # rows of `a` per chunk
    for a0 in range(0, n - 2, ROW):
        a = np.arange(a0, min(a0 + ROW, n - 2))
        # per-row b ranges: b in a+2 .. n-1, minus the (a==0, b==n-1) adjacency
        starts = a + 2
        lens = n - starts
        valid = lens > 0
        a_rows = a[valid]
        s_rows = starts[valid]
        l_rows = lens[valid]
        if len(a_rows) == 0:
            continue
        bb = np.concatenate([np.arange(s, n) for s in s_rows])
        aa = np.repeat(a_rows, l_rows)
        # drop (a==0, b==n-1): that's segment n-1 (closure) adjacent to seg 0
        drop = (aa == 0) & (bb == n - 1)
        aa, bb = aa[~drop], bb[~drop]
        if len(aa) == 0:
            continue
        pa, pb, qa, qb = A[aa], B[aa], A[bb], B[bb]

        # skip pairs sharing a vertex (incl. the closure point)
        shared = (pb == qa).all(axis=1) | (qb == pa).all(axis=1)
        pa, pb, qa, qb = pa[~shared], pb[~shared], qa[~shared], qb[~shared]
        if len(pa) == 0:
            continue

        d1 = (qa[:, 0] - pa[:, 0]) * (qb[:, 1] - pa[:, 1]) - (qa[:, 1] - pa[:, 1]) * (qb[:, 0] - pa[:, 0])
        d2 = (qa[:, 0] - pb[:, 0]) * (qb[:, 1] - pb[:, 1]) - (qa[:, 1] - pb[:, 1]) * (qb[:, 0] - pb[:, 0])
        d3 = (pa[:, 0] - qa[:, 0]) * (pb[:, 1] - qa[:, 1]) - (pa[:, 1] - qa[:, 1]) * (pb[:, 0] - qa[:, 0])
        d4 = (pa[:, 0] - qb[:, 0]) * (pb[:, 1] - qb[:, 1]) - (pa[:, 1] - qb[:, 1]) * (pb[:, 0] - qb[:, 0])

        cross = ((d1 > 0) != (d2 > 0)) & ((d3 > 0) != (d4 > 0))
        total += int(cross.sum())
    return total


def verify_spline_output(
    full: dict,
    size: int,
    paths: list[str],
    symmetry: str,
) -> dict:
    """Rule 4 / rule 7 regression checks on the fitted spline geometry."""
    report: dict = {}
    report["structural"] = {"rule7_reciprocity": len(verify_assignment(full, size)) == 0}

    # rule 4: closure -- every stroke path is a closed loop (start == end)
    closed = 0
    gaps = 0
    self_cross = 0
    for d in paths:
        pts = _path_to_samples(d, steps_per_segment=4)
        if len(pts) < 4:
            continue
        dx = pts[0][0] - pts[-1][0]
        dy = pts[0][1] - pts[-1][1]
        if math.hypot(dx, dy) < 1.0:
            closed += 1
        else:
            gaps += 1
        # spurious self-intersection (skip adjacent segments incl. wrap)
        self_cross += _self_intersection_count(pts)
    report["spline"] = {
        "paths": len(paths),
        "closed_loops": closed,
        "open_or_gapped": gaps,
        "spurious_self_intersections": self_cross,
    }
    # Observability only (not a pass/fail gate): how many lattice dots have at
    # least one line pass. Rule 4 in kolam_rules.py includes "every dot
    # enclosed"; the generator currently allows EMPTY cells, so this exposes
    # the coverage gap explicitly instead of silently implying it.
    enclosed = sum(1 for pairs in full.values() if pairs)
    report["dots_enclosed"] = {
        "count": enclosed,
        "total": size * size,
        "percent": round(100.0 * enclosed / (size * size), 1),
    }
    report["rule4_closure"] = gaps == 0 and closed == len(paths)
    report["rule7_on_spline"] = report["structural"]["rule7_reciprocity"] and self_cross == 0
    return report