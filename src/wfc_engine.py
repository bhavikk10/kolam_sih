"""Wave-Function-Collapse / backtracking tile placement engine for Kolam.

Part 2 + 3 of the rules-based regeneration layer.

Given a square dot lattice, the engine places one canonical tile (from the
six-motif vocabulary in kolam_rules) on each dot such that:

  Rule 2  every line pass lands on a lattice edge midpoint (guaranteed by
          the 8-port model) and no midpoint is shared by more than two
          segments (guaranteed: each midpoint is used by at most one port
          per side).
  Rule 7  adjacent tiles agree on the shared corner: dot A uses port p
          pointing at dot B iff dot B uses the reciprocal port. This is the
          exact "shared-corner agreement" that preserves the single-line
          property.
  Rule 3  only canonical tile classes are placed.

Placement happens on the fundamental domain only (Part 3): a 1/symmetry
wedge of the grid. The full design is produced by replicating the wedge
under the declared symmetry group (D2 or D4), mapping ports with the
corresponding permutations. Replication is seam-free by construction: cells
lying on a mirror axis are constrained to tiles that are invariant under
that axis's port permutation.
"""

from __future__ import annotations

import random

PORT_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

RECIPROCAL_PORT = [4, 5, 6, 7, 0, 1, 2, 3]

# port permutations under lattice transforms
MIRROR_H = [0, 7, 6, 5, 4, 3, 2, 1]      # vertical mirror: (r, c) -> (r, 2m-c)
MIRROR_V = [4, 3, 2, 1, 0, 7, 6, 5]      # horizontal mirror: (r, c) -> (2m-r, c)
MIRROR_DIAG = [6, 5, 4, 3, 2, 1, 0, 7]   # main-diagonal mirror: (r, c) -> (c, r)
MIRROR_AD = [2, 1, 0, 7, 6, 5, 4, 3]     # anti-diagonal mirror: (r, c) -> (2m-c, 2m-r)
ROT_90 = [2, 3, 4, 5, 6, 7, 0, 1]        # 90 deg CW: (r, c) -> (c, 2m-r)
ROT_180 = [4, 5, 6, 7, 0, 1, 2, 3]
ROT_270 = [6, 7, 0, 1, 2, 3, 4, 5]

_ID_PERM = list(range(8))

_GROUP = {
    "D2": {
        "id": (lambda r, c, m: (r, c), _ID_PERM),
        "mirror_h": (lambda r, c, m: (r, 2 * m - c), MIRROR_H),
        "mirror_v": (lambda r, c, m: (2 * m - r, c), MIRROR_V),
        "rot_180": (lambda r, c, m: (2 * m - r, 2 * m - c), ROT_180),
    },
    "D4": {
        "id": (lambda r, c, m: (r, c), _ID_PERM),
        "rot_90": (lambda r, c, m: (c, 2 * m - r), ROT_90),
        "rot_180": (lambda r, c, m: (2 * m - r, 2 * m - c), ROT_180),
        "rot_270": (lambda r, c, m: (2 * m - c, r), ROT_270),
        "mirror_h": (lambda r, c, m: (r, 2 * m - c), MIRROR_H),
        "mirror_v": (lambda r, c, m: (2 * m - r, c), MIRROR_V),
        "mirror_diag": (lambda r, c, m: (c, r), MIRROR_DIAG),
        "mirror_ad": (lambda r, c, m: (2 * m - c, 2 * m - r), MIRROR_AD),
    },
}

_PORT_DIRECTION_DELTAS = [
    (-1, 0), (-1, 1), (0, 1), (1, 1),
    (1, 0), (1, -1), (0, -1), (-1, -1),
]


def apply_perm(pairs: frozenset, perm: list[int]) -> frozenset:
    out = frozenset(frozenset({perm[a], perm[b]}) for a, b in pairs)
    if isinstance(pairs, Tile):
        return Tile(out, wide=pairs.wide, base_name=pairs.base_name)
    return out


def tile_invariant(pairs: frozenset, perm: list[int]) -> bool:
    return apply_perm(pairs, perm) == pairs


