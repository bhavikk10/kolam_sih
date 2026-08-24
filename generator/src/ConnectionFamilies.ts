import type {
  ConnectionFamily,
  ConnectionFamilyId,
  ConnectionMask,
  Direction,
  Orientation,
} from "./types";

/**
 * ============================================================
 * Connection Families
 * ============================================================
 *
 * A connection family describes TOPOLOGY, not visual geometry.
 *
 * The canonical mask is always:
 *
 *   [N, E, S, W, NE, SE, SW, NW]
 *
 * Family IDs are generated from the connected canonical
 * directions, using the same order as the mask above.
 *
 * Examples:
 *
 *   "N"              -> single N connection
 *   "N_S"            -> N + S
 *   "N_E"            -> N + E
 *   "N_E_S_W"        -> all cardinal directions
 *   "NE_SE_SW_NW"    -> all diagonal directions
 *
 * IMPORTANT:
 *
 * A family does NOT describe whether the resulting shape is
 * an eye, door, fan, diamond, etc.
 *
 * Multiple visual tiles may belong to the same topology family.
 * That separation is intentional and allows the solver to work
 * independently of the renderer.
 */

/**
 * Canonical direction ordering.
 *
 * This is deliberately NOT alphabetical.
 * It matches ConnectionMask exactly and therefore gives us
 * deterministic family names.
 */
export const FAMILY_DIRECTION_ORDER: readonly Direction[] = [
  "N",
  "E",
  "S",
  "W",
  "NE",
  "SE",
  "SW",
  "NW",
] as const;

/**
 * Connection values that count as an actual topology
 * connection.
 *
 * At the moment your tiles use `2` for a connection.
 * Keeping this helper tolerant of future non-zero connection
 * values makes the family layer easier to extend.
 */
export const isConnected = (value: number): boolean => value !== 0;

/**
 * Convert a canonical connection mask into its family ID.
 *
 * Example:
 *
 * [2, 0, 2, 0, 0, 0, 0, 0]
 *
 * becomes:
 *
 * "N_S"
 */
export const familyIdFromMask = (mask: ConnectionMask): ConnectionFamilyId => {
  const directions: Direction[] = [];

  for (let i = 0; i < FAMILY_DIRECTION_ORDER.length; i++) {
    if (isConnected(mask[i])) {
      directions.push(FAMILY_DIRECTION_ORDER[i]);
    }
  }

  return (
    directions.length === 0 ? "NONE" : directions.join("_")
  ) as ConnectionFamilyId;
};

/**
 * Create a canonical connection mask from a list of
 * directions.
 *
 * This is preferable to manually writing eight-element arrays
 * throughout the family registry because it makes mistakes much
 * harder to introduce when adding new families.
 */
export const maskFromDirections = (
  directions: readonly Direction[],
  connectionValue: number = 2,
): ConnectionMask => {
  const mask = new Array(FAMILY_DIRECTION_ORDER.length).fill(
    0,
  ) as ConnectionMask;

  for (const direction of directions) {
    const index = FAMILY_DIRECTION_ORDER.indexOf(direction);

    if (index === -1) {
      throw new Error(`Unknown connection direction: ${direction}`);
    }

    mask[index] = connectionValue;
  }

  return mask;
};

/**
 * Assert that a family ID and canonical mask actually describe
 * the same topology.
 *
 * This is useful during development and prevents a typo in the
 * registry from silently producing the wrong solver topology.
 */
export const validateFamilyDefinition = (family: ConnectionFamily): void => {
  const expected = familyIdFromMask(family.canonicalCon);

  if (expected !== family.id) {
    throw new Error(
      `Invalid connection family "${family.id}". ` +
        `Canonical mask describes "${expected}".`,
    );
  }

  if (!Number.isFinite(family.weight) || family.weight < 0) {
    throw new Error(`Invalid weight for connection family "${family.id}".`);
  }

  if (family.orientations && family.orientations.length === 0) {
    throw new Error(
      `Family "${family.id}" has an empty orientations array. ` +
        `Omit it to allow all orientations.`,
    );
  }
};

/**
 * Validate the complete registry.
 *
 * This catches duplicate IDs and invalid family definitions
 * immediately when the module is initialized.
 */
export const validateConnectionFamilies = (
  families: readonly ConnectionFamily[],
): void => {
  const ids = new Set<string>();

  for (const family of families) {
    if (ids.has(family.id)) {
      throw new Error(`Duplicate connection family: ${family.id}`);
    }

    ids.add(family.id);
    validateFamilyDefinition(family);
  }
};

/**
 * ============================================================
 * Current topology registry
 * ============================================================
 *
 * These are the topology families currently represented by the
 * existing Tiles.ts definitions.
 *
 * Visual tile names are intentionally NOT stored here.
 *
 * Current mappings from Tiles.ts:
 *
 *   circle           -> NONE
 *   drop_vertical    -> N
 *   drop_diagonal    -> NE
 *   eye_vertical     -> N_S
 *   eye_diagonal     -> SE_NW
 *   door_diagonal    -> N_E
 *   door_vertical    -> NE_NW
 *   fan_vertical     -> NE_SE_SW
 *   fan_diagonal     -> N_E_S
 *   diamond_vertical -> N_E_S_W
 *   diamond_diagonal -> NE_SE_SW_NW
 *
 * The masks below therefore represent the topology only.
 */

