// TilePainter.ts

import type {
  Connection,
  Direction,
  DotGrid,
  Orientation,
  PlacedTile,
  Tile,
  TileGrid,
  KolamStyle,
} from "./types.js";

import { tiles, drawTile } from "./Tiles.js";

// ============================================================
// Direction setup
//
// IMPORTANT:
//
// Connection arrays are ALWAYS stored as:
//
// [N, E, S, W, NE, SE, SW, NW]
//
// This order is never changed.
//
// Canonical comparison uses a DIFFERENT reading order:
//
// [NW, N, NE, E, SE, S, SW, W]
//
// That order is used ONLY when deciding which rotation of a
// connection pattern is canonical.
// ============================================================

const directions: Direction[] = ["N", "E", "S", "W", "NE", "SE", "SW", "NW"];

const directionIndex: Record<Direction, number> = {
  N: 0,
  E: 1,
  S: 2,
  W: 3,
  NE: 4,
  SE: 5,
  SW: 6,
  NW: 7,
};

// Canonical comparison priority.
// DO NOT use this order for storing Connection[].
const canonicalComparisonOrder: Direction[] = [
  "NW",
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
];

const oppositeDirection: Record<Direction, Direction> = {
  N: "S",
  E: "W",
  S: "N",
  W: "E",

  NE: "SW",
  SE: "NW",
  SW: "NE",
  NW: "SE",
};

// ============================================================
// Grid offsets
// ============================================================

const directionOffset: Record<Direction, [number, number]> = {
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
// Orientation
// ============================================================

const orientations: Orientation[] = ["N", "E", "S", "W"];

// ============================================================
// Rotate connection pattern clockwise
//
// STORAGE ORDER:
//
// [N, E, S, W, NE, SE, SW, NW]
//
// After clockwise rotation:
//
// N <- W
// E <- N
// S <- E
// W <- S
//
// NE <- NW
// SE <- NE
// SW <- SE
// NW <- SW
//
// This function ALWAYS returns the same storage order.
// ============================================================

export const rotateConnectionClockwise = (conn: Connection[]): Connection[] => {
  if (conn.length !== 8) {
    throw new Error(
      `Invalid connection array length: ${conn.length}. Expected 8.`,
    );
  }

  return [
    conn[3], // N  <- W
    conn[0], // E  <- N
    conn[1], // S  <- E
    conn[2], // W  <- S

    conn[7], // NE <- NW
    conn[4], // SE <- NE
    conn[5], // SW <- SE
    conn[6], // NW <- SW
  ];
};

// ============================================================
// Rotate arbitrary number of times
// ============================================================

const rotateConnections = (
  conn: Connection[],
  rotations: number,
): Connection[] => {
  let result = [...conn];

  const count = ((rotations % 4) + 4) % 4;

  for (let i = 0; i < count; i++) {
    result = rotateConnectionClockwise(result);
  }

  return result;
};

// ============================================================
// Canonical comparison
//
// We DO NOT rearrange the actual array.
//
// Example:
//
// stored:
// [N, E, S, W, NE, SE, SW, NW]
//
// comparison:
// [NW, N, NE, E, SE, S, SW, W]
//
// We compare lexicographically, highest first.
// Since Connection values are currently 0/1/2, this works for
// all supported connection values.
// ============================================================

const getCanonicalScore = (conn: Connection[]): number[] => {
  return canonicalComparisonOrder.map(
    (direction) => conn[directionIndex[direction]],
  );
};

// ============================================================
// Compare two canonical scores
//
// Returns:
// > 0 if a is better
// < 0 if b is better
// = 0 if identical
// ============================================================

const compareCanonicalScores = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }

  return 0;
};

// ============================================================
// Find canonical rotation
//
// We generate all four rotations of the ORIGINAL tile pattern.
//
// The best one is the lexicographically greatest pattern when
// READ in:
//
// NW -> N -> NE -> E -> SE -> S -> SW -> W
//
// IMPORTANT:
//
// The returned pattern is STILL STORED as:
//
// [N,E,S,W,NE,SE,SW,NW]
// ============================================================

type CanonicalPattern = {
  conn_type: Connection[];
  rotation: number;
};

