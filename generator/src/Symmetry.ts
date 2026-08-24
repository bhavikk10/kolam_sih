import type {
  ConnectionMask,
  Direction,
  Orientation,
  Symmetry,
  SymmetryCell,
  SymmetryOrbit,
} from "./types";

// ============================================================
// Symmetry
//
// Grid coordinate system:
//
//        col →
//
// row  0  [ ][ ][ ]
//  ↓   1  [ ][ ][ ]
//      2  [ ][ ][ ]
//
// Directions:
//
//              N
//              ↑
//              |
//        W ←───●───→ E
//              |
//              ↓
//              S
//
// Diagonals:
//
//        NW      NE
//          \    /
//           \  /
//            ●
//           /  \
//        SW      SE
//
// Connection storage order is ALWAYS:
//
// [N, E, S, W, NE, SE, SW, NW]
//
// ============================================================

// ============================================================
// Direction order
// ============================================================

export const SYMMETRY_DIRECTIONS: Direction[] = [
  "N",
  "E",
  "S",
  "W",
  "NE",
  "SE",
  "SW",
  "NW",
];

export const SYMMETRY_ORIENTATIONS: Orientation[] = ["N", "E", "S", "W"];

// ============================================================
// Direction vectors
// ============================================================

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
// Transform representation
// ============================================================
//
// A symmetry transformation is represented by:
//
//   1. A coordinate transform
//   2. A direction transform
//
// This is important because a mirror is NOT equivalent to
// a rotation.
//
// Example:
//
// Mirror_V:
//
//     E → W
//     W → E
//     N → N
//     S → S
//     NE → NW
//     NW → NE
//     SE → SW
//     SW → SE
//
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
   * Number of clockwise 90° rotations.
   *
   * Used by rotation transforms.
   *
   * 0 = 0°
   * 1 = 90°
   * 2 = 180°
   * 3 = 270°
   */
  readonly rotation: 0 | 1 | 2 | 3;

  /**
   * Reflection axis.
   *
   * Only present for reflection transforms.
   */
  readonly reflection?: ReflectionAxis;
}

// ============================================================
// Cell transform
// ============================================================

export interface SymmetryMappedCell {
  row: number;
  col: number;

  /**
   * Transformation which maps the source cell and its
   * connection directions to this cell.
   */
  transform: SymmetryTransform;
}

// ============================================================
// Internal helpers
// ============================================================

const mod4 = (value: number): 0 | 1 | 2 | 3 => {
  const normalized = ((value % 4) + 4) % 4;

  return normalized as 0 | 1 | 2 | 3;
};

const isSquareRequired = (symmetry: Symmetry): boolean => {
  return (
    symmetry === "Rotational_4Fold" ||
    symmetry === "Mirror_Diagonal1" ||
    symmetry === "Mirror_Diagonal2"
  );
};

// ============================================================
// Transform constructors
// ============================================================

export const IDENTITY_TRANSFORM: SymmetryTransform = {
  type: "identity",
  rotation: 0,
};

const rotationTransform = (rotation: 0 | 1 | 2 | 3): SymmetryTransform => ({
  type: "rotation",
  rotation,
});

const reflectionTransform = (
  reflection: ReflectionAxis,
): SymmetryTransform => ({
  type: "reflection",
  rotation: 0,
  reflection,
});

// ============================================================
// Coordinate transformation
// ============================================================

