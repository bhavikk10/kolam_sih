'use client';
/* eslint-disable @next/next/no-img-element */

import Link from 'next/link';
import type { ChangeEvent, CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Aperture, ArrowDownToLine, ChevronLeft, ChevronRight,
  ImageUp,
  LoaderCircle, Maximize2, Orbit, Route, Sparkles, TriangleAlert,
  X,
} from 'lucide-react';

type View = 'home' | 'generate' | 'analyse' | 'corpus' | 'pipeline';
type GeneratorSymmetry = 'None' | 'Mirror_V' | 'Mirror_H' | 'Mirror_Diagonal1' | 'Mirror_Diagonal2' | 'Rotational_1Fold' | 'Rotational_2Fold' | 'Rotational_4Fold';
type RunLog = { at: string; event: string; detail: string };
type RenderData = { png_url?: string; symmetry?: GeneratorSymmetry; seed?: number; width?: number; height?: number; engine?: string; dots?: number; islands?: number; edges?: number; attempts?: number; decisions?: number; backtracks?: number; propagations?: number };
type AnalysisAssets = { diagnostic?: string; reconstruction?: string; comparison?: string; svg?: string; result?: string; v29_reconstruction?: string; tile_trace?: string };
type ReconstructionCandidate = { score?: number | null; exact_iou?: number; source_coverage?: number; prediction_precision?: number; stroke_agreement?: number; area_ratio?: number; method?: string; engine_confidence?: number; error?: string };
type ReconstructionSelection = { metric?: string; selection_threshold?: number; winner?: 'v29_vector' | 'tile_trace' | 'tie'; v29_vector?: ReconstructionCandidate; tile_trace?: ReconstructionCandidate };
type InputAssessment = { symmetry?: { vertical?: number; horizontal?: number; rotational?: number; best?: number }; lattice?: { detected?: boolean; rows?: number; columns?: number; dots?: number; spacing?: number; regularity?: number }; alternate?: { method?: string; confidence?: number; tile_confidence?: number; cells?: number } };
type AnalysisData = { source_url?: string; pipeline_version?: string; status?: string; flags?: string[]; notices?: string[]; dots?: unknown[]; lattice?: { status?: string; residual?: number; occupancy?: number }; topology?: { skeleton?: { endpoints?: number; junctions?: number; connected_components?: number; total_pixels?: number } }; fidelity?: { exact_iou?: number; source_coverage?: number; prediction_precision?: number; stroke_agreement?: number; topology_match?: boolean }; segmentation?: { foreground_fraction?: number; luminance_contrast?: number; binary_likeness?: number }; selection?: ReconstructionSelection; input_assessment?: InputAssessment; assets?: AnalysisAssets };
type ApiResult = AnalysisData & { render?: RenderData; seed?: number };
type Job = { id: string; status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'; stage: string; progress: number; error?: string; logs?: RunLog[]; result?: ApiResult };

const API = process.env.NEXT_PUBLIC_KOLAM_API_URL ?? 'http://127.0.0.1:8000';
const NAV: Array<{ id: View; label: string; detail: string; href: string; icon: typeof Sparkles }> = [
  { id: 'home', label: 'Arrival', detail: 'the line begins', href: '/', icon: Aperture },
  { id: 'generate', label: 'Generate', detail: 'solve a new form', href: '/generate', icon: Sparkles },
  { id: 'analyse', label: 'Analyse', detail: 'read a photograph', href: '/analyse', icon: ImageUp },
  { id: 'corpus', label: 'Corpus', detail: 'browse the field', href: '/corpus', icon: Orbit },
  { id: 'pipeline', label: 'Pipeline', detail: 'see each operation', href: '/pipeline', icon: Route },
];
const GENERATOR_SYMMETRIES: Array<{ value: GeneratorSymmetry; label: string }> = [
  { value: 'None', label: 'None' }, { value: 'Mirror_V', label: 'Mirror vertical' }, { value: 'Mirror_H', label: 'Mirror horizontal' },
  { value: 'Mirror_Diagonal1', label: 'Mirror diagonal \\' }, { value: 'Mirror_Diagonal2', label: 'Mirror diagonal /' },
  { value: 'Rotational_1Fold', label: 'Rotational 1-fold' }, { value: 'Rotational_2Fold', label: 'Rotational 2-fold' }, { value: 'Rotational_4Fold', label: 'Rotational 4-fold' },
];

const COPY: Record<View, { eyebrow: string; heading: string; body: string }> = {
  home: { eyebrow: 'Kolam / 01', heading: 'Structure\nin motion.', body: 'A rule-governed drawing practice, examined here as a dot lattice, an ordered path, and a set of local constraints.' },
  generate: { eyebrow: 'Generator / 02', heading: 'Specify a\nconstraint field.', body: 'Set lattice dimensions, occupied dots, independent paths, symmetry, colours, and an optional seed. The solver returns a new valid structure for that request.' },
  analyse: { eyebrow: 'Reconstructor / 03', heading: 'Recover a drawing\nfrom a photograph.', body: 'Upload a kolam image to measure its dot lattice, line topology, reconstruction, and supporting diagnostic artifacts.' },
  corpus: { eyebrow: 'Corpus / 04', heading: 'A field of\nremembered forms.', body: 'Each point is a processed corpus record. Its location, tone, and size are derived from reconstruction metadata; open one to inspect its source and evidence.' },
  pipeline: { eyebrow: 'Methodology / 05', heading: 'A working\nmethod atlas.', body: 'Four independent studies make the system legible: how a photograph is read, how evidence is checked, how a new form is solved, and how each result is made inspectable.' },
};

function absoluteApiUrl(url?: string) { return url ? (url.startsWith('http') ? url : `${API}${url}`) : undefined; }
function Heading({ view, projectTag }: { view: View; projectTag?: string }) {
  const copy = COPY[view];
  return <div className={`page-copy ${view}-copy`}>{projectTag ? <span className="project-tag">{projectTag}</span> : null}<span>{copy.eyebrow}</span><h1>{copy.heading.split('\n').map((line) => <span key={line}>{line}</span>)}</h1>{view === 'home' ? <div className="home-intro" aria-label="Introduction to kolams and this study space"><p className="home-intro-lead">{copy.body}</p><div className="home-intro-section"><span>01 / construction</span><p>A kolam starts with a measured dot lattice. Its line is routed around the dots rather than through them, so every loop is defined by local turning decisions.</p></div><div className="home-intro-section"><span>02 / topology</span><p>Repetition and symmetry are not surface effects: they constrain how paths close, where crossings are permitted, and whether the overall figure remains connected.</p></div><div className="home-intro-section"><span>03 / study system</span><p>This studio keeps the source image, recovered evidence, solver parameters, and rendered result in one place so that each figure can be inspected as a construction rather than only viewed as an image.</p></div></div> : <p>{copy.body}</p>}</div>;
}

function useJob(jobId?: string) {
  const [job, setJob] = useState<Job | undefined>();
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`${API}/api/jobs/${jobId}`);
        if (!response.ok) throw new Error(response.status === 404 ? 'This run belongs to an earlier service session. Start it again.' : 'The Kolam service did not return this run.');
        const next = (await response.json()) as Job;
        if (alive) setJob(next);
      } catch (error) {
        if (alive) setJob({ id: jobId, status: 'failed', stage: 'run unavailable', progress: 0, error: error instanceof Error ? error.message : 'The Kolam service is not reachable.' });
        if (timer !== undefined) window.clearInterval(timer);
      }
    };
    void poll(); timer = window.setInterval(poll, 900);
    return () => { alive = false; if (timer !== undefined) window.clearInterval(timer); };
  }, [jobId]);
  return job;
}