# ---------------------------------------------------------------------------
# Wide-footprint tile variants (Option B: embracing-arc grammar)
# ---------------------------------------------------------------------------
# A "wide" variant of a base tile keeps the SAME port-pair frozenset (so the
# validated tile-graph -- reciprocity, parity gate, axis invariance -- is
# byte-for-byte identical and every existing consumer that iterates the tile
# works unchanged) but carries a `wide=True` rendering flag. At render time
# wide control points extend further from the cell centre, so the curve
# "reaches toward" the neighbouring dot/cell before returning to the correct
# port position: greater visual reach and more spatial crossings. The tight
# twin stays in the candidate list, so the solver can always fall back to the
# tight version (a render-time pass flips wide->tight for any tile whose wide
# sweep would cause a spurious spline self-intersection).

_WIDE_ELIGIBLE = {
    "STRAIGHT_NS", "STRAIGHT_EW", "STRAIGHT_NE_SW", "STRAIGHT_NW_SE",
} | {f"HAIRPIN_{k}" for k in range(8)} | {f"TEARDROP_{k}" for k in range(8)} | {f"WIDE_{k}" for k in range(8)}


class Tile(frozenset):
    """frozenset of port pairs plus rendering/vocabulary flags.

    Equality/hash are by content, so a wide twin is `==` its tight base and
    every structural consumer (reciprocity, axis invariance, trace, verify,
    psi families) treats them identically. `wide` only selects the extended
    control-point geometry at render time; `curved` marks a boundary tile
    whose pairs are all turns (no straight pass-through), used by the psi
    curvature preference (Prompt-4-P1 audit outcome: avoid boxy pass-through
    boundary tiles where the parity gate permits a curved alternative).
    """
    __slots__ = ("wide", "base_name", "curved")

    def __new__(cls, pairs, wide: bool = False, base_name: str | None = None,
                curved: bool = False):
        obj = super().__new__(cls, pairs)
        obj.wide = bool(wide)
        obj.base_name = base_name
        obj.curved = bool(curved)
        return obj


def tile_is_wide(tile) -> bool:
    return bool(getattr(tile, "wide", False))


def tile_is_curved(tile) -> bool:
    """True for a non-empty tile with no straight pass-through pair.

    A pass-through pair joins opposite ports ({p, p+4}): the strand runs
    straight across the dot. Tiles without any such pair sweep around the
    dot instead (hairpin / teardrop / wide turns) -- the curved boundary
    vocabulary the psi curvature preference rewards.
    """
    if not tile:
        return False
    return not any(tuple(p)[1] == _OPPOSITE_PORT[tuple(p)[0]] for p in tile)


# ---------------------------------------------------------------------------
# Canonical tile library
# ---------------------------------------------------------------------------

TILE_LIBRARY: dict[str, frozenset] = {}


def _add_tile(name: str, pair_list: list[list[int]]) -> None:
    TILE_LIBRARY[name] = frozenset(frozenset(p) for p in pair_list)


_add_tile("EMPTY", [])
_add_tile("STRAIGHT_NS", [[0, 4]])
_add_tile("STRAIGHT_EW", [[2, 6]])
_add_tile("STRAIGHT_NE_SW", [[1, 5]])
_add_tile("STRAIGHT_NW_SE", [[3, 7]])
for k in range(8):
    _add_tile(f"HAIRPIN_{k}", [[k, (k + 1) % 8]])
    _add_tile(f"TEARDROP_{k}", [[k, (k + 2) % 8]])
    _add_tile(f"WIDE_{k}", [[k, (k + 3) % 8]])
_add_tile("CROSS_PLUS", [[0, 4], [2, 6]])
_add_tile("CROSS_X", [[1, 5], [3, 7]])
_add_tile("DOUBLE_NS", [[0, 1], [4, 5]])
_add_tile("DOUBLE_EW", [[2, 3], [6, 7]])
_add_tile("DOUBLE_NESW", [[0, 1], [2, 3]])
_add_tile("DOUBLE_NWS", [[0, 7], [4, 3]])
_add_tile("DOUBLE_NE_SW", [[1, 2], [5, 6]])
_add_tile("DOUBLE_SE_NW", [[3, 4], [7, 0]])


