"""Kolam Grammar & Constraint Rules Engine (Step 16).

Defines the mathematical rules governing valid Kolam construction:

1. PORT ADJACENCY: When a strand leaves port P of dot (r,c), it must arrive at
   the reciprocal port of the neighbouring dot in direction P.
   
        Port  Dir-offset  Reciprocal
        ----  ----------  ----------
        N(0)  (r-1, c  )  S(4)
        NE(1) (r-1, c+1)  SW(5)
        E(2)  (r,   c+1)  W(6)
        SE(3) (r+1, c+1)  NW(7)
        S(4)  (r+1, c  )  N(0)
        SW(5) (r+1, c-1)  NE(1)
        W(6)  (r,   c-1)  E(2)
        NW(7) (r-1, c-1)  SE(3)

2. EDGE CONSISTENCY: If port P of dot A is active, the reciprocal port of the
   adjacent dot B must also be active.

3. PORT PAIRING: At each dot, active ports must be paired (each strand enters
   and exits). Unpaired ports are invalid.

4. CLOSED LOOP: All strands must form closed loops (no dangling endpoints).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


# ---------------------------------------------------------------------------
# Port System Constants
# ---------------------------------------------------------------------------

PORT_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
NUM_PORTS = 8

# Direction offsets for each port: (delta_row, delta_col)
PORT_DIRECTION = [
    (-1,  0),   # N
    (-1,  1),   # NE
    ( 0,  1),   # E
    ( 1,  1),   # SE
    ( 1,  0),   # S
    ( 1, -1),   # SW
    ( 0, -1),   # W
    (-1, -1),   # NW
]

# Reciprocal port: if strand exits port P of dot A, it enters port RECIPROCAL[P]
# of the adjacent dot.
RECIPROCAL_PORT = [4, 5, 6, 7, 0, 1, 2, 3]  # N<->S, NE<->SW, E<->W, SE<->NW

# Port angles (radians, measured from positive-x CCW) for Bézier control point
# placement. N = -pi/2 (straight up), going clockwise.
PORT_ANGLES_RAD = [
    -math.pi / 2,          # N   (0)
    -math.pi / 4,          # NE  (1)
    0.0,                   # E   (2)
    math.pi / 4,           # SE  (3)
    math.pi / 2,           # S   (4)
    3 * math.pi / 4,       # SW  (5)
    math.pi,               # W   (6)
    -3 * math.pi / 4,      # NW  (7)
]


# ---------------------------------------------------------------------------
# Bézier Curve Templates
# ---------------------------------------------------------------------------

def bezier_for_edge(
    cx1: float, cy1: float, port_out: int,
    cx2: float, cy2: float, port_in: int,
    spacing: float,
    bow: float = 0.0,
    wide: bool = False,
    s_curve: float = 0.0,
    turn_scale: float = 1.0,
) -> dict:
    """Generate a cubic Bézier curve for a strand travelling between two dots.

    The curve starts at port_out on dot1 and arrives at port_in on dot2.
    Control handles are offset perpendicular to the dot-to-dot axis to
    create the characteristic smooth S-curves of traditional Kolam weave.

    `bow > 0` adds a lateral sweep of the whole curve toward one side (the
    adjacent empty cell), turning straight lattice passes into nested arcs.
    The bow side alternates deterministically with grid position so
    neighbouring edges interlock instead of forming grid lines.

    `wide=True` is the embracing-arc variant (Option B): the same port pair
    and endpoint octagon boundary, but control points extend much further
    from the cell centre (`deflect = 0.5 * spacing`, `bow = 0.42 * spacing`
    with a deterministic alternating side), producing a wide, embracing arc
    that sweeps through the adjacent cell before returning to the port. The
    port connectivity is identical -- this is purely a visual sweep layered
    on the same tile graph, so parity/rule-7 compliance is unchanged.

    `s_curve > 0` (fraction of spacing) is a guaranteed minimum lateral
    S-curve floor for pass-through segments (Prompt-4-P2): the effective bow
    is never smaller than `s_curve * spacing`, so connector runs and boundary
    pass-throughs can never render dead straight in any render mode. The bow
    side still alternates deterministically per grid position.

    `turn_scale > 1` (Prompt-4-P3) multiplies the perpendicular S-curve
    deflection for edges that turn around a dot (sweeping its enclosure, as
    opposed to straight pass-throughs). The two edges of a turn step are both
    scaled, so the dot sits inside a fuller, petal-shaped sweep. Port
    connectivity and endpoints are untouched -- legality is unchanged; the
    caller gates the scale by the verified self-intersection check.

    Returns dict with P0, P1, P2, P3 (each [x, y]).
    """
    oct_r = spacing * 0.35  # octagon boundary radius

    a_out = PORT_ANGLES_RAD[port_out]
    a_in = PORT_ANGLES_RAD[port_in]

    # Start / end on the octagon boundary of each dot
    p0 = [cx1 + oct_r * math.cos(a_out), cy1 + oct_r * math.sin(a_out)]
    p3 = [cx2 + oct_r * math.cos(a_in),  cy2 + oct_r * math.sin(a_in)]

    # Midpoint and perpendicular direction
    mx = (p0[0] + p3[0]) / 2
    my = (p0[1] + p3[1]) / 2
    dx = p3[0] - p0[0]
    dy = p3[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return {"P0": p0, "P1": p0, "P2": p3, "P3": p3}

    # Unit perpendicular
    px, py = -dy / length, dx / length

    # Handle deflection: perpendicular offset creates smooth S-curve
    # The offset magnitude scales with spacing for nice curvature.
    # turn_scale (P3) amplifies the sweep on dot-enclosure (turn) edges so
    # the curve-family tiles render full petals, not thin grazing arcs.
    deflect = spacing * 0.22 * turn_scale

    # Lateral bow: sweep the whole curve toward one side (empty cell).
    # The side alternates with grid position so adjacent edges interlock.
    if wide:
        # Wide embracing arc: much larger deflection and bow, alternating
        # side per grid position (deterministic, mirror-stable per cell).
        deflect = spacing * 0.50
        horizontal = abs(dx) >= abs(dy)
        key = round(my / spacing) if horizontal else round(mx / spacing)
        side = 1.0 if (key % 2 == 0) else -1.0
        bow_off = spacing * 0.42 * side
    elif bow > 0 or s_curve > 0:
        horizontal = abs(dx) >= abs(dy)
        key = round(my / spacing) if horizontal else round(mx / spacing)
        side = 1.0 if (key % 2 == 0) else -1.0
        target = max(bow, s_curve * spacing)
        bow_off = target * side
    else:
        bow_off = 0.0

    # Control handles: 1/3 and 2/3 along the path, offset perpendicular;
    # the bow offset is added to both handles so the whole curve sweeps.
    p1 = [p0[0] + dx * 0.33 + px * (deflect + bow_off),
          p0[1] + dy * 0.33 + py * (deflect + bow_off)]
    p2 = [p0[0] + dx * 0.67 + px * (bow_off - deflect),
          p0[1] + dy * 0.67 + py * (bow_off - deflect)]

    return {"P0": p0, "P1": p1, "P2": p2, "P3": p3}


def bezier_for_local_loop(
    cx: float, cy: float,
    port_a: int, port_b: int,
    spacing: float,
) -> dict:
    """Generate a Bézier curve for a local loop (teardrop) around a single dot.

    Used when two ports on the same dot are paired but don't have an
    outgoing edge — the strand loops around the outside of the dot.

    Returns dict with P0, P1, P2, P3 (each [x, y]).
    """
    oct_r = spacing * 0.38
    angle_a = PORT_ANGLES_RAD[port_a]
    angle_b = PORT_ANGLES_RAD[port_b]

    p0 = [cx + oct_r * math.cos(angle_a), cy + oct_r * math.sin(angle_a)]
    p3 = [cx + oct_r * math.cos(angle_b), cy + oct_r * math.sin(angle_b)]

    # The loop bulges outward from the dot
    gap = min((port_b - port_a) % 8, (port_a - port_b) % 8)
    mid_angle = (angle_a + angle_b) / 2
    if abs(angle_a - angle_b) > math.pi:
        mid_angle += math.pi

    # Bulge radius grows with gap
    bulge = oct_r * (0.8 + gap * 0.4)
    p1 = [cx + bulge * math.cos(mid_angle) + (p0[0] - cx) * 0.3,
          cy + bulge * math.sin(mid_angle) + (p0[1] - cy) * 0.3]
    p2 = [cx + bulge * math.cos(mid_angle) + (p3[0] - cx) * 0.3,
          cy + bulge * math.sin(mid_angle) + (p3[1] - cy) * 0.3]

    return {"P0": p0, "P1": p1, "P2": p2, "P3": p3}


def bezier_for_port_pair(
    cx: float, cy: float,
    port_a: int, port_b: int,
    spacing: float,
) -> dict:
    """Legacy wrapper — generates a local loop curve. Prefer bezier_for_edge
    for inter-dot strands."""
    return bezier_for_local_loop(cx, cy, port_a, port_b, spacing)



# ---------------------------------------------------------------------------
# Grid Neighbor Lookup
# ---------------------------------------------------------------------------

def get_neighbor(
    row: int, col: int, port: int,
    grid_rows: int, grid_cols: int,
    dot_grid: np.ndarray,
) -> tuple[int, int, int] | None:
    """Return (neighbor_row, neighbor_col, reciprocal_port) for a port,
    or None if the neighbor is off-grid or has no dot."""
    dr, dc = PORT_DIRECTION[port]
    nr, nc = row + dr, col + dc
    if 0 <= nr < grid_rows and 0 <= nc < grid_cols and dot_grid[nr, nc]:
        return nr, nc, RECIPROCAL_PORT[port]
    return None


# ---------------------------------------------------------------------------
# Symmetry Transforms (D4)
# ---------------------------------------------------------------------------

def apply_d4_symmetry(
    edge_set: set[tuple[int, int, int, int]],
    grid_rows: int,
    grid_cols: int,
) -> set[tuple[int, int, int, int]]:
    """Expand an edge set under the D4 dihedral symmetry group.
    
    Each edge is (r1, c1, r2, c2). We apply all 8 symmetry transforms
    (4 rotations x 2 reflections) of the grid.
    
    Only works correctly for square grids (grid_rows == grid_cols).
    """
    if grid_rows != grid_cols:
        # For non-square grids, apply D2 instead
        return apply_d2_symmetry(edge_set, grid_rows, grid_cols)
    
    n = grid_rows - 1  # max index
    full = set()
    
    for r1, c1, r2, c2 in edge_set:
        # Identity
        full.add((r1, c1, r2, c2))
        full.add((r2, c2, r1, c1))
        
        # 90-degree rotation: (r,c) -> (c, n-r)
        full.add((c1, n - r1, c2, n - r2))
        full.add((c2, n - r2, c1, n - r1))
        
        # 180-degree rotation: (r,c) -> (n-r, n-c)
        full.add((n - r1, n - c1, n - r2, n - c2))
        full.add((n - r2, n - c2, n - r1, n - c1))
        
        # 270-degree rotation: (r,c) -> (n-c, r)
        full.add((n - c1, r1, n - c2, r2))
        full.add((n - c2, r2, n - c1, r1))
        
        # Horizontal reflection: (r,c) -> (r, n-c)
        full.add((r1, n - c1, r2, n - c2))
        full.add((r2, n - c2, r1, n - c1))
        
        # Vertical reflection: (r,c) -> (n-r, c)
        full.add((n - r1, c1, n - r2, c2))
        full.add((n - r2, c2, n - r1, c1))
        
        # Diagonal reflection: (r,c) -> (c, r)
        full.add((c1, r1, c2, r2))
        full.add((c2, r2, c1, r1))
        
        # Anti-diagonal reflection: (r,c) -> (n-c, n-r)
        full.add((n - c1, n - r1, n - c2, n - r2))
        full.add((n - c2, n - r2, n - c1, n - r1))
    
    return full


def apply_d2_symmetry(
    edge_set: set[tuple[int, int, int, int]],
    grid_rows: int,
    grid_cols: int,
) -> set[tuple[int, int, int, int]]:
    """Expand an edge set under D2 (horizontal + vertical mirror)."""
    mr = grid_rows - 1
    mc = grid_cols - 1
    full = set()
    
    for r1, c1, r2, c2 in edge_set:
        # Identity
        full.add((r1, c1, r2, c2))
        full.add((r2, c2, r1, c1))
        
        # Horizontal mirror: (r,c) -> (r, mc-c)
        full.add((r1, mc - c1, r2, mc - c2))
        full.add((r2, mc - c2, r1, mc - c1))
        
        # Vertical mirror: (r,c) -> (mr-r, c)
        full.add((mr - r1, c1, mr - r2, c2))
        full.add((mr - r2, c2, mr - r1, c1))
        
        # Both: (r,c) -> (mr-r, mc-c)
        full.add((mr - r1, mc - c1, mr - r2, mc - c2))
        full.add((mr - r2, mc - c2, mr - r1, mc - c1))
    
    return full


# ---------------------------------------------------------------------------
# Port Rotation Mapping
# ---------------------------------------------------------------------------

# When we rotate the grid 90 degrees CW, ports rotate too:
# N->E, NE->SE, E->S, SE->SW, S->W, SW->NW, W->N, NW->NE
PORT_ROTATE_CW = [2, 3, 4, 5, 6, 7, 0, 1]

# Horizontal mirror: N->N, NE->NW, E->W, SE->SW, S->S, SW->SE, W->E, NW->NE
PORT_MIRROR_H = [0, 7, 6, 5, 4, 3, 2, 1]

# Vertical mirror: N->S, NE->SE, E->E, SE->NE, S->N, SW->NW, W->W, NW->SW
PORT_MIRROR_V = [4, 3, 2, 1, 0, 7, 6, 5]
