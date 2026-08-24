"""Local HTTP bridge for the Kolam demonstration.

This module deliberately calls the same generation and perception code used by
the command-line prototype.  It never substitutes a cached render for a live
generation or an uploaded image analysis.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import shutil
import subprocess
import sys
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from reconstruction_pipeline import PIPELINE_VERSION, process_image

REPO_ROOT = Path(__file__).resolve().parent.parent
# Corpus source files were recorded from the shared workspace as well as this
# repository.  Keep that intentionally narrow, while allowing those real v29
# originals to be served alongside their evidence artifacts.
WORKSPACE_ROOT = REPO_ROOT.parents[3]
RUNTIME_ROOT = REPO_ROOT / "runtime" / "jobs"
RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
CORPUS_ROOT = REPO_ROOT / "outputs" / "corpus_full_v29"

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class GenerateRequest(BaseModel):
    width: int = Field(9, ge=1, le=25)
    height: int = Field(9, ge=1, le=25)
    dots: int = Field(25, ge=1, le=625)
    islands: int = Field(1, ge=1, le=625)
    symmetry: Literal[
        "None", "Mirror_V", "Mirror_H", "Mirror_Diagonal1", "Mirror_Diagonal2",
        "Rotational_1Fold", "Rotational_2Fold", "Rotational_4Fold",
    ] = "Rotational_4Fold"
    background_color: str = "#321914"
    dot_color: str = "#dca45f"
    stroke_color: str = "#f5e9cf"
    debug_geometry: bool = False
    mode: Literal["classical", "neural"] = "classical"
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    single_stroke: bool = False


@dataclass
class Job:
    id: str
    kind: Literal["generation", "analysis"]
    status: Literal["queued", "running", "complete", "failed", "cancelled"] = "queued"
    stage: str = "queued"
    progress: int = 0
    created_at: str = field(default_factory=now)
    updated_at: str = field(default_factory=now)
    error: str | None = None
    result: dict | None = None
    logs: list[dict[str, str]] = field(default_factory=list)
    cancel_requested: bool = False

    def public(self) -> dict:
        payload = asdict(self)
        payload.pop("cancel_requested", None)
        return payload


jobs: dict[str, Job] = {}
corpus_cache: list[dict[str, Any]] | None = None


def update(job: Job, stage: str, progress: int) -> None:
    job.status = "running"
    job.stage = stage
    job.progress = progress
    job.updated_at = now()


def append_log(job: Job, event: str, detail: str) -> None:
    """Expose only events emitted by a local solver or pipeline boundary."""
    job.logs.append({"at": now(), "event": event, "detail": detail})
    job.logs[:] = job.logs[-40:]
    job.updated_at = now()


def asset_url(job: Job, path: str | Path | None) -> str | None:
    if not path:
        return None
    candidate = Path(path)
    if not candidate.exists():
        return None
    return f"/api/jobs/{job.id}/assets/{candidate.name}"


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def corpus_records() -> list[dict[str, Any]]:
    """Build a deterministic, actual-v29 corpus index on first request."""
    global corpus_cache
    if corpus_cache is not None:
        return corpus_cache
    records: list[dict[str, Any]] = []
    if not CORPUS_ROOT.is_dir():
        corpus_cache = records
        return records
    for case_dir in sorted(CORPUS_ROOT.iterdir(), key=lambda path: path.name.casefold()):
        result_path = case_dir / "result.json"
        required = [case_dir / name for name in ("diagnostic.png", "reconstruction.png", "comparison.png", "reconstruction.svg")]
        if not case_dir.is_dir() or not result_path.is_file() or not all(path.is_file() for path in required):
            continue
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            source_path = Path(result.get("input", {}).get("path", "")).resolve()
        except (OSError, json.JSONDecodeError):
            continue
        # A source may have come from a temporary clipboard path.  It cannot be
        # honestly shown as an original later, so it is not part of this view.
        if not source_path.is_file() or not is_within(source_path, WORKSPACE_ROOT):
            continue
        lattice = result.get("lattice", {}) or {}
        fidelity = result.get("fidelity", {}) or {}
        topology = result.get("topology", {}) or {}
        records.append({
            "id": case_dir.name,
            "label": source_path.name,
            "status": result.get("status", "unknown"),
            "dots": len(result.get("dots", [])),
            "lattice": {key: lattice.get(key) for key in ("status", "residual", "occupancy")},
            "topology": topology.get("skeleton", {}),
            "fidelity": {key: fidelity.get(key) for key in ("exact_iou", "source_coverage", "prediction_precision", "stroke_agreement", "topology_match")},
            "segmentation": {key: (result.get("segmentation", {}) or {}).get(key) for key in ("foreground_fraction", "luminance_contrast", "binary_likeness")},
            "flags": result.get("flags", []),
            "notices": result.get("notices", []),
            "views": {
                "source": f"/api/corpus/{case_dir.name}/assets/source",
                "reconstruction": f"/api/corpus/{case_dir.name}/assets/reconstruction.png",
                "diagnostic": f"/api/corpus/{case_dir.name}/assets/diagnostic.png",
                "comparison": f"/api/corpus/{case_dir.name}/assets/comparison.png",
                "result": f"/api/corpus/{case_dir.name}/assets/result.json",
            },
        })
    corpus_cache = records
    return records


def bridge_runner() -> Path:
    suffix = ".cmd" if sys.platform == "win32" else ""
    runner = REPO_ROOT / "generator" / "node_modules" / ".bin" / f"tsx{suffix}"
    if not runner.exists():
        raise RuntimeError("The generation bridge is unavailable. Install its local dependencies and try again.")
    return runner


def valid_color(value: str) -> str:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("Generator colours must use six-digit hex values.")
    return value


def run_teammate_generator(
    *,
    request: GenerateRequest,
    seed: int,
    on_event: Callable[[str, dict[str, Any]], None],
) -> dict:
    """Execute the teammate's public generator and relay its emitted attempt log."""
    payload = {
        "width": request.width,
        "height": request.height,
        "dots": request.dots,
        "islands": request.islands,
        "symmetry": request.symmetry,
        "seed": seed,
        "maxAttempts": 50,
        "debug": request.debug_geometry,
        "style": {
            "backgroundColor": valid_color(request.background_color),
            "dotColor": valid_color(request.dot_color),
            "strokeColor": valid_color(request.stroke_color),
        },
    }
    proc = subprocess.Popen(
        [str(bridge_runner()), str(REPO_ROOT / "generator" / "src" / "api-bridge.ts")],
        cwd=REPO_ROOT / "generator",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin and proc.stdout and proc.stderr
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    def read_stdout() -> None:
        stdout_parts.append(proc.stdout.read())

    def read_stderr() -> None:
        for raw_line in proc.stderr:
            line = raw_line.strip()
            if line.startswith("KOLAM_PROGRESS "):
                try:
                    on_event("attempt", json.loads(line.removeprefix("KOLAM_PROGRESS ")))
                except json.JSONDecodeError:
                    stderr_parts.append(line)
            elif line:
                stderr_parts.append(line)
                on_event("solver", {"detail": line})

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    try:
        proc.stdin.write(json.dumps(payload))
        proc.stdin.close()
        proc.wait(timeout=180)
    except subprocess.TimeoutExpired as exc:
        proc.kill()
        raise RuntimeError("Generation exceeded the 180 second local limit.") from exc
    finally:
        stdout_thread.join(timeout=3)
        stderr_thread.join(timeout=3)

    try:
        result = json.loads("".join(stdout_parts))
    except json.JSONDecodeError as exc:
        detail = ("\n".join(stderr_parts) or "".join(stdout_parts) or "The generator bridge did not return JSON.")[-1000:]
        raise RuntimeError(f"Generation bridge failed: {detail}") from exc
    if proc.returncode != 0 or not result.get("success"):
        failure = result.get("failure", {})
        message = failure.get("message") if isinstance(failure, dict) else None
        detail = message or ("\n".join(stderr_parts) or "The solver did not find a valid topology.")[-1000:]
        raise RuntimeError(f"Generation failed: {detail}")
    return result


def generation_worker(job: Job, request: GenerateRequest) -> None:
    if request.mode == "neural":
        raise ValueError("Neural generation is not available in this local build.")
    if request.dots > request.width * request.height:
        raise ValueError("Dot count cannot exceed the requested grid capacity.")
    if request.islands > request.dots:
        raise ValueError("Island count cannot exceed the requested dot count.")

    work_dir = RUNTIME_ROOT / job.id
    work_dir.mkdir(parents=True, exist_ok=True)
    base_seed = request.seed if request.seed is not None else int(uuid.uuid4().int % 2_000_000_000)
    append_log(job, "request", f"{request.width}×{request.height} · {request.dots} dots · {request.islands} island(s) · {request.symmetry}")
    update(job, "preparing the form", 8)

    def on_event(event: str, payload: dict[str, Any]) -> None:
        if event == "attempt":
            attempt = int(payload.get("attempt", 0))
            maximum = max(1, int(payload.get("maxAttempts", 50)))
            update(job, f"solver attempt {attempt} of {maximum}", min(86, 10 + round(72 * attempt / maximum)))
            append_log(job, "attempt", f"attempt {attempt} / {maximum}")
        else:
            append_log(job, "solver", str(payload.get("detail", "solver event")))

    result = run_teammate_generator(request=request, seed=base_seed, on_event=on_event)

    if job.cancel_requested:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.updated_at = now()
        return

    update(job, "drawing the final form", 92)
    render = result.get("render", {}) or {}
    encoded_png = render.get("pngBase64")
    if not isinstance(encoded_png, str):
        raise RuntimeError("The generator returned no image.")
    png_path = work_dir / "generation.png"
    png_path.write_bytes(base64.b64decode(encoded_png, validate=True))
    metrics = result.get("metrics", {}) or {}
    append_log(
        job,
        "solved",
        f"{metrics.get('decisions', 0)} decisions · {metrics.get('backtracks', 0)} backtracks · {metrics.get('propagations', 0)} propagations",
    )
    job.result = {
        "request": request.model_dump(),
        "seed": base_seed,
        "render": {
            "engine": "Kolam generator",
            "symmetry": request.symmetry,
            "seed": base_seed,
            "width": request.width,
            "height": request.height,
            "dots": metrics.get("dots"),
            "islands": request.islands,
            "edges": metrics.get("edges"),
            "family_diversity": metrics.get("familyDiversity"),
            "attempts": result.get("attempts"),
            "decisions": metrics.get("decisions"),
            "backtracks": metrics.get("backtracks"),
            "propagations": metrics.get("propagations"),
            "png_url": asset_url(job, png_path),
        },
    }
    job.status = "complete"
    job.stage = "complete"
    job.progress = 100
    job.updated_at = now()


def analysis_worker(job: Job, image_path: Path) -> None:
    work_dir = RUNTIME_ROOT / job.id
    if job.cancel_requested:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.updated_at = now()
        return
    append_log(job, "source", image_path.name)
    update(job, "reading the image", 18)
    append_log(job, "analysis", "image processing started")
    v29_result = process_image(image_path, work_dir, resume=False)
    if job.cancel_requested:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.updated_at = now()
        return
    update(job, "preparing the reconstruction", 94)
    append_log(
        job,
        "result",
        f"{v29_result.get('status')} · {len(v29_result.get('dots', []))} recovered dots · lattice {v29_result.get('lattice', {}).get('status', 'unavailable')}",
    )
    artifacts = v29_result.get("artifacts", {}) or {}
    published: dict[str, Path] = {}
    for key, filename in {
        "diagnostic": "diagnostic.png",
        "svg": "reconstruction.svg",
        "png": "reconstruction.png",
        "comparison": "comparison.png",
    }.items():
        source = Path(artifacts.get(key, ""))
        if not source.is_file():
            raise RuntimeError(f"The reconstruction did not produce its required {filename} file.")
        destination = work_dir / filename
        shutil.copy2(source, destination)
        published[key] = destination
    result_json = Path(artifacts.get("diagnostic", "")).parent / "result.json"
    if not result_json.is_file():
        raise RuntimeError("The reconstruction did not produce result.json.")
    shutil.copy2(result_json, work_dir / "result.json")
    append_log(job, "files", "diagnostic, reconstruction, comparison, SVG, result.json")

    job.result = {
        "source_url": asset_url(job, image_path),
        "pipeline_version": v29_result.get("pipeline_version"),
        "status": v29_result.get("status"),
        "flags": v29_result.get("flags", []),
        "notices": v29_result.get("notices", []),
        "dots": v29_result.get("dots", []),
        "dot_inference": v29_result.get("dot_inference", {}),
        "lattice": v29_result.get("lattice", {}),
        "segmentation": v29_result.get("segmentation", {}),
        "topology": v29_result.get("topology", {}),
        "fidelity": v29_result.get("fidelity", {}),
        "assets": {
            "diagnostic": asset_url(job, published["diagnostic"]),
            "reconstruction": asset_url(job, published["png"]),
            "svg": asset_url(job, published["svg"]),
            "comparison": asset_url(job, published["comparison"]),
            "result": asset_url(job, work_dir / "result.json"),
        },
    }
    job.status = "complete"
    job.stage = "complete"
    job.progress = 100
    job.updated_at = now()


async def run_generation(job: Job, request: GenerateRequest) -> None:
    try:
        await asyncio.to_thread(generation_worker, job, request)
    except Exception as exc:  # noqa: BLE001 - surfaced safely to the UI
        job.status = "failed"
        job.stage = "failed"
        job.error = str(exc)
        job.updated_at = now()


async def run_analysis(job: Job, image_path: Path) -> None:
    try:
        await asyncio.to_thread(analysis_worker, job, image_path)
    except Exception as exc:  # noqa: BLE001 - surfaced safely to the UI
        job.status = "failed"
        job.stage = "failed"
        job.error = str(exc)
        job.updated_at = now()


app = FastAPI(title="Kolam local bridge", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "generation_engine": "teammate GenerationOrchestrator",
        "reconstruction_pipeline": PIPELINE_VERSION,
    }


@app.post("/api/generations", status_code=202)
async def create_generation(request: GenerateRequest) -> dict:
    job = Job(id=uuid.uuid4().hex, kind="generation")
    jobs[job.id] = job
    asyncio.create_task(run_generation(job, request))
    return job.public()


@app.post("/api/analyses", status_code=202)
async def create_analysis(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "upload.png").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(415, "Use a PNG, JPEG, or WebP image.")
    content = await file.read()
    if not content or len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Images must be smaller than 10 MB.")
    try:
        from PIL import Image
        from io import BytesIO

        with Image.open(BytesIO(content)) as image:
            width, height = image.size
            if not (128 <= width <= 6000 and 128 <= height <= 6000):
                raise ValueError
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, "The uploaded file is not a usable image between 128 and 6000 pixels.") from exc

    job = Job(id=uuid.uuid4().hex, kind="analysis")
    jobs[job.id] = job
    work_dir = RUNTIME_ROOT / job.id
    work_dir.mkdir(parents=True, exist_ok=True)
    image_path = work_dir / f"source{suffix}"
    image_path.write_bytes(content)
    asyncio.create_task(run_analysis(job, image_path))
    return job.public()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found.")
    return job.public()