# ---------------------------------------------------------------------------
# Boundary-aware grammar: EDGE_* / CORNER_* families
# ---------------------------------------------------------------------------
# Boundary cells expose fewer than 8 in-grid ports (edge=5, corner=3). Serving
# them from the filtered 8-port interior set starves even-parity edge cells:
# the parity gate + rule 3 leave almost no motif there (e.g. D4 (0,2) gets only
# TEARDROP_3), forcing EMPTY and dangling dots. Instead we enumerate the full
# rule-3-valid vocabulary over exactly the ports each boundary class exposes:
# disjoint port-pair sets with at most 2 pairs (<=4 active ports, "max two
# lines through a point"), invariant under the cell's axis stabiliser (same
# seam-free logic as `axis_perms`). Tiles stay raw frozensets, so replicate /
# trace / verify are name-agnostic and work unchanged.

_OPPOSITE_PORT = [4, 5, 6, 7, 0, 1, 2, 3]


def cell_available_ports(r: int, c: int, size: int) -> frozenset:
    """Ports whose neighbouring dot lies inside the grid."""
    return frozenset(
        p for p in range(8)
        if 0 <= r + DIR8[p][0] < size and 0 <= c + DIR8[p][1] < size
    )


def _pair_sets_on(avail: frozenset, max_pairs: int = 2) -> list[frozenset]:
    """All disjoint port-pair sets using only `avail`, up to `max_pairs` pairs
    (rule 3: at most two lines pass through one dot)."""
    ports = sorted(avail)
    pairs = [(a, b) for i, a in enumerate(ports) for b in ports[i + 1:]]
    results: set[frozenset] = set()
    for a, b in pairs:
        results.add(frozenset([frozenset({a, b})]))
    if max_pairs >= 2:
        for i, (a, b) in enumerate(pairs):
            for (c2, d) in pairs[i + 1:]:
                if len({a, b, c2, d}) < 4:
                    continue
                results.add(frozenset([frozenset({a, b}), frozenset({c2, d})]))
    return sorted(results, key=lambda t: (len(t), sorted(sorted(p) for p in t)))


def _tile_is_connector(pairs: frozenset) -> bool:
    """A straight through-pass: exactly one pair of opposite ports. Boundary
    tiles are classified structurally so the parity gate (connectors on odd
    cells, motifs on even cells) extends to the new families."""
    if len(pairs) != 1:
        return False
    (p,) = tuple(pairs)
    a, b = tuple(p)
    return b == _OPPOSITE_PORT[a]


_BOUNDARY_TILE_CACHE: dict[tuple, list[frozenset]] = {}


def boundary_tiles_for(
    avail: frozenset,
    req_perms: list[list[int]],
    max_pairs: int = 1,
) -> list[frozenset]:
    """Rule-3-valid tiles on `avail` invariant under every required perm.

    `max_pairs` caps the number of strands through the dot. Boundary cells
    default to 1 pair: a 2-pair boundary tile lets the same traced loop visit
    the dot twice, and the centripetal spline then pinches into a spurious
    near-dot self-intersection (regression `cross` fails). Single-strand
    hairpins / teardrops / wides still give the boundary dot real motif
    options without that risk.
    """
    key = (tuple(sorted(avail)), tuple(tuple(p) for p in req_perms), max_pairs)
    if key not in _BOUNDARY_TILE_CACHE:
        tiles = [
            t for t in _pair_sets_on(frozenset(avail), max_pairs=max_pairs)
            if all(tile_invariant(t, perm) for perm in req_perms)
        ]
        _BOUNDARY_TILE_CACHE[key] = tiles
    return _BOUNDARY_TILE_CACHE[key]


def uses_port(pairs: frozenset, port: int) -> bool:
    return any(port in p for p in pairs)


# ---------------------------------------------------------------------------
# Grid / fundamental domain geometry
# ---------------------------------------------------------------------------

DIR8 = _PORT_DIRECTION_DELTAS


def grid_cells(size: int) -> list[tuple[int, int]]:
    return [(r, c) for r in range(size) for c in range(size)]


def fundamental_domain(size: int, symmetry: str) -> list[tuple[int, int]]:
    m = size // 2
    cells = []
    for r, c in grid_cells(size):
        if symmetry == "D4":
            if r <= m and c <= m and r <= c:
                cells.append((r, c))
        elif symmetry == "D2":
            if r <= m and c <= m:
                cells.append((r, c))
        else:
            raise ValueError(f"unsupported symmetry {symmetry}")
    return cells