export const transformCell = (
  row: number,
  col: number,
  width: number,
  height: number,
  transform: SymmetryTransform,
): [number, number] => {
  switch (transform.type) {
    // --------------------------------------------------------
    // Identity
    // --------------------------------------------------------

    case "identity":
      return [row, col];

    // --------------------------------------------------------
    // Rotation
    // --------------------------------------------------------

    case "rotation": {
      switch (transform.rotation) {
        // 0°
        case 0:
          return [row, col];

        // 90° clockwise
        case 1:
          return [col, height - 1 - row];

        // 180°
        case 2:
          return [height - 1 - row, width - 1 - col];

        // 270° clockwise
        case 3:
          return [width - 1 - col, row];
      }
    }

    // --------------------------------------------------------
    // Reflection
    // --------------------------------------------------------

    case "reflection": {
      switch (transform.reflection) {
        // x -> -x
        //
        // left <-> right
        //
        // E <-> W
        //
        case "vertical":
          return [row, width - 1 - col];

        // y -> -y
        //
        // top <-> bottom
        //
        // N <-> S
        //
        case "horizontal":
          return [height - 1 - row, col];

        // Main diagonal:
        //
        //     \
        //      \
        //
        // row <-> col
        //
        case "diagonal1":
          return [col, row];

        // Anti-diagonal:
        //
        //       /
        //      /
        //
        case "diagonal2":
          return [height - 1 - col, width - 1 - row];
      }
    }

    default:
      throw new Error(`Unknown transform type: ${transform.type}`);
  }
};

// ============================================================
// Direction transformation
// ============================================================

const rotateDirection = (
  direction: Direction,
  turns: 0 | 1 | 2 | 3,
): Direction => {
  const cardinal: Direction[] = ["N", "E", "S", "W"];

  const diagonal: Direction[] = ["NE", "SE", "SW", "NW"];

  if (direction.length === 1) {
    const index = cardinal.indexOf(direction);

    return cardinal[mod4(index + turns)];
  }

  const index = diagonal.indexOf(direction);

  return diagonal[mod4(index + turns)];
};

const reflectDirection = (
  direction: Direction,
  axis: ReflectionAxis,
): Direction => {
  switch (axis) {
    // --------------------------------------------------------
    // Vertical reflection
    //
    // E <-> W
    // NE <-> NW
    // SE <-> SW
    // --------------------------------------------------------

    case "vertical":
      switch (direction) {
        case "N":
          return "N";

        case "E":
          return "W";

        case "S":
          return "S";

        case "W":
          return "E";

        case "NE":
          return "NW";

        case "SE":
          return "SW";

        case "SW":
          return "SE";

        case "NW":
          return "NE";
      }

    // --------------------------------------------------------
    // Horizontal reflection
    //
    // N <-> S
    // NE <-> SE
    // NW <-> SW
    // --------------------------------------------------------

    case "horizontal":
      switch (direction) {
        case "N":
          return "S";

        case "E":
          return "E";

        case "S":
          return "N";

        case "W":
          return "W";

        case "NE":
          return "SE";

        case "SE":
          return "NE";

        case "SW":
          return "NW";

        case "NW":
          return "SW";
      }

    // --------------------------------------------------------
    // Main diagonal
    //
    // N <-> W
    // E <-> S
    //
    // NE, SE, SW, NW remain on their respective diagonal
    // axes.
    // --------------------------------------------------------

    case "diagonal1":
      switch (direction) {
        case "N":
          return "W";

        case "E":
          return "S";

        case "S":
          return "E";

        case "W":
          return "N";

        case "NE":
          return "SW";

        case "SE":
          return "SE";

        case "SW":
          return "NE";

        case "NW":
          return "NW";
      }

    // --------------------------------------------------------
    // Anti-diagonal
    //
    // N <-> E
    // S <-> W
    // --------------------------------------------------------

    case "diagonal2":
      switch (direction) {
        case "N":
          return "E";

        case "E":
          return "N";

        case "S":
          return "W";

        case "W":
          return "S";

        case "NE":
          return "NE";

        case "SE":
          return "NW";

        case "SW":
          return "SW";

        case "NW":
          return "SE";
      }
  }
};

// ============================================================
// Transform a direction
// ============================================================

export const transformDirection = (
  direction: Direction,
  transform: SymmetryTransform,
): Direction => {
  if (transform.type === "reflection") {
    if (!transform.reflection) {
      throw new Error("Reflection transform is missing its axis.");
    }

    return reflectDirection(direction, transform.reflection);
  }

  return rotateDirection(direction, transform.rotation);
};

// ============================================================
// Transform a connection mask
// ============================================================
//
// IMPORTANT:
//
// Input and output ALWAYS use:
//
// [N,E,S,W,NE,SE,SW,NW]
//
// No alternative bit ordering is ever used.
//
// ============================================================

