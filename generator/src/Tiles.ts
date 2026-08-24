// Tiles.ts

import type {
  Connection,
  Direction,
  DrawContext,
  Orientation,
  Tile,
  KolamStyle,
} from "./types";

// ============================================================
// Geometry Configuration
// ============================================================
//
// Canonical mathematical coordinate system:
//
//                    N (0, +1)
//                       |
//                       |
//        W (-1, 0) ---- O ---- E (+1, 0)
//                       |
//                       |
//                    S (0, -1)
//
// Canvas Y is inverted, so mathematical Y is converted
// to canvas Y when drawing.
//
// Tile boundary:
//
//        NW (-1,+1) -------- NE (+1,+1)
//             |                    |
//             |                    |
//             |         O          |
//             |                    |
//        SW (-1,-1) -------- SE (+1,-1)
//
// ============================================================

const GEOMETRY = {
  // Number of samples used for mathematical curves.
  samples: 96,

  // ----------------------------------------------------------
  // Circle
  // ----------------------------------------------------------

  circleRadius: 0.34,

  // ----------------------------------------------------------
  // Drop
  // ----------------------------------------------------------

  dropRadius: 0.8,

  // ----------------------------------------------------------
  // Eye
  // ----------------------------------------------------------

  eyeRadius: 1,
  eyeAmplitude: 0.45,

  // ----------------------------------------------------------
  // Door
  // ----------------------------------------------------------

  doorRadius: 1,
  doorAmplitude: -1.9,

  // Diagonal door tuning.
  diagonalDoorRadius: 1,
  diagonalDoorAmplitude: -2.7,

  // ----------------------------------------------------------
  // Fan
  // ----------------------------------------------------------

  fanRadius: 1,

  // Controls how far the curved NE -> SW section
  // bends toward NW.
  fanVerticalBulge: 0.7,

  // Temporary until the canonical fan_vertical
  // equations are finalized.
  fanDiagonalBulge: 0.55,
};

// ============================================================
// Mathematical helpers
// ============================================================

type Point = {
  x: number;
  y: number;
};

const point = (x: number, y: number): Point => ({
  x,
  y,
});

const rotatePoint = (p: Point, angle: number): Point => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  return {
    x: p.x * c - p.y * s,
    y: p.x * s + p.y * c,
  };
};

// ============================================================
// Direction vectors
// ============================================================

const directionVector: Record<Direction, Point> = {
  N: point(0, 1),
  E: point(1, 0),
  S: point(0, -1),
  W: point(-1, 0),

  NE: point(1, 1),
  SE: point(1, -1),
  SW: point(-1, -1),
  NW: point(-1, 1),
};

// ============================================================
// Pseudo / boundary point
// ============================================================

export const getBoundaryPoint = (direction: Direction, size: number): Point => {
  const d = size / 2;
  const vector = directionVector[direction];

  return point(vector.x * d, -vector.y * d);
};

// ============================================================
// Mathematical coordinate -> Canvas coordinate
// ============================================================
//
// One mathematical unit = size / 2 pixels.
//
// Mathematical:
//
//        +Y
//         ↑
//
// Canvas:
//
//         ↓ +Y
//
// ============================================================

const mathToCanvas = (
  x: number,
  y: number,
  scale: number,
): [number, number] => {
  return [x * scale, -y * scale];
};

// ============================================================
// Draw y = f(x)
// ============================================================

const drawFunction = (
  ctx: CanvasRenderingContext2D,
  scale: number,
  xMin: number,
  xMax: number,
  fn: (x: number) => number,
  samples: number = GEOMETRY.samples,
): void => {
  ctx.beginPath();

  for (let i = 0; i <= samples; i++) {
    const x = xMin + ((xMax - xMin) * i) / samples;
    const y = fn(x);

    const [cx, cy] = mathToCanvas(x, y, scale);

    if (i === 0) {
      ctx.moveTo(cx, cy);
    } else {
      ctx.lineTo(cx, cy);
    }
  }

  ctx.stroke();
};

// ============================================================
// Draw parametric curve
// ============================================================

