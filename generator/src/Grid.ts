import type { DotGrid, Symmetry } from "./types.js";
import { buildSymmetryOrbits, validateSymmetryDimensions } from "./Symmetry.js";

// ============================================================
// Generate Dot Grid
// ============================================================
//
// The dot grid is generated BEFORE the connection solver.
//
// Important invariant:
//
//   countIslands(grid) === islands
//
// uses 8-neighbour connectivity, exactly like the connection
// solver's graph/component logic.
//
// Symmetry is handled at the ORBIT level rather than by placing
// random dots and hoping the final shape happens to be valid.
//
// For symmetric grids, an orbit is an indivisible group of cells.
// Selecting an orbit means selecting every symmetric counterpart.
//
// ============================================================

type Cell = readonly [number, number];

const EIGHT_NEIGHBOURS: readonly Cell[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

const cellKey = (row: number, col: number): string => `${row},${col}`;

const shuffle = <T>(items: readonly T[]): T[] => {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
};

const insideGrid = (
  row: number,
  col: number,
  width: number,
  height: number,
): boolean => {
  return row >= 0 && row < height && col >= 0 && col < width;
};

// ============================================================
// Symmetry orbit generation
// ============================================================
//
// Delegates to Symmetry.ts to ensure consistent and correct
// orbit coordinates across all 8 symmetry modes.
//

const buildOrbits = (
  width: number,
  height: number,
  symmetry: Symmetry,
): Cell[][] => {
  validateSymmetryDimensions(width, height, symmetry);
  const symmetryOrbits = buildSymmetryOrbits(width, height, symmetry);
  return symmetryOrbits.map((orbit) =>
    orbit.cells.map((cell) => [cell.row, cell.col] as Cell),
  );
};

// ============================================================
// Grid helpers
// ============================================================

const emptyGrid = (width: number, height: number): DotGrid => {
  return Array.from({ length: height }, () => Array(width).fill(0));
};

const cloneGrid = (grid: DotGrid): DotGrid => {
  return grid.map((row) => [...row]);
};

const setOrbit = (
  grid: DotGrid,
  orbit: readonly Cell[],
  value: 0 | 1,
): void => {
  for (const [row, col] of orbit) {
    grid[row][col] = value;
  }
};

const orbitFitsDotBudget = (
  grid: DotGrid,
  orbit: readonly Cell[],
  remainingDots: number,
): boolean => {
  let newDots = 0;

  for (const [row, col] of orbit) {
    if (grid[row][col] === 0) {
      newDots++;
    }
  }

  return newDots <= remainingDots;
};

// ============================================================
// Connectivity helpers
// ============================================================

const orbitTouchesGrid = (grid: DotGrid, orbit: readonly Cell[]): boolean => {
  const height = grid.length;
  const width = grid[0].length;

  for (const [row, col] of orbit) {
    for (const [dr, dc] of EIGHT_NEIGHBOURS) {
      const nr = row + dr;
      const nc = col + dc;

      if (!insideGrid(nr, nc, width, height)) {
        continue;
      }

      if (grid[nr][nc] === 1) {
        return true;
      }
    }
  }

  return false;
};

// ============================================================
// Invariant helpers
// ============================================================
//
// These are the internal checks that keep the public invariant
// honest:
//
//   countDots(grid)     === number of 1 cells
//   countIslands(grid)  === 8-connected component count
//   hasSymmetry(grid)   === every orbit is all-0 or all-1
//
// 8-neighbour connectivity is used here, matching the connection
// solver's graph/component logic exactly.
//

export const countDots = (grid: DotGrid): number => {
  let total = 0;

  for (const row of grid) {
    for (const cell of row) {
      if (cell === 1) {
        total++;
      }
    }
  }

  return total;
};

export const countIslands = (grid: DotGrid): number => {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const visited = new Set<string>();

  let islands = 0;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (grid[row][col] !== 1) {
        continue;
      }

      const key = cellKey(row, col);

      if (visited.has(key)) {
        continue;
      }

      islands++;

      const queue: Cell[] = [[row, col]];
      visited.add(cellKey(row, col));

      while (queue.length > 0) {
        const [cr, cc] = queue.pop()!;

        for (const [dr, dc] of EIGHT_NEIGHBOURS) {
          const nr = cr + dr;
          const nc = cc + dc;

          if (!insideGrid(nr, nc, width, height)) {
            continue;
          }

          if (grid[nr][nc] !== 1) {
            continue;
          }

          const nKey = cellKey(nr, nc);

          if (visited.has(nKey)) {
            continue;
          }

          visited.add(nKey);
          queue.push([nr, nc]);
        }
      }
    }
  }

  return islands;
};