const getCanonicalPattern = (conn: Connection[]): CanonicalPattern => {
  let bestPattern = [...conn];
  let bestRotation = 0;

  let bestScore = getCanonicalScore(bestPattern);

  for (let rotation = 1; rotation < 4; rotation++) {
    const candidate = rotateConnections(conn, rotation);

    const candidateScore = getCanonicalScore(candidate);

    if (compareCanonicalScores(candidateScore, bestScore) > 0) {
      bestPattern = candidate;
      bestScore = candidateScore;
      bestRotation = rotation;
    }
  }

  return {
    conn_type: bestPattern,
    rotation: bestRotation,
  };
};

// ============================================================
// Get canonical information for a tile
//
// We intentionally derive this from tile.con rather than blindly
// trusting tile.conn_type.
//
// This protects the solver from malformed / stale conn_type data
// and makes the canonicalization rule explicit in one place.
// ============================================================

const getTileCanonicalPattern = (tile: Tile): CanonicalPattern => {
  return getCanonicalPattern(tile.con);
};

// ============================================================
// Rotate tile into an actual placement
//
// There are TWO rotations involved:
//
// 1. canonicalRotation
//    Converts the tile's original geometry into its canonical
//    orientation.
//
// 2. placementRotation
//    Rotates that canonical tile into the desired orientation.
//
// Therefore:
//
// actual geometry rotation =
// canonicalRotation + placementRotation
//
// The resulting `con` is ALWAYS stored in:
//
// [N,E,S,W,NE,SE,SW,NW]
// ============================================================

const rotateTile = (tile: Tile, placementRotation: number): PlacedTile => {
  const canonical = getTileCanonicalPattern(tile);

  const actualConnections = rotateConnections(
    canonical.conn_type,
    placementRotation,
  );

  const totalRotation = (canonical.rotation + placementRotation) % 4;

  return {
    id: tile.id,

    name: tile.name,

    orientation: orientations[totalRotation],

    con: actualConnections,

    // Canonical representation.
    conn_type: [...canonical.conn_type],
  };
};

// ============================================================
// 4-fold coordinate rotation
//
// (row, col)
//       |
//       v
// (col, size - 1 - row)
// ============================================================

const rotatePosition90 = (
  row: number,
  col: number,
  size: number,
): [number, number] => {
  return [col, size - 1 - row];
};

// ============================================================
// Get complete 4-fold orbit
// ============================================================

const getOrbit4Fold = (
  row: number,
  col: number,
  size: number,
): [number, number][] => {
  const orbit: [number, number][] = [];

  let currentRow = row;
  let currentCol = col;

  for (let i = 0; i < 4; i++) {
    const exists = orbit.some(([r, c]) => r === currentRow && c === currentCol);

    if (!exists) {
      orbit.push([currentRow, currentCol]);
    }

    [currentRow, currentCol] = rotatePosition90(currentRow, currentCol, size);
  }

  return orbit;
};

// ============================================================
// Canonical orbit anchor
// ============================================================

const getOrbitAnchor = (
  row: number,
  col: number,
  size: number,
): [number, number] => {
  const orbit = getOrbit4Fold(row, col, size);

  orbit.sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2);

  return orbit[0];
};

const isOrbitAnchor = (row: number, col: number, size: number): boolean => {
  const [anchorRow, anchorCol] = getOrbitAnchor(row, col, size);

  return row === anchorRow && col === anchorCol;
};

// ============================================================
// Validate 4-fold dot symmetry
// ============================================================

const has4FoldSymmetry = (grid: DotGrid): boolean => {
  const height = grid.length;

  if (height === 0) {
    return false;
  }

  const width = grid[0].length;

  if (width === 0) {
    return false;
  }

  if (height !== width) {
    return false;
  }

  for (let row = 0; row < height; row++) {
    if (grid[row].length !== width) {
      return false;
    }

    for (let col = 0; col < width; col++) {
      const [rotatedRow, rotatedCol] = rotatePosition90(row, col, width);

      if (grid[row][col] !== grid[rotatedRow][rotatedCol]) {
        return false;
      }
    }
  }

  return true;
};

// ============================================================
// Check if a connection exists
// ============================================================

const hasConnection = (value: Connection): boolean => {
  return value > 0;
};

// ============================================================
// Check tile at one position
//
// Rules:
//
// 1. Position itself must be a dot.
// 2. A connection cannot leave the grid.
// 3. A connection cannot point to a missing dot.
// 4. If neighbour exists but isn't solved yet, connection is
//    temporarily allowed.
// 5. If neighbour is already solved, connections must match.
// ============================================================