def fundamental_orbit(
    size: int, symmetry: str
) -> dict[tuple[int, int], list[tuple[tuple[int, int], list[int]]]]:
    """For each fundamental cell, its full orbit under the symmetry group.

    Returns { f_cell: [(image_cell, port_perm)] } where port_perm carries the
    fundamental tile to the image cell. Image cells are deduplicated (several
    group elements can map a cell onto the same image).
    """
    m = size // 2
    group = _GROUP[symmetry]
    orbits: dict[tuple[int, int], list[tuple[tuple[int, int], list[int]]]] = {}
    for cell in fundamental_domain(size, symmetry):
        seen: dict[tuple[int, int], list[int]] = {}
        for _, (tf, perm) in group.items():
            nr, nc = tf(cell[0], cell[1], m)
            seen[(nr, nc)] = perm
        orbits[cell] = list(seen.items())
    return orbits


def _compose(p: list[int], q: list[int]) -> list[int]:
    """Composition p after q: port i -> p[q[i]]."""
    return [p[q[i]] for i in range(8)]


def _inverse(p: list[int]) -> list[int]:
    inv = [0] * 8
    for i, v in enumerate(p):
        inv[v] = i
    return inv


def axis_invariant_perms(size: int, symmetry: str) -> dict[tuple[int, int], list[list[int]]]:
    """Port permutations a fundamental cell must be invariant under (seam-free).

    A fundamental cell f is written to each of its orbit images with a path
    port-permutation `path`. If an image cell is fixed by a group element t,
    the tile at the image is invariant under t, which pulls back to f as
    invariance under the conjugate  path^{-1} . t . path. Enforcing these
    conjugates makes replication seam-free by construction.
    """
    m = size // 2
    group = _GROUP[symmetry]
    perms: dict[tuple[int, int], list[list[int]]] = {}
    for cell, orbit in fundamental_orbit(size, symmetry).items():
        fixing: list[list[int]] = []
        for (ir, ic), path in orbit:
            path_inv = _inverse(path)
            for _, (tf, perm) in group.items():
                nr, nc = tf(ir, ic, m)
                if nr == ir and nc == ic:
                    conj = _compose(path_inv, _compose(perm, path))
                    if conj not in fixing:
                        fixing.append(conj)
        if len(fixing) > 1:
            perms[cell] = fixing
    return perms


# ---------------------------------------------------------------------------
# WFC solver (backtracking + minimum-remaining-values)
# ---------------------------------------------------------------------------

def neighbors_consistent(
    assign: dict[tuple[int, int], frozenset],
    cell: tuple[int, int],
    candidate: frozenset,
    size: int,
) -> bool:
    r, c = cell
    for port in range(8):
        dr, dc = DIR8[port]
        nr, nc = r + dr, c + dc
        if not (0 <= nr < size and 0 <= nc < size):
            continue
        nb = (nr, nc)
        if nb not in assign:
            continue
        rp = RECIPROCAL_PORT[port]
        if uses_port(candidate, port) != uses_port(assign[nb], rp):
            return False
    return True


def _cell_candidates(
    cell: tuple[int, int],
    size: int,
    axis_perms: dict,
    allow_classes: set[str],
    connector_classes: set[str],
    parity_gate: bool,
    use_boundary_grammar: bool,
    boundary_max_pairs: int,
    wide_bias: bool = True,
) -> list[frozenset]:
    """Valid tiles for one fundamental cell (Prompt 1 vocabulary).

    Boundary cells use the class-specific EDGE_/CORNER_ enumeration; interior
    cells use the canonical library. Both are filtered by the parity gate
    (connectors on odd cells, motifs on even cells) and per-cell axis
    invariance. EMPTY is always available last.

    `wide_bias=True` also offers the wide-footprint variant of every eligible
    interior tile (same port pairs, `wide=True` rendering flag), so the solver
    can prefer wider sweeps when the topology allows.
    """
    r, c = cell
    in_bounds = lambda port: (  # noqa: E731
        0 <= r + DIR8[port][0] < size and 0 <= c + DIR8[port][1] < size
    )
    empty = [TILE_LIBRARY["EMPTY"]]
    avail = cell_available_ports(r, c, size)
    if use_boundary_grammar and len(avail) < 8:
        out: list[frozenset] = []
        for t in boundary_tiles_for(avail, axis_perms.get(cell, []),
                                    boundary_max_pairs):
            if _tile_is_connector(t):
                # connectors only on odd cells when the parity gate is on
                if parity_gate and (r + c) % 2 == 0:
                    continue
            elif parity_gate and (r + c) % 2 == 1:
                # motifs only on even cells when the parity gate is on
                continue
            # mark curved boundary tiles (no straight pass-through pair) so
            # the psi curvature preference can reward them over boxy
            # pass-throughs on parity-permissive cells (Prompt-4-P1)
            if tile_is_curved(t):
                out.append(Tile(t, curved=True))
            else:
                out.append(t)
        if not out:
            return empty
        return out + empty
    out = []
    for name, pairs in TILE_LIBRARY.items():
        if name not in allow_classes:
            continue
        if name in connector_classes:
            # connectors only on odd cells when the parity gate is on
            if parity_gate and (r + c) % 2 == 0:
                continue
        elif parity_gate and (r + c) % 2 == 1:
            # motifs only on even cells when the parity gate is on
            continue
        if any(not in_bounds(p) for pr in pairs for p in pr):
            continue
        if cell in axis_perms and not all(
            tile_invariant(pairs, perm) for perm in axis_perms[cell]
        ):
            continue
        out.append(pairs)
        if wide_bias and name in _WIDE_ELIGIBLE:
            out.append(Tile(pairs, wide=True, base_name=name))
    if not out:
        return empty
    return out + empty