export const hasSymmetry = (grid: DotGrid, symmetry: Symmetry): boolean => {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const orbits = buildOrbits(width, height, symmetry);

  for (const orbit of orbits) {
    const first = grid[orbit[0][0]]?.[orbit[0][1]];

    for (const [row, col] of orbit) {
      if (grid[row]?.[col] !== first) {
        return false;
      }
    }
  }

  return true;
};

// ============================================================
// Generate a single connected component
// ============================================================
//
// This is the critical fix for the original bug.
//
// We don't randomly scatter dots and hope they connect.
//
// We start with one seed and grow the component by adding
// neighbouring cells/orbits.
//

const growConnectedGrid = (
  width: number,
  height: number,
  dots: number,
  symmetry: Symmetry,
): DotGrid | null => {
  const grid = emptyGrid(width, height);
  const orbits = buildOrbits(width, height, symmetry);

  /*
   * A valid starting orbit must itself be connected.
   *
   * This matters for rotational symmetry. For example, the four
   * corners of a 9x9 grid form one symmetry orbit, but they are
   * NOT one 8-connected component.
   */
  const validSeeds = orbits.filter((orbit) => {
    if (orbit.length > dots) {
      return false;
    }

    const test = emptyGrid(width, height);
    setOrbit(test, orbit, 1);

    return countIslands(test) === 1;
  });

  if (validSeeds.length === 0) {
    return null;
  }

  /*
   * Randomize seeds so repeated generation doesn't always produce
   * the same visual structure.
   */
  const seeds = shuffle(validSeeds);

  for (const seed of seeds) {
    const candidate = emptyGrid(width, height);

    setOrbit(candidate, seed, 1);

    let placed = countDots(candidate);

    if (placed > dots) {
      continue;
    }

    /*
     * Grow until the requested dot count is reached.
     */
    while (placed < dots) {
      const available = orbits.filter((orbit) => {
        /*
         * Already selected.
         */
        if (orbit.some(([row, col]) => candidate[row][col] === 1)) {
          return false;
        }

        /*
         * Don't exceed the exact dot count.
         */
        if (!orbitFitsDotBudget(candidate, orbit, dots - placed)) {
          return false;
        }

        /*
         * Every new orbit must touch the existing component.
         */
        return orbitTouchesGrid(candidate, orbit);
      });

      if (available.length === 0) {
        break;
      }

      /*
       * Prefer smaller orbits first when we are close to the
       * requested dot count. This dramatically reduces cases
       * where we get stuck with 1-3 dots remaining.
       */
      const remaining = dots - placed;

      const compatible = available.filter((orbit) => orbit.length <= remaining);

      if (compatible.length === 0) {
        break;
      }

      /*
       * Random weighted selection:
       *
       * - smaller orbit = higher probability
       * - touching more existing cells = higher probability
       */
      const scored = compatible.map((orbit) => {
        let contacts = 0;

        for (const [row, col] of orbit) {
          for (const [dr, dc] of EIGHT_NEIGHBOURS) {
            const nr = row + dr;
            const nc = col + dc;

            if (insideGrid(nr, nc, width, height) && candidate[nr][nc] === 1) {
              contacts++;
            }
          }
        }

        const sizePenalty = orbit.length === remaining ? 4 : 1 / orbit.length;

        return {
          orbit,
          score: contacts * 3 + sizePenalty,
        };
      });

      scored.sort((a, b) => b.score - a.score);

      /*
       * Pick randomly from the strongest candidates instead of
       * always taking the absolute best one.
       */
      const topCount = Math.min(4, scored.length);

      const selected = scored[Math.floor(Math.random() * topCount)].orbit;

      setOrbit(candidate, selected, 1);
      placed = countDots(candidate);
    }

    if (placed === dots && countIslands(candidate) === 1) {
      return candidate;
    }
  }

  return null;
};

// ============================================================
// Generate multiple islands
// ============================================================
//
// For multiple islands we deliberately create independent seeds
// and then grow them while preventing accidental 8-neighbour
// contact between different components.
//
// Symmetry may make some island counts mathematically impossible.
// For example, rotational symmetry can force components to appear
// in symmetric groups. In those cases generation correctly fails
// instead of returning an invalid grid.
//

