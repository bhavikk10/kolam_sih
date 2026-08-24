// TileResolver.ts

import { tiles } from "./Tiles.js";
import { familyIdFromMask, CONNECTION_FAMILY_MAP } from "./ConnectionFamilies.js";
import { transformConnectionMask } from "./Symmetry.js";
import type {
  Tile,
  ConnectionFamilyId,
  ConnectionMask,
  ConnectionCandidate,
  ConnectionGrid,
  TileGrid,
  PlacedTile,
  Orientation,
  Connection,
} from "./types.js";

interface IndexedTile {
  tile: Tile;
  templateOffset: Orientation; // Orientation turns applied to template canonical conn_type to align with solver canonical family mask
}

const familyToTilesMap = new Map<ConnectionFamilyId, IndexedTile[]>();

const ORIENTATIONS: Orientation[] = ["N", "E", "S", "W"];

const getOrientationTurns = (orientation: Orientation): number => {
  return ORIENTATIONS.indexOf(orientation);
};

const getOrientationFromTurns = (turns: number): Orientation => {
  return ORIENTATIONS[((turns % 4) + 4) % 4];
};

const composeOrientations = (a: Orientation, b: Orientation): Orientation => {
  return getOrientationFromTurns(getOrientationTurns(a) + getOrientationTurns(b));
};

const rotateMask = (mask: ConnectionMask, turns: number): ConnectionMask => {
  return transformConnectionMask(mask, {
    type: "rotation",
    rotation: ((turns % 4) + 4) % 4 as 0 | 1 | 2 | 3,
  });
};

/**
 * Build the visual tile index and validate all entries.
 */
export const initTileResolver = (): void => {
  familyToTilesMap.clear();

  for (const tile of tiles) {
    const mask = tile.conn_type as ConnectionMask;
    if (!mask || mask.length !== 8) {
      throw new Error(
        `Tile "${tile.name}" (ID ${tile.id}) has invalid canonical conn_type: ${JSON.stringify(mask)}`
      );
    }

    let matchedFamilyId: ConnectionFamilyId | null = null;
    let matchedOffset: Orientation | null = null;

    // Test all 4 orientations to find which solver family this tile's canonical shape maps to.
    for (const orientation of ORIENTATIONS) {
      const turns = getOrientationTurns(orientation);
      const rotated = rotateMask(mask, turns);
      const familyId = familyIdFromMask(rotated);

      if (CONNECTION_FAMILY_MAP.has(familyId)) {
        matchedFamilyId = familyId;
        matchedOffset = orientation;
        break;
      }
    }

    if (!matchedFamilyId || !matchedOffset) {
      throw new Error(
        `Tile "${tile.name}" (ID ${tile.id}) could not be mapped to any known solver family ID ` +
        `under any of the 4 rotations. Canonical conn_type: ${JSON.stringify(mask)}`
      );
    }

    if (!familyToTilesMap.has(matchedFamilyId)) {
      familyToTilesMap.set(matchedFamilyId, []);
    }

    familyToTilesMap.get(matchedFamilyId)!.push({
      tile,
      templateOffset: matchedOffset,
    });
  }

  // Verify that every family in the solver registry has at least one mapped visual tile template
  for (const familyId of CONNECTION_FAMILY_MAP.keys()) {
    const matched = familyToTilesMap.get(familyId) ?? [];
    if (matched.length === 0) {
      throw new Error(`Solver family "${familyId}" has no compatible visual tiles registered.`);
    }
  }
};

// Initialize index at module startup
initTileResolver();

/**
 * Resolves a single ConnectionCandidate to a PlacedTile template.
 */
export const resolveTile = (candidate: ConnectionCandidate): PlacedTile => {
  const familyId = candidate.familyId;
  const compatible = familyToTilesMap.get(familyId) ?? [];

  if (compatible.length === 0) {
    throw new Error(`No compatible visual tiles found for family ID "${familyId}"`);
  }

  // Random selection among all visual tile options for the same family
  const choice = compatible[Math.floor(Math.random() * compatible.length)];

  // Compose the final tile drawing orientation: templateOffset + candidate.orientation
  const finalOrientation = composeOrientations(choice.templateOffset, candidate.orientation);

  return {
    id: choice.tile.id,
    name: choice.tile.name,
    orientation: finalOrientation,
    con: [...candidate.con] as Connection[],
    conn_type: [...choice.tile.conn_type] as Connection[],
  };
};

/**
 * Resolves a full ConnectionGrid to a TileGrid.
 */
export const resolveTileGrid = (connectionGrid: ConnectionGrid): TileGrid => {
  const height = connectionGrid.length;
  const width = connectionGrid[0]?.length ?? 0;

  const tileGrid: TileGrid = Array.from({ length: height }, () =>
    Array(width).fill(null),
  );

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const candidate = connectionGrid[row]?.[col];
      if (candidate) {
        tileGrid[row][col] = resolveTile(candidate);
      }
    }
  }

  return tileGrid;
};
