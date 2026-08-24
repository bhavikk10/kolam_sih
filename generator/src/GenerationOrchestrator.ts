// GenerationOrchestrator.ts

import type {
  Symmetry,
  DotGrid,
  ConnectionGrid,
  TileGrid,
  ConnectionSolverResult,
} from "./types.js";
import { generateGrid } from "./Grid.js";
import { solveConnections } from "./ConnectionSolver.js";
import { CONNECTION_FAMILIES } from "./ConnectionFamilies.js";
import { resolveTileGrid } from "./TileResolver.js";
import {
  checkRequestFeasibility,
  type GenerationFailure,
} from "./GenerationFeasibility.js";

export interface GenerationOrchestratorOptions {
  width: number;
  height: number;
  dots: number;
  islands: number;
  symmetry: Symmetry;
  maxAttempts?: number;
  maxBacktracksPerAttempt?: number;
  maxRestartsPerAttempt?: number;
  seed?: number;
  onProgress?: (attempt: number, maxAttempts: number) => void | Promise<void>;
  yieldBetweenAttempts?: boolean;
}

export type GenerationOrchestratorResult =
  | {
      success: true;
      dotGrid: DotGrid;
      connectionGrid: ConnectionGrid;
      tileGrid: TileGrid;
      solverResult: ConnectionSolverResult;
      attempts: number;
    }
  | {
      success: false;
      failure: GenerationFailure;
      attempts: number;
    };

/**
 * Orchestrates multi-attempt Kolam generation.
 *
 * Flow:
 * 1. Fail fast on static infeasibility (checkRequestFeasibility).
 * 2. Loop up to maxAttempts (default 50):
 *    - Generate a fresh randomized DotGrid using Grid.ts.
 *    - Run single-attempt ConnectionSolver.
 *    - If solver fails (retryable), log attempt diagnostics and retry with a new DotGrid.
 *    - If solver succeeds, resolve tiles and return success.
 * 3. Return structured failure if all attempts are exhausted.
 */
export const generateKolam = async (
  options: GenerationOrchestratorOptions,
): Promise<GenerationOrchestratorResult> => {
  const {
    width,
    height,
    dots,
    islands,
    symmetry,
    maxAttempts = 50,
    maxBacktracksPerAttempt = 100_000,
    maxRestartsPerAttempt = 5,
    seed,
    onProgress,
    yieldBetweenAttempts = true,
  } = options;

  // 1. Pre-check static feasibility (FAIL FAST for impossible requests)
  const feasibilityFailure = checkRequestFeasibility(
    width,
    height,
    dots,
    islands,
    symmetry,
  );

  if (feasibilityFailure) {
    return {
      success: false,
      failure: feasibilityFailure,
      attempts: 0,
    };
  }

  // 2. Multi-attempt generation loop for retryable failures
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (onProgress) {
      await onProgress(attempt, maxAttempts);
    }

    if (yieldBetweenAttempts && typeof setTimeout !== "undefined") {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // A. Generate fresh randomized dot grid
    let dotGrid: DotGrid;
    try {
      dotGrid = generateGrid(width, height, dots, islands, symmetry);
    } catch (gridError) {
      const msg =
        gridError instanceof Error ? gridError.message : "Grid placement failed.";
      console.log(
        `[Attempt ${attempt}/${maxAttempts}] NO_SYMMETRIC_GRID: ${msg}`,
      );
      continue;
    }

    // B. Solve connections
    const solverGrid = {
      width,
      height,
      isDot: (row: number, col: number): boolean => dotGrid[row]?.[col] === 1,
    };

    const solverResult = solveConnections({
      grid: solverGrid,
      islands,
      symmetry,
      families: CONNECTION_FAMILIES,
      maxBacktracks: maxBacktracksPerAttempt,
      maxRestarts: maxRestartsPerAttempt,
      randomize: true,
      seed: seed === undefined ? undefined : (seed + attempt - 1) >>> 0,
    });

    if (!solverResult.success) {
      const isLimit = solverResult.backtracks >= maxBacktracksPerAttempt;
      const reason = isLimit ? "SEARCH_LIMIT_REACHED" : "NO_TOPOLOGY_SOLUTION";
      console.log(
        `[Attempt ${attempt}/${maxAttempts}] ${reason} | Decisions: ${solverResult.decisions} | Backtracks: ${solverResult.backtracks} | Propagations: ${solverResult.propagations}`,
      );
      continue;
    }

    // C. Resolve visual tiles
    let tileGrid: TileGrid;
    try {
      tileGrid = resolveTileGrid(solverResult.grid);
    } catch (tileError) {
      const msg =
        tileError instanceof Error ? tileError.message : "Tile resolution failed.";
      console.log(
        `[Attempt ${attempt}/${maxAttempts}] NO_COMPATIBLE_TILE: ${msg}`,
      );
      return {
        success: false,
        failure: {
          reason: "NO_COMPATIBLE_TILE",
          message: `Tile resolution failed: ${msg}`,
        },
        attempts: attempt,
      };
    }

    // Success!
    return {
      success: true,
      dotGrid,
      connectionGrid: solverResult.grid,
      tileGrid,
      solverResult,
      attempts: attempt,
    };
  }

  // All retry attempts exhausted
  return {
    success: false,
    failure: {
      reason: "NO_TOPOLOGY_SOLUTION",
      message: `Could not generate a valid Kolam for these settings after ${maxAttempts} attempts. Try changing the dot count, island count, or symmetry.`,
    },
    attempts: maxAttempts,
  };
};