/**
 * Default probability weights.
 *
 * These are deliberately centralized.
 *
 * Later, the solver can multiply these base weights by
 * complexity / visual / diversity scores without changing the
 * family definitions.
 */
export const CONNECTION_FAMILY_WEIGHTS: Readonly<
  Record<ConnectionFamilyId, number>
> = {
  NONE: 1,
  N: 1,
  NE: 1,
  N_S: 1,
  SE_NW: 1,
  N_E: 1,
  NE_NW: 1,
  NE_SE_SW: 1,
  N_E_S: 1,
  N_E_S_W: 1,
  NE_SE_SW_NW: 1,
};

/**
 * All currently supported topology families.
 *
 * IMPORTANT:
 *
 * `orientations` describes which rotations the topology family
 * may take when the solver materializes candidates.
 *
 * We currently expose all four orientations because the solver
 * already treats the canonical family as the source and derives
 * rotated masks from it.
 *
 * This can later be restricted on a per-family basis without
 * changing the solver API.
 */
export const CONNECTION_FAMILIES: ConnectionFamily[] = [
  {
    id: "NONE",
    canonicalCon: maskFromDirections([]),
    weight: CONNECTION_FAMILY_WEIGHTS.NONE,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "N",
    canonicalCon: maskFromDirections(["N"]),
    weight: CONNECTION_FAMILY_WEIGHTS.N,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "NE",
    canonicalCon: maskFromDirections(["NE"]),
    weight: CONNECTION_FAMILY_WEIGHTS.NE,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "N_S",
    canonicalCon: maskFromDirections(["N", "S"]),
    weight: CONNECTION_FAMILY_WEIGHTS.N_S,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "SE_NW",
    canonicalCon: maskFromDirections(["SE", "NW"]),
    weight: CONNECTION_FAMILY_WEIGHTS.SE_NW,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "N_E",
    canonicalCon: maskFromDirections(["N", "E"]),
    weight: CONNECTION_FAMILY_WEIGHTS.N_E,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "NE_NW",
    canonicalCon: maskFromDirections(["NE", "NW"]),
    weight: CONNECTION_FAMILY_WEIGHTS.NE_NW,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "NE_SE_SW",
    canonicalCon: maskFromDirections(["NE", "SE", "SW"]),
    weight: CONNECTION_FAMILY_WEIGHTS.NE_SE_SW,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "N_E_S",
    canonicalCon: maskFromDirections(["N", "E", "S"]),
    weight: CONNECTION_FAMILY_WEIGHTS.N_E_S,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "N_E_S_W",
    canonicalCon: maskFromDirections(["N", "E", "S", "W"]),
    weight: CONNECTION_FAMILY_WEIGHTS.N_E_S_W,
    orientations: ["N", "E", "S", "W"],
  },

  {
    id: "NE_SE_SW_NW",
    canonicalCon: maskFromDirections(["NE", "SE", "SW", "NW"]),
    weight: CONNECTION_FAMILY_WEIGHTS.NE_SE_SW_NW,
    orientations: ["N", "E", "S", "W"],
  },
];

/**
 * Fail fast if the registry itself is inconsistent.
 *
 * This runs once when the module is loaded.
 */
validateConnectionFamilies(CONNECTION_FAMILIES);

/**
 * Fast lookup by topology ID.
 */
export const CONNECTION_FAMILY_MAP: ReadonlyMap<
  ConnectionFamilyId,
  ConnectionFamily
> = new Map(CONNECTION_FAMILIES.map((family) => [family.id, family]));

/**
 * Get a family by its topology ID.
 */
export const getConnectionFamily = (
  id: ConnectionFamilyId,
): ConnectionFamily => {
  const family = CONNECTION_FAMILY_MAP.get(id);

  if (!family) {
    throw new Error(`Unknown connection family: ${id}`);
  }

  return family;
};

/**
 * Get the family represented by a canonical mask.
 */
export const getConnectionFamilyForMask = (
  mask: ConnectionMask,
): ConnectionFamily => {
  const id = familyIdFromMask(mask);

  return getConnectionFamily(id);
};

/**
 * Return all families that have a particular number of
 * connected endpoints.
 *
 * Useful later for generation heuristics and complexity rules.
 */
export const getFamiliesByConnectionCount = (
  count: number,
): ConnectionFamily[] =>
  CONNECTION_FAMILIES.filter(
    (family) => family.canonicalCon.filter(isConnected).length === count,
  );

/**
 * Return a defensive copy of the registry.
 *
 * Solver code should normally use CONNECTION_FAMILIES directly,
 * but this helper is useful when an extension wants to alter
 * weights without mutating the global registry.
 */
export const cloneConnectionFamilies = (): ConnectionFamily[] =>
  CONNECTION_FAMILIES.map((family) => ({
    ...family,
    canonicalCon: [...family.canonicalCon] as ConnectionMask,
    orientations: family.orientations ? [...family.orientations] : undefined,
  }));