function Floor({ dense = false }: { dense?: boolean }) {
  return <><svg className="floor-grain" aria-hidden="true"><filter id="earth-noise"><feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" seed="12" /><feColorMatrix values="0.36 0 0 0 0.07 0 0.13 0 0 0 0.02 0 0 0.08 0 0.02 0 0 0 0.45 0" /></filter><rect width="100%" height="100%" filter="url(#earth-noise)" /></svg><div className={`ambient-lattice ${dense ? 'is-dense' : ''}`} aria-hidden="true" /><div className="floor-vignette" aria-hidden="true" /><div className="floor-register" aria-hidden="true"><i /><i /><i /></div></>;
}

function usePageVisibility() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

function FieldCursor() {
  const reduceMotion = useReducedMotion();
  const cursorRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reduceMotion || !window.matchMedia('(pointer:fine)').matches) return;
    const move = (event: PointerEvent) => {
      const cursor = cursorRef.current;
      if (!cursor) return;
      cursor.style.setProperty('--cursor-x', `${event.clientX}px`);
      cursor.style.setProperty('--cursor-y', `${event.clientY}px`);
      cursor.dataset.visible = 'true';
    };
    const leave = () => { if (cursorRef.current) cursorRef.current.dataset.visible = 'false'; };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('mouseleave', leave);
    return () => { window.removeEventListener('pointermove', move); document.removeEventListener('mouseleave', leave); };
  }, [reduceMotion]);
  return <span className="field-cursor" ref={cursorRef} data-visible="false" aria-hidden="true" />;
}

function Navigation({ active }: { active: View }) {
  const [visited, setVisited] = useState<View[]>([]);
  useEffect(() => {
    try { setVisited(JSON.parse(sessionStorage.getItem('kolamStudio.visited') ?? '[]') as View[]); }
    catch { setVisited([]); }
  }, []);
  const markVisited = (id: View) => {
    const next = [...new Set([...visited, id])];
    setVisited(next);
    sessionStorage.setItem('kolamStudio.visited', JSON.stringify(next));
  };
  return <nav className="edge-nav" aria-label="Kolam sections">{NAV.map(({ id, label, detail, href, icon: Icon }, index) => <Link className={`nav-glyph ${id === active ? 'is-active' : ''}${visited.includes(id) ? ' is-visited' : ''}`} href={href} key={id} onClick={() => markVisited(id)} aria-label={`${label}: ${detail}`}><span className="nav-orbit" aria-hidden="true" /><Icon size={18} strokeWidth={1.35} /><span className="nav-ribbon"><b>0{index + 1}</b><strong>{label}</strong><i>{detail}</i></span></Link>)}</nav>;
}
function Brand() { return <Link className="brand" href="/" aria-label="kolamStudio home"><span className="brand-wordmark"><b>kolam</b><i>Studio</i></span></Link>; }

function WedgeControl({ label, value, min, max, step = 1, color, display, hint, onChange }: { label: string; value: number; min: number; max: number; step?: number; color: string; display: string; hint: string; onChange: (next: number) => void }) {
  const pct = (value - min) / (max - min);
  return <label className="wedge-control"><span className="wedge-index">{label === 'grid' ? '01' : label === 'symmetry' ? '02' : '03'}</span><span className="wedge-name">{label}<small>{hint}</small></span><span className="wedge-arc" style={{ '--wedge': `${Math.max(18, pct * 88)}deg`, '--accent': color } as CSSProperties}><span className="wedge-value">{display}</span></span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function JobStatus({ job, onCancel }: { job?: Job; onCancel?: () => void }) {
  if (!job || job.status === 'complete') return null;
  const busy = job.status === 'queued' || job.status === 'running';
  return <div className={`job-status ${job.status}`} role="status" aria-live="polite">{busy ? <LoaderCircle className="spin" size={18} /> : <TriangleAlert size={18} />}<div><strong>{job.stage}</strong><span>{busy ? `${job.progress}% — in progress` : job.error ?? 'The job could not complete.'}</span></div>{busy && onCancel ? <button className="icon-button" onClick={onCancel} aria-label="Cancel current job"><X size={16} /></button> : null}</div>;
}

function logTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function RunLog({ job, label }: { job?: Job; label: string }) {
  if (!job?.logs?.length) return null;
  return <section className="run-log" aria-label={`${label} live log`}><header><span>{label}</span><small>{job.status === 'complete' ? 'completed run' : 'live record'}</small></header><ol>{job.logs.slice(-12).map((item, index) => <li key={`${item.at}-${index}`}><time dateTime={item.at}>{logTime(item.at)}</time><div><b>{item.event.replaceAll('_', ' ')}</b><span>{item.detail}</span></div></li>)}</ol></section>;
}

function symmetryGuide(symmetry: GeneratorSymmetry) {
  if (symmetry.includes('4Fold')) return 'is-quarter-turn';
  if (symmetry.includes('2Fold')) return 'is-half-turn';
  if (symmetry.includes('Vertical')) return 'is-vertical';
  if (symmetry.includes('Horizontal')) return 'is-horizontal';
  if (symmetry.includes('Diagonal1')) return 'is-diagonal-one';
  if (symmetry.includes('Diagonal2')) return 'is-diagonal-two';
  return 'is-free';
}

function ConstructionPreview({ width, height, dots, symmetry }: { width: number; height: number; dots: number; symmetry: GeneratorSymmetry }) {
  const count = width * height;
  const occupied = useMemo(() => {
    const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => ((a * 71 + width * 23 + height * 13) % count) - ((b * 71 + width * 23 + height * 13) % count));
    return new Set(order.slice(0, Math.min(dots, count)));
  }, [count, dots, height, width]);
  return <div className="constraint-preview" aria-label={`Pre-solve lattice: ${width} by ${height} grid, ${dots} requested dots, ${symmetry}`}><div className="constraint-preview-grid" style={{ gridTemplateColumns: `repeat(${width}, 1fr)`, gridTemplateRows: `repeat(${height}, 1fr)`, aspectRatio: `${width} / ${height}` }}>{Array.from({ length: count }, (_, index) => <i className={occupied.has(index) ? 'is-occupied' : ''} key={index} />)}</div><span className={`symmetry-guide ${symmetryGuide(symmetry)}`} aria-hidden="true"><i /><i /></span></div>;
}

function SolverLoom({ job }: { job?: Job }) {
  const progress = job?.progress ?? 0;
  const stages = ['field', 'solve', 'verify', 'render'];
  return <div className="solver-loom" aria-live="polite"><div className="solver-progress"><b>{progress}<span>%</span></b><i><em style={{ width: `${progress}%` }} /></i></div><div className="solver-loom-stages">{stages.map((stage, index) => <span className={progress >= index * 25 || job?.stage.toLowerCase().includes(stage) ? 'is-lit' : ''} key={stage} />)}</div><strong>{job?.stage ?? 'waiting for generation service'}</strong><small>progress reported by the solver</small></div>;
}