const tileFitsAt = (
  grid: DotGrid,
  filled: TileGrid,
  row: number,
  col: number,
  tile: PlacedTile,
): boolean => {
  if (grid[row]?.[col] !== 1) {
    return false;
  }

  for (const direction of directions) {
    const index = directionIndex[direction];

    const [dr, dc] = directionOffset[direction];

    const nr = row + dr;
    const nc = col + dc;

    const value = tile.con[index];

    // --------------------------------------------------------
    // Outside grid
    // --------------------------------------------------------

    if (nr < 0 || nr >= grid.length || nc < 0 || nc >= grid[0].length) {
      if (hasConnection(value)) {
        return false;
      }

      continue;
    }

    // --------------------------------------------------------
    // Missing dot
    // --------------------------------------------------------

    if (grid[nr][nc] !== 1) {
      if (hasConnection(value)) {
        return false;
      }

      continue;
    }

    // --------------------------------------------------------
    // Neighbour exists but isn't solved yet.
    // --------------------------------------------------------

    const neighbour = filled[nr][nc];

    if (!neighbour) {
      continue;
    }

    // --------------------------------------------------------
    // Already solved neighbour.
    // --------------------------------------------------------

    const neighbourIndex = directionIndex[oppositeDirection[direction]];

    if (value !== neighbour.con[neighbourIndex]) {
      return false;
    }
  }

  return true;
};

// ============================================================
// Symmetric placement
// ============================================================

type Placement = {
  row: number;
  col: number;
  tile: PlacedTile;
};

// ============================================================
// Create the complete 4-fold tile group
//
// A tile rotated clockwise around the symmetry center must also
// rotate its connection pattern clockwise.
//
// This is why we create each placement using:
//
// placementRotation + symmetryRotation
// ============================================================

const createSymmetricPlacements = (
  row: number,
  col: number,
  tile: Tile,
  placementRotation: number,
  size: number,
): Placement[] => {
  const placements: Placement[] = [];

  let currentRow = row;
  let currentCol = col;

  for (let symmetryRotation = 0; symmetryRotation < 4; symmetryRotation++) {
    const exists = placements.some(
      (placement) =>
        placement.row === currentRow && placement.col === currentCol,
    );

    if (!exists) {
      const totalRotation = (placementRotation + symmetryRotation) % 4;

      placements.push({
        row: currentRow,
        col: currentCol,
        tile: rotateTile(tile, totalRotation),
      });
    }

    [currentRow, currentCol] = rotatePosition90(currentRow, currentCol, size);
  }

  return placements;
};

// ============================================================
// Check group
// ============================================================

const symmetricGroupFits = (
  grid: DotGrid,
  filled: TileGrid,
  placements: Placement[],
): boolean => {
  // ----------------------------------------------------------
  // All positions must be valid dots.
  // ----------------------------------------------------------

  for (const placement of placements) {
    if (grid[placement.row]?.[placement.col] !== 1) {
      return false;
    }

    // Don't overwrite an existing tile.
    if (filled[placement.row][placement.col]) {
      return false;
    }
  }

  // ----------------------------------------------------------
  // Check every tile against the already solved grid.
  // ----------------------------------------------------------

  for (const placement of placements) {
    if (
      !tileFitsAt(grid, filled, placement.row, placement.col, placement.tile)
    ) {
      return false;
    }
  }

  // ----------------------------------------------------------
  // Check connections BETWEEN tiles in this group.
  //
  // They haven't been placed into `filled` yet, so this must
  // be checked separately.
  // ----------------------------------------------------------

  for (const placement of placements) {
    for (const direction of directions) {
      const index = directionIndex[direction];

      const [dr, dc] = directionOffset[direction];

      const nr = placement.row + dr;

      const nc = placement.col + dc;

      const neighbour = placements.find(
        (candidate) => candidate.row === nr && candidate.col === nc,
      );

      if (!neighbour) {
        continue;
      }

      const neighbourIndex = directionIndex[oppositeDirection[direction]];

      if (placement.tile.con[index] !== neighbour.tile.con[neighbourIndex]) {
        return false;
      }
    }
  }

  return true;
};

// ============================================================
// Place group
// ============================================================

const placeGroup = (filled: TileGrid, placements: Placement[]): void => {
  for (const placement of placements) {
    filled[placement.row][placement.col] = placement.tile;
  }
};

// ============================================================
// Remove group
// ============================================================

