/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
import {useGraphSettings} from './GraphSettings.jsx';
// The data map: recorded topology (topology.mjs) -> visible projection -> lane layout (layout.mjs) -> particle world
// (physics.mjs, optional fluid medium from fluid.mjs) -> React Flow cards and strings. Every card shows its observation time;
// every string is a recorded relationship; motion is decoration on top of evidence, never evidence itself.
import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Background, BackgroundVariant, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useInternalNode, useReactFlow} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './datamap.css';
import {BOX, PORTS, PORT_LANE, REL, audit, createTopology, ids, ms, project, record} from './topology.mjs';
import {layoutProjection} from './layout.mjs';
import {LANE_DIR, createDiffusion, createWorld} from './physics.mjs';
import {createFluid, stokesletField} from './fluid.mjs';
import {KIND_LABEL, bodyFor, fileKind} from './shape.mjs';
import {Cube} from './ui.jsx';

export const SETTINGS_KEY = 'vervain.datamap.settings.v2';
export const DEFAULTS = Object.freeze({lifespan: 60, showEnded: true, fade: true, physics: true, medium: 'stokes', assoc: false, wave: true, lanes: false, metrics: false, minimap: false});
const LIFESPANS = [3, 5, 15, 30, 60, 120, 240, 720];
/** @type {any} */
const FIT = {padding: {top: '96px', bottom: '80px', left: '40px', right: '40px'}, maxZoom: 1};
const cls = (...n) => n.filter(Boolean).join(' ');
const hhmmss = at => new Date(at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
const full = at => new Date(at).toISOString();
const base = p => (p || '').split('/').filter(Boolean).pop() || p;
const tilde = (p, home) => home && p?.startsWith(home) ? `~${p.slice(home.length)}` || '~' : p;
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export function readSettings() { try { return {...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')}; } catch { return {...DEFAULTS}; } }

// ---------- cards ----------
function Handles() { return <><Handle type="target" position={Position.Left} className="dm-handle" isConnectable={false}/><Handle type="source" position={Position.Right} className="dm-handle" isConnectable={false}/></>; }
const Stamp = ({at}) => at ? <time className="dm-stamp" dateTime={full(at)} title={`Observed ${full(at)}`} aria-label={`Observed ${new Date(at).toLocaleString()}`}>{hhmmss(at)}</time> : <span className="dm-stamp" title="No observation time">unknown</span>;
const STATE_TEXT = {editing: 'Write completed', reading: 'Read completed', blocked: 'Blocked', failed: 'Failed', observed: 'Observed', running: 'Observed running', idle: 'Turn complete', ended: 'Ended', interrupted: 'Interrupted', awaiting_permission: 'Permission requested', compacting: 'Compaction started', compacted: 'Compaction completed', contains: 'Contains recent activity', box: ''};
const Card = memo(/** @param {any} props */ function Card({data, selected}) {
  const {node, body, lifted, stub} = data, a = node.activity;
  const style = /** @type {any} */ ({'--age': data.fade ? node.age ?? 0 : 0, width: body.w, height: body.h});
  const common = cls('dm-card', `dm-${body.silhouette}`, stub && 'is-stub', lifted && 'is-lifted', data.bundled && 'is-bundled', selected && 'is-selected', body.sizeState === 'empty' && 'is-empty', data.leaving && 'is-leaving');
  const title = stub ? node.retained : node.kind === 'file' ? node.meta.path : node.kind === 'folder' ? node.meta.path : node.kind === 'agent' ? `${node.meta.client || 'agent'} ${node.id.slice(6)}` : node.meta.upstream;
  if (node.kind === 'box') return <div className={cls('dm-box', data.live && 'is-live', data.dropReady && 'is-drop-target')} title="Open the Box: context and governance for this project"><Handles/><Cube size={84} glass attention={data.live || data.dropReady} open={data.dropReady}/><strong>{data.label}</strong><small>{data.dropReady ? 'Drop to add to context' : data.sub}</small></div>;
  return <div className={common} style={style} title={title}>
    <Handles/>
    <header>
      <span className="dm-glyph" aria-hidden="true">{data.glyph}</span>
      <strong>{data.label}</strong>
      {node.kind === 'folder' && <button type="button" className="dm-expand nodrag nopan" aria-label={`${data.expanded ? 'Collapse' : 'Expand'} folder ${data.label}`} aria-expanded={data.expanded} onClick={e => { e.stopPropagation(); data.onExpand(node.id); }}>{data.expanded ? '▾' : '▸'}</button>}
      {!['file','folder'].includes(node.kind) && <Stamp at={a?.at}/>}
    </header>
    <div className="dm-meta">
      {node.kind !== 'folder' && <span className={cls('dm-state', `is-${a?.state}`)}>{stub ? 'Retained ancestor' : STATE_TEXT[a?.state] || a?.state}</span>}
      {data.detail && <code title={data.detail}>{data.detail}</code>}
      {['file','folder'].includes(node.kind) && <Stamp at={a?.at}/>}
    </div>
  </div>;
});
const NODE_TYPES = {card: Card};

// ---------- strings ----------
function rect(n) { return {x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured?.width || n.width || 216, h: n.measured?.height || n.height || 64}; }
function stringPath(a, b) {
  const ac = {x: a.x + a.w / 2, y: a.y + a.h / 2}, bc = {x: b.x + b.w / 2, y: b.y + b.h / 2};
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  const horizontal = Math.abs(dx) / Math.max(1, (a.w + b.w) / 2) >= Math.abs(dy) / Math.max(1, (a.h + b.h) / 2);
  let s, t, k;
  if (horizontal) { const sign = bc.x >= ac.x ? 1 : -1; s = {x: ac.x + sign * a.w / 2, y: ac.y}; t = {x: bc.x - sign * b.w / 2, y: bc.y}; k = Math.max(24, Math.min(160, Math.abs(t.x - s.x) * .5)); return {d: `M${s.x},${s.y} C${s.x + sign * k},${s.y} ${t.x - sign * k},${t.y} ${t.x},${t.y}`, s, t}; }
  const sign = bc.y >= ac.y ? 1 : -1; s = {x: ac.x, y: ac.y + sign * a.h / 2}; t = {x: bc.x, y: bc.y - sign * b.h / 2}; k = Math.max(24, Math.min(160, Math.abs(t.y - s.y) * .5));
  return {d: `M${s.x},${s.y} C${s.x},${s.y + sign * k} ${t.x},${t.y - sign * k} ${t.x},${t.y}`, s, t};
}
/** @param {any} props */
function StringEdge({source, target, data}) {
  const a = useInternalNode(source), b = useInternalNode(target);
  if (!a || !b) return null;
  const p = stringPath(rect(a), rect(b));
  return <g className={cls('dm-edge', `dm-edge-${data.rel}`, !data.tree && 'dm-edge-assoc')} style={/** @type {any} */ ({'--age': data.fade ? data.age : 0, '--wave': data.wave || 0})}>
    <title>{`${REL[data.rel]?.label || data.rel}. First ${full(data.first_at)}, last ${full(data.last_at)}, ${data.count} observation${data.count === 1 ? '' : 's'}.`}</title>
    {data.wave > 0.02 && <path className="dm-edge-glow" d={p.d}/>}
    <path className="dm-edge-line" d={p.d}/>
    {data.rel === 'sent' && <path className="dm-arrow" d="M-7,-4 L0,0 L-7,4" transform={`translate(${p.t.x},${p.t.y}) rotate(${Math.atan2(p.t.y - p.s.y, p.t.x - p.s.x) * 180 / Math.PI})`}/>}
  </g>;
}
const EDGE_TYPES = {string: StringEdge};

// ---------- pages ----------
/** @param {any} props */
function DetailPage({node, topology, projection, home, onBack}) {
  const close = useRef(null);
  useEffect(() => { close.current?.focus(); const key = e => { if (e.key === 'Escape') onBack(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onBack]);
  const projectRoot = topology.nodes.get(BOX)?.meta?.root || node.meta?.project || '';
  const projectName = base(projectRoot) || 'Project';
  const relative = path => projectRoot && path?.startsWith(`${projectRoot}/`) ? path.slice(projectRoot.length + 1) : base(path);
  const title = node.kind === 'file' || node.kind === 'folder' ? relative(node.meta.path) : node.kind === 'agent' ? (node.meta?.name || (node.meta?.client === 'codex' ? 'Codex' : node.meta?.client === 'claude-code' ? 'Claude' : 'Agent')) : node.meta?.upstream || projectName;
  const kind = node.kind === 'file' ? `${KIND_LABEL[fileKind(node.meta.path)]} file` : node.kind === 'agent' ? 'Agent prompt' : node.kind === 'folder' ? 'Folder' : node.kind === 'destination' ? 'Cloud destination' : 'Project';
  const actionText = row => {
    const operation = String(row.evidence?.operation || '').toLowerCase();
    const status = String(row.evidence?.status || '').toLowerCase();
    const verb = operation === 'edit' || operation === 'write' ? 'Write' : operation === 'read' ? 'Read' : operation ? operation[0].toUpperCase() + operation.slice(1) : row.rel === 'spawned' ? 'Task started' : row.rel === 'sent' ? 'Request sent' : 'Observed';
    if (node.kind === 'folder') return 'Observed by agent';
    if (node.kind === 'file') return `${verb} ${['blocked','denied'].includes(status)?'blocked':status==='completed'?'completed':status || 'observed'}`;
    return `${verb}${status && status !== 'observed' ? ` ${status}` : operation ? ' completed' : ''}`;
  };
  const recorded = audit(topology);
  const rows = recorded.filter(row => {
    if (node.kind === 'folder') { const target = topology.nodes.get(row.target); return row.evidence?.operation && target?.kind === 'file' && target.meta?.path?.startsWith(`${node.meta.path}/`); }
    return (row.source === node.id || row.target === node.id) && (row.evidence?.operation || ['spawned','sent'].includes(row.rel));
  }).sort((a, b) => a.first_at - b.first_at).slice(0, 8);
  const counterpart = row => {
    const id = row.source === node.id ? row.target : row.source;
    const other = topology.nodes.get(id);
    if (other?.kind === 'file' || other?.kind === 'folder') return relative(other.meta?.path);
    if (other?.kind === 'agent') return other.meta?.name || (other.meta?.client === 'codex' ? 'Codex' : other.meta?.client === 'claude-code' ? 'Claude' : 'Agent');
    return other?.meta?.upstream || id.replace(/^\w+:/, '');
  };
  return <section className="dm-page" role="dialog" aria-modal="true" aria-label={`${kind}: ${title}`}>
    <header><span className="dm-type">{kind}</span><h2>{title}</h2><button ref={close} className="dm-close" type="button" aria-label="Close details" onClick={onBack}>×</button></header>
    <div className="dm-summary"><span>{projectName}</span>{node.kind !== 'box' && <><b>›</b><span>{node.kind === 'file' || node.kind === 'folder' ? relative(node.meta.path) : title}</span></>}</div>
    <div className="dm-observed"><span>Observed</span><time dateTime={full(node.first_at)}>{new Date(node.first_at).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit'})}</time></div>
    {rows.length > 0 && <div className="dm-action-list" aria-label="Recorded actions">{rows.map(row => <div className="dm-action-row" key={row.id}><time dateTime={full(row.first_at)}>{hhmmss(row.first_at)}</time><span className={cls('dm-action-dot', actionText(row).startsWith('Read') ? 'is-read' : actionText(row).startsWith('Write') ? 'is-write' : '')}/><div><strong>{actionText(row)}</strong><span>{counterpart(row)}</span></div></div>)}</div>}
  </section>;
}
function RelationshipPage({edge, topology, home, onBack}) {
  const close=useRef(null);
  useEffect(()=>{close.current?.focus();const key=event=>{if(event.key==='Escape')onBack();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[onBack]);
  const nodeLabel=id=>{const node=topology.nodes.get(id);if(node?.kind==='file' || node?.kind==='folder')return tilde(node.meta.path,home);return node?.meta?.label || node?.meta?.name || node?.meta?.client || node?.meta?.upstream || id.replace(/^\w+:/,'');};
  const observations=[...(edge.observations || (edge.evidence?[{...edge.evidence,at:edge.last_at}]:[]))].sort((a,b)=>ms(a.at)-ms(b.at));
  return <section className="dm-page" role="dialog" aria-modal="true" aria-label={`${REL[edge.rel]?.label || 'Relationship'} details`}>
    <header><span className="dm-type">Relationship</span><h2>{REL[edge.rel]?.label || edge.rel}</h2><button ref={close} className="dm-close" type="button" aria-label="Close details" onClick={onBack}>×</button></header>
    <div className="dm-summary"><span>{nodeLabel(edge.source)}</span><b>›</b><span>{nodeLabel(edge.target)}</span></div>
    {observations.length>0 && <div className="dm-action-list" aria-label="Recorded observations">{observations.map((item,index)=>{const operation=String(item.operation || 'Observed').replaceAll('_',' '),status=['blocked','denied'].includes(item.status)?'blocked':item.status==='completed'?'completed':String(item.status || 'observed').replaceAll('_',' ');return <div className="dm-action-row" key={`${item.event_id || item.at}-${index}`}><time dateTime={item.at || undefined}>{item.at?hhmmss(ms(item.at)):'unknown'}</time><span className={cls('dm-action-dot',operation.toLowerCase()==='read'?'is-read':/write|edit/.test(operation.toLowerCase())?'is-write':'')}/><div><strong>{operation[0].toUpperCase()+operation.slice(1)} {status}</strong><span>{item.path?base(item.path):status}</span></div></div>;})}</div>}
  </section>;
}
/** @param {any} props */
function AuditPanel({topology, home, onClose}) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => audit(topology, {query: q}).slice(0, 300), [topology, q]);
  return <aside className="dm-audit" aria-label="Audit of recorded relationships">
    <header style={{display: 'flex', gap: 8, alignItems: 'center'}}><h2>Audit</h2><span style={{flex: 1}}/><button type="button" onClick={onClose}>Close</button></header>
    <input type="search" aria-label="Search recorded relationships" placeholder="Path, agent, basis" value={q} onChange={e => setQ(e.target.value)}/>
    <small>{rows.length} of {topology.edges.size} recorded relationships. The visible window never deletes any of these.</small>
    <table><tbody>{rows.map(r => <tr key={r.id}><td>{REL[r.rel]?.label || r.rel}</td><td>{tilde(r.source.replace(/^\w+:/, ''), home)} → {tilde(r.target.replace(/^\w+:/, ''), home)}</td><td><time dateTime={full(r.last_at)}>{hhmmss(r.last_at)}</time></td></tr>)}</tbody></table>
  </aside>;
}
/** @param {any} props */
function Switches({settings, onChange}) {
  const Row = /** @param {any} p */ ({k, label, detail}) => <label><span>{label}<small>{detail}</small></span><input type="checkbox" role="switch" checked={!!settings[k]} onChange={e => onChange({[k]: e.target.checked})}/></label>;
  return <div className="dm-switches" role="group" aria-label="Map settings">
    <h3>Visibility</h3>
    <label><span>Node lifespan<small>Activity older than this dissolves. Audit keeps everything.</small></span><select value={settings.lifespan} onChange={e => onChange({lifespan: Number(e.target.value)})}>{LIFESPANS.map(n => <option key={n} value={n}>{n < 60 ? `${n} min` : `${n / 60} h`}</option>)}</select></label>
    <Row k="showEnded" label="Keep ended sessions" detail="Completion changes activity, not lineage."/>
    <Row k="fade" label="Fade with age" detail="Saturation and opacity follow observation age."/>
    <Row k="assoc" label="Show associations" detail="Every recorded relationship, not one string per node."/>
    <Row k="lanes" label="Label the four lanes" detail="West structure, north tasks, east cloud, south outside."/>
    <h3>Motion</h3>
    <Row k="physics" label="Graph motion" detail="New activity briefly moves the connected graph. Off with reduced motion."/>
    <label><span>Interaction medium<small>Stokes: closed-form near field. Fluid: 48×48 incompressible grid.</small></span><select value={settings.medium} onChange={e => onChange({medium: e.target.value})}><option value="none">None</option><option value="stokes">Stokes flow</option><option value="fluid">Fluid grid</option></select></label>
    <Row k="wave" label="Activity wave" detail="Graph diffusion glow from new observations. Decorative."/>
    <Row k="minimap" label="Minimap" detail="Overview in the corner; drag it to pan."/>
    <Row k="metrics" label="Show measurements" detail="Frame time, settle time, overlap, divergence."/>
  </div>;
}

// ---------- the map ----------
/**
 * @param {{source:{poll:(signal?:AbortSignal)=>Promise<any>, clock:()=>number, label?:string, interval?:number}, onOpen?:(what:string,node:any)=>boolean|void, onIncludeFile?:((path:string,kind?:string)=>Promise<any>)|null, initialSettings?:any, still?:boolean}} props
 */
export function DataMap(props) { return <ReactFlowProvider><MapView {...props}/></ReactFlowProvider>; }
export default DataMap;

/** @param {{source:any, onOpen?:(what:string,node:any)=>boolean|void, onIncludeFile?:((path:string,kind?:string)=>Promise<any>)|null, initialSettings?:any, still?:boolean}} props */
function MapView({source, onOpen = () => {}, onIncludeFile = null, initialSettings = null, still = false}) {
  const flow = useReactFlow();
  const topologyRef = useRef(null); if (!topologyRef.current) topologyRef.current = createTopology();
  const topology = topologyRef.current;
  // Lazy refs: one world and one diffusion field per mounted map, never a throwaway instance per render.
  const worldRef = useRef(null); if (!worldRef.current) worldRef.current = createWorld();
  const diffusionRef = useRef(null); if (!diffusionRef.current) diffusionRef.current = createDiffusion();
  const world = worldRef.current, diffusion = diffusionRef.current, fluid = useRef(null), sources = useRef(new Map());
  const rest = useRef(new Map()), sizes = useRef(new Map()), seenEdges = useRef(new Set()), seenBodies = useRef(new Set()), lastFocus = useRef(null);
  const [settings, setSettings] = useState(() => ({...readSettings(), ...(initialSettings || {})}));
  const [version, setVersion] = useState(0), [status, setStatus] = useState('connecting'), [serverNow, setServerNow] = useState(() => source.clock()), [tick, setTick] = useState(() => source.clock());
  const [cursor, setCursor] = useState(null), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(30);
  const [selected, setSelected] = useState(null), [page, setPage] = useState(null), [edgePage,setEdgePage]=useState(null), [showAudit, setShowAudit] = useState(false), [showSwitches, setShowSwitches] = useState(false), [expanded, setExpanded] = useState(() => new Set()), [dropReady,setDropReady]=useState(false), [feedback,setFeedback]=useState('');
  const [rfNodes, setRfNodes] = useState([]), [motionOff, setMotionOff] = useState(reduced), [find, setFind] = useState(''), [hits, setHits] = useState(/** @type {any[]} */ ([]));
  const [metrics, setMetrics] = useState(null);
  const [sharedSettings,updateSharedSettings]=useGraphSettings();
  useEffect(()=>{if(!initialSettings)setSettings(current=>({...current,...sharedSettings}));},[sharedSettings,initialSettings]);
  const update = patch => {setSettings(s => { const next = {...s, ...patch}; try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {} return next; });if(!initialSettings&&['lifespan','showEnded','fade','physics','playback'].some(key=>key in patch))updateSharedSettings(patch);};
  useEffect(() => { const m = window.matchMedia('(prefers-reduced-motion: reduce)'), f = () => setMotionOff(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  const [autoPaused, setAutoPaused] = useState(false);
  const physicsOn = settings.physics && !motionOff && !autoPaused;

  // polling: the record only grows; polling never resets it
  useEffect(() => {
    let stopped = false, timer = 0;
    async function poll() {
      try { const snap = await source.poll(); if (stopped) return; record(topology, snap); setServerNow(ms(snap.now) || source.clock()); setVersion(v => v + 1); setStatus('live'); }
      catch { if (!stopped) setStatus('lost'); }
      finally { if (!stopped && !still) timer = setTimeout(poll, source.interval || 1000); }
    }
    poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [source, still, topology]);
  useEffect(() => { if (still) return; const t = setInterval(() => setTick(source.clock()), 1000); return () => clearInterval(t); }, [source, still]);
  // playback clock
  useEffect(() => { if (!playing || cursor === null) return; let last = performance.now(); const t = setInterval(() => { const now = performance.now(), dt = (now - last) * speed; last = now; setCursor(c => { const end = source.clock(); const at = Math.min(end, c + dt); if (at >= end) setPlaying(false); return at; }); }, 100); return () => clearInterval(t); }, [playing, speed, cursor === null, source]);

  const now = still ? serverNow : Math.max(serverNow, tick);
  const at = cursor ?? now, lifespan = settings.lifespan * 60000;
  const projection = useMemo(() => project(topology, {at, now, lifespan, showEnded: settings.showEnded, assoc: settings.assoc, expanded}), [topology, version, at, now, lifespan, settings.showEnded, settings.assoc, expanded]);
  const home = topology.home;
  // bodies: shape from metadata, mass from size and branch weight (descendants make a branch heavy so a child cannot haul it)
  const bodies = useMemo(() => {
    const kids = new Map(); for (const [c, p] of projection.parent) kids.set(p, (kids.get(p) || 0) + 1);
    const desc = new Map(); const count = id => { if (desc.has(id)) return desc.get(id); let n = 0; for (const [c, p] of projection.parent) if (p === id) n += 1 + count(c); desc.set(id, n); return n; };
    const out = new Map();
    for (const n of projection.nodes) { const b = bodyFor({...n, spawned: projection.parent.get(n.id)?.startsWith('agent:'), expanded: expanded.has(n.id)}); out.set(n.id, {...b, m: b.fixed ? b.m : b.m * Math.min(3, 1 + 0.15 * count(n.id))}); }
    return out;
  }, [projection, expanded]);
  const layout = useMemo(() => { for (const [id, b] of bodies) sizes.current.set(id, {w: b.w, h: b.h}); const l = layoutProjection(projection, rest.current, sizes.current); rest.current = l; return l; }, [projection, bodies]);
  useEffect(() => {
    // Graceful reduction: above 150 cards the world steps at 60 Hz with one constraint sweep; above 400 it pauses and the
    // map holds its rest positions, with the reason shown in the status line.
    const n = layout.size; world.setQuality(n > 150 ? 'dense' : 'default'); setAutoPaused(n > 400);
    const physical = [...layout].filter(([id]) => id !== BOX).map(([id, r]) => ({id, home: {x: r.x, y: r.y}, w: bodies.get(id).w, h: bodies.get(id).h, r: bodies.get(id).r, m: bodies.get(id).m, fixed: bodies.get(id).fixed, parent: r.parent === BOX ? null : r.parent, port: r.port, root: r.root, rest: r.rest, kind: projection.nodes.find(n => n.id === id)?.kind}));
    world.sync(physical);
    const arrivals = physical.filter(n => !seenBodies.current.has(n.id));
    if (seenBodies.current.size) for (const n of arrivals) world.pulse(n.id);
    seenBodies.current = new Set(physical.map(n => n.id));
    diffusion.setGraph(projection.edges);
    for (const e of projection.edges) if (!seenEdges.current.has(e.id) && at >= e.first_at) { seenEdges.current.add(e.id); if (settings.wave && now - e.last_at < 15000) { diffusion.inject(e.target, 1); diffusion.inject(e.source, .6); } }
  }, [layout, bodies, projection, world, diffusion, settings.wave, at, now]);
  // medium
  useEffect(() => {
    if (!physicsOn || settings.medium === 'none') { world.setField(null); return; }
    if (settings.medium === 'fluid') { fluid.current ||= createFluid({n: 48, cell: 60}); const f = fluid.current, fn = (x, y) => f.sample(x, y); fn.splat = (x, y, fx, fy) => f.splat(x, y, fx, fy); world.setField(fn); }
    else { const fn = (x, y) => stokesletField([...sources.current.values()])(x, y); fn.splat = (x, y, fx, fy) => { sources.current.set('pointer', {x, y, vx: fx, vy: fy, t: performance.now()}); }; world.setField(fn); }
  }, [physicsOn, settings.medium, world]);

  // the render loop: fixed-step physics, fluid at frame rate, diffusion, then only moved positions reach React Flow
  const posRef = useRef(new Map());
  const buildNodes = useCallback(() => {
    const out = [];
    for (const n of projection.nodes) {
      const b = bodies.get(n.id), body = world.bodies.get(n.id), r = layout.get(n.id) || {x: 0, y: 0};
      const cx = physicsOn && body ? body.x : r.x, cy = physicsOn && body ? body.y : r.y;
      posRef.current.set(n.id, {x: cx, y: cy});
      const label = n.kind === 'request' ? n.meta.name : n.kind === 'box' ? base(n.meta.root || source.label || 'Box') : n.kind === 'agent' ? (n.meta.name || (n.meta.client === 'codex' ? 'Codex' : n.meta.client === 'claude-code' ? 'Claude' : 'Agent')) : n.kind === 'destination' ? n.meta.upstream.replace(/^https?:\/\//, '') : n.kind === 'folder' ? (n.meta.label || (n.meta.anchor ? base(n.meta.path) : tilde(n.meta.path, home))) : base(n.meta.path);
      const under = n.kind === 'folder' ? projection.nodes.filter(x => x.kind === 'file' && x.meta.path.startsWith(`${n.meta.path}/`)) : [];
      const detail = n.kind === 'request' ? 'Local model request · open receipt' : n.kind === 'folder' ? `${under.length} observed${under.filter(x => projection.port.get(x.id) === 'n').length ? ` · ${under.filter(x => projection.port.get(x.id) === 'n').length} under tasks` : ''}` : n.kind === 'destination' ? `${n.meta.requests} requests` : '';
      out.push({id: n.id, type: 'card', position: {x: cx - b.w / 2, y: cy - b.h / 2}, width: b.w, height: b.h, draggable: ['file','folder','agent','agent_group'].includes(n.kind) && !!onIncludeFile, selected: selected === n.id, zIndex: body?.lifted ? 40 : n.kind === 'box' ? 5 : 10 - Math.round((n.age || 0) * 4),
        ariaLabel: `${label}, ${n.kind}, ${STATE_TEXT[n.activity?.state] || ''}, observed ${new Date(n.activity?.at || n.last_at).toLocaleString()}. Enter for details.`,
        data: {node: n, body: b, label, detail, glyph: n.kind === 'request' ? '↗' : n.kind === 'agent' ? (n.meta.client === 'codex' ? '›_' : '✳') : n.kind === 'folder' ? (expanded.has(n.id) ? '▿' : '▹') : n.kind === 'file' ? ({code: '</>', prose: '¶', data: '{}', media: '▧', config: '⚙', unknown: '?'})[fileKind(n.meta.path)] : '☁', sub: n.kind === 'box' ? `${projection.nodes.some(x => x.kind === 'agent' && ['running','reading','editing'].includes(x.activity?.state)) ? 'Agent running' : projection.nodes.some(x => x.kind === 'agent') ? `${projection.nodes.filter(x => x.kind === 'agent').length} agents observed` : 'Waiting for agent'} · ${projection.nodes.filter(x => x.kind === 'file').length} files accessed` : '', live: n.kind === 'box' && projection.nodes.some(x => x.age < .05 && x.kind !== 'box' && x.kind !== 'folder'), dropReady: n.kind === 'box' && dropReady,
          fade: settings.fade, lifted: !!body?.lifted, stub: !!n.stub, expanded: expanded.has(n.id), onExpand: id => setExpanded(s => { const x = new Set(s); x.has(id) ? x.delete(id) : x.add(id); return x; })}});
    }
    return out;
  }, [projection, bodies, layout, physicsOn, selected, settings.fade, expanded, home, source.label, world, onIncludeFile, dropReady]);
  useEffect(() => { setRfNodes(prev => { const old = new Map(prev.map(n => [n.id, n])); return buildNodes().map(n => { const o = old.get(n.id); return o?.dragging ? {...n, position: o.position, dragging: true} : o?.measured ? {...n, measured: o.measured} : n; }); }); }, [buildNodes]);
  useEffect(() => {
    let frame = 0, last = performance.now(), lastMetrics = 0;
    const loop = t => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(1 / 30, (t - last) / 1000); last = t;
      if (document.hidden) return;
      for (const [k, s] of sources.current) if (t - s.t > 400) sources.current.delete(k); else { s.vx *= Math.exp(-dt * 6); s.vy *= Math.exp(-dt * 6); }
      if (fluid.current && settings.medium === 'fluid' && physicsOn) fluid.current.step(dt);
      const waveOn = settings.wave && diffusion.size() > 0; if (waveOn) diffusion.step(dt);
      const moved = physicsOn && world.step(t);
      const held = world.grabbed?.(), bundle = new Set(held?.bundle || []);
      if (moved || waveOn || held) setRfNodes(nodes => nodes.map(n => { const b = world.bodies.get(n.id); if (!b || b.dragging || !physicsOn) return n; const x = b.x - n.width / 2, y = b.y - n.height / 2; const eps = world.bodies.size > 150 ? .5 : .05; const inBundle = bundle.has(n.id); return Math.abs(x - n.position.x) < eps && Math.abs(y - n.position.y) < eps && n.data.lifted === !!b.lifted && n.data.bundled === inBundle ? n : {...n, position: {x, y}, zIndex: b.lifted ? 40 : n.zIndex, data: {...n.data, lifted: !!b.lifted, bundled: inBundle}}; }));
      if (settings.metrics && t - lastMetrics > 500) { lastMetrics = t; setMetrics({...world.metrics(), fluid: fluid.current && settings.medium === 'fluid' ? fluid.current.diagnostics() : null, nodes: projection.nodes.length, edges: projection.edges.length, wave: diffusion.size()}); }
    };
    frame = requestAnimationFrame(loop); return () => cancelAnimationFrame(frame);
  }, [world, diffusion, physicsOn, settings.medium, settings.wave, settings.metrics, projection.nodes.length, projection.edges.length]);

  const edges = useMemo(() => projection.edges.map(e => ({id: e.id, source: e.source, target: e.target, type: 'string', selectable: true, focusable: true, data: {...e, fade: settings.fade, wave: settings.wave ? Math.max(diffusion.get(e.target), diffusion.get(e.source) * .5) : 0}})), [projection, settings.fade, settings.wave, diffusion, tick]);
  const dragged = useRef(false);
  const overBox = n => {
    const box = rfNodes.find(item => item.id === BOX); if (!box) return false;
    const center = {x: n.position.x + n.width / 2, y: n.position.y + n.height / 2};
    return center.x >= box.position.x && center.x <= box.position.x + box.width && center.y >= box.position.y && center.y <= box.position.y + box.height;
  };
  const onDragStart = (_, n) => {
    dragged.current = false;
    const b = bodies.get(n.id);
    if (physicsOn && b) world.drag(n.id, n.position.x + b.w / 2, n.position.y + b.h / 2, performance.now());
  };
  const onDrag = (_, n) => {
    dragged.current = true;
    const b = bodies.get(n.id);
    if (physicsOn && b) world.drag(n.id, n.position.x + b.w / 2, n.position.y + b.h / 2, performance.now());
    setDropReady(overBox(n));
  };
  const onDragStop = (_, n) => {
    const shouldInclude = overBox(n), node = projection.nodes.find(item => item.id === n.id), b = bodies.get(n.id);
    setDropReady(false);
    if (physicsOn && b) world.release(n.id, performance.now());
    else setRfNodes(buildNodes());
    if (shouldInclude && (node?.kind === 'file' || node?.kind === 'folder') && onIncludeFile) Promise.resolve(onIncludeFile(node.meta.path, node.kind)).then(result => {
      const subject = result?.count > 1 ? `${result.count} observed files` : node.kind === 'folder' ? 'Observed folder files' : 'File';
      setFeedback(result?.already ? 'Already in context.' : result?.draft ? `${subject} added to the local context draft.` : `${subject} added to the next request.`);
      setTimeout(() => setFeedback(''), 2400);
    }).catch(error => { setFeedback(error.message || 'Could not add this file.'); setTimeout(() => setFeedback(''), 3000); });
    setTimeout(() => { dragged.current = false; }, 0);
  };
  function open(n) {
    if (dragged.current) return;
    const node = projection.nodes.find(x => x.id === n.id); if (!node) return;
    if (node.kind === 'box') { onOpen('box', node); return; }
    if (['file','agent','request'].includes(node.kind) && onOpen(node.kind, node) === true) return;
    lastFocus.current = document.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
    setSelected(n.id); setPage(n.id);
  }
  const back = useCallback(() => { setPage(null);setEdgePage(null); requestAnimationFrame(() => lastFocus.current?.focus()); }, []);
  function startPlayback() { setCursor(now - lifespan); setPlaying(!motionOff); }
  // ---------- navigation ----------
  const centerOn = useCallback((id, zoom = 1) => { const p = posRef.current.get(id); if (p) flow.setCenter(p.x, p.y, {zoom, duration: motionOff ? 0 : 300}); }, [flow, motionOff]);
  useEffect(() => {
    const q = find.trim().toLowerCase(); if (!q) { setHits([]); return; }
    const text = n => `${n.kind} ${n.meta?.path || ''} ${n.meta?.name || ''} ${n.meta?.label || ''} ${n.meta?.client || ''} ${n.meta?.upstream || ''} ${n.id}`.toLowerCase();
    setHits(projection.nodes.filter(n => n.id !== BOX && text(n).includes(q)).slice(0, 8));
  }, [find, projection]);
  const pageNode = page && projection.nodes.find(n => n.id === page);
  // Harness handle for scripted browser tests; only when measurements are switched on.
  useEffect(() => { if (settings.metrics && typeof window !== 'undefined') /** @type {any} */ (window).__datamap = {projection, topology, world, fluid: fluid.current, rest: rest.current, settings, cursor, now, expanded, setExpanded}; }, [settings, projection, topology, world, cursor, now, expanded]);
  const bounds = useMemo(() => { let r = 400; for (const p of posRef.current.values()) r = Math.max(r, Math.abs(p.x), Math.abs(p.y)); return r + 200; }, [rfNodes.length]);
  const zoom = flow.getZoom?.() || 1;

  return <div className={cls('dm-root', `is-${status}`)}>
    <ReactFlow nodes={rfNodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
      onNodesChange={changes => { const kept = changes.filter(change => change.type !== 'remove' && change.type !== 'select'); if (kept.length) setRfNodes(nodes => applyNodeChanges(kept, nodes)); }}
      onNodeDragStart={onDragStart} onNodeDrag={onDrag} onNodeDragStop={onDragStop} nodeDragThreshold={5}
      onNodeClick={(_, n) => open(n)} onEdgeClick={(_,edge)=>{setSelected(edge.id);setEdgePage(edge.id);}} onPaneClick={() => setSelected(null)} onKeyDown={e => { const el = /** @type {HTMLElement} */ (e.target); if ((e.key === 'Enter' || e.key === ' ') && el?.classList?.contains('react-flow__node')) { e.preventDefault(); open({id: el.dataset.id}); } }}
      nodesConnectable={false} edgesFocusable deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null} zoomOnDoubleClick={false}
      minZoom={.15} maxZoom={1.8} colorMode="dark" aria-label="Recorded data map" fitView fitViewOptions={FIT}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.1} color="#ffffff22"/>
      {settings.minimap && <MiniMap pannable zoomable position="bottom-right" nodeColor={/** @param {any} n */ n => n.id === BOX ? '#a994ec' : n.data?.node?.kind === 'agent' ? '#9d8fb8' : '#4a4a4a'} maskColor="#10101099" style={{background: '#161616', border: '1px solid #333'}}/>}
    </ReactFlow>
    {settings.lanes && <div className="dm-lanes" aria-hidden="true">{Object.entries(PORT_LANE).map(([k, v]) => { const [lx, ly] = LANE_DIR[k]; const p = flow.flowToScreenPosition?.({x: lx * bounds, y: ly * bounds}) || {x: 0, y: 0}; return <span key={k} style={{left: p.x, top: p.y, transform: 'translate(-50%,-50%)'}}>{k.toUpperCase()} · {v}</span>; })}</div>}
    <div className="dm-top"><div className="dm-commandbar">
      <div className="dm-status" role="status"><strong>{projection.coverage.drawn_relationships} of {projection.coverage.recorded_relationships} relationships drawn</strong><small>{projection.coverage.relationships_not_drawn} outside this graph view · {projection.coverage.records_outside_page || 0} records outside the loaded event page</small></div>
      <div className="dm-tools dm-find">
        <input type="search" aria-label="Find a session, file or folder" placeholder="Find" value={find} onChange={e => setFind(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && hits[0]) { setSelected(hits[0].id); centerOn(hits[0].id); } if (e.key === 'Escape') setFind(''); }}/>
        {hits.length > 0 && <ul className="dm-hits" role="listbox" aria-label="Matches">{hits.map(h => <li key={h.id}><button type="button" onClick={() => { setSelected(h.id); centerOn(h.id); setFind(''); }}>{h.kind === 'file' || h.kind === 'folder' ? tilde(h.meta.path, home) : h.meta?.name || h.meta?.client || h.id}<small>{PORT_LANE[projection.port.get(h.id)] || ''}</small></button></li>)}</ul>}
      </div>
      <div className="dm-tools" role="group" aria-label="Time window">{[15, 60, 240, 720].map(n => <button key={n} type="button" aria-pressed={settings.lifespan === n} onClick={() => update({lifespan: n})}>{n < 60 ? `${n}m` : `${n / 60}h`}</button>)}</div>
      <div className="dm-tools">
        <button type="button" title="Fit everything" onClick={() => flow.fitView({...FIT, duration: motionOff ? 0 : 250})}>Fit</button>
        <button type="button" aria-pressed={showSwitches} onClick={() => setShowSwitches(s => !s)}>Switches</button>
        <button type="button" aria-pressed={showAudit} onClick={() => setShowAudit(s => !s)}>Audit</button>
        {cursor === null ? <button type="button" onClick={startPlayback}>Playback</button> : <button type="button" onClick={() => { setCursor(null); setPlaying(false); }}>Return to live</button>}
      </div>
    </div></div>
    {showSwitches && <Switches settings={settings} onChange={update}/>}
    {cursor !== null && <div className="dm-playback" aria-label="Playback controls">
      <button type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(p => !p)}>{playing ? 'Ⅱ' : '▶'}</button>
      <input type="range" aria-label="Playback time" min={now - lifespan} max={now} step={1000} value={cursor} onChange={e => { setPlaying(false); setCursor(Number(e.target.value)); }}/>
      <time dateTime={full(cursor)}>{new Date(cursor).toLocaleTimeString()}</time>
      <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[1, 10, 30, 120, 600].map(n => <option key={n} value={n}>{n}×</option>)}</select>
      <button type="button" onClick={() => { setCursor(null); setPlaying(false); }}>Return to live</button>
    </div>}
    {settings.metrics && metrics && <pre className="dm-metrics" aria-label="Measurements">{`nodes ${metrics.nodes}  edges ${metrics.edges}  bodies ${metrics.bodies}\nframe ms p50 ${metrics.frameMs.p50.toFixed(2)} p90 ${metrics.frameMs.p90.toFixed(2)} p99 ${metrics.frameMs.p99.toFixed(2)} max ${metrics.frameMs.max.toFixed(2)}\nsettle ${metrics.settleMs === null ? 'n/a' : `${Math.round(metrics.settleMs)} ms`}  overlap ${metrics.overlap.toFixed(1)} px  err ${metrics.err.toFixed(2)}  ${metrics.awake ? 'awake' : 'asleep'}\n${metrics.fluid ? `fluid ${metrics.fluid.cells} cells  step ${metrics.fluid.stepMs.toFixed(2)} ms  div max ${metrics.fluid.divergence.max.toExponential(2)} mean ${metrics.fluid.divergence.mean.toExponential(2)} /s` : 'medium: ' + settings.medium}\nwave ${metrics.wave}  zoom ${zoom.toFixed(2)}`}</pre>}
    <div className="dm-bottom">
      <div className="dm-zoom"><button type="button" aria-label="Zoom out" onClick={() => flow.zoomOut()}>−</button><button type="button" aria-label="Zoom in" onClick={() => flow.zoomIn()}>+</button><button type="button" aria-label="Fit the map" onClick={() => flow.fitView({...FIT, duration: motionOff ? 0 : 250})}>⤢</button></div>
    </div>
    {showAudit && <AuditPanel topology={topology} home={home} onClose={() => setShowAudit(false)}/>}
    {pageNode && <DetailPage node={pageNode} topology={topology} projection={projection} home={home} onBack={back}/>}
    {edgePage && projection.edges.some(edge => edge.id === edgePage) && <RelationshipPage edge={projection.edges.find(edge=>edge.id===edgePage)} topology={topology} home={home} onBack={back}/>}
    {feedback && <div className="dm-feedback" role="status">{feedback}</div>}
  </div>;
}