const drawParametric = (
  ctx: CanvasRenderingContext2D,
  scale: number,
  tMin: number,
  tMax: number,
  fn: (t: number) => Point,
  samples: number = GEOMETRY.samples,
): void => {
  ctx.beginPath();

  for (let i = 0; i <= samples; i++) {
    const t = tMin + ((tMax - tMin) * i) / samples;

    const p = fn(t);

    const [cx, cy] = mathToCanvas(p.x, p.y, scale);

    if (i === 0) {
      ctx.moveTo(cx, cy);
    } else {
      ctx.lineTo(cx, cy);
    }
  }

  ctx.stroke();
};

// ============================================================
// Draw mathematical line segment
// ============================================================

const drawLine = (
  ctx: CanvasRenderingContext2D,
  scale: number,
  a: Point,
  b: Point,
): void => {
  const [x1, y1] = mathToCanvas(a.x, a.y, scale);
  const [x2, y2] = mathToCanvas(b.x, b.y, scale);

  ctx.beginPath();

  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);

  ctx.stroke();
};

// ============================================================
// Rotate a canonical mathematical point around origin
// ============================================================

const drawRotatedFunction = (
  ctx: CanvasRenderingContext2D,
  scale: number,
  angle: number,
  xMin: number,
  xMax: number,
  fn: (x: number) => number,
  samples: number = GEOMETRY.samples,
): void => {
  drawParametric(
    ctx,
    scale,
    xMin,
    xMax,
    (x) => {
      const y = fn(x);

      return rotatePoint(point(x, y), angle);
    },
    samples,
  );
};

// ============================================================
// Debug helpers
// ============================================================

export const drawDot = (
  ctx: CanvasRenderingContext2D,
  radius: number = 3,
): void => {
  ctx.beginPath();

  ctx.arc(0, 0, radius, 0, Math.PI * 2);

  ctx.fill();
};

export const getPseudoPoint = (
  direction: Direction,
  size: number,
): [number, number] => {
  const d = size / 2;

  switch (direction) {
    case "N":
      return [0, -d];

    case "E":
      return [d, 0];

    case "S":
      return [0, d];

    case "W":
      return [-d, 0];

    case "NE":
      return [d, -d];

    case "SE":
      return [d, d];

    case "SW":
      return [-d, d];

    case "NW":
      return [-d, -d];
  }
};

export const drawPseudoPoints = (
  ctx: CanvasRenderingContext2D,
  size: number,
): void => {
  const directions: Direction[] = ["N", "E", "S", "W", "NE", "SE", "SW", "NW"];

  ctx.save();

  ctx.globalAlpha = 0.35;

  for (const direction of directions) {
    const [x, y] = getPseudoPoint(direction, size);

    ctx.beginPath();

    ctx.arc(x, y, 2, 0, Math.PI * 2);

    ctx.fill();
  }

  ctx.restore();
};

// ============================================================
// 1. CIRCLE
// ============================================================

export const drawCircle = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;

  ctx.beginPath();

  ctx.arc(0, 0, GEOMETRY.circleRadius * scale, 0, Math.PI * 2);

  ctx.stroke();
};

// ============================================================
// 2. DROP — VERTICAL
// ============================================================
//
// Locked mathematical definition:
//
// r = 0.8
//
// y = -sqrt(r² - x²)
//       {-r <= x <= r}
//
// y = x/r + 1
//       {-r <= x <= 0}
//
// y = -x/r + 1
//       {0 <= x <= r}
//
// Connection:
// N
//
// ============================================================

export const drawDropVertical = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;
  const r = GEOMETRY.dropRadius;

  // Lower semicircle.
  drawFunction(
    ctx,
    scale,
    -r,
    r,
    (x) => -Math.sqrt(Math.max(0, r * r - x * x)),
  );

  // N -> W.
  drawFunction(ctx, scale, -r, 0, (x) => x / r + 1, 24);

  // N -> E.
  drawFunction(ctx, scale, 0, r, (x) => -x / r + 1, 24);
};

// ============================================================
// 3. DROP — DIAGONAL
// ============================================================
//
// Same mathematical drop primitive as the vertical drop.
//
// Rotated -45° and scaled by sqrt(2) so that:
//
// N -> NE
//
// and the connection terminates exactly on the NE pseudo-point.
//
// ============================================================

