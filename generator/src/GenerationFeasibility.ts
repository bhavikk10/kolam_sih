// GenerationFeasibility.ts

import type { Symmetry } from "./types.js";
import { validateSymmetryDimensions, buildSymmetryOrbits } from "./Symmetry.js";
import { CONNECTION_FAMILY_MAP } from "./ConnectionFamilies.js";

export type GenerationFailureReason =
  | "INVALID_INPUT"
  | "UNSUPPORTED_SYMMETRY"
  | "IMPOSSIBLE_DOT_COUNT"
  | "IMPOSSIBLE_ISLAND_COUNT"
  | "NO_SYMMETRIC_GRID"
  | "NO_TOPOLOGY_SOLUTION"
  | "SEARCH_LIMIT_REACHED"
  | "NO_COMPATIBLE_TILE"
  | "UNKNOWN";

export interface GenerationFailure {
  reason: GenerationFailureReason;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Validate request parameters and basic feasibility constraints BEFORE starting generation.
 * Prevents UI freezes/crashes by catching mathematically impossible configurations.
 */
export const checkRequestFeasibility = (
  width: number,
  height: number,
  dots: number,
  islands: number,
  symmetry: Symmetry
): GenerationFailure | null => {
  // 1. Basic numeric validations
  if (!Number.isInteger(width) || width <= 0) {
    return {
      reason: "INVALID_INPUT",
      message: `Grid width must be a positive integer. Got: ${width}`,
    };
  }
  if (!Number.isInteger(height) || height <= 0) {
    return {
      reason: "INVALID_INPUT",
      message: `Grid height must be a positive integer. Got: ${height}`,
    };
  }
  if (!Number.isInteger(dots) || dots <= 0) {
    return {
      reason: "INVALID_INPUT",
      message: `Dot count must be a positive integer. Got: ${dots}`,
    };
  }
  if (!Number.isInteger(islands) || islands <= 0) {
    return {
      reason: "INVALID_INPUT",
      message: `Island count must be a positive integer. Got: ${islands}`,
    };
  }
  if (dots > width * height) {
    return {
      reason: "INVALID_INPUT",
      message: `Requested dot count (${dots}) exceeds grid capacity (${width} × ${height} = ${width * height}).`,
    };
  }
  if (islands > dots) {
    return {
      reason: "INVALID_INPUT",
      message: `Requested island count (${islands}) cannot exceed dot count (${dots}).`,
    };
  }

  // 2. Symmetry dimension compatibility
  try {
    validateSymmetryDimensions(width, height, symmetry);
  } catch (error) {
    return {
      reason: "UNSUPPORTED_SYMMETRY",
      message: error instanceof Error ? error.message : "Incompatible symmetry dimensions.",
    };
  }

  // 3. Symmetry orbit cardinality (Subset Sum / DP Check)
  // Verify that the requested dots can be formed as a sum of available symmetry-orbit sizes.
  const orbits = buildSymmetryOrbits(width, height, symmetry);
  const orbitSizes = orbits.map((orbit) => orbit.cells.length);

  if (!canFormDotCount(dots, orbitSizes)) {
    return {
      reason: "IMPOSSIBLE_DOT_COUNT",
      message: `Requested dot count (${dots}) is mathematically impossible to construct under ${symmetry} symmetry. ` +
        `Dot counts must be a sum of available orbit sizes.`,
      details: { availableOrbitSizes: Array.from(new Set(orbitSizes)).sort((a, b) => a - b) },
    };
  }

  // 4. Island feasibility under Rotational_4Fold
  if (symmetry === "Rotational_4Fold") {
    // Under 4-fold rotational symmetry, components not covering the center must appear in groups of 4.
    // The center cell (if grid is odd) can form 1 component.
    // So the number of islands must be of the form 4k or 4k + 1.
    if (islands % 4 !== 0 && islands % 4 !== 1) {
      return {
        reason: "IMPOSSIBLE_ISLAND_COUNT",
        message: `Requested island count (${islands}) is impossible under Rotational_4Fold symmetry. ` +
          `The number of islands must be of the form 4k or 4k + 1.`,
      };
    }
  }

  return null;
};

/**
 * Solve 0/1 Subset Sum to determine if a target sum can be formed by a subset of items.
 */
function canFormDotCount(target: number, sizes: number[]): boolean {
  const dp = new Array(target + 1).fill(false);
  dp[0] = true;

  for (const size of sizes) {
    for (let j = target; j >= size; j--) {
      if (dp[j - size]) {
        dp[j] = true;
      }
    }
  }

  return dp[target];
}