const removeGroup = (filled: TileGrid, placements: Placement[]): void => {
  for (const placement of placements) {
    filled[placement.row][placement.col] = null;
  }
};

// ============================================================
// Fisher-Yates shuffle
// ============================================================

const shuffle = <T>(array: T[]): T[] => {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
};

// ============================================================
// Tile ordering
//
// IMPORTANT:
//
// Circle is deliberately placed LAST.
//
// This means:
//
// - We still allow circles.
// - We don't make them impossible.
// - A non-circle solution will always be preferred when one
//   exists at the current search point.
//
// This is much stronger than simply giving circle a slightly
// smaller random probability.
// ============================================================

const getCandidateTiles = (): Tile[] => {
  const nonCircles = tiles.filter((tile) => tile.name !== "circle");

  const circles = tiles.filter((tile) => tile.name === "circle");

  return [...shuffle(nonCircles), ...shuffle(circles)];
};

// ============================================================
// Find next symmetry group
//
// Uses a constraint heuristic instead of simply scanning from
// top-left.
//
// We prefer a group whose positions already have the most
// neighbouring solved tiles.
//
// This greatly reduces blind backtracking.
// ============================================================

const findNextGroup = (
  grid: DotGrid,
  filled: TileGrid,
): [number, number] | null => {
  const size = grid.length;

  let best: [number, number] | null = null;

  let bestConstraintScore = -1;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (grid[row][col] !== 1) {
        continue;
      }

      if (filled[row][col]) {
        continue;
      }

      if (!isOrbitAnchor(row, col, size)) {
        continue;
      }

      const orbit = getOrbit4Fold(row, col, size);

      let score = 0;

      for (const [orbitRow, orbitCol] of orbit) {
        for (const direction of directions) {
          const [dr, dc] = directionOffset[direction];

          const nr = orbitRow + dr;

          const nc = orbitCol + dc;

          if (nr < 0 || nr >= size || nc < 0 || nc >= size) {
            continue;
          }

          if (filled[nr][nc]) {
            score++;
          }
        }
      }

      if (score > bestConstraintScore) {
        bestConstraintScore = score;

        best = [row, col];
      }
    }
  }

  return best;
};

// ============================================================
// Validate final grid
//
// IMPORTANT:
//
// We validate ACTUAL `con`, not `conn_type`.
//
// `conn_type` is canonical metadata.
// `con` is what is physically present after rotation.
// ============================================================

const validateFinalGrid = (grid: DotGrid, filled: TileGrid): boolean => {
  const size = grid.length;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (grid[row][col] === 0) {
        continue;
      }

      const tile = filled[row][col];

      if (!tile) {
        return false;
      }

      // ------------------------------------------------------
      // Non-circle tiles must actually have a connection.
      // ------------------------------------------------------

      const hasAnyConnection = tile.con.some(hasConnection);

      if (tile.name !== "circle" && !hasAnyConnection) {
        return false;
      }

      // ------------------------------------------------------
      // Validate every direction.
      // ------------------------------------------------------

      for (const direction of directions) {
        const index = directionIndex[direction];

        const [dr, dc] = directionOffset[direction];

        const nr = row + dr;

        const nc = col + dc;

        const value = tile.con[index];

        // ----------------------------------------------------
        // Outside grid.
        //
        // An active connection may NEVER leave the grid.
        // ----------------------------------------------------

        if (nr < 0 || nr >= size || nc < 0 || nc >= size) {
          if (hasConnection(value)) {
            return false;
          }

          continue;
        }

        // ----------------------------------------------------
        // Missing dot.
        // ----------------------------------------------------

        if (grid[nr][nc] !== 1) {
          if (hasConnection(value)) {
            return false;
          }

          continue;
        }

        // ----------------------------------------------------
        // Every neighbouring dot must have a tile.
        // ----------------------------------------------------

        const neighbour = filled[nr][nc];

        if (!neighbour) {
          return false;
        }

        // ----------------------------------------------------
        // Connection must match.
        // ----------------------------------------------------

        const neighbourIndex = directionIndex[oppositeDirection[direction]];

        if (value !== neighbour.con[neighbourIndex]) {
          return false;
        }
      }
    }
  }

  // ----------------------------------------------------------
  // Ensure the result itself is 4-fold symmetric.
  //
  // Both the occupied pattern and the connection state must
  // rotate consistently.
  // ----------------------------------------------------------

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const [rr, cc] = rotatePosition90(row, col, size);

      const a = filled[row][col];

      const b = filled[rr][cc];

      if (Boolean(a) !== Boolean(b)) {
        return false;
      }
    }
  }

  return true;
};

