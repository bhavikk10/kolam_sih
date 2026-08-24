# Kolam local interface

This is a local React interface for the Kolam solver and reconstruction pipeline.

```powershell
npm install
npm run demo
```

The local interface is available at `http://localhost:3000` in development.
For a production preview, run `npm run build` followed by `npm run start`; it listens on port 8080.

## Truthfulness boundary

- **Generate** always queues fresh output from the local classical WFC/CP-SAT pipeline. An unlocked seed creates a new run; a locked seed is reproducible.
- **Analyse** sends an uploaded image through the real six-stage image pipeline. Failed stages are reported as failures; no substitute geometry or statistics are produced.
- The three analyser samples are explicitly marked **verified sample** because they are cached artifacts from completed pipeline runs.
- Neural mode is visible but unavailable until the learned model is wired in.

Temporary API artifacts live in `../runtime/jobs` and can be removed through the local cleanup endpoint after a demo.
