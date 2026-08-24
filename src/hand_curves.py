"""Hand-curated curve templates & compound motif handlers for Kolam construction.

Supports:
  1. Base Single-Pass Motifs:
     - Gap 1: TIGHT_LOOP (hairpin)
     - Gap 2: OUTER_LOOP (teardrop)
     - Gap 3: WIDE_CURVE (sweeping arc)
     - Gap 4: STRAIGHT_PASS (interleaving S-bow)
  2. Compound Motifs (Multi-Pass Dot Tile Configurations):
     - DOUBLE_LOOP: Two independent non-crossing or concentric loops at a dot.
     - QUAD_JUNCTION: 4-way lattice crossing (two perpendicular straight passes).
     - TRIPLE_JUNCTION: 3-way junction combining pass-through and turning loop.
"""

from __future__ import annotations
import math

PORT_ANGLES_RAD = [
    -math.pi / 2,           # N   (0)
    -math.pi / 4,           # NE  (1)
    0.0,                    # E   (2)
    math.pi / 4,            # SE  (3)
    math.pi / 2,            # S   (4)
    3 * math.pi / 4,        # SW  (5)
    math.pi,                # W   (6)
    -3 * math.pi / 4,       # NW  (7)
]

OCT_R = 0.35

COMPOUND_MOTIFS = {
    "DOUBLE_LOOP": "Two non-crossing loops wrapping adjacent corners of a dot",
    "QUAD_JUNCTION": "4-port crossing (N<->S and E<->W or diagonal cross)",
    "TRIPLE_JUNCTION": "3-port junction connecting straight pass and loop",
}


def _port_xy(port: int) -> tuple[float, float]:
    a = PORT_ANGLES_RAD[port]
    return (OCT_R * math.cos(a), OCT_R * math.sin(a))


def _gap_between(port_a: int, port_b: int) -> int:
    return min((port_b - port_a) % 8, (port_a - port_b) % 8)


def get_compound_motif_type(port_pairs: list[list[int]]) -> str | None:
    """Classify compound motif configuration at a dot."""
    if len(port_pairs) < 2:
        return None
    
    pairs = [tuple(sorted(p)) for p in port_pairs]
    n = len(pairs)
    
    if n == 2:
        gaps = [_gap_between(p[0], p[1]) for p in pairs]
        if all(g == 4 for g in gaps):
            return "QUAD_JUNCTION"
        elif all(g <= 2 for g in gaps):
            return "DOUBLE_LOOP"
        else:
            return "TRIPLE_JUNCTION"
    elif n > 2:
        return "QUAD_JUNCTION"
    
    return None


def hand_bezier_for_edge(
    cx1: float, cy1: float, port_out: int,
    cx2: float, cy2: float, port_in: int,
    spacing: float,
    bow: float = 0.0,
    wide: bool = False,
    s_curve: float = 0.15,
    turn_scale: float = 1.0,
    side: float = 1.0,
    compound_type: str | None = None,
) -> dict:
    """Hand-curated cubic Bézier for a strand travelling between two dots.
    
    Adjusts control handles based on single-pass gap geometry and compound
    motif context (DOUBLE_LOOP, QUAD_JUNCTION, TRIPLE_JUNCTION).
    """
    a_out = PORT_ANGLES_RAD[port_out]
    a_in  = PORT_ANGLES_RAD[port_in]
    oct_r = spacing * OCT_R

    p0w = [cx1 + oct_r * math.cos(a_out), cy1 + oct_r * math.sin(a_out)]
    p3w = [cx2 + oct_r * math.cos(a_in),  cy2 + oct_r * math.sin(a_in)]

    gap = _gap_between(port_out, port_in)

    # Compound scale modifications
    if compound_type == "QUAD_JUNCTION":
        # Straighten crossings slightly to avoid collision near dot center
        s_curve = max(0.08, s_curve * 0.8)
    elif compound_type == "DOUBLE_LOOP":
        # Expand clearance for double loops
        turn_scale = turn_scale * 1.15

    # --- Gap 4: Straight Pass-Through ---
    if gap == 4:
        dx = p3w[0] - p0w[0]
        dy = p3w[1] - p0w[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            return {"P0": p0w, "P1": p0w, "P2": p3w, "P3": p3w}
        perp_x, perp_y = -dy / length, dx / length
        bow_eff = max(bow, s_curve * spacing)
        bow_off = bow_eff * side
        deflect = spacing * 0.14 * turn_scale
        p1 = [p0w[0] + dx * 0.33 + perp_x * (deflect + bow_off),
              p0w[1] + dy * 0.33 + perp_y * (deflect + bow_off)]
        p2 = [p0w[0] + dx * 0.67 + perp_x * (bow_off - deflect),
              p0w[1] + dy * 0.67 + perp_y * (bow_off - deflect)]
        return {"P0": p0w, "P1": p1, "P2": p2, "P3": p3w}

    # --- Curve-Family (Gap 1, 2, 3) ---
    mx = (p0w[0] + p3w[0]) / 2.0
    my = (p0w[1] + p3w[1]) / 2.0

    ARM = {1: 0.32, 2: 0.46, 3: 0.58}
    arm_frac = ARM.get(gap, 0.40) * spacing * turn_scale

    tx0 = math.cos(a_out)
    ty0 = math.sin(a_out)
    tx3 = math.cos(a_in)
    ty3 = math.sin(a_in)

    if gap == 1:
        # Tight Hairpin
        weight = 0.55
        p1 = [
            p0w[0] + tx0 * arm_frac * (1 - weight) + mx * weight * 0.35,
            p0w[1] + ty0 * arm_frac * (1 - weight) + my * weight * 0.35,
        ]
        p2 = [
            p3w[0] + tx3 * arm_frac * (1 - weight) + mx * weight * 0.35,
            p3w[1] + ty3 * arm_frac * (1 - weight) + my * weight * 0.35,
        ]
    elif gap == 2:
        # Teardrop Loop
        apex_pull = 0.48
        dx_chord = p3w[0] - p0w[0]
        dy_chord = p3w[1] - p0w[1]
        chord_len = math.hypot(dx_chord, dy_chord)
        if chord_len > 1e-6:
            px_perp = -dy_chord / chord_len
            py_perp = dx_chord / chord_len
        else:
            px_perp, py_perp = 0.0, 1.0
        apex_offset = chord_len * 0.35
        apx = mx + px_perp * apex_offset
        apy = my + py_perp * apex_offset
        p1 = [
            p0w[0] * (1 - apex_pull) + apx * apex_pull + tx0 * arm_frac * 0.38,
            p0w[1] * (1 - apex_pull) + apy * apex_pull + ty0 * arm_frac * 0.38,
        ]
        p2 = [
            p3w[0] * (1 - apex_pull) + apx * apex_pull + tx3 * arm_frac * 0.38,
            p3w[1] * (1 - apex_pull) + apy * apex_pull + ty3 * arm_frac * 0.38,
        ]
    else:
        # Wide Arc
        p1 = [p0w[0] + tx0 * arm_frac, p0w[1] + ty0 * arm_frac]
        p2 = [p3w[0] + tx3 * arm_frac, p3w[1] + ty3 * arm_frac]

    if wide:
        arm_wide = spacing * 0.55 * turn_scale
        p1 = [p0w[0] + tx0 * arm_wide, p0w[1] + ty0 * arm_wide]
        p2 = [p3w[0] + tx3 * arm_wide, p3w[1] + ty3 * arm_wide]

    return {"P0": p0w, "P1": p1, "P2": p2, "P3": p3w}
