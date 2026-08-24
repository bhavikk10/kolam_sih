import { DIRECTION_INDEX, OPPOSITE_DIRECTION } from "./types";

import type {
  ConnectionCandidate,
  ConnectionFamily,
  ConnectionGrid,
  ConnectionMask,
  ConnectionSolverOptions,
  ConnectionSolverResult,
  Direction,
  SolverGrid,
  SymmetryOrbit,
  SymmetryTransform,
} from "./types";

import { transformConnectionMask, validateSymmetryGrid } from "./Symmetry";

import {
  checkConstraints,
  scoreCandidate,
  type ConstraintDomains,
  type ConstraintState,
  DEFAULT_CONNECTION_CONSTRAINTS,
} from "./ConnectionConstraints";

// ============================================================
// CONSTANTS
// ============================================================

const DIRECTIONS: Direction[] = ["N", "E", "S", "W", "NE", "SE", "SW", "NW"];

const directionVector: Record<Direction, readonly [number, number]> = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
  NE: [-1, 1],
  SE: [1, 1],
  SW: [1, -1],
  NW: [-1, -1],
};

// ============================================================
// INTERNAL TYPES
// ============================================================

interface Cell {
  row: number;
  col: number;
}

interface Arc {
  from: Cell;
  to: Cell;
  direction: Direction;
}

interface SolverState {
  domains: ConstraintDomains;
  assignments: ConnectionGrid;

  backtracks: number;
  decisions: number;
  propagations: number;
}

interface SolverOptions {
  maxBacktracks: number;
  maxRestarts: number;
  randomize: boolean;
  seed: number;
}

// ============================================================
// RANDOM NUMBER GENERATOR
// ============================================================

class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let x = this.state;

    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;

    this.state = x >>> 0;

    return this.state / 0xffffffff;
  }

  integer(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      return 0;
    }

    return Math.floor(this.next() * maxExclusive);
  }
}

// ============================================================
// CELL / MASK HELPERS
// ============================================================

const cellKey = (row: number, col: number): string => `${row},${col}`;

const cloneMask = (mask: ConnectionMask): ConnectionMask =>
  [...mask] as ConnectionMask;

const maskKey = (mask: ConnectionMask): string => mask.join(",");

const candidateKey = (candidate: ConnectionCandidate): string =>
  [candidate.familyId, candidate.orientation, maskKey(candidate.con)].join(":");

const getDomain = (state: SolverState, cell: Cell): ConnectionCandidate[] =>
  state.domains.get(cellKey(cell.row, cell.col)) ?? [];

const setDomain = (
  state: SolverState,
  cell: Cell,
  domain: ConnectionCandidate[],
): void => {
  state.domains.set(cellKey(cell.row, cell.col), domain);
};

// ============================================================
// CANDIDATE GENERATION
// ============================================================

const getCandidates = (families: ConnectionFamily[]): ConnectionCandidate[] => {
  const result: ConnectionCandidate[] = [];
  const seen = new Set<string>();

  for (const family of families) {
    const orientations = family.orientations ?? ["N", "E", "S", "W"];

    for (const orientation of orientations) {
      const orientationTurns =
        orientation === "N"
          ? 0
          : orientation === "E"
            ? 1
            : orientation === "S"
              ? 2
              : 3;

      const transform: SymmetryTransform =
        orientationTurns === 0
          ? {
              type: "identity",
              rotation: 0,
            }
          : {
              type: "rotation",
              rotation: orientationTurns as 1 | 2 | 3,
            };

      const con = transformConnectionMask(family.canonicalCon, transform);

      const candidate: ConnectionCandidate = {
        familyId: family.id,
        orientation,
        con,
        weight: family.weight,
      };

      const key = candidateKey(candidate);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(candidate);
    }
  }

  return result;
};

// ============================================================
// GRID HELPERS
// ============================================================

const insideGrid = (grid: SolverGrid, row: number, col: number): boolean =>
  row >= 0 && row < grid.height && col >= 0 && col < grid.width;

const getNeighbour = (
  grid: SolverGrid,
  row: number,
  col: number,
  direction: Direction,
): Cell | null => {
  const [dr, dc] = directionVector[direction];

  const nr = row + dr;
  const nc = col + dc;

  if (!insideGrid(grid, nr, nc)) {
    return null;
  }

  return {
    row: nr,
    col: nc,
  };
};