const growMultipleIslands = (
  width: number,
  height: number,
  dots: number,
  islands: number,
  symmetry: Symmetry,
): DotGrid | null => {
  /*
   * The generic symmetric case is more constrained than the
   * single-island case. Use randomized construction with strict
   * validation rather than making assumptions about which
   * component counts are possible.
   */

  const orbits = buildOrbits(width, height, symmetry);

  for (let attempt = 0; attempt < 500; attempt++) {
    const grid = emptyGrid(width, height);

    /*
     * Randomize orbit order for each attempt.
     */
    const shuffled = shuffle(orbits);

    /*
     * Start with several candidate seeds.
     *
     * We only accept a seed if adding its orbit increases the
     * component count exactly as expected.
     */
    for (const orbit of shuffled) {
      if (countDots(grid) >= dots) {
        break;
      }

      if (!orbitFitsDotBudget(grid, orbit, dots - countDots(grid))) {
        continue;
      }

      const before = countIslands(grid);

      const test = cloneGrid(grid);
      setOrbit(test, orbit, 1);

      const after = countIslands(test);

      /*
       * We want to build components rather than accidentally
       * merging existing ones.
       */
      if (before < islands && after <= islands) {
        if (after === before + 1 || (before === 0 && after >= 1)) {
          setOrbit(grid, orbit, 1);
        }
      }

      if (countIslands(grid) === islands) {
        break;
      }
    }

    /*
     * If we have not yet created the requested number of
     * components, this attempt failed.
     */
    if (countIslands(grid) !== islands) {
      continue;
    }

    /*
     * Now grow the existing islands without merging them.
     */
    let placed = countDots(grid);

    while (placed < dots) {
      const available = shuffled.filter((orbit) => {
        if (orbit.some(([row, col]) => grid[row][col] === 1)) {
          return false;
        }

        if (!orbitFitsDotBudget(grid, orbit, dots - placed)) {
          return false;
        }

        /*
         * It must touch an existing component.
         */
        if (!orbitTouchesGrid(grid, orbit)) {
          return false;
        }

        /*
         * We test the actual result below, so don't allow an
         * orbit that would merge the two existing islands.
         */
        const test = cloneGrid(grid);
        setOrbit(test, orbit, 1);

        return countIslands(test) === islands;
      });

      if (available.length === 0) {
        break;
      }

      const selected = available[Math.floor(Math.random() * available.length)];

      setOrbit(grid, selected, 1);
      placed = countDots(grid);
    }

    if (placed === dots && countIslands(grid) === islands) {
      return grid;
    }
  }

  return null;
};

// ============================================================
// Public Grid Generator
// ============================================================

export const generateGrid = (
  x: number,
  y: number,
  dots: number,
  islands: number,
  symmetry: Symmetry,
): DotGrid => {
  if (!Number.isInteger(x) || x <= 0) {
    throw new Error("x must be a positive integer.");
  }

  if (!Number.isInteger(y) || y <= 0) {
    throw new Error("y must be a positive integer.");
  }

  if (!Number.isInteger(dots) || dots <= 0) {
    throw new Error("dots must be a positive integer.");
  }

  if (dots > x * y) {
    throw new Error("Number of dots cannot exceed grid size.");
  }

  if (!Number.isInteger(islands) || islands <= 0) {
    throw new Error("islands must be a positive integer.");
  }

  if (islands > dots) {
    throw new Error("Number of islands cannot exceed number of dots.");
  }

  validateSymmetryDimensions(x, y, symmetry);

  /*
   * ============================================================
   * Fast path: single island
   * ============================================================
   *
   * This is the important case for the 9x9 failure you showed.
   */
  if (islands === 1) {
    const MAX_ATTEMPTS = 2_000;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const grid = growConnectedGrid(x, y, dots, symmetry);

      if (!grid) {
        continue;
      }

      if (countDots(grid) !== dots) {
        continue;
      }

      if (countIslands(grid) !== islands) {
        continue;
      }

      if (!hasSymmetry(grid, symmetry)) {
        continue;
      }

      return grid;
    }
  }

  /*
   * ============================================================
   * Multiple islands
   * ============================================================
   */

  const MAX_ATTEMPTS = 2_000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const grid = growMultipleIslands(x, y, dots, islands, symmetry);

    if (!grid) {
      continue;
    }

    if (countDots(grid) !== dots) {
      continue;
    }

    if (countIslands(grid) !== islands) {
      continue;
    }

    if (!hasSymmetry(grid, symmetry)) {
      continue;
    }

    return grid;
  }

  throw new Error(
    `Could not generate a ${x}x${y} grid with ` +
      `${dots} dots, ${islands} islands, ` +
      `and ${symmetry} symmetry.`,
  );
};