export const drawDropDiagonal = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;
  const r = GEOMETRY.dropRadius;

  const angle = -Math.PI / 4;
  const diagonalScale = Math.SQRT2;

  drawParametric(ctx, scale, -r, r, (x) => {
    const y = -Math.sqrt(Math.max(0, r * r - x * x));

    const rotated = rotatePoint(
      point(x * diagonalScale, y * diagonalScale),
      angle,
    );

    return rotated;
  });

  drawParametric(
    ctx,
    scale,
    -r,
    0,
    (x) => {
      const y = x / r + 1;

      return rotatePoint(point(x * diagonalScale, y * diagonalScale), angle);
    },
    24,
  );

  drawParametric(
    ctx,
    scale,
    0,
    r,
    (x) => {
      const y = -x / r + 1;

      return rotatePoint(point(x * diagonalScale, y * diagonalScale), angle);
    },
    24,
  );
};

// ============================================================
// 4. EYE — VERTICAL
// ============================================================
//
// Locked:
//
// y = a sin(π(x+r)/(2r))
//       {-r <= x <= r}
//
// y = -a sin(π(x+r)/(2r))
//       {-r <= x <= r}
//
// r = 1
// a = 0.45
//
// Connections:
// W + E
//
// ============================================================

export const drawEyeVertical = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;

  const r = GEOMETRY.eyeRadius;
  const a = GEOMETRY.eyeAmplitude;

  const sine = (x: number): number =>
    a * Math.sin((Math.PI * (x + r)) / (2 * r));

  drawFunction(ctx, scale, -r, r, sine);

  drawFunction(ctx, scale, -r, r, (x) => -sine(x));
};

// ============================================================
// 5. EYE — DIAGONAL
// ============================================================
//
// Same locked sine-eye.
//
// We rotate the complete eye by -45°.
//
// W -> SW
// E -> NE
//
// The canonical eye has endpoints at x = +/-1.
// Multiplying by sqrt(2) before rotation places the
// endpoints exactly at the diagonal pseudo-points:
//
// SW = (-1,-1)
// NE = (+1,+1)
//
// ============================================================

export const drawEyeDiagonal = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;

  const r = GEOMETRY.eyeRadius;
  const a = GEOMETRY.eyeAmplitude;

  const angle = -Math.PI / 4;
  const diagonalScale = Math.SQRT2;

  const sine = (x: number): number =>
    a * Math.sin((Math.PI * (x + r)) / (2 * r));

  drawParametric(ctx, scale, -r, r, (x) => {
    const y = sine(x);

    return rotatePoint(point(x * diagonalScale, y * diagonalScale), angle);
  });

  drawParametric(ctx, scale, -r, r, (x) => {
    const y = -sine(x);

    return rotatePoint(point(x * diagonalScale, y * diagonalScale), angle);
  });
};

// ============================================================
// 6. DOOR — VERTICAL
// ============================================================
//
// Locked:
//
// y = 1
//       {-1 <= x <= 1}
//
// y = a(1 - x²/r²) + r
//       {-1 <= x <= 1}
//
// r = 1
// a = -1.9
//
// Connections:
// SW + SE
//
// ============================================================

export const drawDoorVertical = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;

  const r = GEOMETRY.doorRadius;
  const a = GEOMETRY.doorAmplitude;

  // Straight top reference edge.
  drawFunction(ctx, scale, -r, r, () => r, 1);

  // Parabolic curve.
  drawFunction(ctx, scale, -r, r, (x) => a * (1 - (x * x) / (r * r)) + r);
};

// ============================================================
// DOOR — DIAGONAL
//
// Canonical connections:
//
// N (0, 1)
// ●
//  \
//   \      ← parabola
//    \____
//          ● E (1, 0)
//
// Canonical equation:
//
// y = -x + 1 + a*x*(1-x)
// {0 <= x <= 1}
//
// a = -2.7
//
// IMPORTANT:
// This geometry is ALREADY diagonal.
// Do NOT rotate it here.
//
// drawTile() is responsible only for the tile's
// N/E/S/W orientation.
// ============================================================