// ============================================================
// BASIC TOPOLOGY HELPERS
// ============================================================

const candidatesCompatible = (
  a: ConnectionCandidate,
  direction: Direction,
  b: ConnectionCandidate,
): boolean => {
  const aIndex = DIRECTION_INDEX[direction];

  const bIndex = DIRECTION_INDEX[OPPOSITE_DIRECTION[direction]];

  return (a.con[aIndex] !== 0) === (b.con[bIndex] !== 0);
};

// ============================================================
// SYMMETRY HELPERS
// ============================================================

const transformMask = (
  mask: ConnectionMask,
  transform: SymmetryTransform,
): ConnectionMask => transformConnectionMask(mask, transform);

const inverseTransform = (transform: SymmetryTransform): SymmetryTransform => {
  if (transform.type === "identity") {
    return {
      type: "identity",
      rotation: 0,
    };
  }

  if (transform.type === "rotation") {
    return {
      type: "rotation",
      rotation: ((4 - transform.rotation) % 4) as 0 | 1 | 2 | 3,
    };
  }

  return {
    type: "reflection",
    rotation: 0,
    reflection: transform.reflection,
  };
};

const composeRelativeTransform = (
  from: SymmetryTransform,
  to: SymmetryTransform,
): SymmetryTransform => {
  if (from.type === "identity") {
    return to;
  }

  if (to.type === "identity") {
    return inverseTransform(from);
  }

  if (from.type === "rotation" && to.type === "rotation") {
    return {
      type: "rotation",
      rotation: ((4 - from.rotation + to.rotation) % 4) as 0 | 1 | 2 | 3,
    };
  }

  const sourceDirections: Direction[] = ["N", "E", "S", "W"];

  const mapped = sourceDirections.map((direction) => {
    const mask = new Array(8).fill(0) as ConnectionMask;

    mask[DIRECTION_INDEX[direction]] = 1;

    const relative = transformMask(
      transformMask(mask, inverseTransform(from)),
      to,
    );

    for (let i = 0; i < relative.length; i++) {
      if (relative[i] !== 0) {
        return DIRECTIONS[i];
      }
    }

    return direction;
  });

  const rotations: Direction[][] = [
    ["N", "E", "S", "W"],
    ["E", "S", "W", "N"],
    ["S", "W", "N", "E"],
    ["W", "N", "E", "S"],
  ];

  for (let rotation = 0; rotation < rotations.length; rotation++) {
    if (mapped.every((value, index) => value === rotations[rotation][index])) {
      return {
        type: "rotation",
        rotation: rotation as 0 | 1 | 2 | 3,
      };
    }
  }

  const reflections: Array<{
    reflection: "vertical" | "horizontal" | "diagonal1" | "diagonal2";
    mapping: Direction[];
  }> = [
    {
      reflection: "vertical",
      mapping: ["N", "W", "S", "E"],
    },
    {
      reflection: "horizontal",
      mapping: ["S", "E", "N", "W"],
    },
    {
      reflection: "diagonal1",
      mapping: ["W", "S", "E", "N"],
    },
    {
      reflection: "diagonal2",
      mapping: ["E", "N", "W", "S"],
    },
  ];

  for (const candidate of reflections) {
    if (mapped.every((value, index) => value === candidate.mapping[index])) {
      return {
        type: "reflection",
        rotation: 0,
        reflection: candidate.reflection,
      };
    }
  }

  throw new Error("Could not determine relative symmetry transform.");
};

// ============================================================
// SYMMETRY ORBIT RESTRICTION
// ============================================================