def _add_connectivity_flow(
    model,
    cell_var,
    enc,
    fundamental: list[tuple[int, int]],
    size: int,
    symmetry: str,
    cand_lists: list[list[frozenset]],
    cp_model,
) -> None:
    """Rule-4 connectivity as native single-commodity flow over the full grid.

    Replication copies of a connected fundamental stroke are *not* connected
    by default -- orbit copies must link across seams -- so the flow network is
    built on the replicated full grid. For every full-grid cell g:

      - port_used[g, p] is a BoolVar, functionally dependent on the origin
        fundamental IntVar (table constraint per port),
      - edge_active[u, v] is the AND of port_used on both ends,
      - a directed integer flow f[u, v] is bounded by edge_active[u, v].

    A chosen root cell is forced non-empty, and every other non-empty cell has
    net inflow >= 1. Single-commodity flow with unit demands at every non-root
    non-empty cell is feasible iff every such cell has a path to the root --
    i.e. the active-edge graph is a single connected component (rule 4). The
    solver therefore either produces a single-stroke assignment or proves none
    exists (INFEASIBLE): a decisive answer.
    """
    full_cells = [(r, c) for r in range(size) for c in range(size)]
    orbit = fundamental_orbit(size, symmetry)
    origin_of: dict[tuple[int, int], tuple[int, list[int]]] = {}
    for f_idx, fc in enumerate(fundamental):
        for (ir, ic), perm in orbit[fc]:
            origin_of[(ir, ic)] = (f_idx, perm)

    # root: the first fundamental cell that has a non-empty candidate
    root_f = next(
        i for i, cl in enumerate(cand_lists) if any(t for t in cl)
    )
    root_cell = fundamental[root_f]

    # port_used[g, p]: BoolVar = whether the tile placed at full cell g uses
    # port p, as a function of the origin fundamental IntVar.
    pu: dict[tuple[tuple[int, int], int], object] = {}
    for g in full_cells:
        f_idx, perm = origin_of[g]
        cl = cand_lists[f_idx]
        for p in range(8):
            b = model.NewBoolVar(f"pu_{g[0]}_{g[1]}_{p}")
            rows = []
            for v, tile in enumerate(cl):
                used = {perm[q] for pr in tile for q in pr}
                rows.append((v, 1 if p in used else 0))
            model.AddAllowedAssignments([cell_var[f_idx], b], rows)
            pu[(g, p)] = b

    # root non-empty anchors the flow (single component around it)
    model.Add(enc[root_f] == 1)

    K = size * size
    flow: dict[tuple[tuple[int, int], tuple[int, int]], object] = {}
    for (r, c) in full_cells:
        for p in range(8):
            nr, nc = r + DIR8[p][0], c + DIR8[p][1]
            if not (0 <= nr < size and 0 <= nc < size):
                continue
            u, v = (r, c), (nr, nc)
            rp = RECIPROCAL_PORT[p]
            a = model.NewBoolVar(f"ea_{r}_{c}_{nr}_{nc}")
            model.Add(a <= pu[(u, p)])
            model.Add(a <= pu[(v, rp)])
            model.Add(a >= pu[(u, p)] + pu[(v, rp)] - 1)
            fl = model.NewIntVar(0, K, f"f_{r}_{c}_{nr}_{nc}")
            model.Add(fl <= K * a)
            flow[(u, v)] = fl

    # every non-root non-empty cell must have net inflow >= 1 (path to root)
    for g in full_cells:
        if g == root_cell:
            continue
        f_idx, _ = origin_of[g]
        inflow = sum(flow[(w, g)] for w in full_cells if (w, g) in flow)
        outflow = sum(flow[(g, w)] for w in full_cells if (g, w) in flow)
        model.Add(inflow - outflow >= enc[f_idx])