export const drawDoorDiagonal = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;
  const a = -2.8;

  // ==========================================================
  // Straight edge: N -> E
  //
  // y = -x + 1
  // 0 <= x <= 1
  // ==========================================================

  drawFunction(ctx, scale, 0, 1, (x) => -x + 1, 32);

  // ==========================================================
  // Parabolic edge: N -> E
  //
  // x + y - 1 = a(1 - (x - y)^2)
  //
  // Let:
  //
  // t = x - y
  //
  // Then:
  //
  // x + y - 1 = a(1 - t²)
  //
  // Therefore:
  //
  // x + y = 1 + a(1 - t²)
  //
  // Combining with x - y = t:
  //
  // x = (1 + a(1 - t²) + t) / 2
  //
  // y = (1 + a(1 - t²) - t) / 2
  //
  // -1 <= t <= 1
  //
  // t = -1 -> N
  // t =  1 -> E
  // ==========================================================

  drawParametric(
    ctx,
    scale,
    -1,
    1,
    (t) => {
      const sum = 1 + a * (1 - t * t);

      const x = (sum + t) / 2;
      const y = (sum - t) / 2;

      return { x, y };
    },
    96,
  );
};
// ============================================================
// 8. FAN — VERTICAL
// ============================================================
//
// NOT MATHEMATICALLY LOCKED YET.
//
// Connections:
// NE + SE + SW
//
// This is intentionally kept simple until we define the
// exact canonical equations in Desmos.
//
// ============================================================

// ==========================================================
// FAN — VERTICAL
//
// Connections:
//
// NE
//  \
//   \
//    )   <- curved section: NE -> SW
//   /
//  /
// SW
//
// The remaining straight sections are:
//
// NE -> SE
// SW -> SE
//
// Canonical connections:
// NE + SE + SW
// ==========================================================
// ==========================================================
// FAN — VERTICAL
//
// Connections:
//
// NE + SE + SW
//
// Straight edges:
//   NE -> SE
//   SW -> SE
//
// Curved edge:
//   NE -> SW
//
// The curve bulges toward NW.
// ==========================================================

// ==========================================================
// FAN — VERTICAL
//
// Connections:
//
// NE + SE + SW
//
// Straight sections:
//
// NE -> SE
// SW -> SE
//
// Curved section:
//
// NE -> SW
//
// The curved section is a parabola which bends toward NW.
// ==========================================================

export const drawFanVertical = ({ ctx, size }: DrawContext): void => {
  const r = GEOMETRY.fanRadius;
  const scale = size / 2;
  const bulge = GEOMETRY.fanVerticalBulge;

  // ==========================================================
  // CURVED SECTION: NE -> SW
  //
  // We use t ∈ [-1, 1].
  //
  // The straight diagonal from NE -> SW is:
  //
  //     x = r t
  //     y = r t
  //
  // We offset perpendicular to that diagonal toward NW.
  //
  // Perpendicular unit vector:
  //
  //     (-1 / √2, +1 / √2)
  //
  // The parabola offset is:
  //
  //     bulge * (1 - t²)
  //
  // Therefore:
  //
  //     x = rt - bulge(1-t²)/√2
  //     y = rt + bulge(1-t²)/√2
  //
  // At t = -1:
  //     (-r, -r) = SW
  //
  // At t = +1:
  //     ( r,  r) = NE
  //
  // At t = 0:
  //     (-bulge/√2, +bulge/√2)
  //
  // which bends toward NW.
  // ==========================================================

  drawParametric(
    ctx,
    scale,
    -1,
    1,
    (t) => {
      const offset = (bulge * (1 - t * t)) / Math.sqrt(2);

      const x = r * t - offset;
      const y = r * t + offset;

      return { x, y };
    },
    GEOMETRY.samples,
  );

  // ==========================================================
  // STRAIGHT: NE -> SE
  // ==========================================================

  drawLine(ctx, scale, point(r, r), point(r, -r));

  // ==========================================================
  // STRAIGHT: SW -> SE
  // ==========================================================

  drawLine(ctx, scale, point(-r, -r), point(r, -r));
};
// ============================================================
// 9. FAN — DIAGONAL
// ============================================================
//
// LOCKED STRUCTURE:
//
// NW ---------------- NE
//  \                   |
//   \                  |
//    \                 |
//     \                |
//      \               |
//       \              |
//        \------------- SE
//
// NW -> NE : straight line
// NE -> SE : straight line
// NW -> SE : quadratic Bézier
//
// Connections:
// NW + NE + SE
//
// The Bézier control point is deliberately exposed as a
// tuning parameter.
//
// ============================================================