const restrictOrbitToCandidate = (
  state: SolverState,
  orbit: SymmetryOrbit,
  representative: Cell,
  candidate: ConnectionCandidate,
): boolean => {
  const representativeCell = orbit.cells.find(
    (cell) =>
      cell.row === representative.row && cell.col === representative.col,
  );

  if (!representativeCell) {
    return false;
  }

  // Assign the representative to exactly this candidate (singleton).
  setDomain(state, representative, [candidate]);

  const representativeMask = transformMask(
    candidate.con,
    inverseTransform(representativeCell.transform),
  );

  for (const orbitCell of orbit.cells) {
    // Skip the representative — already assigned above.
    if (
      orbitCell.row === representative.row &&
      orbitCell.col === representative.col
    ) {
      continue;
    }

    const requiredMask = transformMask(representativeMask, orbitCell.transform);

    const domain = getDomain(state, orbitCell);

    const filtered = domain.filter(
      (other) => maskKey(other.con) === maskKey(requiredMask),
    );

    if (filtered.length === 0) {
      return false;
    }

    // If multiple candidates match the same mask, pick the first one
    // to ensure domains converge to singletons (preventing infinite
    // recursion when e.g. all 4 NONE orientations share the same mask).
    setDomain(state, orbitCell, [filtered[0]]);
  }

  return true;
};

const assignOrbitCandidate = (
  state: SolverState,
  orbit: SymmetryOrbit,
  representative: Cell,
  candidate: ConnectionCandidate,
): boolean => restrictOrbitToCandidate(state, orbit, representative, candidate);

// ============================================================
// INITIAL STATE
// ============================================================

const createInitialState = (
  grid: SolverGrid,
  candidates: ConnectionCandidate[],
): SolverState => {
  const domains = new Map<string, ConnectionCandidate[]>();

  const assignments: ConnectionGrid = Array.from({ length: grid.height }, () =>
    Array.from({ length: grid.width }, () => null),
  );

  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (!grid.isDot(row, col)) {
        continue;
      }

      domains.set(cellKey(row, col), [...candidates]);
    }
  }

  return {
    domains,
    assignments,
    backtracks: 0,
    decisions: 0,
    propagations: 0,
  };
};

// ============================================================
// ARC QUEUE
// ============================================================

const makeInitialArcQueue = (grid: SolverGrid): Arc[] => {
  const queue: Arc[] = [];

  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (!grid.isDot(row, col)) {
        continue;
      }

      for (const direction of DIRECTIONS) {
        const neighbour = getNeighbour(grid, row, col, direction);

        if (!neighbour || !grid.isDot(neighbour.row, neighbour.col)) {
          continue;
        }

        queue.push({
          from: { row, col },
          to: neighbour,
          direction,
        });
      }
    }
  }

  return queue;
};

const addIncomingArcs = (queue: Arc[], grid: SolverGrid, cell: Cell): void => {
  for (const direction of DIRECTIONS) {
    const neighbour = getNeighbour(grid, cell.row, cell.col, direction);

    if (!neighbour || !grid.isDot(neighbour.row, neighbour.col)) {
      continue;
    }

    queue.push({
      from: neighbour,
      to: cell,
      direction: OPPOSITE_DIRECTION[direction],
    });
  }
};

// ============================================================
// AC-3
// ============================================================

const revise = (state: SolverState, arc: Arc): boolean => {
  const fromDomain = getDomain(state, arc.from);

  const toDomain = getDomain(state, arc.to);

  const filtered = fromDomain.filter((a) =>
    toDomain.some((b) => candidatesCompatible(a, arc.direction, b)),
  );

  if (filtered.length === fromDomain.length) {
    return false;
  }

  setDomain(state, arc.from, filtered);

  return true;
};

const propagateArcs = (
  state: SolverState,
  grid: SolverGrid,
  initialQueue?: Arc[],
): boolean => {
  const queue = initialQueue ?? makeInitialArcQueue(grid);

  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const arc = queue[queueIndex++];

    state.propagations++;

    const changed = revise(state, arc);

    if (!changed) {
      continue;
    }

    if (getDomain(state, arc.from).length === 0) {
      return false;
    }

    addIncomingArcs(queue, grid, arc.from);
  }

  return true;
};

// ============================================================
// SYMMETRY PROPAGATION
// ============================================================

