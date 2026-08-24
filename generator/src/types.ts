// types.ts

export type Orientation = "N" | "E" | "S" | "W";

export type Direction = "N" | "E" | "S" | "W" | "NE" | "SE" | "SW" | "NW";

export type Symmetry =
  | "None"
  | "Mirror_V"
  | "Mirror_H"
  | "Mirror_Diagonal1"
  | "Mirror_Diagonal2"
  | "Rotational_1Fold"
  | "Rotational_2Fold"
  | "Rotational_4Fold";

export interface KolamStyle {
  backgroundColor: string;
  dotColor: string;
  strokeColor: string;
}

export const DEFAULT_KOLAM_STYLE: KolamStyle = {
  backgroundColor: "#ffffff",
  dotColor: "#000000",
  strokeColor: "#000000",
};

export type DrawContext = {
  ctx: CanvasRenderingContext2D;
  size: number;
};

export type Connection = -1 | 0 | 1 | 2;

export type Tile = {
  id: number;
  name: string;
  orientation: Orientation;

  // Actual connections for THIS orientation
  // [N, E, S, W, NE, SE, SW, NW]
  con: Connection[];

  // Canonical/base connections
  // [N, E, S, W, NE, SE, SW, NW]
  conn_type: Connection[];

  drawFunc: (data: DrawContext) => void;
};

export type PlacedTile = {
  id: number;
  name: string;
  orientation: Orientation;

  // Actual connections after rotation
  con: Connection[];

  // Canonical connections of the tile
  conn_type: Connection[];
};
export type DotGrid = number[][];

export type TileGrid = (PlacedTile | null)[][];
// ============================================================
// CONNECTION TYPES
// ============================================================

export type ConnectionMask = [
  number, // N
  number, // E
  number, // S
  number, // W
  number, // NE
  number, // SE
  number, // SW
  number, // NW
];

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

export const OPPOSITE_DIRECTION: Record<Direction, Direction> = {
  N: "S",
  E: "W",
  S: "N",
  W: "E",
  NE: "SW",
  SE: "NW",
  SW: "NE",
  NW: "SE",
};

export const DIRECTION_INDEX: Record<Direction, number> = {
  N: 0,
  E: 1,
  S: 2,
  W: 3,
  NE: 4,
  SE: 5,
  SW: 6,
  NW: 7,
};

// ============================================================
// CONNECTION FAMILY
// ============================================================

export type ConnectionFamilyId =
  | "NONE"
  | "N"
  | "NE"
  | "N_S"
  | "SE_NW"
  | "N_E"
  | "NE_NW"
  | "NE_SE_SW"
  | "N_E_S"
  | "N_E_S_W"
  | "NE_SE_SW_NW";

export interface ConnectionFamily {
  id: ConnectionFamilyId;

  /**
   * Canonical connection mask.
   *
   * ALWAYS:
   *
   * [N,E,S,W,NE,SE,SW,NW]
   */
  canonicalCon: ConnectionMask;

  /**
   * Relative probability when multiple families can
   * represent the same topology.
   */
  weight: number;

  /**
   * Which orientations are allowed for this family.
   *
   * Empty means all four.
   */
  orientations?: Orientation[];
}

// ============================================================
// SOLVER CANDIDATE
// ============================================================

export interface ConnectionCandidate {
  familyId: ConnectionFamilyId;

  /**
   * Orientation of the canonical family.
   */
  orientation: Orientation;

  /**
   * Actual mask after applying orientation.
   *
   * ALWAYS:
   *
   * [N,E,S,W,NE,SE,SW,NW]
   */
  con: ConnectionMask;

  weight: number;
}

// ============================================================
// CONNECTION GRID
// ============================================================

export type ConnectionCell = ConnectionCandidate | null;

export type ConnectionGrid = ConnectionCell[][];

// ============================================================
// DOT GRID
// ============================================================

/**
 * Keep your existing DotGrid definition if it already exists.
 *
 * The solver only needs to be able to ask:
 *
 *     isDot(row, col)
 *
 * so the adapter below can work with whatever Grid.ts currently
 * produces.
 */
export interface SolverGrid {
  width: number;
  height: number;

  isDot(row: number, col: number): boolean;
}

// ============================================================
// SYMMETRY ORBIT
// ============================================================
export type SymmetryTransformType = "identity" | "rotation" | "reflection";

export type ReflectionAxis =
  | "vertical"
  | "horizontal"
  | "diagonal1"
  | "diagonal2";

export interface SymmetryTransform {
  readonly type: SymmetryTransformType;

  /**
   * Clockwise 90° rotations:
   *
   * 0 = 0°
   * 1 = 90°
   * 2 = 180°
   * 3 = 270°
   */
  readonly rotation: 0 | 1 | 2 | 3;

  /**
   * Only present when type === "reflection".
   */
  readonly reflection?: ReflectionAxis;
}

export interface SymmetryCell {
  row: number;
  col: number;
  transform: SymmetryTransform;
}

export interface SymmetryOrbit {
  cells: SymmetryCell[];
}

// ============================================================
// SOLVER OPTIONS
// ============================================================

export interface ConnectionSolverOptions {
  grid: SolverGrid;

  islands: number;

  symmetry: Symmetry;

  families: ConnectionFamily[];

  maxBacktracks?: number;

  maxRestarts?: number;

  randomize?: boolean;

  /** Optional explicit seed for reproducible topology search. */
  seed?: number;
}

// ============================================================
// SOLVER RESULT
// ============================================================

export interface ConnectionSolverResult {
  success: boolean;

  grid: ConnectionGrid;

  backtracks: number;

  decisions: number;

  propagations: number;

  /**
   * Seed used for this generation.
   * Useful for reproducing bugs.
   */
  seed?: number;
}