export const drawFanDiagonal = ({ ctx, size }: DrawContext): void => {
  const r = GEOMETRY.fanRadius;
  const scale = size / 2;

  // ==========================================================
  // CURVED SIDE
  //
  // x = -sqrt(r² - y²)
  //
  // N -> S
  // ==========================================================

  drawParametric(
    ctx,
    scale,
    -r,
    r,
    (y) => {
      const x = -Math.sqrt(Math.max(0, r * r - y * y));

      return { x, y };
    },
    GEOMETRY.samples,
  );

  // ==========================================================
  // N -> E
  //
  // y = -x + r
  //
  // 0 <= x <= r
  // ==========================================================

  drawFunction(ctx, scale, 0, r, (x) => -x + r, 32);

  // ==========================================================
  // S -> E
  //
  // y = x - r
  //
  // 0 <= x <= r
  // ==========================================================

  drawFunction(ctx, scale, 0, r, (x) => x - r, 32);
};

// ============================================================
// 10. DIAMOND — CARDINAL
// ============================================================
//
// Locked as four semicircular arcs:
//
// N -> E
// E -> S
// S -> W
// W -> N
//
// The result is a smooth four-sided diamond.
//
// ============================================================

export const drawDiamondVertical = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;

  // W -> N
  drawFunction(ctx, scale, -1, 0, (x) => x + 1, 32);

  // N -> E
  drawFunction(ctx, scale, 0, 1, (x) => -x + 1, 32);

  // W -> S
  drawFunction(ctx, scale, -1, 0, (x) => -x - 1, 32);

  // S -> E
  drawFunction(ctx, scale, 0, 1, (x) => x - 1, 32);
};

// ============================================================
// 11. DIAMOND — DIAGONAL
// ============================================================
//
// Locked as four straight lines:
//
// NW -> NE
// NE -> SE
// SE -> SW
// SW -> NW
//
// ============================================================

export const drawDiamondDiagonal = ({ ctx, size }: DrawContext): void => {
  const scale = size / 2;

  drawLine(ctx, scale, point(-1, 1), point(1, 1));

  drawLine(ctx, scale, point(1, 1), point(1, -1));

  drawLine(ctx, scale, point(1, -1), point(-1, -1));

  drawLine(ctx, scale, point(-1, -1), point(-1, 1));
};

// ============================================================
// Orientation
// ============================================================

export const orientationAngle: Record<Orientation, number> = {
  N: 0,
  E: Math.PI / 2,
  S: Math.PI,
  W: Math.PI * 1.5,
};

// ============================================================
// TILE RENDERER
// ============================================================
//
// IMPORTANT:
//
// drawFunc ALWAYS draws canonical geometry.
//
// Orientation is applied HERE.
//
// This means we never bake orientation into the mathematical
// definitions themselves.
// ============================================================

export const drawTile = (
  ctx: CanvasRenderingContext2D,
  tile: Tile,
  x: number,
  y: number,
  size: number,
  debug: boolean = false,
  style?: KolamStyle,
): void => {
  ctx.save();

  // Tile centre.
  ctx.translate(x, y);

  // Rotate canonical geometry.
  ctx.rotate(orientationAngle[tile.orientation]);

  // Clean mathematical stroke.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (style) {
    ctx.strokeStyle = style.strokeColor;
    ctx.fillStyle = style.dotColor;
  }

  // Canonical geometry.
  tile.drawFunc({
    ctx,
    size,
  });

  if (style) {
    ctx.fillStyle = style.dotColor;
  }
  drawDot(ctx);

  // Optional pseudo-point reference layer.
  if (debug) {
    drawPseudoPoints(ctx, size);
  }

  ctx.restore();
};

// ============================================================
// TILE DEFINITIONS
// ============================================================
//
// ALL CONNECTION ARRAYS:
//
// [N, E, S, W, NE, SE, SW, NW]
//
// conn:
// Actual connections for this orientation.
//
// conn_type:
// Canonical/base connections.
//
// ============================================================