const propagateSymmetry = (
  state: SolverState,
  grid: SolverGrid,
  orbits: SymmetryOrbit[],
): boolean => {
  let changed = true;

  while (changed) {
    changed = false;

    for (const orbit of orbits) {
      if (orbit.cells.length <= 1) {
        continue;
      }

      const representative = orbit.cells[0];

      if (!representative) {
        continue;
      }

      if (!grid.isDot(representative.row, representative.col)) {
        continue;
      }

      const representativeDomain = getDomain(state, representative);

      if (representativeDomain.length === 0) {
        return false;
      }

      const validRepresentative = representativeDomain.filter((candidate) =>
        orbit.cells.every((orbitCell) => {
          const required = transformMask(
            candidate.con,
            composeRelativeTransform(
              representative.transform,
              orbitCell.transform,
            ),
          );

          return getDomain(state, orbitCell).some(
            (other) => maskKey(other.con) === maskKey(required),
          );
        }),
      );

      if (validRepresentative.length === 0) {
        return false;
      }

      if (validRepresentative.length !== representativeDomain.length) {
        setDomain(state, representative, validRepresentative);
        changed = true;
      }

      for (let i = 1; i < orbit.cells.length; i++) {
        const orbitCell = orbit.cells[i];

        const domain = getDomain(state, orbitCell);

        const filtered = domain.filter((candidate) =>
          getDomain(state, representative).some((representativeCandidate) => {
            const required = transformMask(
              representativeCandidate.con,
              composeRelativeTransform(
                representative.transform,
                orbitCell.transform,
              ),
            );

            return maskKey(required) === maskKey(candidate.con);
          }),
        );

        if (filtered.length === 0) {
          return false;
        }

        if (filtered.length !== domain.length) {
          setDomain(state, orbitCell, filtered);
          changed = true;
        }
      }
    }

    if (!propagateArcs(state, grid)) {
      return false;
    }
  }

  return true;
};

// ============================================================
// CONSTRAINT STATE ADAPTER
// ============================================================

const toConstraintState = (
  state: SolverState,
  islands: number,
): ConstraintState => ({
  domains: state.domains,
  assignments: state.assignments,
  islands,
});

// ============================================================
// CONSTRAINT PROPAGATION
// ============================================================
//
// The solver remains responsible for:
//   - AC-3
//   - symmetry orbit propagation
//
// ConnectionConstraints is responsible for:
//   - boundary validity
//   - island feasibility
//   - future hard constraints
//
// This avoids duplicating the expensive adjacency propagation
// inside the constraint engine.
// ============================================================

const runHardConstraints = (
  state: SolverState,
  grid: SolverGrid,
  orbits: SymmetryOrbit[],
  islands: number,
): boolean => {
  const result = checkConstraints(
    {
      grid,
      state: toConstraintState(state, islands),
      orbits,
    },
    DEFAULT_CONNECTION_CONSTRAINTS,
  );

  return result.valid;
};

const propagateAll = (
  state: SolverState,
  grid: SolverGrid,
  orbits: SymmetryOrbit[],
  islands: number,
): boolean => {
  let changed = true;

  while (changed) {
    changed = false;

    const before = snapshotDomains(state);

    // 1. Symmetry must propagate before local arcs.
    if (!propagateSymmetry(state, grid, orbits)) {
      return false;
    }

    // 2. AC-3 propagates local connection compatibility.
    if (!propagateArcs(state, grid)) {
      return false;
    }

    // 3. Hard constraints prune/reject the branch.
    if (!runHardConstraints(state, grid, orbits, islands)) {
      return false;
    }

    const after = snapshotDomains(state);

    changed = before !== after;
  }

  return true;
};

// ============================================================
// MRV + DEGREE
// ============================================================

const selectOrbit = (
  state: SolverState,
  orbits: SymmetryOrbit[],
  grid: SolverGrid,
): SymmetryOrbit | null => {
  let best: SymmetryOrbit | null = null;

  let bestSize = Number.POSITIVE_INFINITY;

  let bestDegree = -1;

  for (const orbit of orbits) {
    const representative = orbit.cells[0];

    if (!representative) {
      continue;
    }

    if (!grid.isDot(representative.row, representative.col)) {
      continue;
    }

    const domain = getDomain(state, representative);

    if (domain.length <= 1) {
      continue;
    }

    let degree = 0;

    for (const cell of orbit.cells) {
      for (const direction of DIRECTIONS) {
        const neighbour = getNeighbour(grid, cell.row, cell.col, direction);

        if (neighbour && grid.isDot(neighbour.row, neighbour.col)) {
          degree++;
        }
      }
    }

    if (
      domain.length < bestSize ||
      (domain.length === bestSize && degree > bestDegree)
    ) {
      best = orbit;
      bestSize = domain.length;
      bestDegree = degree;
    }
  }

  return best;
};