function Generator() {
  const [width, setWidth] = useState(9);
  const [height, setHeight] = useState(9);
  const [dots, setDots] = useState(25);
  const [islands, setIslands] = useState(1);
  const [symmetry, setSymmetry] = useState<GeneratorSymmetry>('Rotational_4Fold');
  const [backgroundColor, setBackgroundColor] = useState('#321914');
  const [dotColor, setDotColor] = useState('#dca45f');
  const [strokeColor, setStrokeColor] = useState('#f5e9cf');
  const [debugGeometry, setDebugGeometry] = useState(false);
  const [lockSeed, setLockSeed] = useState(false);
  const [seed, setSeed] = useState<number | undefined>();
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const displayRender = job?.status === 'complete' ? job.result?.render : undefined;
  const focused = Boolean(displayRender?.png_url);
  const isSolving = job?.status === 'running' || job?.status === 'queued';
  useEffect(() => { if (job?.status === 'complete' && job.result?.seed !== undefined) setSeed(job.result.seed); }, [job?.status, job?.result?.seed]);
  const updateWidth = (next: number) => { const value = Math.max(1, Math.min(25, next || 1)); setWidth(value); setDots((current) => Math.min(current, value * height)); };
  const updateHeight = (next: number) => { const value = Math.max(1, Math.min(25, next || 1)); setHeight(value); setDots((current) => Math.min(current, width * value)); };
  const generate = async () => {
    try {
      const response = await fetch(API + '/api/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ width, height, dots, islands, symmetry, background_color: backgroundColor, dot_color: dotColor, stroke_color: strokeColor, debug_geometry: debugGeometry, mode: 'classical', seed: lockSeed ? seed : null }) });
      if (!response.ok) throw new Error(await response.text());
      const started = (await response.json()) as Job;
      setJobId(started.id);
    } catch (error) { window.alert('Generation could not start: ' + (error instanceof Error ? error.message : 'unknown error')); }
  };
  const cancel = async () => { if (jobId) await fetch(API + '/api/jobs/' + jobId, { method: 'DELETE' }); };
  return <section className={'generator-stage' + (focused ? ' is-focused' : '')}>
    <Heading view="generate" />
    <motion.div className={'generator-art' + (job && job.status !== 'complete' ? ' is-working' : '')} layout transition={{ type: 'spring', stiffness: 70, damping: 20 }}>
      <AnimatePresence mode="wait">
        {displayRender?.png_url ? <motion.div key={displayRender.png_url} className="generator-output">
          <motion.img className="living-output" initial={{ clipPath: 'inset(8% 8% 8% 8%)', opacity: 0, scale: .9 }} animate={{ clipPath: 'inset(0 0 0 0)', opacity: 1, scale: 1 }} transition={{ duration: 1.05, ease: 'easeOut' }} src={absoluteApiUrl(displayRender.png_url)} alt={'Generated ' + displayRender.symmetry + ' kolam'} />
          <div className="generator-output-meta"><span>generated form</span><strong>{displayRender.width} × {displayRender.height} · {displayRender.dots} dots · {displayRender.islands} island{displayRender.islands === 1 ? '' : 's'}</strong><small>{displayRender.decisions} decisions · {displayRender.backtracks} backtracks · {displayRender.propagations} propagations</small></div>
        </motion.div> : isSolving ? <motion.div key={job?.id ?? 'solving'} className="generator-empty-state is-solving" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><SolverLoom job={job} /></motion.div> : <motion.div key="awaiting-solve" className="generator-empty-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><ConstructionPreview width={width} height={height} dots={dots} symmetry={symmetry} /></motion.div>}
      </AnimatePresence>
    </motion.div>
    <aside className="control-drift" aria-label="Generation controls">
      <div className="control-heading"><div><span>generator</span><strong>generation parameters</strong></div></div>
      <div className="generator-fields">
        <label><span>grid width</span><input type="number" min="1" max="25" value={width} onChange={(event) => updateWidth(Number(event.target.value))} /><small>lattice columns</small></label>
        <label><span>grid height</span><input type="number" min="1" max="25" value={height} onChange={(event) => updateHeight(Number(event.target.value))} /><small>lattice rows</small></label>
        <label><span>number of dots</span><input type="number" min="1" max={width * height} value={dots} onChange={(event) => setDots(Math.max(1, Math.min(width * height, Number(event.target.value) || 1)))} /><small>occupied positions</small></label>
        <label><span>number of islands</span><input type="number" min="1" max={dots} value={islands} onChange={(event) => setIslands(Math.max(1, Math.min(dots, Number(event.target.value) || 1)))} /><small>independent returns</small></label>
        <label className="generator-select"><span>symmetry</span><select value={symmetry} onChange={(event) => setSymmetry(event.target.value as GeneratorSymmetry)}>{GENERATOR_SYMMETRIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>construction constraint</small></label>
      </div>
      <div className="palette-controls"><span>render colours</span><label><span>ground</span><input type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} /></label><label><span>dots</span><input type="color" value={dotColor} onChange={(event) => setDotColor(event.target.value)} /></label><label><span>stroke</span><input type="color" value={strokeColor} onChange={(event) => setStrokeColor(event.target.value)} /></label></div>
      <label className="debug-toggle-control"><input type="checkbox" checked={debugGeometry} onChange={(event) => setDebugGeometry(event.target.checked)} /> show construction guides</label>
      <label className="seed-lock"><input type="checkbox" checked={lockSeed} onChange={(event) => { setLockSeed(event.target.checked); if (!seed) setSeed(Math.floor(Math.random() * 2_000_000_000)); }} /> lock seed {lockSeed && seed ? <code>{seed}</code> : <em>new form each time</em>}</label>
      <button className={'action-button' + (isSolving ? ' is-pausing' : '')} onClick={isSolving ? cancel : generate}>{isSolving ? 'cancel generation' : 'generate valid form'}</button>
      {displayRender?.png_url ? <a className="quiet-download" href={absoluteApiUrl(displayRender.png_url)} download><ArrowDownToLine size={14} /> export image</a> : null}
      <JobStatus job={job} />
      <RunLog job={job} label="generation log" />
    </aside>
  </section>;
}

type Sample = { id: string; source: string; preview?: string; fallback?: string; label: string };
type GalleryRecord = { id: string; label?: string; views: { source: string; reconstruction: string } };
const FALLBACK_SAMPLES: Sample[] = [
  { id: 'local-001', source: '/samples/kolam_color_001.jpg', label: 'reference image 01' },
  { id: 'local-002', source: '/samples/kolam_color_002.jpg', label: 'reference image 02' },
  { id: 'local-003', source: '/samples/kolam_color_003.jpg', label: 'reference image 03' },
];

function formatRatio(value?: number) { return value === undefined ? '—' : (value * 100).toFixed(1) + '%'; }

function formatScore(value?: number) { return typeof value === 'number' ? `${value.toFixed(1)}%` : '—'; }

function SourceAssessment({ assessment }: { assessment?: InputAssessment }) {
  const symmetry = assessment?.symmetry;
  if (!symmetry) return null;
  const axes: Array<[string, number | undefined]> = [
    ['vertical mirror', symmetry.vertical],
    ['horizontal mirror', symmetry.horizontal],
    ['180° rotation', symmetry.rotational],
  ];
  const lattice = assessment?.lattice;
  const alternate = assessment?.alternate;
  const grid = lattice?.detected ? `${lattice.rows ?? '—'} × ${lattice.columns ?? '—'}` : 'not detected';
  return <section className="source-assessment"><header><span>source assessment</span><strong>symmetry / lattice</strong></header><div className="symmetry-profile">{axes.map(([label, value]) => <div className="symmetry-row" key={label}><span>{label}</span><i aria-hidden="true"><b style={{ '--symmetry-score': `${Math.max(0, Math.min(100, value ?? 0))}%` } as CSSProperties} /></i><strong>{formatScore(value)}</strong></div>)}</div><div className="source-assessment-grid"><div><small>dot grid</small><b>{grid}</b><em>{lattice?.dots ?? '—'} recovered points</em></div><div><small>grid regularity</small><b>{formatScore(lattice?.regularity)}</b><em>spacing {lattice?.spacing ?? '—'} px</em></div>{alternate?.confidence !== undefined ? <div><small>alternate read</small><b>{formatScore(alternate.confidence)}</b><em>{alternate.method ?? 'trace'} · {alternate.cells ?? 0} cells</em></div> : null}{alternate?.tile_confidence !== undefined ? <div><small>tile evidence</small><b>{formatScore(alternate.tile_confidence)}</b><em>local tile classification</em></div> : null}</div></section>;
}

function AnalysisLedger({ result }: { result?: AnalysisData }) {
  if (!result) return <section className="analysis-ledger is-empty"><header><span>analysis</span><strong>awaiting image</strong></header><p>Recovered structure, measured qualities, and reference files appear here after analysis.</p></section>;
  const skeleton = result.topology?.skeleton;
  const selection = result.selection;
  const winner = selection?.winner === 'tile_trace' ? 'tile / trace reconstruction' : selection?.winner === 'tie' ? 'outputs are within the selection threshold' : 'vector reconstruction';
  return <section className="analysis-ledger"><header><span>analysis</span><strong>reconstruction record</strong><i>{result.status?.replace('_', ' ')}</i></header><div className="analysis-metrics"><div><small>lattice</small><b>{result.lattice?.status ?? 'not recovered'}</b><em>residual {result.lattice?.residual?.toFixed(2) ?? '—'}</em></div><div><small>dots</small><b>{result.dots?.length ?? 0}</b><em>occupancy {formatRatio(result.lattice?.occupancy)}</em></div><div><small>topology</small><b>{skeleton?.connected_components ?? '—'} components</b><em>{skeleton?.endpoints ?? '—'} endpoints · {skeleton?.junctions ?? '—'} junctions</em></div><div><small>shape agreement</small><b>{formatRatio(result.fidelity?.stroke_agreement)}</b><em>source coverage {formatRatio(result.fidelity?.source_coverage)}</em></div></div>{selection ? <div className="analysis-selection"><span>output selection</span><strong>{winner}</strong><small>{selection.metric ?? 'comparison unavailable'}</small><div><b>vector <i>{selection.v29_vector?.score?.toFixed(2) ?? '—'}</i></b><b>tile / trace <i>{selection.tile_trace?.score?.toFixed(2) ?? '—'}</i></b></div></div> : null}<SourceAssessment assessment={result.input_assessment} />{result.flags?.length || result.notices?.length ? <div className="analysis-notices">{[...(result.flags ?? []), ...(result.notices ?? [])].slice(0, 5).map((notice) => <span key={notice}>{notice.replaceAll('_', ' ')}</span>)}</div> : null}<div className="analysis-artifacts"><span>files</span>{result.assets?.v29_reconstruction ? <a href={absoluteApiUrl(result.assets.v29_reconstruction)} target="_blank" rel="noreferrer">vector output</a> : null}{result.assets?.tile_trace ? <a href={absoluteApiUrl(result.assets.tile_trace)} target="_blank" rel="noreferrer">tile / trace output</a> : null}{result.assets?.diagnostic ? <a href={absoluteApiUrl(result.assets.diagnostic)} target="_blank" rel="noreferrer">diagnostic</a> : null}{result.assets?.comparison ? <a href={absoluteApiUrl(result.assets.comparison)} target="_blank" rel="noreferrer">comparison</a> : null}{result.assets?.svg ? <a href={absoluteApiUrl(result.assets.svg)} target="_blank" rel="noreferrer">vector</a> : null}{result.assets?.result ? <a href={absoluteApiUrl(result.assets.result)} target="_blank" rel="noreferrer">result.json</a> : null}</div></section>;
}

function Analyser() {
  const [jobId, setJobId] = useState<string>();
  const [samples, setSamples] = useState<Sample[]>(FALLBACK_SAMPLES);
  const [selectedSample, setSelectedSample] = useState<Sample | undefined>(FALLBACK_SAMPLES[0]);
  const [sourcePreview, setSourcePreview] = useState<string>();
  const [blend, setBlend] = useState(0);
  const [lensMode, setLensMode] = useState<'source' | 'reconstruction' | 'diagnostic'>('source');
  const inspectorRef = useRef<HTMLSpanElement>(null);
  const job = useJob(jobId);
  const result: AnalysisData | undefined = job?.status === 'complete' ? job.result : undefined;
  const isAnalysing = job?.status === 'queued' || job?.status === 'running';
  const activeSource = result ? absoluteApiUrl(result.source_url) : isAnalysing ? sourcePreview : undefined;
  const activeRecon = result ? absoluteApiUrl(result.assets?.reconstruction) : undefined;
  const activeDiagnostic = result ? absoluteApiUrl(result.assets?.diagnostic) : undefined;
  const inspectedAsset = lensMode === 'source' ? activeSource : lensMode === 'reconstruction' ? activeRecon : activeDiagnostic;
  useEffect(() => {
    const controller = new AbortController();
    fetch(API + '/api/corpus/gallery?limit=25', { signal: controller.signal }).then((response) => response.ok ? response.json() as Promise<{ records?: GalleryRecord[] }> : undefined).then((payload) => {
      const records = payload?.records;
      if (!records?.length) return;
      const references = records
        .filter((record) => record.id && record.views.source && record.views.reconstruction)
        .slice(0, 25)
        .map((record) => ({
          id: record.id,
          source: absoluteApiUrl(record.views.source)!,
          preview: absoluteApiUrl(record.views.source)!,
          fallback: absoluteApiUrl(record.views.reconstruction),
          label: record.label ?? 'corpus reference',
        }));
      if (references.length) {
        setSamples(references);
        setSelectedSample(references[0]);
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  useEffect(() => () => { if (sourcePreview?.startsWith('blob:')) URL.revokeObjectURL(sourcePreview); }, [sourcePreview]);
  const startAnalysis = async (file?: File, preview?: string) => {
    if (!file) return;
    if (preview) setSourcePreview(preview);
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await fetch(API + '/api/analyses', { method: 'POST', body: form });
      if (!response.ok) throw new Error(await response.text());
      const started = (await response.json()) as Job;
      setBlend(0);
      setLensMode('source');
      setJobId(started.id);
    } catch (error) { window.alert('Analysis could not start: ' + (error instanceof Error ? error.message : 'unknown error')); }
  };
  const startSampleAnalysis = async (sample: Sample) => {
    setSelectedSample(sample);
    setJobId(undefined);
    setSourcePreview(sample.source);
    try {
      const response = await fetch(API + '/api/analyses/corpus/' + encodeURIComponent(sample.id), { method: 'POST' });
      if (!response.ok) throw new Error(await response.text());
      const started = (await response.json()) as Job;
      setBlend(0);
      setLensMode('source');
      setJobId(started.id);
    } catch (error) { window.alert('Sample could not be analysed: ' + (error instanceof Error ? error.message : 'unknown error')); }
  };
  const onInput = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void startAnalysis(file, URL.createObjectURL(file)); };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void startAnalysis(file, URL.createObjectURL(file)); };
  const cancel = async () => { if (jobId) await fetch(API + '/api/jobs/' + jobId, { method: 'DELETE' }); };
  const moveInspector = (event: ReactPointerEvent<HTMLDivElement>) => {
    const inspector = inspectorRef.current;
    if (!inspector || !inspectedAsset) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100));
    inspector.style.setProperty('--inspect-x', `${x}%`);
    inspector.style.setProperty('--inspect-y', `${y}%`);
    inspector.style.backgroundPosition = `${x}% ${y}%`;
    inspector.dataset.visible = 'true';
  };
  const hideInspector = () => { if (inspectorRef.current) inspectorRef.current.dataset.visible = 'false'; };
  return <section className={'analysis-stage' + (result ? ' is-focused' : '')}>
    <Heading view="analyse" />
    <motion.div className={'analysis-canvas' + (result && inspectedAsset ? ' has-inspector' : '')} onPointerMove={moveInspector} onPointerLeave={hideInspector} layout transition={{ type: 'spring', stiffness: 70, damping: 20 }}>
      {activeRecon ? <img className="analysis-reconstruction" src={activeRecon} alt="Reconstructed kolam" /> : null}
      {activeSource ? <div className="analysis-source-window" style={{ clipPath: activeRecon ? 'inset(0 ' + blend + '% 0 0)' : 'inset(0 0 0 0)' }}><img className="analysis-source" src={activeSource} alt="Kolam submitted for structural analysis" /></div> : null}
      {activeRecon ? <span className="scan-divider" style={{ left: (100 - blend) + '%' }} aria-hidden="true" /> : null}
      {isAnalysing && activeSource ? <div className="analysis-scan-pass" aria-hidden="true"><i /><b /><b /><b /><span>{job?.stage}</span></div> : null}
      {result && inspectedAsset ? <span ref={inspectorRef} className="analysis-inspector" style={{ backgroundImage: `url(\"${inspectedAsset}\")` }} data-visible="false" aria-hidden="true" /> : null}
      {result ? <div className="analysis-inspector-tabs" role="group" aria-label="Inspect returned analysis artifact"><button className={lensMode === 'source' ? 'selected' : ''} onClick={() => setLensMode('source')} disabled={!activeSource}>source</button><button className={lensMode === 'reconstruction' ? 'selected' : ''} onClick={() => setLensMode('reconstruction')} disabled={!activeRecon}>reconstruction</button><button className={lensMode === 'diagnostic' ? 'selected' : ''} onClick={() => setLensMode('diagnostic')} disabled={!activeDiagnostic}>diagnostic</button></div> : null}
      <div className="scan-register" aria-hidden="true"><span>{activeRecon ? 'comparison frame' : activeSource ? 'source frame' : 'scan well'}</span><i /><span>{activeRecon ? 'original / reconstruction' : activeSource ? 'measuring source' : 'awaiting image'}</span></div>
    </motion.div>
    <aside className="analysis-tools">
      <div className="tool-heading"><span>reconstructor</span><strong>input image</strong></div>
      <label className="upload-target" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><strong>drop or choose an image</strong><span>PNG, JPEG, or WebP</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={onInput} /></label>
      <div className="study-rack sample-carousel"><div><span>reference gallery</span></div><div className="study-list">{samples.map((sample) => <button key={sample.id} className={selectedSample?.id === sample.id && isAnalysing ? 'selected' : ''} onClick={() => void startSampleAnalysis(sample)} aria-label={'Analyse ' + sample.label}><img src={sample.preview ?? sample.source} alt="" onError={(event) => { if (sample.fallback && event.currentTarget.src !== sample.fallback) event.currentTarget.src = sample.fallback; }} /></button>)}</div></div>
      <label className="blend-control"><span>comparison divider</span><div className="scrub-rail"><i>original</i><input aria-label="Original to reconstruction scan slider" type="range" min="0" max="100" value={blend} onChange={(event) => setBlend(Number(event.target.value))} /><i>reconstruction</i></div></label>
      <AnalysisLedger result={result} />
      <JobStatus job={job} onCancel={cancel} />
      <RunLog job={job} label="analysis log" />
    </aside>
  </section>;
}

type CorpusRecord = { id: string; label: string; status: string; dots: number; lattice: { status?: string; residual?: number; occupancy?: number }; topology: { endpoints?: number; junctions?: number; connected_components?: number }; fidelity: { exact_iou?: number; source_coverage?: number; prediction_precision?: number; stroke_agreement?: number; topology_match?: boolean }; segmentation: { foreground_fraction?: number; luminance_contrast?: number; binary_likeness?: number }; flags: string[]; notices: string[]; views: { source: string; reconstruction: string; diagnostic: string; comparison: string; result: string } };
const corpusHash = (value: string) => [...value].reduce((hash, character) => ((hash * 31 + character.charCodeAt(0)) >>> 0), 7);

function Corpus() {
  const [focus, setFocus] = useState<CorpusRecord | undefined>();
  const [opened, setOpened] = useState<CorpusRecord | undefined>();
  const [corpus, setCorpus] = useState<CorpusRecord[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const reduceMotion = useReducedMotion();
  const pageVisible = usePageVisibility();
  useEffect(() => { fetch(API + '/api/corpus?limit=600').then((response) => response.ok ? response.json() as Promise<{ records?: CorpusRecord[] }> : undefined).then((payload) => { if (payload?.records) setCorpus(payload.records); }).catch(() => undefined); }, []);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpened(undefined); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
  const frames = opened ? [{ key: 'source', label: 'original', url: opened.views.source }, { key: 'reconstruction', label: 'reconstruction', url: opened.views.reconstruction }, { key: 'diagnostic', label: 'diagnostic', url: opened.views.diagnostic }, { key: 'comparison', label: 'comparison', url: opened.views.comparison }] : [];
  useEffect(() => { setFrameIndex(0); }, [opened?.id]);
  return <section className="corpus-stage">
    <Heading view="corpus" />
    <div className="constellation" aria-label="Kolam corpus constellation">
      <div className="corpus-precession" aria-hidden="true"><i /><i /><i /></div>
      <div className="constellation-field">
        {corpus.map((record, index) => {
          const hash = corpusHash(record.id);
          const angle = (index * 137.508 + (hash % 83)) % 360;
          const radialSeed = (hash >>> 9) % 100;
          const radius = radialSeed < 34 ? 218 + ((hash >>> 16) % 78) : radialSeed < 90 ? 128 + ((hash >>> 13) % 91) : 56 + ((hash >>> 11) % 62);
          const squash = .64 + ((hash >>> 6) % 18) / 100;
          const size = Math.min(18, 4 + Math.sqrt(Math.max(record.dots, 1)) * .92);
          const tone = (hash >>> 4) % 4;
          const duration = 76 + (hash % 64);
          const phase = -((hash % 18) + ((hash >>> 15) % 10) / 10);
          const isFocused = focus?.id === record.id;
          return <motion.span key={record.id} className="corpus-orbit" style={{ '--orbit-radius': radius + 'px', '--orbit-squash': String(squash), '--counter-squash': String(1 / squash), '--node-delay': phase + 's' } as CSSProperties} initial={{ rotate: angle - 25 }} animate={{ rotate: reduceMotion || !pageVisible ? angle - 25 : angle - 385 }} transition={{ duration, repeat: reduceMotion || !pageVisible ? 0 : Infinity, ease: 'linear', delay: reduceMotion || !pageVisible ? 0 : phase }}><span className="corpus-orbit-arm">{isFocused ? <span className="corpus-node-tether" aria-hidden="true" /> : null}<motion.button className={'corpus-node tone-' + tone + (record.status === 'auto_flagged' ? ' is-flagged' : '') + (isFocused ? ' is-focused' : '')} style={{ width: size, height: size }} animate={{ opacity: 1 }} transition={{ duration: .25 }} onFocus={() => setFocus(record)} onMouseEnter={() => setFocus(record)} onClick={() => { setFocus(record); setOpened(record); }} aria-label={'Open ' + record.label + ', ' + record.dots + ' recovered dots, ' + record.status} /></span></motion.span>;
        })}
      </div>
    </div>
    {focus ? <motion.div className={'corpus-focus ' + focus.status} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}><img src={absoluteApiUrl(focus.views.reconstruction)} alt="" /><div><span>{focus.label}</span><strong>{focus.dots} dots · {focus.lattice.status}</strong><small>open record</small><div className="corpus-provenance" aria-hidden="true"><span>source</span><i /><span>reconstruction</span><i /><span>diagnostic</span></div></div></motion.div> : null}
    <AnimatePresence>{opened ? <motion.div className="artifact-overlay" role="dialog" aria-modal="true" aria-label={'Corpus study ' + opened.label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><button className="overlay-backdrop" onClick={() => setOpened(undefined)} aria-label="Close corpus study" /><motion.article className="artifact-card corpus-artifact-card" initial={{ y: 20, scale: .98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, scale: .98 }}><div className="artifact-image"><img src={absoluteApiUrl(frames[frameIndex]?.url)} alt={String(frames[frameIndex]?.label) + ' for ' + opened.label} /><span><Maximize2 size={14} /> record / {frames[frameIndex]?.label}</span><div className="artifact-frame-tabs">{frames.map((frame, index) => <button className={frameIndex === index ? 'selected' : ''} key={frame.key} onClick={() => setFrameIndex(index)}>{frame.label}</button>)}</div></div><div className="artifact-meta"><button className="artifact-close" onClick={() => setOpened(undefined)} aria-label="Close"><X size={18} /></button><span>corpus record / {opened.status}</span><h2>{opened.label}</h2><p>Original, reconstruction, and diagnostic remain together for this record.</p><dl><div><dt>recovered dots</dt><dd>{opened.dots}</dd></div><div><dt>lattice</dt><dd>{opened.lattice.status ?? '—'}</dd></div><div><dt>stroke agreement</dt><dd>{formatRatio(opened.fidelity.stroke_agreement)}</dd></div><div><dt>source coverage</dt><dd>{formatRatio(opened.fidelity.source_coverage)}</dd></div><div><dt>components</dt><dd>{opened.topology.connected_components ?? '—'}</dd></div><div><dt>junctions</dt><dd>{opened.topology.junctions ?? '—'}</dd></div></dl>{opened.flags.length || opened.notices.length ? <div className="artifact-findings">{[...opened.flags, ...opened.notices].slice(0, 6).map((finding) => <span key={finding}>{finding.replaceAll('_', ' ')}</span>)}</div> : null}<a className="quiet-download" href={absoluteApiUrl(opened.views.result)} target="_blank" rel="noreferrer">open result.json</a></div></motion.article></motion.div> : null}</AnimatePresence>
  </section>;
}

const METHOD_STUDIES = [
  { title: 'Perception', tag: '01 / image measurement', className: 'perception', summary: 'The source image is retained while candidate dots, stroke pixels, and paths are measured.', input: 'source image · diagnostic view', trace: 'image → foreground → lattice / paths', steps: [['Validate the source image', 'Check the image type and dimensions, then preserve the supplied frame as the reference artifact.'], ['Segment usable evidence', 'Separate the drawing from its background while retaining uncertainty where contrast or noise makes a decision unreliable.'], ['Extract structural candidates', 'Measure candidate dot locations, skeletal strokes, and paths for the reconstruction record.']] },
  { title: 'Verification', tag: '02 / constraint checks', className: 'verification', summary: 'Recovered claims are tested against lattice residuals, topology counts, and image agreement.', input: 'lattice fit · skeleton metrics', trace: 'residual · components · agreement', steps: [['Fit the dot lattice', 'Estimate the measured lattice and retain its fit residual rather than concealing geometric error.'], ['Check path topology', 'Count components, endpoints, and junctions to expose broken or ambiguous line structure.'], ['Report image agreement', 'Record source coverage, stroke agreement, and flags so the result remains auditable.']] },
  { title: 'Generation', tag: '03 / solver request', className: 'generation', summary: 'A new figure is solved from declared constraints; it is not selected from a fixture catalogue.', input: 'grid · dots · islands · symmetry', trace: 'constraints → candidates → valid form', steps: [['Declare the request', 'Width, height, dot count, islands, symmetry, palette, and optional seed define the generation request.'], ['Search valid candidates', 'The solver constructs forms that satisfy the selected constraints rather than replaying a stored design.'], ['Validate before rendering', 'Only a returned, checked structure reaches the workbench and becomes available to export.']] },
  { title: 'Rendering', tag: '04 / output record', className: 'rendering', summary: 'The returned structure is rendered with ordered stroke data and its supporting artifacts.', input: 'ordered strokes · evidence assets', trace: 'SVG / PNG · comparison · result record', steps: [['Render ordered strokes', 'Linework is drawn in sequence so the construction remains legible rather than becoming a static icon.'], ['Compare source and result', 'The reconstruction desk uses a direct divider between the original and reconstructed frames.'], ['Attach artifacts', 'Diagnostic, reconstruction, comparison, vector, and result record remain accessible with the study.']] },
] as const;

function StudyDiagram({ type }: { type: typeof METHOD_STUDIES[number]['className'] }) {
  if (type === 'generation') return <span className="study-diagram diagram-generation" aria-hidden="true">{Array.from({ length: 16 }, (_, index) => <i key={index} />)}<b /></span>;
  if (type === 'rendering') return <span className="study-diagram diagram-rendering" aria-hidden="true"><i /><i /><i /><b /></span>;
  if (type === 'verification') return <span className="study-diagram diagram-verification" aria-hidden="true"><i /><i /><i /><b /></span>;
  return <span className="study-diagram diagram-perception" aria-hidden="true"><i /><i /><i /><b /></span>;
}

function Pipeline() {
  const [active, setActive] = useState(0); const study = METHOD_STUDIES[active];
  return <section className="pipeline-stage methodology-stage"><Heading view="pipeline" /><section className="methodology-atlas" aria-label="Four independent methodology studies"><div className="atlas-register"><span>methodology atlas</span><strong>four independent studies</strong><i>not a linear pipeline</i></div>{METHOD_STUDIES.map((item, index) => <button key={item.title} className={`method-sheet ${item.className} ${active === index ? 'is-active' : ''}`} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)} aria-pressed={active === index}><span className="sheet-corners" aria-hidden="true" /><span className="sheet-index">0{index + 1}</span><span className="method-visual" aria-hidden="true"><StudyDiagram type={item.className} /></span><span className="sheet-copy"><i>{item.tag}</i><b>{item.title}</b><em>{item.summary}</em></span><span className="study-annotation">{item.trace}</span><span className="sheet-rule" aria-hidden="true" /></button>)}</section><aside className="method-margin-note" aria-live="polite"><span className={`method-note-index ${study.className}`}>{String(active + 1).padStart(2, '0')}</span><div className="method-note-copy"><span>opened study / {String(active + 1).padStart(2, '0')}</span><h2>{study.title}</h2><p>{study.summary}</p><ol className="method-steps">{study.steps.map(([title, detail], index) => <li key={title}><i>{String(index + 1).padStart(2, '0')}</i><div><b>{title}</b><span>{detail}</span></div></li>)}</ol></div><div className="method-evidence"><span>input</span><b>{study.input}</b><span>record</span><b>{study.trace}</b></div></aside></section>;
}

function SpecimenCard({ asset, label, className, rotation = 0, scale = 1 }: { asset: string; label: string; className: string; rotation?: number; scale?: number }) {
  return <figure role="img" tabIndex={0} aria-label={`Corpus reference specimen: ${label}`} className={`specimen-card ${className}`} style={{ '--specimen-rotation': `${rotation}deg`, '--specimen-scale': scale } as CSSProperties}><img src={asset} alt="" /><figcaption><span>reference</span>{label}</figcaption><span className="specimen-ticks"><i /><i /><i /><i /></span></figure>;
}

const HERO_PATHS = [
  'M 342.00,188.00 C 382.00,164.00 386.00,113.00 341.00,91.00', 'M 341.00,91.00 C 292.00,109.00 298.00,164.00 341.00,188.00', 'M 341.00,487.00 C 383.00,516.00 386.00,583.00 335.00,582.00', 'M 335.00,582.00 C 293.00,557.00 300.00,512.00 339.00,486.00', 'M 189.00,339.00 C 168.00,384.00 104.00,385.00 95.00,335.00', 'M 95.00,335.00 C 117.00,291.00 166.00,298.00 190.00,337.00', 'M 490.00,339.00 C 514.00,382.00 566.00,385.00 588.00,341.00', 'M 588.00,341.00 C 570.00,293.00 515.00,297.00 490.00,338.00', 'M 289.00,239.00 C 269.00,294.00 178.00,273.00 211.00,217.00', 'M 211.00,217.00 C 236.00,185.00 271.00,213.00 290.00,238.00', 'M 442.00,189.00 C 478.00,170.00 492.00,230.00 443.00,289.00', 'M 443.00,289.00 C 389.00,290.00 401.00,224.00 441.00,189.00', 'M 239.00,387.00 C 205.00,406.00 186.00,460.00 233.00,472.00', 'M 233.00,472.00 C 289.00,477.00 284.00,407.00 241.00,387.00', 'M 391.00,439.00 C 409.00,478.00 470.00,489.00 477.00,441.00', 'M 477.00,441.00 C 475.00,387.00 410.00,397.00 391.00,437.00', 'M 290.00,239.00 C 340.00,290.00 340.00,290.00 390.00,239.00', 'M 290.00,439.00 C 340.00,390.00 340.00,390.00 390.00,439.00', 'M 241.00,289.00 C 290.00,340.00 290.00,340.00 241.00,387.00', 'M 443.00,289.00 C 390.00,340.00 390.00,340.00 441.00,387.00', 'M 289.00,289.00 C 325.00,325.00 355.00,355.00 391.00,391.00', 'M 391.00,289.00 C 355.00,325.00 325.00,355.00 289.00,391.00',
];
const HERO_DOTS = [[340, 140], [240, 240], [340, 240], [440, 240], [140, 340], [240, 340], [340, 340], [440, 340], [540, 340], [240, 440], [340, 440], [440, 440], [340, 540]];
const DIAMOND_LATTICE_PATHS = [
  'M 340 92 C 304 120 304 168 340 198 C 376 168 376 120 340 92', 'M 224 176 C 188 204 188 250 224 278 C 260 250 260 204 224 176',
  'M 456 176 C 420 204 420 250 456 278 C 492 250 492 204 456 176', 'M 108 340 C 76 368 76 414 108 442 C 144 414 144 368 108 340',
  'M 572 340 C 536 368 536 414 572 442 C 604 414 604 368 572 340', 'M 224 504 C 260 476 260 430 224 402 C 188 430 188 476 224 504',
  'M 456 504 C 492 476 492 430 456 402 C 420 430 420 476 456 504', 'M 340 588 C 376 560 376 512 340 482 C 304 512 304 560 340 588',
  'M 224 176 C 258 206 294 238 340 280 C 386 238 422 206 456 176', 'M 108 340 C 156 320 194 300 224 278 C 258 316 298 352 340 392',
  'M 572 340 C 524 320 486 300 456 278 C 422 316 382 352 340 392', 'M 224 504 C 258 474 294 442 340 400 C 386 442 422 474 456 504',
  'M 224 278 C 264 298 302 320 340 340 C 378 320 416 298 456 278', 'M 224 402 C 264 382 302 360 340 340 C 378 360 416 382 456 402',
  'M 108 340 C 146 362 184 382 224 402 C 258 374 298 356 340 340', 'M 572 340 C 534 362 496 382 456 402 C 422 374 382 356 340 340',
];
const DIAMOND_LATTICE_DOTS: readonly (readonly [number, number])[] = [[340, 140], [224, 226], [456, 226], [108, 391], [224, 278], [340, 340], [456, 278], [572, 391], [224, 402], [456, 402], [340, 535]];
const EIGHT_POINT_PATHS = [
  'M 340 92 C 304 126 304 178 340 220 C 376 178 376 126 340 92', 'M 340 220 C 292 250 254 282 220 330 C 254 378 292 410 340 440',
  'M 340 440 C 304 482 304 534 340 588 C 376 534 376 482 340 440', 'M 340 220 C 388 250 426 282 460 330 C 426 378 388 410 340 440',
  'M 92 340 C 126 304 178 304 220 340 C 178 376 126 376 92 340', 'M 220 340 C 250 292 282 254 330 220 C 378 254 410 292 440 340',
  'M 440 340 C 410 388 378 426 330 460 C 282 426 250 388 220 340', 'M 588 340 C 554 376 502 376 460 340 C 502 304 554 304 588 340',
  'M 220 340 C 250 388 282 426 330 460 C 378 426 410 388 440 340', 'M 220 220 C 258 252 294 286 340 330 C 386 286 422 252 460 220',
  'M 220 460 C 258 428 294 394 340 350 C 386 394 422 428 460 460', 'M 220 220 C 188 264 174 310 220 340 C 174 370 188 416 220 460',
  'M 92 340 C 126 302 178 302 220 340 C 260 378 300 378 340 340 C 380 302 420 302 460 340 C 502 378 554 378 588 340',
  'M 460 220 C 492 264 506 310 460 340 C 506 370 492 416 460 460', 'M 340 220 C 310 258 310 296 340 330 C 370 296 370 258 340 220',
  'M 340 350 C 310 384 310 422 340 460 C 370 422 370 384 340 350',
];
const EIGHT_POINT_DOTS: readonly (readonly [number, number])[] = [[340, 148], [220, 220], [340, 220], [460, 220], [148, 340], [220, 340], [340, 340], [460, 340], [532, 340], [220, 460], [340, 460], [460, 460], [340, 532]];
const ARRIVAL_PATTERNS = [
  { id: 'root', source: 'traced reference / root motif', cycleMs: 6600 },
  { id: 'diamond-lattice', source: 'supplied figure / 01', paths: DIAMOND_LATTICE_PATHS, dots: DIAMOND_LATTICE_DOTS, cycleMs: 7600 },
  { id: 'eight-point', source: 'supplied figure / 02', paths: EIGHT_POINT_PATHS, dots: EIGHT_POINT_DOTS, cycleMs: 7600 },
] as const;

function LivingHeroMotif({ reduceMotion, activeStep }: { reduceMotion: boolean | null; activeStep: number }) {
  const duration = reduceMotion ? 0 : .62;
  return <div className="living-home-motif"><span className="hero-start-point" aria-hidden="true" /><svg className="home-motif" viewBox="0 0 680 680" role="img" aria-label="Kolam linework traced from a single starting point"><rect width="680" height="680" fill="#3b1b17" /><g fill="none" stroke="#f4ecd8" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">{HERO_PATHS.map((path, index) => <motion.path className={`sequence-path ${activeStep === index ? 'is-current' : ''}`} key={path} d={path} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration, delay: reduceMotion ? 0 : index * .165, ease: [.61, .01, .22, 1] }} />)}</g><g className="gesture-energy" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{HERO_PATHS.map((path, index) => <motion.path key={'energy-' + path} d={path} initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: [0, .92, .12] }} transition={{ duration, delay: reduceMotion ? 0 : index * .165, ease: [.61, .01, .22, 1] }} />)}</g><g fill="#ffffff">{HERO_DOTS.map(([cx, cy], index) => <motion.circle className={`sequence-dot ${activeStep % HERO_DOTS.length === index ? 'is-current' : ''}`} key={`${cx}-${cy}`} cx={cx} cy={cy} r="4.5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : .48, delay: reduceMotion ? 0 : .12 }} />)}</g></svg></div>;
}

function LivingCorpusStudy({ paths, dots, source, reduceMotion, activeStep }: { paths: readonly string[]; dots: readonly (readonly [number, number])[]; source: string; reduceMotion: boolean | null; activeStep: number }) {
  return <div className="living-home-motif"><svg className="home-motif corpus-study-motif" viewBox="0 0 680 680" role="img" aria-label={`A dot-and-stroke study inspired by ${source}`}><rect width="680" height="680" fill="#3b1b17" /><g fill="none" stroke="#f4ecd8" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">{paths.map((path, index) => <motion.path className={`sequence-path ${activeStep === index ? 'is-current' : ''}`} key={path} d={path} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduceMotion ? 0 : .92, delay: reduceMotion ? 0 : .22 + index * .26, ease: [.61, .01, .22, 1] }} />)}</g><g className="gesture-energy" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths.map((path, index) => <motion.path key={'energy-' + path} d={path} initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: [0, .9, .1] }} transition={{ duration: reduceMotion ? 0 : .92, delay: reduceMotion ? 0 : .22 + index * .26, ease: [.61, .01, .22, 1] }} />)}</g><g fill="#ffffff">{dots.map(([cx, cy], index) => <motion.circle className={`sequence-dot ${activeStep % dots.length === index ? 'is-current' : ''}`} key={`${cx}-${cy}`} cx={cx} cy={cy} r="4.5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : .48, delay: reduceMotion ? 0 : .12 }} />)}</g></svg></div>;
}

function HomeStage() {
  const reduceMotion = useReducedMotion();
  const pageVisible = usePageVisibility();
  const [patternIndex, setPatternIndex] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const pattern = ARRIVAL_PATTERNS[patternIndex];
  const dotCount = 'dots' in pattern ? pattern.dots.length : HERO_DOTS.length;
  const strokeCount = 'paths' in pattern ? pattern.paths.length : HERO_PATHS.length;
  const settle = Boolean(reduceMotion || !pageVisible);
  useEffect(() => { if (settle) return; const timer = window.setTimeout(() => setPatternIndex((index) => (index + 1) % ARRIVAL_PATTERNS.length), pattern.cycleMs); return () => window.clearTimeout(timer); }, [pattern.cycleMs, patternIndex, settle]);
  useEffect(() => {
    setActiveStep(0);
    if (settle) return;
    const interval = window.setInterval(() => setActiveStep((step) => (step + 1) % strokeCount), Math.max(260, Math.floor((pattern.cycleMs - 2_500) / strokeCount)));
    return () => window.clearInterval(interval);
  }, [pattern.cycleMs, pattern.id, settle, strokeCount]);
  return <section className="home-stage"><Heading view="home" projectTag="SIH 2026 · GGSIPU2625" /><div className="construction-scene" aria-label="A repeating sequence of a traced kolam and two supplied dot-and-stroke studies"><div className="construction-dots" /><div className="construction-axis" /><div className="theatre-register" aria-hidden="true"><span>reference sequence / 0{patternIndex + 1}</span><i><b className={patternIndex === 0 ? 'active' : ''} /><b className={patternIndex === 1 ? 'active' : ''} /><b className={patternIndex === 2 ? 'active' : ''} /></i></div><div className="theatre-count" aria-hidden="true"><span>dot {activeStep % dotCount + 1} / {dotCount}</span><i /><span>segment {activeStep + 1} / {strokeCount}</span></div><AnimatePresence mode="wait" initial={false}><motion.div key={pattern.id} className={'arrival-pattern arrival-pattern--' + pattern.id} initial={{ opacity: 0, scale: .985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.012 }} transition={{ duration: settle ? 0 : .42, ease: 'easeInOut' }}>{'paths' in pattern ? <LivingCorpusStudy paths={pattern.paths} dots={pattern.dots} source={pattern.source} reduceMotion={settle} activeStep={activeStep} /> : <LivingHeroMotif reduceMotion={settle} activeStep={activeStep} />}<span className="arrival-source">{pattern.source}</span></motion.div></AnimatePresence><span className="construction-note note-field">01 / dot lattice</span><span className="construction-note note-rule">02 / local turning rule</span><span className="construction-note note-return">03 / closed path</span></div></section>;
}

export function KolamExperience({ view }: { view: View }) {
  const visible = usePageVisibility();
  return <main className={`kolam-app view-${view}${visible ? '' : ' is-hidden'}`}><Floor dense={view === 'corpus' || view === 'pipeline'} /><FieldCursor /><Brand /><Navigation active={view} />{view === 'home' ? <HomeStage /> : null}{view === 'generate' ? <Generator /> : null}{view === 'analyse' ? <Analyser /> : null}{view === 'corpus' ? <Corpus /> : null}{view === 'pipeline' ? <Pipeline /> : null}</main>;
}