export const tiles: Tile[] = [
  // ==========================================================
  // CIRCLE
  // ==========================================================

  {
    id: 1,
    name: "circle",
    orientation: "N",

    con: [
      0, // N
      0, // E
      0, // S
      0, // W
      0, // NE
      0, // SE
      0, // SW
      0, // NW
    ],

    conn_type: [0, 0, 0, 0, 0, 0, 0, 0],

    drawFunc: drawCircle,
  },

  // ==========================================================
  // DROP — VERTICAL
  // ==========================================================

  {
    id: 2,
    name: "drop_vertical",
    orientation: "N",

    con: [
      2, // N
      0, // E
      0, // S
      0, // W
      0, // NE
      0, // SE
      0, // SW
      0, // NW
    ],

    conn_type: [2, 0, 0, 0, 0, 0, 0, 0],

    drawFunc: drawDropVertical,
  },

  // ==========================================================
  // DROP — DIAGONAL
  // ==========================================================

  {
    id: 3,
    name: "drop_diagonal",
    orientation: "N",

    con: [
      0, // N
      0, // E
      0, // S
      0, // W
      2, // NE
      0, // SE
      0, // SW
      0, // NW
    ],

    conn_type: [0, 0, 0, 0, 2, 0, 0, 0],

    drawFunc: drawDropDiagonal,
  },

  // ==========================================================
  // EYE — VERTICAL
  // ==========================================================

  {
    id: 4,
    name: "eye_vertical",
    orientation: "N",

    con: [
      0, // N
      2, // E
      0, // S
      2, // W
      0, // NE
      0, // SE
      0, // SW
      0, // NW
    ],

    conn_type: [0, 2, 0, 2, 0, 0, 0, 0],

    drawFunc: drawEyeVertical,
  },

  // ==========================================================
  // EYE — DIAGONAL
  // ==========================================================

  {
    id: 5,
    name: "eye_diagonal",
    orientation: "N",

    con: [
      0, // N
      0, // E
      0, // S
      0, // W
      0, // NE
      2, // SE
      0, // SW
      2, // NW
    ],

    conn_type: [0, 0, 0, 0, 0, 2, 0, 2],

    drawFunc: drawEyeDiagonal,
  },

  // ==========================================================
  // DOOR — VERTICAL
  // ==========================================================

  {
    id: 6,
    name: "door_vertical",
    orientation: "N",

    con: [
      0, // N
      0, // E
      0, // S
      0, // W
      2, // NE
      0, // SE
      0, // SW
      2, // NW
    ],

    conn_type: [0, 0, 0, 0, 2, 0, 0, 2],

    drawFunc: drawDoorVertical,
  },

  // ==========================================================
  // DOOR — DIAGONAL
  // ==========================================================

  {
    id: 7,
    name: "door_diagonal",
    orientation: "N",

    con: [
      2, // N
      2, // E
      0, // S
      0, // W
      0, // NE
      0, // SE
      0, // SW
      0, // NW
    ],

    conn_type: [2, 2, 0, 0, 0, 0, 0, 0],

    drawFunc: drawDoorDiagonal,
  },

  // ==========================================================
  // FAN — VERTICAL
  // ==========================================================

  {
    id: 8,
    name: "fan_vertical",
    orientation: "N",

    con: [
      0, // N
      0, // E
      0, // S
      0, // W
      2, // NE
      2, // SE
      2, // SW
      0, // NW
    ],

    conn_type: [0, 0, 0, 0, 2, 2, 2, 0],

    drawFunc: drawFanVertical,
  },

  // ==========================================================
  // FAN — DIAGONAL
  // ==========================================================

  {
    id: 9,
    name: "fan_diagonal",
    orientation: "N",

    con: [
      2, // N
      2, // E
      2, // S
      0, // W
      0, // NE
      0, // SE
      0, // SW
      0, // NW
    ],

    conn_type: [2, 2, 2, 0, 0, 0, 0, 0],

    drawFunc: drawFanDiagonal,
  },

  // ==========================================================
  // DIAMOND — CARDINAL
  // ==========================================================

  {
    id: 10,
    name: "diamond_vertical",
    orientation: "N",

    con: [
      2, // N
      2, // E
      2, // S
      2, // W
      0, // NE
      0, // SE
      0, // SW
      0, // NW
    ],

    conn_type: [2, 2, 2, 2, 0, 0, 0, 0],

    drawFunc: drawDiamondVertical,
  },

  // ==========================================================
  // DIAMOND — DIAGONAL
  // ==========================================================

  {
    id: 11,
    name: "diamond_diagonal",
    orientation: "N",

    con: [
      0, // N
      0, // E
      0, // S
      0, // W
      2, // NE
      2, // SE
      2, // SW
      2, // NW
    ],

    conn_type: [0, 0, 0, 0, 2, 2, 2, 2],

    drawFunc: drawDiamondDiagonal,
  },
];