// ============================================================
// COMPLETION / MATERIALIZATION
// ============================================================

const isComplete = (state: SolverState, grid: SolverGrid): boolean => {
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (!grid.isDot(row, col)) {
        continue;
      }

      if (getDomain(state, { row, col }).length !== 1) {
        return false;
      }
    }
  }

  return true;
};

const materialize = (state: SolverState, grid: SolverGrid): void => {
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (!grid.isDot(row, col)) {
        state.assignments[row][col] = null;
        continue;
      }

      const domain = getDomain(state, { row, col });

      state.assignments[row][col] = domain.length === 1 ? domain[0] : null;
    }
  }
};

// ============================================================
// FINAL TOPOLOGY VALIDATION
// ============================================================
//
// We deliberately validate the finished topology again.
//
// Incremental constraints prevent wasted search.
// Final validation is the safety net before returning a result.
// ============================================================

const validateFinalTopology = (
  state: SolverState,
  grid: SolverGrid,
  orbits: SymmetryOrbit[],
  islands: number,
): boolean => {
  if (!isComplete(state, grid)) {
    return false;
  }

  if (!runHardConstraints(state, grid, orbits, islands)) {
    return false;
  }

  // At this point every dot has one candidate.
  // Island constraint must still hold exactly.
  const result = checkConstraints(
    {
      grid,
      state: toConstraintState(state, islands),
      orbits,
    },
    DEFAULT_CONNECTION_CONSTRAINTS,
  );

  return result.valid;
};

// ============================================================
// WEIGHTED CANDIDATE ORDER
// ============================================================
//
// Family weight remains the base probability.
//
// Soft constraints multiply that weight.
//
// This is the extension point for future:
//   - complexity
//   - visual preference
//   - density
//   - symmetry aesthetics
//   - pattern diversity
//
// Hard constraints have already removed impossible candidates.
// ============================================================

const weightedOrder = (
  candidates: ConnectionCandidate[],
  rng: RNG,
  randomize: boolean,
  scoreForCandidate?: (candidate: ConnectionCandidate) => number,
): ConnectionCandidate[] => {
  const remaining = [...candidates];

  if (!randomize) {
    return remaining.sort(
      (a, b) =>
        (scoreForCandidate?.(b) ?? 1) * b.weight -
        (scoreForCandidate?.(a) ?? 1) * a.weight,
    );
  }

  const result: ConnectionCandidate[] = [];

  while (remaining.length > 0) {
    const weighted = remaining.map((candidate) => ({
      candidate,
      weight:
        Math.max(candidate.weight, 0.000001) *
        Math.max(scoreForCandidate?.(candidate) ?? 1, 0),
    }));

    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);

    if (totalWeight <= 0) {
      const index = rng.integer(remaining.length);

      result.push(remaining[index]);

      remaining.splice(index, 1);
      continue;
    }

    let target = rng.next() * totalWeight;

    let selectedIndex = remaining.length - 1;

    for (let i = 0; i < weighted.length; i++) {
      target -= weighted[i].weight;

      if (target <= 0) {
        selectedIndex = i;
        break;
      }
    }

    result.push(remaining[selectedIndex]);

    remaining.splice(selectedIndex, 1);
  }

  return result;
};

// ============================================================
// STATE CLONING
// ============================================================

const cloneState = (state: SolverState): SolverState => {
  const domains = new Map<string, ConnectionCandidate[]>();

  for (const [key, domain] of state.domains) {
    domains.set(key, [...domain]);
  }

  return {
    domains,
    assignments: state.assignments.map((row) => [...row]),
    backtracks: state.backtracks,
    decisions: state.decisions,
    propagations: state.propagations,
  };
};

// ============================================================
// DOMAIN SNAPSHOT
// ============================================================

const snapshotDomains = (state: SolverState): string =>
  [...state.domains.entries()]
    .map(([key, domain]) => `${key}:${domain.length}`)
    .sort()
    .join("|");

// ============================================================
// SEARCH
// ============================================================