def solve(
    size: int,
    symmetry: str = "D4",
    parity_gate: bool = True,
    allow_classes: set[str] | None = None,
    seed: int = 42,
    max_backtracks: int = 200_000,
    connectivity_sticky: bool = True,
    flow_bias: bool = True,
    psi_bias: bool = True,
    wide_bias: bool = True,
    curved_bias: bool = True,
    require_single_stroke: bool = False,
    use_boundary_grammar: bool = True,
    boundary_max_pairs: int = 2,
    time_limit_seconds: float = 30.0,
) -> dict[tuple[int, int], frozenset]:
    """Place tiles on the fundamental domain via OR-Tools CP-SAT, then replicate.

    Reformulates Prompt 1's per-class tile vocabulary as a constraint
    satisfaction problem solved *jointly* rather than by heuristic
    backtracking:

      - one IntVar per fundamental cell over its valid candidate list
      - parity gate + per-cell axis invariance are baked into the candidate
        lists (they hold exactly for every value a variable can take)
      - pairwise port-reciprocity between every adjacent fundamental-cell pair
        is an AddAllowedAssignments table constraint
      - dots_enclosed (non-empty cells on the replicated full grid, i.e.
        sum over fundamental cells of enc[i] * |orbit(i)|) is the MAXIMIZE
        objective. An OPTIMAL result proves the maximum achievable coverage;
        if that maximum is below the full dot count, 100% coverage is provably
        infeasible -- a decisive answer the old backtracker could not give
        (it could not distinguish "infeasible" from "search missed it").

    require_single_stroke=True enforces rule 4 natively: a single-commodity
    flow over the replicated full grid is added to the model (every non-root
    non-empty cell has net inflow >= 1 from the root), so the solver either
    returns a connected single-stroke design or proves none exists (CP-SAT
    INFEASIBLE) -- a decisive answer rather than a heuristic miss.

    `max_backtracks`, `connectivity_sticky` and `flow_bias` are accepted for
    interface compatibility with the previous backtracking solver but have no
    effect on the CP-SAT model: the parity gate, axis invariance and
    reciprocity constraints are enforced exactly regardless of heuristic knobs.

    `psi_bias` (default True) adds the heuristic motif-transition scorer
    (src/motif_psi) as a lexicographic SECONDARY objective: coverage
    (dots_enclosed) remains the primary objective, so psi only selects among
    coverage-optimal solutions. It encodes two expert heuristics -- reward
    varied motif-family transitions and penalise abrupt connector<->crossing
    seams -- mirroring the role `flow_bias` played in the retired backtracker
    (it influences WHICH valid solution is found, never WHETHER one exists).
    Set psi_bias=False to return the plain coverage-optimal solution.
    """
    from ortools.sat.python import cp_model

    fundamental = fundamental_domain(size, symmetry)
    axis_perms = axis_invariant_perms(size, symmetry)

    if allow_classes is None:
        allow_classes = set(TILE_LIBRARY)
    connector_classes = {
        "STRAIGHT_NS", "STRAIGHT_EW", "STRAIGHT_NE_SW", "STRAIGHT_NW_SE",
    }

    cand_lists = [
        _cell_candidates(cell, size, axis_perms, allow_classes,
                         connector_classes, parity_gate,
                         use_boundary_grammar, boundary_max_pairs,
                         wide_bias=wide_bias)
        for cell in fundamental
    ]

    model = cp_model.CpModel()
    cell_var = [
        model.NewIntVar(0, len(cl) - 1, f"cell_{r}_{c}")
        for (r, c), cl in zip(fundamental, cand_lists)
    ]
    enc = [model.NewBoolVar(f"enc_{r}_{c}") for (r, c) in fundamental]

    # dots_enclosed: enc[i] == 1 iff cell i picks a non-empty tile
    for i, cl in enumerate(cand_lists):
        allowed = ([(v, 1) for v, t in enumerate(cl) if t]
                   + [(v, 0) for v, t in enumerate(cl) if not t])
        model.AddAllowedAssignments([cell_var[i], enc[i]], allowed)

    # pairwise port-reciprocity between every adjacent fundamental-cell pair
    index_of = {cell: i for i, cell in enumerate(fundamental)}
    seen_pairs: set[tuple[int, int]] = set()
    for i, (r, c) in enumerate(fundamental):
        for p in range(8):
            nr, nc = r + DIR8[p][0], c + DIR8[p][1]
            j = index_of.get((nr, nc))
            if j is None or j == i:
                continue
            a, b = (i, j) if i < j else (j, i)
            if (a, b) in seen_pairs:
                continue
            seen_pairs.add((a, b))
            # port leaving cell a toward cell b
            if a == i:
                pp = p
            else:
                pp = RECIPROCAL_PORT[p]
            rp = RECIPROCAL_PORT[pp]
            allowed = [
                (vi, vj)
                for vi, ti in enumerate(cand_lists[a])
                for vj, tj in enumerate(cand_lists[b])
                if uses_port(ti, pp) == uses_port(tj, rp)
            ]
            model.AddAllowedAssignments([cell_var[a], cell_var[b]], allowed)

    # dots_enclosed: enc[i] == 1 iff cell i picks a non-empty tile.
    # The visible metric counts non-empty cells on the replicated FULL grid,
    # so the objective is weighted by orbit size: each fundamental cell fills
    # exactly |orbit| full-grid cells when it is non-empty.
    orbit = fundamental_orbit(size, symmetry)
    orbit_weight = [len(orbit[cell]) for cell in fundamental]
    coverage_expr = sum(enc[i] * orbit_weight[i] for i in range(len(fundamental)))

    psi_expr = None
    if psi_bias:
        # psi secondary objective: coverage is kept primary by a two-phase
        # solve (phase 1 maximises coverage; phase 2 pins coverage to its
        # optimum and maximises psi among those solutions). A small bonus
        # per wide variant makes the solver prefer wider sweeps among
        # coverage-optimal assignments; a smaller bonus per curved boundary
        # tile steers even-parity boundary cells away from boxy straight
        # pass-throughs toward the curved vocabulary (Prompt-4-P1 audit).
        from motif_psi import add_psi_secondary_objective
        psi_expr = add_psi_secondary_objective(model, cell_var, cand_lists,
                                               fundamental,
                                               wide_bonus=40 if wide_bias else 0,
                                               curved_bonus=35 if curved_bias else 0)

    model.Maximize(coverage_expr)

    if require_single_stroke:
        # native rule-4 connectivity (single-commodity flow on the full grid)
        _add_connectivity_flow(model, cell_var, enc, fundamental, size, symmetry,
                               cand_lists, cp_model)

    solver = cp_model.CpSolver()
    solver.parameters.random_seed = seed
    solver.parameters.max_time_in_seconds = time_limit_seconds

    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError(
            f"no solution for size={size} symmetry={symmetry} "
            f"parity_gate={parity_gate} single_stroke={require_single_stroke} "
            f"(CP-SAT status {solver.StatusName(status)})"
        )

    if psi_bias:
        # phase 2: pin coverage to its optimum, then maximise psi among the
        # coverage-optimal assignments (true lexicographic refinement).
        model.Add(coverage_expr == int(round(solver.ObjectiveValue())))
        model.Maximize(psi_expr)
        status2 = solver.Solve(model)
        if status2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            raise RuntimeError(
                f"psi refinement failed for size={size} symmetry={symmetry} "
                f"(CP-SAT status {solver.StatusName(status2)})"
            )

    assign = {
        cell: cand_lists[i][solver.Value(cell_var[i])]
        for i, cell in enumerate(fundamental)
    }
    return replicate(assign, size, symmetry)


