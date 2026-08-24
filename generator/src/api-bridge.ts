/*
 * Line-oriented bridge for the local Python API.
 *
 * This is deliberately small: it invokes the teammate generator's public
 * `generateKolam` orchestrator and serialises only its solved topology.  The
 * HTTP API owns presentation-format rendering; it does not replace or
 * reimplement the solver.
 */

import { generateKolam } from "./GenerationOrchestrator.js";
import { paintTileGrid } from "./TilePainter.js";
import { createCanvas } from "@napi-rs/canvas";
import type { KolamStyle, Symmetry } from "./types.js";

type BridgeRequest = {
  width: number;
  height: number;
  dots: number;
  islands: number;
  symmetry: Symmetry;
  seed: number;
  maxAttempts?: number;
  style?: KolamStyle;
  debug?: boolean;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const write = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

async function main(): Promise<void> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
  const request = JSON.parse(raw) as BridgeRequest;
  const style: KolamStyle = request.style ?? {
    backgroundColor: "#321914",
    dotColor: "#dca45f",
    strokeColor: "#f5e9cf",
  };

  const originalLog = console.log;
  const originalRandom = Math.random;
  console.log = (...parts: unknown[]) => process.stderr.write(`${parts.join(" ")}\n`);
  Math.random = mulberry32(request.seed);

  try {
    const result = await generateKolam({
      width: request.width,
      height: request.height,
      dots: request.dots,
      islands: request.islands,
      symmetry: request.symmetry,
      maxAttempts: request.maxAttempts ?? 20,
      maxBacktracksPerAttempt: 100_000,
      maxRestartsPerAttempt: 5,
      seed: request.seed,
      onProgress: (attempt, maxAttempts) => {
        process.stderr.write(`KOLAM_PROGRESS ${JSON.stringify({ attempt, maxAttempts })}\n`);
      },
      yieldBetweenAttempts: false,
    });

    if (!result.success) {
      write({ success: false, attempts: result.attempts, failure: result.failure });
      return;
    }

    const connectionGrid = result.connectionGrid.map((row) => row.map((cell) => cell ? {
      familyId: cell.familyId,
      orientation: cell.orientation,
      con: cell.con,
    } : null));
    const tileGrid = result.tileGrid.map((row) => row.map((cell) => cell ? {
      id: cell.id,
      name: cell.name,
      orientation: cell.orientation,
      con: cell.con,
      conn_type: cell.conn_type,
    } : null));
    const dotCount = result.dotGrid.reduce((total, row) => total + row.filter((cell) => cell === 1).length, 0);
    const directedConnections = connectionGrid.reduce((total, row) => total + row.reduce((rowTotal, cell) => rowTotal + (cell?.con.filter((value) => value !== 0).length ?? 0), 0), 0);
    const families = new Set(connectionGrid.flat().flatMap((cell) => cell ? [cell.familyId] : []));
    const tileSize = Math.max(20, Math.floor(920 / Math.max(request.width, request.height)));
    const canvas = createCanvas(
      Math.round(request.width * tileSize + tileSize * 1.4),
      Math.round(request.height * tileSize + tileSize * 1.4),
    );
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    paintTileGrid(ctx, result.tileGrid, tileSize, Boolean(request.debug), style);

    write({
      success: true,
      attempts: result.attempts,
      dotGrid: result.dotGrid,
      connectionGrid,
      tileGrid,
      metrics: {
        seed: request.seed,
        width: request.width,
        height: request.height,
        dots: dotCount,
        edges: Math.round(directedConnections / 2),
        familyDiversity: families.size,
        decisions: result.solverResult.decisions,
        backtracks: result.solverResult.backtracks,
        propagations: result.solverResult.propagations,
      },
      render: {
        pngBase64: canvas.toBuffer("image/png").toString("base64"),
        width: canvas.width,
        height: canvas.height,
      },
    });
  } finally {
    Math.random = originalRandom;
    console.log = originalLog;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Generator bridge failed.";
  write({ success: false, attempts: 0, failure: { reason: "BRIDGE_ERROR", message } });
});