const search = (
  state: SolverState,
  grid: SolverGrid,
  orbits: SymmetryOrbit[],
  islands: number,
  options: SolverOptions,
  rng: RNG,
): boolean => {
  if (state.backtracks > options.maxBacktracks) {
    return false;
  }

  // Re-check constraints at every search node.
  // This means an impossible branch is rejected before
  // another decision is made.
  if (!runHardConstraints(state, grid, orbits, islands)) {
    return false;
  }

  if (isComplete(state, grid)) {
    return validateFinalTopology(state, grid, orbits, islands);
  }

  const orbit = selectOrbit(state, orbits, grid);

  if (!orbit) {
    return false;
  }

  const representative = orbit.cells[0];

  if (!representative) {
    return false;
  }

  const domain = getDomain(state, representative);

  if (domain.length === 0) {
    return false;
  }

  const ordered = weightedOrder(domain, rng, options.randomize, (candidate) => {
    const score = scoreCandidate({
      grid,
      state: toConstraintState(state, islands),
      cell: {
        row: representative.row,
        col: representative.col,
      },
      candidate,
    });

    return score.multiplier;
  });

  for (const candidate of ordered) {
    if (state.backtracks > options.maxBacktracks) {
      return false;
    }

    state.decisions++;

    const next = cloneState(state);

    if (!assignOrbitCandidate(next, orbit, representative, candidate)) {
      state.backtracks++;
      continue;
    }

    // This is the crucial point:
    //
    // candidate assignment
    //       ↓
    // symmetry propagation
    //       ↓
    // AC-3
    //       ↓
    // constraints
    //       ↓
    // either continue OR backtrack
    if (!propagateAll(next, grid, orbits, islands)) {
      state.backtracks++;
      continue;
    }

    if (search(next, grid, orbits, islands, options, rng)) {
      state.domains = next.domains;

      state.assignments = next.assignments;

      state.backtracks = next.backtracks;

      state.decisions = next.decisions;

      state.propagations = next.propagations;

      return true;
    }

    state.backtracks++;
  }

  return false;
};

// ============================================================
// PUBLIC SOLVER
// ============================================================

export const solveConnections = (
  options: ConnectionSolverOptions,
): ConnectionSolverResult => {
  const {
    grid,
    islands,
    symmetry,
    families,
    maxBacktracks = 100_000,
    maxRestarts = 3,
    randomize = true,
    seed: requestedSeed,
  } = options;

  if (!Number.isInteger(islands) || islands < 1) {
    throw new Error("islands must be a positive integer.");
  }

  // Symmetry.ts remains the single source of truth
  // for symmetry validation and orbit construction.
  const orbits = validateSymmetryGrid(grid, symmetry);

  const candidates = getCandidates(families);

  if (candidates.length === 0) {
    throw new Error("No connection candidates were provided.");
  }

  const baseSeed = (requestedSeed ?? Date.now()) >>> 0;

  let bestResult: ConnectionSolverResult | null = null;

  for (let restart = 0; restart <= maxRestarts; restart++) {
    const seed = (baseSeed + restart * 1_000_003) >>> 0;

    const rng = new RNG(seed);

    const state = createInitialState(grid, candidates);

    // Initial propagation is important:
    // don't make a single search decision until
    // all immediately discoverable constraints
    // have been applied.
    if (!propagateAll(state, grid, orbits, islands)) {
      const failed: ConnectionSolverResult = {
        success: false,
        grid: state.assignments,
        backtracks: state.backtracks,
        decisions: state.decisions,
        propagations: state.propagations,
      };

      if (!bestResult) {
        bestResult = failed;
      }

      continue;
    }

    const success = search(
      state,
      grid,
      orbits,
      islands,
      {
        maxBacktracks,
        maxRestarts,
        randomize,
        seed,
      },
      rng,
    );

    materialize(state, grid);

    const result: ConnectionSolverResult = {
      success,
      grid: state.assignments,
      backtracks: state.backtracks,
      decisions: state.decisions,
      propagations: state.propagations,
      seed,
    };

    if (!bestResult || result.success) {
      bestResult = result;
    }

    if (success) {
      return result;
    }
  }

  return (
    bestResult ?? {
      success: false,
      grid: Array.from(
        {
          length: grid.height,
        },
        () =>
          Array.from(
            {
              length: grid.width,
            },
            () => null,
          ),
      ),
      backtracks: 0,
      decisions: 0,
      propagations: 0,
    }
  );
};