def replicate(
    assign: dict[tuple[int, int], frozenset],
    size: int,
    symmetry: str,
) -> dict[tuple[int, int], frozenset]:
    """Replicate the fundamental-domain assignment to the whole grid via orbits."""
    full: dict[tuple[int, int], frozenset] = {}
    for cell, pairs in assign.items():
        for (ir, ic), perm in fundamental_orbit(size, symmetry)[cell]:
            full[(ir, ic)] = apply_perm(pairs, perm)
    return full


def verify_assignment(full: dict[tuple[int, int], frozenset], size: int) -> list[dict]:
    """Verify edge consistency of a full assignment; return violations."""
    viol = []
    for (r, c), pairs in full.items():
        for port in range(8):
            dr, dc = DIR8[port]
            nr, nc = r + dr, c + dc
            if not (0 <= nr < size and 0 <= nc < size):
                continue
            nb = (nr, nc)
            rp = RECIPROCAL_PORT[port]
            if uses_port(pairs, port) != uses_port(full[nb], rp):
                viol.append(
                    {
                        "cell": [r, c],
                        "neighbor": [nr, nc],
                        "port": PORT_NAMES[port],
                        "reciprocal": PORT_NAMES[rp],
                    }
                )
    return viol


def component_stats(
    full: dict[tuple[int, int], frozenset], size: int
) -> dict:
    """Connected-component analysis of the stroke graph (rule 4).

    Dots with an active port form a graph edge to the reciprocal neighbor.
    Because every library tile uses an even number of ports, every dot on a
    stroke has degree >= 2, so a single component means one continuous closed
    stroke with every dot enclosed.
    """
    edges: set[frozenset] = set()
    for (r, c), pairs in full.items():
        used = {p for pr in pairs for p in pr}
        for p in used:
            dr, dc = DIR8[p]
            nr, nc = r + dr, c + dc
            if not (0 <= nr < size and 0 <= nc < size):
                continue
            rp = RECIPROCAL_PORT[p]
            nb_used = {q for pr in full[(nr, nc)] for q in pr}
            if rp in nb_used:
                edges.add(frozenset([(r, c), (nr, nc)]))

    parent: dict[tuple[int, int], tuple[int, int]] = {}

    def find(x: tuple[int, int]) -> tuple[int, int]:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: tuple[int, int], b: tuple[int, int]) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for e in edges:
        a, b = tuple(e)
        union(a, b)

    comps: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for cell in parent:
        comps.setdefault(find(cell), []).append(cell)

    nonempty = [cell for cell, pairs in full.items() if pairs]
    dangling = [cell for cell in nonempty if cell not in parent]
    return {
        "components": len(comps),
        "component_sizes": sorted((len(v) for v in comps.values()), reverse=True),
        "nonempty_dots": len(nonempty),
        "dots_not_on_stroke": dangling,
        "edges": len(edges),
    }


