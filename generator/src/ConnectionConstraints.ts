import { DIRECTION_INDEX, OPPOSITE_DIRECTION } from "./types";

import type {
  ConnectionCandidate,
  ConnectionGrid,
  Direction,
  SolverGrid,
  SymmetryOrbit,
} from "./types";

/**
 * Incremental topology constraints.
 *
 * Hard constraints may reject/narrow a partial solver state.
 * Soft constraints may influence candidate probability later.
 *
 * Current hard constraints:
 *   - dots
 *   - boundaries
 *   - local adjacency
 *   - symmetry/orbit feasibility
 *   - island feasibility
 *
 * Future example:
 *   ComplexityConstraint can implement scoreCandidate() without
 *   changing the topology validity rules.
 */

export type ConstraintDomains = Map<string, ConnectionCandidate[]>;

export interface ConstraintState {
  domains: ConstraintDomains;
  assignments: ConnectionGrid;
  islands: number;
}

export interface ConstraintContext {
  grid: SolverGrid;
  state: ConstraintState;
  orbits?: SymmetryOrbit[];
}

export type ConstraintFailureReason =
  | "EMPTY_DOMAIN"
  | "BOUNDARY_VIOLATION"
  | "DOT_VIOLATION"
  | "NEIGHBOUR_MISMATCH"
  | "SYMMETRY_VIOLATION"
  | "TOO_MANY_ISLANDS"
  | "TOO_FEW_ISLANDS_POSSIBLE"
  | "INVALID_ISLAND_COUNT";

export interface ConstraintFailure {
  constraint: string;
  reason: ConstraintFailureReason;
  message: string;
  cells?: Array<{ row: number; col: number }>;
  direction?: Direction;
}

export interface ConstraintCheckResult {
  valid: boolean;
  changed?: boolean;
  failure?: ConstraintFailure;
}

export interface ConstraintScore {
  /** Multiplicative weight. 1 = neutral. */
  multiplier: number;
  /** Optional additive score for future ranking strategies. */
  additive: number;
}

export interface SoftConstraintContext {
  grid: SolverGrid;
  state: ConstraintState;
  cell: { row: number; col: number };
  candidate: ConnectionCandidate;
}

export interface ConnectionConstraint {
  readonly id: string;

  /**
   * May reject a branch and may narrow domains.
   * Must never mutate anything outside context.state.
   */
  check(context: ConstraintContext): ConstraintCheckResult;

  /**
   * Optional. Used later by complexity/style constraints.
   * Returning no score means neutral influence.
   */
  scoreCandidate?(context: SoftConstraintContext): ConstraintScore;
}

export const DIRECTIONS: Direction[] = [
  "N",
  "E",
  "S",
  "W",
  "NE",
  "SE",
  "SW",
  "NW",
];

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

const cellKey = (row: number, col: number): string => `${row},${col}`;

const inside = (grid: SolverGrid, row: number, col: number): boolean =>
  row >= 0 && row < grid.height && col >= 0 && col < grid.width;

const neighbourOf = (
  grid: SolverGrid,
  row: number,
  col: number,
  direction: Direction,
): { row: number; col: number } | null => {
  const [dr, dc] = directionVector[direction];
  const r = row + dr;
  const c = col + dc;
  return inside(grid, r, c) ? { row: r, col: c } : null;
};

const connected = (
  candidate: ConnectionCandidate,
  direction: Direction,
): boolean => candidate.con[DIRECTION_INDEX[direction]] !== 0;

const compatible = (
  a: ConnectionCandidate,
  direction: Direction,
  b: ConnectionCandidate,
): boolean =>
  connected(a, direction) === connected(b, OPPOSITE_DIRECTION[direction]);

// ============================================================
// Boundary / dot constraint
// ============================================================

export const boundaryConstraint: ConnectionConstraint = {
  id: "boundary",

  check({ grid, state }): ConstraintCheckResult {
    let changed = false;

    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const key = cellKey(row, col);
        const domain = state.domains.get(key) ?? [];

        if (!grid.isDot(row, col)) {
          if (domain.length !== 0) {
            state.domains.set(key, []);
            changed = true;
          }
          continue;
        }

        const filtered = domain.filter((candidate) => {
          for (const direction of DIRECTIONS) {
            if (!connected(candidate, direction)) continue;

            const next = neighbourOf(grid, row, col, direction);
            if (!next || !grid.isDot(next.row, next.col)) {
              return false;
            }
          }
          return true;
        });

        if (filtered.length === 0) {
          return {
            valid: false,
            changed,
            failure: {
              constraint: "boundary",
              reason: "BOUNDARY_VIOLATION",
              message: `Cell (${row}, ${col}) has no boundary-valid candidate.`,
              cells: [{ row, col }],
            },
          };
        }

        if (filtered.length !== domain.length) {
          state.domains.set(key, filtered);
          changed = true;
        }
      }
    }

    return { valid: true, changed };
  },
};

