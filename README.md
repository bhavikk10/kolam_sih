# Kolam — Reconstruction, Generation & Corpus Studio

> A local research application for reading kolam drawings as structured evidence, reconstructing them as inspectable vector geometry, and generating new rule-constrained forms.

Kolam combines two complementary systems in one interface:

- **Reconstruction** — a v29 image-analysis pipeline that turns a photograph or scan into lattice, stroke, topology, SVG, raster, and fidelity evidence.
- **Generation** — a constraint-based TypeScript solver that creates new kolams from dot-count, island-count, symmetry, colour, and seed inputs.

The browser experience keeps the original image, recovered structure, rendered output, and machine-readable artifacts together rather than presenting a result as an opaque image.

## Navigate

- [Quick start](#quick-start)
- [How the system is organised](#how-the-system-is-organised)
- [Reconstruction methodology (v29)](#reconstruction-methodology-v29)
- [Generation methodology](#generation-methodology)
- [Corpus](#corpus)
- [API reference](#api-reference)
- [Project layout](#project-layout)
- [Reproducibility and limits](#reproducibility-and-limits)

## Quick start

### Prerequisites

- Node.js 22.13 or newer
- Python 3.10 or newer

Install the Python dependencies from the project root:

```powershell
python -m pip install -r requirements.txt
```

Install the web dependencies:

```powershell
cd web
npm install
```

The generator dependencies are included locally. If they need to be restored:

```powershell
cd ../generator
npm install
```

### Run the complete local application

From `web/`:

```powershell
npm run demo
```

This starts both services:

| Service | Address | Purpose |
| --- | --- | --- |
| Web application | http://localhost:3000 | Generate, analyse, browse corpus, and inspect methodology |
| Local API | http://127.0.0.1:8000 | Runs reconstruction, generation, jobs, and corpus access |

To run them separately, use `npm run dev` for the web interface and `npm run api` for the FastAPI service.

## How the system is organised

```text
Browser application (web/)
        │
        ├── POST /api/analyses
        │       └── v29 reconstruction pipeline (src/)
        │               └── evidence bundle: PNGs, SVG, JSON and metrics
        │
        ├── POST /api/generations
        │       └── generator/api-bridge.ts
        │               └── constraint solver → tile renderer → PNG
        │
        └── GET /api/corpus
                └── outputs/corpus_full_v29/
```

The web client deliberately calls the local API directly at `http://127.0.0.1:8000`. The API runs long work as jobs, so generation and reconstruction can be polled without blocking the interface.

## Reconstruction methodology (v29)

**Pipeline version:** `2026.08.benchmark-v29`

The reconstruction path is evidence-led: it estimates what is visible in the source, writes intermediate evidence, and reports uncertainty rather than claiming an exact symbolic reconstruction where the image cannot support one.

1. **Content-addressed input** — the image is hashed so completed analyses can be identified and safely resumed.
2. **Bounded-resolution analysis** — very large images are normalised to a practical analysis scale while retaining an explicit record of the source.
3. **Foreground segmentation** — contrast, polarity, and morphology separate drawn material from background.
4. **Text and watermark screening** — non-kolam marks are retained as evidence and can trigger quality notices.
5. **Multi-scale dot candidates** — dot-like structures are found across several scales instead of assuming a single image size.
6. **Affine lattice fitting** — a lattice is estimated with residual and occupancy evidence, accommodating moderate perspective and skew.
7. **Stroke topology** — the foreground is skeletonised, branches are pruned, and endpoints, junctions, and connected components are measured.
8. **Authoritative vector reconstruction** — recovered segments are transformed into an SVG representation; clean PNG and comparison views are derived from it.
9. **Round-trip fidelity** — rendered reconstruction and source are compared through coverage, precision, IoU, stroke agreement, and topology checks.
10. **Automatic release screen** — flags and notices make weak or unusual results visible instead of silently presenting them as reliable.

Each analysis stores an inspectable evidence bundle containing the source, diagnostic image, reconstruction, comparison image, SVG where applicable, and `result.json`.

For the extended methodology and reported evaluation, read [reconstruction_analysis.md](reconstruction_analysis.md).

## Generation methodology

Generation is not a style-transfer model. It is a local-constraint solver that produces a valid tile topology and then renders it.

1. A dot grid is created from width, height, dot count, island count, and requested symmetry.
2. The feasibility gate rejects combinations that cannot satisfy those requirements.
3. A connection solver propagates reciprocal eight-direction port constraints between neighbouring dots.
4. Symmetry and boundary constraints are maintained during solving.
5. The resolved connection masks are mapped to a tile family and orientation.
6. The selected tile grid is rendered by the generator bridge and returned to the API as a PNG plus structural metrics.

The generator is seedable. Supplying the same request and seed makes a result reproducible within the same solver version.

## Corpus

The active corpus lives in:

```text
outputs/corpus_full_v29/
```

The API indexes its completed v29 evidence folders at request time. Browse it at [http://localhost:3000/corpus](http://localhost:3000/corpus) while the application is running.

`outputs/corpus_sample_200_v29/` is a deterministic sample used for compact corpus work and inspection. Both folders are retained because the corpus is part of the running application, not a static frontend gallery.

## API reference

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Confirms service availability and versions |
| `POST` | `/api/generations` | Starts a generator job |
| `POST` | `/api/analyses` | Uploads an image and starts v29 reconstruction |
| `GET` | `/api/jobs/{id}` | Polls a running or completed job |
| `DELETE` | `/api/jobs/{id}` | Cancels a job |
| `GET` | `/api/jobs/{id}/assets/{name}` | Retrieves generated job artifacts |
| `GET` | `/api/corpus?limit=600` | Returns corpus metadata for the browser constellation |
| `GET` | `/api/corpus/{id}/assets/{name}` | Retrieves corpus evidence assets |
| `POST` | `/api/cleanup` | Removes completed runtime jobs according to the local cleanup policy |

## Project layout

```text
.
├── web/                         # Next/Vinext browser experience
│   ├── app/                     # Routes, components, visual system
│   └── public/samples/          # Curated analysis and interface samples
├── src/
│   ├── api_server.py            # FastAPI job, corpus and asset bridge
│   ├── reconstruction_pipeline.py # v29 orchestration and evidence output
│   ├── extract_paths.py         # Skeleton segment extraction
│   ├── skeletonize_strokes.py   # Stroke cleanup and pruning
│   ├── spline_render.py         # Vector path and raster rendering
│   ├── kolam_grammar.py         # Port and curve grammar
│   ├── hand_curves.py           # Curve motif geometry
│   └── wfc_engine.py            # Reconstruction-side constraint checks
├── generator/
│   └── src/                     # Grid, symmetry, solver, tiles and API bridge
├── outputs/
│   ├── corpus_full_v29/         # Active full-corpus evidence
│   └── corpus_sample_200_v29/   # Active deterministic sample
├── runtime/                     # Local, per-job output; generated at runtime
├── reconstruction_analysis.md   # Methodology, evaluation and limitations
└── requirements.txt             # Python dependencies
```

Historical experiments, legacy output, unused testers, and duplicate static corpus assets are intentionally kept outside this final project in the sibling `archives/` directory.

## Reproducibility and limits

- Reconstruction reports measured evidence, not guaranteed ground truth. Low-quality input, text overlays, fragmented strokes, perspective, and unconventional layouts can produce flags or notices.
- Round-trip metrics evaluate agreement between the observed image and the rendered recovered geometry. They do not replace expert annotation or establish cultural/semantic intent.
- Corpus availability depends on the two retained v29 corpus folders being present at their documented paths.
- Generated results are rule-constrained topologies rendered from a fixed tile vocabulary; they are not claims of historical authenticity.

## Development checks

After starting `npm run demo`, verify the full path locally:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
Invoke-RestMethod 'http://127.0.0.1:8000/api/corpus?limit=1'
```

Then visit the web application to exercise generation, image analysis, artifact inspection, and corpus navigation.

---

Built as a local, inspectable studio for structural study of kolam drawings.