export const transformConnectionMask = (
  mask: ConnectionMask,
  transform: SymmetryTransform,
): ConnectionMask => {
  const result = [0, 0, 0, 0, 0, 0, 0, 0] as ConnectionMask;

  for (
    let sourceIndex = 0;
    sourceIndex < SYMMETRY_DIRECTIONS.length;
    sourceIndex++
  ) {
    const sourceDirection = SYMMETRY_DIRECTIONS[sourceIndex];

    const targetDirection = transformDirection(sourceDirection, transform);

    const targetIndex = SYMMETRY_DIRECTIONS.indexOf(targetDirection);

    result[targetIndex] = mask[sourceIndex];
  }

  return result;
};

// ============================================================
// Transform orientation
// ============================================================
//
// This is useful for rotational symmetry.
//
// For reflections, orientation alone cannot fully describe
// the transformed geometry. A reflected geometry is potentially
// a different visual transformation.
//
// Therefore:
//
//     rotation -> orientation can be transformed
//     reflection -> caller should retain reflection metadata
//
// ============================================================

export const transformOrientation = (
  orientation: Orientation,
  transform: SymmetryTransform,
): Orientation => {
  if (transform.type === "reflection") {
    /*
     * Reflection of a canonical orientation is not generally
     * representable as a simple rotation.
     *
     * We therefore return the orientation after applying the
     * reflected direction to the canonical N axis.
     *
     * The solver should primarily use transformConnectionMask().
     * Rendering can later use the complete transform metadata.
     */

    const transformed = transformDirection(
      orientationToDirection(orientation),
      transform,
    );

    return directionToOrientation(transformed);
  }

  return orientationFromTurns(
    orientationToTurns(orientation) + transform.rotation,
  );
};

// ============================================================
// Orientation helpers
// ============================================================

const orientationToTurns = (orientation: Orientation): 0 | 1 | 2 | 3 => {
  switch (orientation) {
    case "N":
      return 0;

    case "E":
      return 1;

    case "S":
      return 2;

    case "W":
      return 3;
  }
};

const orientationFromTurns = (turns: number): Orientation => {
  switch (mod4(turns)) {
    case 0:
      return "N";

    case 1:
      return "E";

    case 2:
      return "S";

    case 3:
      return "W";
  }
};

const orientationToDirection = (orientation: Orientation): Direction => {
  return orientation;
};

const directionToOrientation = (direction: Direction): Orientation => {
  switch (direction) {
    case "N":
      return "N";

    case "E":
      return "E";

    case "S":
      return "S";

    case "W":
      return "W";

    /*
     * An orientation is cardinal by definition.
     *
     * These cases should never be reached because the
     * orientation transformation starts from N/E/S/W.
     */
    default:
      throw new Error(
        `Cannot convert diagonal direction ${direction} to orientation.`,
      );
  }
};

// ============================================================
// Symmetry -> generating transforms
// ============================================================

export const getSymmetryTransforms = (
  symmetry: Symmetry,
): SymmetryTransform[] => {
  switch (symmetry) {
    case "None":
      return [IDENTITY_TRANSFORM];

    case "Rotational_1Fold":
      /*
       * One-fold rotational symmetry is the identity.
       *
       * It is retained as a separate public symmetry mode
       * because it is part of the application's API.
       */
      return [IDENTITY_TRANSFORM];

    case "Rotational_2Fold":
      return [IDENTITY_TRANSFORM, rotationTransform(2)];

    case "Rotational_4Fold":
      return [
        IDENTITY_TRANSFORM,
        rotationTransform(1),
        rotationTransform(2),
        rotationTransform(3),
      ];

    case "Mirror_V":
      return [IDENTITY_TRANSFORM, reflectionTransform("vertical")];

    case "Mirror_H":
      return [IDENTITY_TRANSFORM, reflectionTransform("horizontal")];

    case "Mirror_Diagonal1":
      return [IDENTITY_TRANSFORM, reflectionTransform("diagonal1")];

    case "Mirror_Diagonal2":
      return [IDENTITY_TRANSFORM, reflectionTransform("diagonal2")];
  }
};