// ============================================================
// Local adjacency constraint
// ============================================================

export const adjacencyConstraint: ConnectionConstraint = {
  id: "adjacency",

  check({ grid, state }): ConstraintCheckResult {
    let changed = false;

    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        if (!grid.isDot(row, col)) continue;

        const key = cellKey(row, col);
        let domain = state.domains.get(key) ?? [];

        for (const direction of DIRECTIONS) {
          const next = neighbourOf(grid, row, col, direction);
          if (!next || !grid.isDot(next.row, next.col)) continue;

          const other = state.domains.get(cellKey(next.row, next.col)) ?? [];

          const filtered = domain.filter((candidate) =>
            other.some((candidate2) =>
              compatible(candidate, direction, candidate2),
            ),
          );

          if (filtered.length === 0) {
            return {
              valid: false,
              changed,
              failure: {
                constraint: "adjacency",
                reason: "NEIGHBOUR_MISMATCH",
                message: `Cell (${row}, ${col}) has no candidate supported by its ${direction} neighbour.`,
                cells: [{ row, col }, next],
                direction,
              },
            };
          }

          if (filtered.length !== domain.length) {
            domain = filtered;
            state.domains.set(key, domain);
            changed = true;
          }
        }
      }
    }

    return { valid: true, changed };
  },
};

// ============================================================
// Symmetry feasibility
// ============================================================
//
// Symmetry.ts remains the source of truth for transformations.
// The solver's existing orbit propagation can do the actual mask
// transformation; this constraint verifies that each orbit still
// has at least one mutually compatible representative candidate.
// ============================================================

export const symmetryConstraint: ConnectionConstraint = {
  id: "symmetry",

  check({ state, orbits, grid }): ConstraintCheckResult {
    if (!orbits) return { valid: true, changed: false };

    for (const orbit of orbits) {
      if (orbit.cells.length <= 1) continue;

      const representative = orbit.cells[0];
      if (!representative) continue;

      if (!grid.isDot(representative.row, representative.col)) continue;

      const domain =
        state.domains.get(cellKey(representative.row, representative.col)) ??
        [];

      if (domain.length === 0) {
        return {
          valid: false,
          failure: {
            constraint: "symmetry",
            reason: "SYMMETRY_VIOLATION",
            message: "A symmetry orbit has an empty representative domain.",
            cells: [{ row: representative.row, col: representative.col }],
          },
        };
      }
    }

    return { valid: true, changed: false };
  },
};

// ============================================================
// Island feasibility
// ============================================================
//
// For a partial state:
//
// mandatory graph = edges that EVERY remaining candidate requires
// possible graph  = edges for which at least one compatible pair exists
//
// Therefore:
//
//   mandatoryComponents <= finalIslands <= possibleComponents
//
// If requested islands falls outside that interval, backtrack now.
// This is the important pruning step that prevents completing a
// branch which can no longer satisfy the island requirement.
// ============================================================

interface Graph {
  nodes: Set<string>;
  edges: Map<string, Set<string>>;
}

const newGraph = (): Graph => ({
  nodes: new Set(),
  edges: new Map(),
});

const addNode = (graph: Graph, key: string): void => {
  graph.nodes.add(key);
  if (!graph.edges.has(key)) graph.edges.set(key, new Set());
};

const addEdge = (graph: Graph, a: string, b: string): void => {
  addNode(graph, a);
  addNode(graph, b);
  graph.edges.get(a)!.add(b);
  graph.edges.get(b)!.add(a);
};

const components = (graph: Graph): number => {
  const visited = new Set<string>();
  let count = 0;

  for (const start of graph.nodes) {
    if (visited.has(start)) continue;

    count++;
    const queue = [start];
    let index = 0;
    visited.add(start);

    while (index < queue.length) {
      const current = queue[index++];

      for (const next of graph.edges.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return count;
};

const buildIslandGraph = (
  grid: SolverGrid,
  domains: ConstraintDomains,
  mode: "mandatory" | "possible",
): Graph => {
  const graph = newGraph();

  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (grid.isDot(row, col)) addNode(graph, cellKey(row, col));
    }
  }

  // Only one direction from each undirected pair is needed.
  const pairDirections: Direction[] = ["E", "S", "SE", "SW"];

  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (!grid.isDot(row, col)) continue;

      const key = cellKey(row, col);
      const domain = domains.get(key) ?? [];

      for (const direction of pairDirections) {
        const next = neighbourOf(grid, row, col, direction);
        if (!next || !grid.isDot(next.row, next.col)) continue;

        const nextKey = cellKey(next.row, next.col);
        const other = domains.get(nextKey) ?? [];

        if (domain.length === 0 || other.length === 0) continue;

        if (mode === "mandatory") {
          const aAlways = domain.every((c) => connected(c, direction));
          const bAlways = other.every((c) =>
            connected(c, OPPOSITE_DIRECTION[direction]),
          );

          if (aAlways && bAlways) addEdge(graph, key, nextKey);
        } else {
          const opposite = OPPOSITE_DIRECTION[direction];

          const possible = domain.some((a) =>
            other.some(
              (b) => connected(a, direction) && connected(b, opposite),
            ),
          );

          if (possible) {
            addEdge(graph, key, nextKey);
          }
        }
      }
    }
  }

  return graph;
};