@app.get("/api/jobs/{job_id}/assets/{asset_name}")
def get_asset(job_id: str, asset_name: str) -> FileResponse:
    job = jobs.get(job_id)
    root = (RUNTIME_ROOT / job_id).resolve()
    asset = (root / Path(asset_name).name).resolve()
    if job is None or root not in asset.parents or not asset.is_file():
        raise HTTPException(404, "Asset not found.")
    return FileResponse(asset)


@app.get("/api/corpus")
async def get_corpus(limit: int = 600) -> dict:
    # Indexing several thousand v29 evidence folders is real local I/O.  Keep
    # it out of FastAPI's request loop so a first corpus visit cannot stall a
    # concurrently running generation or reconstruction.
    records = await asyncio.to_thread(corpus_records)
    # Round-robin buckets preserve evidence variety without sampling randomly.
    # The display stays responsive while still growing beyond the former 240.
    buckets: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
    for record in records:
        bucket = (
            str(record["status"]),
            str(record["lattice"].get("status")),
            min(8, int(record["dots"]) // 25),
        )
        buckets.setdefault(bucket, []).append(record)
    selected: list[dict[str, Any]] = []
    offsets = {key: 0 for key in buckets}
    keys = sorted(buckets)
    target = max(1, min(limit, len(records), 900))
    while len(selected) < target:
        added = False
        for key in keys:
            offset = offsets[key]
            if offset >= len(buckets[key]):
                continue
            selected.append(buckets[key][offset])
            offsets[key] += 1
            added = True
            if len(selected) == target:
                break
        if not added:
            break
    return {"available": len(records), "records": selected}


@app.get("/api/corpus/{case_id}/assets/{asset_name}")
def get_corpus_asset(case_id: str, asset_name: str) -> FileResponse:
    root = (CORPUS_ROOT / case_id).resolve()
    if not is_within(root, CORPUS_ROOT) or not root.is_dir():
        raise HTTPException(404, "Corpus record not found.")
    names = {
        "diagnostic.png": root / "diagnostic.png",
        "reconstruction.png": root / "reconstruction.png",
        "comparison.png": root / "comparison.png",
        "reconstruction.svg": root / "reconstruction.svg",
        "result.json": root / "result.json",
    }
    if asset_name == "source":
        try:
            source = Path(json.loads((root / "result.json").read_text(encoding="utf-8"))["input"]["path"]).resolve()
        except (OSError, KeyError, json.JSONDecodeError):
            raise HTTPException(404, "Original source not available.") from None
        if not source.is_file() or not is_within(source, WORKSPACE_ROOT):
            raise HTTPException(404, "Original source not available.")
        return FileResponse(source)
    asset = names.get(asset_name)
    if asset is None or not asset.is_file():
        raise HTTPException(404, "Corpus artifact not found.")
    return FileResponse(asset)


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found.")
    job.cancel_requested = True
    if job.status == "queued":
        job.status = "cancelled"
        job.stage = "cancelled"
        job.updated_at = now()
    return job.public()


@app.post("/api/cleanup")
def cleanup_finished_jobs() -> dict:
    """Manual cleanup endpoint for the local demo; never touches source assets."""
    removed = 0
    for job_id, job in list(jobs.items()):
        if job.status not in {"complete", "failed", "cancelled"}:
            continue
        directory = RUNTIME_ROOT / job_id
        if directory.exists():
            shutil.rmtree(directory)
        jobs.pop(job_id, None)
        removed += 1
    return {"removed": removed}