def try_solve(
    size: int,
    symmetry: str = "D4",
    parity_gate: bool = True,
    allow_classes: set[str] | None = None,
    seed: int = 42,
    attempts: int = 8,
    require_single_stroke: bool = False,
    connectivity_sticky: bool = True,
    flow_bias: bool = True,
    psi_bias: bool = True,
    wide_bias: bool = True,
    curved_bias: bool = True,
    use_boundary_grammar: bool = True,
    boundary_max_pairs: int = 2,
) -> dict[tuple[int, int], frozenset]:
    """Solve with retries until a verified, seam-free assignment is found.

    With require_single_stroke=True, only assignments whose full stroke graph
    is a single connected component (rule 4: one continuous line) are accepted.
    """
    last_err = None
    for i in range(attempts):
        try:
            s = seed + i * 131
            full = solve(size, symmetry, parity_gate, allow_classes, s,
                         connectivity_sticky=connectivity_sticky,
                         flow_bias=flow_bias,
                         psi_bias=psi_bias,
                         wide_bias=wide_bias,
                         curved_bias=curved_bias,
                         require_single_stroke=require_single_stroke,
                         use_boundary_grammar=use_boundary_grammar,
                         boundary_max_pairs=boundary_max_pairs)
            viol = verify_assignment(full, size)
            if viol:
                last_err = RuntimeError(f"{len(viol)} edge violations after replication")
                continue
            stats = component_stats(full, size)
            if require_single_stroke and stats["components"] != 1:
                last_err = RuntimeError(
                    f"{stats['components']} stroke components (need 1): "
                    f"{stats['component_sizes']}"
                )
                continue
            return full
        except RuntimeError as e:
            last_err = e
    raise RuntimeError(f"no verified solution: {last_err}")