export const islandConstraint: ConnectionConstraint = {
  id: "islands",

  check({ grid, state }): ConstraintCheckResult {
    if (!Number.isInteger(state.islands) || state.islands < 1) {
      return {
        valid: false,
        failure: {
          constraint: "islands",
          reason: "INVALID_ISLAND_COUNT",
          message: "Island count must be a positive integer.",
        },
      };
    }

    const mandatory = components(
      buildIslandGraph(grid, state.domains, "mandatory"),
    );

    const possible = components(
      buildIslandGraph(grid, state.domains, "possible"),
    );

    // Bound: components(possible) <= finalIslands <= components(mandatory)

    if (possible > state.islands) {
      return {
        valid: false,
        failure: {
          constraint: "islands",
          reason: "TOO_MANY_ISLANDS",
          message: `At least ${possible} islands are already forced, but ${state.islands} were requested.`,
        },
      };
    }

    if (mandatory < state.islands) {
      return {
        valid: false,
        failure: {
          constraint: "islands",
          reason: "TOO_FEW_ISLANDS_POSSIBLE",
          message: `At most ${mandatory} islands remain achievable, but ${state.islands} are required.`,
        },
      };
    }

    return { valid: true, changed: false };
  },
};

// ============================================================
// Constraint registry
// ============================================================

export const DEFAULT_CONNECTION_CONSTRAINTS: ConnectionConstraint[] = [
  boundaryConstraint,
  adjacencyConstraint,
  symmetryConstraint,
  islandConstraint,
];

// ============================================================
// Constraint engine
// ============================================================

const snapshotDomains = (domains: ConstraintDomains): string =>
  [...domains.entries()]
    .map(
      ([key, values]) =>
        `${key}:${values
          .map((v) => `${v.familyId}/${v.orientation}/${v.con.join("")}`)
          .sort()
          .join("|")}`,
    )
    .sort()
    .join(";");

export const checkConstraints = (
  context: ConstraintContext,
  constraints: ConnectionConstraint[] = DEFAULT_CONNECTION_CONSTRAINTS,
): ConstraintCheckResult => {
  let changed = false;

  for (const constraint of constraints) {
    const before = snapshotDomains(context.state.domains);
    const result = constraint.check(context);

    if (!result.valid) {
      return { ...result, changed: changed || !!result.changed };
    }

    const after = snapshotDomains(context.state.domains);
    if (before !== after) changed = true;
  }

  return { valid: true, changed };
};

// ============================================================
// Soft scoring API
// ============================================================
//
// Complexity belongs here later.
//
// Example:
//
// const complexityConstraint: ConnectionConstraint = {
//   id: "complexity",
//   check: () => ({ valid: true }),
//   scoreCandidate: ({ candidate }) => ({
//     multiplier: complexityWeight(candidate),
//     additive: 0,
//   }),
// };
//
// No topology validity is affected by this.
// ============================================================

export const scoreCandidate = (
  context: SoftConstraintContext,
  constraints: ConnectionConstraint[] = DEFAULT_CONNECTION_CONSTRAINTS,
): ConstraintScore => {
  let multiplier = 1;
  let additive = 0;

  for (const constraint of constraints) {
    if (!constraint.scoreCandidate) continue;

    const score = constraint.scoreCandidate(context);

    if (Number.isFinite(score.multiplier) && score.multiplier >= 0) {
      multiplier *= score.multiplier;
    }

    if (Number.isFinite(score.additive)) {
      additive += score.additive;
    }
  }

  return { multiplier, additive };
};

// ============================================================
// Completed topology check
// ============================================================

export const validateCompletedIslands = (
  grid: SolverGrid,
  domains: ConstraintDomains,
  islands: number,
): ConstraintCheckResult => {
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (!grid.isDot(row, col)) continue;

      const domain = domains.get(cellKey(row, col)) ?? [];

      if (domain.length !== 1) {
        return {
          valid: false,
          failure: {
            constraint: "islands",
            reason: "EMPTY_DOMAIN",
            message: `Cell (${row}, ${col}) is not fully resolved.`,
            cells: [{ row, col }],
          },
        };
      }
    }
  }

  const graph = buildIslandGraph(grid, domains, "possible");
  const actual = components(graph);

  if (actual !== islands) {
    return {
      valid: false,
      failure: {
        constraint: "islands",
        reason:
          actual > islands ? "TOO_MANY_ISLANDS" : "TOO_FEW_ISLANDS_POSSIBLE",
        message: `Completed topology has ${actual} islands; ${islands} were requested.`,
      },
    };
  }

  return { valid: true };
};