// ============================================================
// Validate symmetry against grid dimensions
// ============================================================

export const validateSymmetryDimensions = (
  width: number,
  height: number,
  symmetry: Symmetry,
): void => {
  if (width <= 0 || height <= 0) {
    throw new Error("Grid dimensions must be greater than zero.");
  }

  if (isSquareRequired(symmetry) && width !== height) {
    throw new Error(`${symmetry} requires a square grid.`);
  }
};

// ============================================================
// Cell key
// ============================================================

const cellKey = (row: number, col: number): string => `${row},${col}`;

// ============================================================
// Build a symmetry orbit for one cell
// ============================================================

export const getSymmetryOrbit = (
  row: number,
  col: number,
  width: number,
  height: number,
  symmetry: Symmetry,
): SymmetryOrbit => {
  validateSymmetryDimensions(width, height, symmetry);

  const transforms = getSymmetryTransforms(symmetry);

  const cells: SymmetryCell[] = [];

  const seen = new Set<string>();

  for (const transform of transforms) {
    const [mappedRow, mappedCol] = transformCell(
      row,
      col,
      width,
      height,
      transform,
    );

    const key = cellKey(mappedRow, mappedCol);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    cells.push({
      row: mappedRow,
      col: mappedCol,
      transform,
    });
  }

  return {
    cells,
  };
};

// ============================================================
// Build every orbit in the grid
// ============================================================

export const buildSymmetryOrbits = (
  width: number,
  height: number,
  symmetry: Symmetry,
): SymmetryOrbit[] => {
  validateSymmetryDimensions(width, height, symmetry);

  const orbits: SymmetryOrbit[] = [];

  const assigned = new Set<string>();

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const startKey = cellKey(row, col);

      if (assigned.has(startKey)) {
        continue;
      }

      const orbit = getSymmetryOrbit(row, col, width, height, symmetry);

      for (const cell of orbit.cells) {
        assigned.add(cellKey(cell.row, cell.col));
      }

      orbits.push(orbit);
    }
  }

  return orbits;
};

// ============================================================
// Find the orbit containing a particular cell
// ============================================================

export const findSymmetryOrbit = (
  row: number,
  col: number,
  orbits: SymmetryOrbit[],
): SymmetryOrbit | undefined => {
  const key = cellKey(row, col);

  return orbits.find((orbit) =>
    orbit.cells.some((cell) => cellKey(cell.row, cell.col) === key),
  );
};

// ============================================================
// Transform one candidate mask through an orbit transform
// ============================================================
//
// This is the function the CSP solver should eventually call.
//
// Example:
//
// canonical:
//     N + E
//
// 90° rotation:
//     E + S
//
// Vertical mirror:
//     N + W
//
// ============================================================

export const transformCandidateMask = (
  mask: ConnectionMask,
  cell: SymmetryCell,
): ConnectionMask => {
  return transformConnectionMask(mask, cell.transform);
};

// ============================================================
// Validate an entire orbit against a dot grid
// ============================================================

export interface SymmetryDotGrid {
  width: number;
  height: number;

  isDot(row: number, col: number): boolean;
}

export const isOrbitCompatibleWithDotGrid = (
  orbit: SymmetryOrbit,
  grid: SymmetryDotGrid,
): boolean => {
  if (orbit.cells.length === 0) {
    return true;
  }

  const first = orbit.cells[0];

  const expected = grid.isDot(first.row, first.col);

  for (const cell of orbit.cells) {
    if (grid.isDot(cell.row, cell.col) !== expected) {
      return false;
    }
  }

  return true;
};

// ============================================================
// Validate all orbits against a dot grid
// ============================================================

export const validateSymmetryGrid = (
  grid: SymmetryDotGrid,
  symmetry: Symmetry,
): SymmetryOrbit[] => {
  const orbits = buildSymmetryOrbits(grid.width, grid.height, symmetry);

  for (const orbit of orbits) {
    if (!isOrbitCompatibleWithDotGrid(orbit, grid)) {
      throw new Error(`Dot grid violates ${symmetry} symmetry.`);
    }
  }

  return orbits;
};