// ============================================================
// Recursive solver
// ============================================================

const solve4Fold = (grid: DotGrid, filled: TileGrid): boolean => {
  const next = findNextGroup(grid, filled);

  // ----------------------------------------------------------
  // Nothing left to solve.
  // ----------------------------------------------------------

  if (!next) {
    return validateFinalGrid(grid, filled);
  }

  const [row, col] = next;

  const size = grid.length;

  // ----------------------------------------------------------
  // Non-circles first.
  //
  // Circle is only reached after every other tile candidate
  // has failed for this branch.
  // ----------------------------------------------------------

  const candidateTiles = getCandidateTiles();

  for (const tile of candidateTiles) {
    // --------------------------------------------------------
    // Try all four orientations.
    //
    // We shuffle the starting rotation slightly so repeated
    // generations don't always have the exact same structure.
    // --------------------------------------------------------

    const rotations = shuffle([0, 1, 2, 3]);

    for (const rotation of rotations) {
      const placements = createSymmetricPlacements(
        row,
        col,
        tile,
        rotation,
        size,
      );

      // ------------------------------------------------------
      // Entire group must fit before touching the grid.
      // ------------------------------------------------------

      if (!symmetricGroupFits(grid, filled, placements)) {
        continue;
      }

      // ------------------------------------------------------
      // Place group.
      // ------------------------------------------------------

      placeGroup(filled, placements);

      // ------------------------------------------------------
      // Continue recursively.
      // ------------------------------------------------------

      if (solve4Fold(grid, filled)) {
        return true;
      }

      // ------------------------------------------------------
      // Contradiction.
      //
      // Undo the WHOLE symmetry group.
      // ------------------------------------------------------

      removeGroup(filled, placements);
    }
  }

  return false;
};

// ============================================================
// Public generator
// ============================================================

export const generateTileGrid4Fold = (grid: DotGrid): TileGrid => {
  const size = grid.length;

  if (size === 0) {
    throw new Error("Cannot generate a tile grid from an empty dot grid.");
  }

  if (grid[0].length !== size) {
    throw new Error("4-fold tile generation requires a square grid.");
  }

  if (!has4FoldSymmetry(grid)) {
    throw new Error("Dot grid does not have 4-fold rotational symmetry.");
  }

  const filled: TileGrid = Array.from(
    {
      length: size,
    },
    () => Array<PlacedTile | null>(size).fill(null),
  );

  const success = solve4Fold(grid, filled);

  if (!success) {
    throw new Error(
      "Could not construct a valid 4-fold Kolam from this dot grid.",
    );
  }

  return filled;
};

// ============================================================
// Canvas Painter
// ============================================================
//
// `debug = false` by default.
//
// The UI can pass `true` when the user enables the debug
// connection-point toggle.
//
// Pseudo/connection points are therefore NEVER part of the
// normal Kolam output.
// ============================================================

export const paintTileGrid = (
  ctx: CanvasRenderingContext2D,
  grid: TileGrid,
  tileSize: number,
  debug = false,
  style?: KolamStyle,
): void => {
  const height = grid.length;
  const width = Math.max(0, ...grid.map((row) => row.length));

  const bg = style?.backgroundColor ?? "#ffffff";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const offsetX = (ctx.canvas.width - width * tileSize) / 2;

  const offsetY = (ctx.canvas.height - height * tileSize) / 2;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const placed = grid[row][col];

      if (!placed) {
        continue;
      }

      const tile = tiles.find((candidate) => candidate.id === placed.id);

      if (!tile) {
        throw new Error(`Tile ID ${placed.id} not found.`);
      }

      const x = offsetX + col * tileSize + tileSize / 2;

      const y = offsetY + row * tileSize + tileSize / 2;

      drawTile(
        ctx,
        {
          ...tile,
          orientation: placed.orientation,
        },
        x,
        y,
        tileSize,
        debug,
        style,
      );
    }
  }
};

/** Backward-compatible name retained for the original square D4 demo. */
export const paintTileGrid4Fold = (
  ctx: CanvasRenderingContext2D,
  grid: TileGrid,
  tileSize: number,
  debug = false,
  style?: KolamStyle,
): void => paintTileGrid(ctx, grid, tileSize, debug, style);
