/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
// Recorded topology for the data map. Four separate ideas, never mixed:
//   recorded topology  = every observed node and relationship, kept for the whole session (append only);
//   current activity   = what the latest observation at or before the cursor says about a node;
//   visible projection = the user's time window and filters, applied to the record without changing it;
//   physical state     = positions, ports and velocities, which live in physics.mjs.
// Nothing here invents a relationship. Every edge carries the observation that produced it.
import {agentGroupId, agentGroupLabel} from './data-strings-model.mjs';

export const BOX = 'box';
export const PORTS = ['w', 'n', 'e', 's'];
/** Semantic lanes: a port is meaning, not a screen quadrant. Positions never feed back into this. */
export const PORT_LANE = Object.freeze({w: 'Project structure', n: 'Agents and tasks', e: 'Cloud destinations', s: 'Outside the Box'});
// follow: which evidence keeps an edge bright. 'target' = the thing the relationship explains stays alive (a spawned task,
// a contained file); 'self' = only the observation itself (an action, a request). tree: may serve as a layout parent.
export const REL = Object.freeze({
  contains: {w: 1, lane: 'structure', dotted: false, label: 'Folder containment', follow: 'target', tree: true},
  spawned: {w: 1, lane: 'workflow', dotted: true, label: 'Recorded task spawn', follow: 'target', tree: true},
  acted: {w: 1.5, lane: 'workflow', dotted: false, label: 'Observed file action', follow: 'self', tree: true},
  transformed: {w: 1, lane: 'workflow', dotted: false, label: 'Recorded transformation', follow: 'target', tree: true},
  sent: {w: 1, lane: 'egress', dotted: false, label: 'Observed request', follow: 'self', tree: true},
  anchored: {w: 1, lane: 'structure', dotted: false, label: 'Box folder', follow: 'target', tree: true},
  works_in: {w: 2, lane: 'workflow', dotted: false, label: 'Session project', follow: 'target', tree: false},
  root: {w: 1, lane: 'box', dotted: false, label: 'Attached to the Box', follow: 'target', tree: false},
  member: {w: 1, lane: 'workflow', dotted: false, label: 'Session in agent group', follow: 'target', tree: true},
  association: {w: 1, lane: 'workflow', dotted: true, label: 'Received agent-file association', follow: 'self', tree: false},
});
export const ENDED = new Set(['ended', 'completed', 'stopped', 'interrupted', 'interrupted_observed', 'failed']);
export const ms = v => typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v || '') || 0;
const trim = p => typeof p === 'string' ? p.replace(/\/+$/, '') || '/' : '';
export const parentOf = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const within = (p, f) => f === '/' ? p.startsWith('/') : p === f || p.startsWith(`${f}/`);
export const ids = Object.freeze({agent: k => `agent:${k}`, file: p => `file:${p}`, folder: p => `folder:${p}`, destination: u => `destination:${u}`});
const num = (v, d) => Number.isFinite(v) ? v : d;
const stamp = (a, b) => ({first_at: Math.min(num(a.first_at, Infinity), num(b.first_at, Infinity)), last_at: Math.max(num(a.last_at, 0), num(b.last_at, 0))});

/** @typedef {{id:string,kind:string,first_at:number,last_at:number,meta:any,marks:Array<{at:number,state:string}>}} TNode */
/** @typedef {{id:string,rel:string,source:string,target:string,first_at:number,last_at:number,count:number,evidence:any}} TEdge */
export function createTopology() { return {nodes: new Map(), edges: new Map(), version: 0, coverage: {}}; }

function upsertNode(t, id, kind, at, meta = {}) {
  const old = t.nodes.get(id);
  const node = old || {id, kind, first_at: num(at, Infinity), last_at: 0, meta: {}, marks: []};
  Object.assign(node, stamp(node, {first_at: at, last_at: at}), {meta: {...node.meta, ...meta}});
  if (!old) t.nodes.set(id, node);
  return node;
}
/** A state mark is an observation of activity at a time; marks stay sorted so any cursor time can be answered. */
function mark(node, at, state, version = null) {
  if (!at) return;
  if (node.marks.some(m => m.at === at && m.state === state)) return;
  node.marks.push({at, state, ...(version ? {version} : {})});
  node.marks.sort((a, b) => a.at - b.at);
}
function upsertEdge(t, rel, source, target, at, evidence = null) {
  if (!source || !target || source === target) return null;
  const id = `${rel}:${source}->${target}`;
  const old = t.edges.get(id);
  const edge = old || {id, rel, source, target, first_at: num(at, Infinity), last_at: 0, count: 0, evidence: null, observations: [], seen: new Set()};
  Object.assign(edge, stamp(edge, {first_at: at, last_at: at}));
  // count distinct observations: the same event re-polled, or the same instant, never counts twice
  const key = evidence?.event_id || `${at}`; if (!edge.seen.has(key)) { edge.seen.add(key); edge.count++; if (evidence) edge.observations.push({...evidence, at}); }
  if (evidence && (!edge.evidence || (at || 0) >= (edge.evidence.at || 0))) edge.evidence = {...evidence, at};
  if (!old) t.edges.set(id, edge);
  return edge;
}
const STATE_OF = {session_end: 'ended', subagent_stop: 'ended', turn_complete: 'idle', turn_interrupted: 'interrupted', session_start: 'running', subagent_start: 'running',
  permission_request: 'awaiting_permission', permission_denied: 'blocked', tool_failure: 'failed', compaction_start: 'compacting', compaction_complete: 'compacted'};

/**
 * Fold one API snapshot into the record. Idempotent for duplicates, order independent, and it never removes anything.
 * `sessions`/`events` are the /api/activity shapes; `relationships` is the optional aggregated projection; `live` is the egress payload.
 */
export function record(t, {sessions = [], events = [], relationships = [], requests = [], live = null, anchors = [], coverage = null} = {}) {
  t.version++;
  if (coverage && typeof coverage === 'object') t.coverage={...t.coverage,...coverage};
  // Box folders (anchors) carry the time they were first known, so a project never appears in playback before it did.
  t.anchors ||= new Map();
  const liveAt = ms(live?.now) || 0;
  const anchor = (path, at) => { if (typeof path !== 'string' || !path.startsWith('/')) return; const p = trim(path); t.anchors.set(p, Math.min(t.anchors.get(p) ?? Infinity, at || 0)); };
  for (const a of [...(live?.anchors || []), live?.root]) anchor(a, liveAt);
  for (const a of anchors || []) anchor(a, 0);
  for (const s of sessions) anchor(s?.project || s?.cwd, ms(s?.first_observed_at || s?.started_at || s?.last_observed_at || s?.last_at));
  for (const [a, at] of t.anchors) { const n = upsertNode(t, ids.folder(a), 'folder', at, {path: a, anchor: true}); n.first_at = Math.min(n.first_at, at); upsertEdge(t, 'anchored', BOX, ids.folder(a), at, {basis: 'box_anchor'}); }
  const home = p => { const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/.exec(p || ''); if (m && !t.home) t.home = m[1]; };
  const mark_file = (path, at, op, status, extra = {}) => {
    const file = upsertNode(t, ids.file(path), 'file', at, {path, ...extra});
    file.last_at = Math.max(file.last_at, at);
    const state=status==='completed' ? (['write', 'create', 'delete', 'move_from', 'move_to'].includes(op) ? 'editing' : 'reading')
      : ['blocked','denied'].includes(status) ? 'blocked' : status==='failed' ? 'failed' : 'observed';
    mark(file, at, state, extra.version || null);
    home(path);
    return file;
  };
  for (const s of sessions) {
    const key = s.id || s.key; if (!key) continue;
    const at = ms(s.last_observed_at || s.last_at), first = ms(s.first_observed_at || s.started_at) || at;
    const node = upsertNode(t, ids.agent(key), 'agent', first, {client: s.client || s.runtime, model: s.model || s.model_id || null, project: s.project || s.cwd || null, name: s.name || s.task_label || null, session_id: s.session_id, guard_seen: s.guard_seen, controls: s.controls});
    node.last_at = Math.max(node.last_at, at);
    if (at) mark(node, at, ENDED.has(s.state) ? 'ended' : s.state === 'idle_observed' ? 'idle' : 'observed');
    if (s.parent_id) { upsertNode(t, ids.agent(s.parent_id), 'agent', first, {}); upsertEdge(t, 'spawned', ids.agent(s.parent_id), ids.agent(key), first, {basis: 'native_parent_id'}); }
    home(s.project || s.cwd);
  }
  for (const e of events) {
    if (!e?.agent_id) continue;
    const at = ms(e.at), aid = ids.agent(e.agent_id);
    mark(upsertNode(t, aid, 'agent', at), at, STATE_OF[e.kind] || 'observed');
    if (e.parent_id) upsertEdge(t, 'spawned', ids.agent(e.parent_id), aid, at, {basis: 'native_parent_id', event_id: e.id});
    for (const r of e.resources || []) {
      if (typeof r?.path !== 'string' || !r.path.startsWith('/')) continue;
      if (['attempted','awaiting_permission','checked'].includes(e.status)) continue;
      mark_file(r.path, at, r.operation, e.status, {project: r.project || null, version: r.version || null});
      upsertEdge(t, 'acted', aid, ids.file(r.path), at, {operation: r.operation || e.kind, status: e.status || 'unknown', event_id: e.id, basis: 'received_hook'});
    }
  }
  for (const r of relationships) {
    if (['attempted','awaiting_permission','checked'].includes(r.status)) continue;
    const at = ms(r.last_at), first = ms(r.first_at) || at, aid = ids.agent(r.agent_id);
    upsertNode(t, aid, 'agent', first).last_at = Math.max(t.nodes.get(aid).last_at, at);
    if (r.parent_id) upsertEdge(t, 'spawned', ids.agent(r.parent_id), aid, first, {basis: 'native_parent_id'});
    const file = mark_file(r.path, at, r.operation, r.status, {project: r.project || null}); file.first_at = Math.min(file.first_at, first);
    const edge = upsertEdge(t, 'acted', aid, ids.file(r.path), at, {operation: r.operation, status: r.status, basis: r.basis || 'journal_aggregate', path_identity: r.path_identity || null});
    if (edge) { edge.first_at = Math.min(edge.first_at, first); edge.count = Math.max(edge.count, r.count || 1); }
  }
  for (const f of live?.files || []) {
    if (typeof f?.path !== 'string') continue;
    const at = ms(f.last_at), first = ms(f.first_at) || at;
    const file = upsertNode(t, ids.file(f.path), 'file', first, {path: f.path, sent_bytes: f.sent_bytes, withheld_bytes: f.withheld_bytes, prepared_bytes: f.prepared_bytes, withheld_by: f.withheld_by, protection: f.protection});
    file.last_at = Math.max(file.last_at, at); home(f.path);
    for (const key of f.sessions || []) upsertEdge(t, 'acted', ids.agent(key), ids.file(f.path), at, {operation: 'egress_source', status: 'observed', basis: 'egress_provenance'});
  }
  for (const d of live?.destinations || []) if (d?.upstream && Number(d.requests) > 0) {
    const at = ms(d.last_at);
    upsertNode(t, ids.destination(d.upstream), 'destination', at, {upstream: d.upstream, requests: d.requests, sent_bytes: d.sent_bytes, withheld_bytes: d.withheld_bytes});
    upsertEdge(t, 'sent', BOX, ids.destination(d.upstream), at, {basis: 'proxy_request', requests: d.requests});
  }
  for (const request of requests) {
    if (!request?.id || !Number.isFinite(request.at)) continue;
    const id = 'request:' + request.id;
    const node = upsertNode(t, id, 'request', request.at, {request_id:request.id, model:request.model, name:request.model || 'Local model request', session_id:request.sessionId});
    mark(node, request.at, request.status || 'observed');
    upsertEdge(t, 'sent', BOX, id, request.at, {basis:'governed_request_record', event_id:request.id, status:request.status || 'observed'});
  }
  upsertNode(t, BOX, 'box', 0, {root: live?.root || null});
  return t;
}

const CONTAINER_DIRS = new Set(['Desktop', 'Documents', 'Downloads', 'Projects', 'projects', 'code', 'Code', 'dev', 'Developer', 'src', 'work', 'repos', 'git', 'GitHub', 'Sites', 'Library']);
/** The folder a path hangs from: the nearest Box folder, or a stable outside group (~/.claude, ~/Desktop/site, /opt/x). */
export function groupOf(path, anchors, home) {
  const dir = parentOf(path);
  let best = null; for (const a of anchors || []) if (within(path, a) && a !== path && (!best || a.length > best.length)) best = a;
  if (best) return best;
  if (home && within(dir, home)) { const parts = dir.slice(home.length).split('/').filter(Boolean); if (!parts.length) return home; return `${home}/${parts.slice(0, CONTAINER_DIRS.has(parts[0]) && parts.length > 1 ? 2 : 1).join('/')}`; }
  const parts = dir.split('/').filter(Boolean); return parts.length ? `/${parts.slice(0, ['private', 'Volumes', 'Users', 'home', 'var', 'opt', 'mnt'].includes(parts[0]) && parts.length > 1 ? 2 : 1).join('/')}` : '/';
}

/** Activity of a node as recorded at or before `at`; never a later observation. */
export function stateAt(node, at) {
  let last = null;
  for (const m of node.marks) { if (m.at > at) break; last = m; }
  if (!last) return node.first_at <= at ? {state: 'observed', at: node.first_at, basis: 'first_observation'} : null;
  return {state: last.state, at: last.at, basis: 'observation', ...(last.version ? {version: last.version} : {})};
}
export function lastActivityAt(node, at) { const s = stateAt(node, at); return s ? s.at : 0; }

/**
 * edge_last_activity = max(last relationship observation, activity of the endpoint the relationship explains).
 * The explained endpoint is the target for containment, spawn, action and egress; a busy parent never brightens every old branch.
 */
export function edgeActivityAt(t, edge, at) {
  const observed = edge.last_at <= at ? edge.last_at : edge.first_at <= at ? edge.first_at : 0;
  if (REL[edge.rel]?.follow !== 'target') return observed;
  const target = t.nodes.get(edge.target);
  return Math.max(observed, target ? lastActivityAt(target, at) : 0);
}

/**
 * The visible projection at cursor `at`: nodes whose first observation is at or before `at` and whose activity is inside the
 * lifespan (ms), plus ancestor stubs for visible descendants. Ended sessions are retained until they age out; completion never
 * shortens a lifespan. `assoc` includes every real relationship instead of one tree edge per node.
 */
export function project(t, {at = Date.now(), now = at, lifespan = 3600e3, showEnded = true, assoc = false, focus = null, expanded = new Set(), expandCap = 12, groupAgents = false, agentPages = new Map(), agentPageSize = 4} = {}) {
  const visible = new Map(), stubs = new Set(), historical = at < now - 1500;
  const age = s => Math.max(0, Math.min(1, (at - s.at) / lifespan));
  const hide = node => historical ? {...node, meta: {...node.meta, protection: null, withheld_by: null, liveStateHidden: true}} : node;
  for (const node of t.nodes.values()) {
    if (node.kind === 'box') { visible.set(node.id, {...node, activity: {state: 'box', at}}); continue; }
    if (node.kind === 'folder') continue;
    const s = stateAt(node, at);
    if (!s) continue;
    if (!showEnded && s.state === 'ended') continue;
    if (at - s.at < lifespan) visible.set(node.id, {...hide(node), activity: s, age: age(s), version: s.version || null});
  }
  // An expanded folder shows what the record holds for it beyond the window (capped), marked as retained rather than active.
  const opened = [...expanded].filter(id => typeof id === 'string' && id.startsWith('folder:')).map(id => id.slice(7));
  if (opened.length) {
    const shown = new Map();
    for (const node of [...t.nodes.values()].sort((a, b) => b.last_at - a.last_at)) {
      if (node.kind !== 'file' || visible.has(node.id) || node.first_at > at) continue;
      const dir = opened.find(d => parentOf(node.meta.path) === d); if (!dir) continue;
      const n = (shown.get(dir) || 0) + 1; shown.set(dir, n); if (n > expandCap) continue;
      const s = stateAt(node, at) || {state: 'observed', at: node.first_at};
      visible.set(node.id, {...hide(node), activity: s, age: 1, stub: true, retained: `Shown because its folder is expanded. Last observed ${new Date(s.at).toLocaleTimeString()}.`});
    }
  }
  // Folders are path structure derived at projection time from the visible files and the Box folders, so the projection
  // does not depend on the order observations arrived. Only a file's own folder is drawn; it hangs from the nearest drawn
  // ancestor (a Box folder, another drawn folder, or its outside group) and is labelled by the path between them, so a
  // chain of single-child folders reads as one card. A folder is as recent as its most recent visible content.
  const edges = [], anchors = [...(t.anchors || new Map())].filter(([, first]) => first <= at).map(([p]) => p), folderAct = new Map(), chain = new Map();
  const folder = (path, first) => { const id = ids.folder(path); if (!visible.has(id)) visible.set(id, {id, kind: 'folder', first_at: first, last_at: 0, meta: {path, anchor: anchors.includes(path), group: !anchors.includes(path)}, marks: [], activity: {state: 'observed', at: first}, age: 1}); else visible.get(id).first_at = Math.min(visible.get(id).first_at, first); return id; };
  for (const a of anchors) folder(a, t.anchors.get(a));
  const link = (fid, child, first, last) => { const key = `${fid}>${child}`; const e = chain.get(key); if (!e) chain.set(key, {id: `contains:${fid}->${child}`, rel: 'contains', source: fid, target: child, first_at: first, last_at: last, count: 1, evidence: {basis: 'path'}}); else { e.first_at = Math.min(e.first_at, first); e.last_at = Math.max(e.last_at, last); } folderAct.set(fid, Math.max(folderAct.get(fid) || 0, last)); };
  const files = [...visible.values()].filter(n => n.kind === 'file');
  for (const n of files) { const dir = parentOf(n.meta.path), top = groupOf(n.meta.path, anchors, t.home); folder(top, n.first_at); const fid = folder(dir, n.first_at); link(fid, n.id, n.first_at, n.activity.at); }
  const drawn = [...visible.values()].filter(n => n.kind === 'folder').sort((a, b) => a.meta.path.length - b.meta.path.length);
  for (const f of drawn) {
    if (f.meta.anchor) continue;
    const top = groupOf(`${f.meta.path}/.`, anchors, t.home);
    let parent = null; for (const g of drawn) if (g !== f && within(f.meta.path, g.meta.path) && (within(g.meta.path, top) || g.meta.path === top) && (!parent || g.meta.path.length > parent.meta.path.length)) parent = g;
    f.meta.label = parent ? f.meta.path.slice(parent.meta.path.length + 1) : null;
    if (parent) link(parent.id, f.id, f.first_at, folderAct.get(f.id) || f.first_at);
  }
  for (const f of [...drawn].reverse()) if (folderAct.has(f.id)) for (const e of chain.values()) if (e.target === f.id) { e.last_at = Math.max(e.last_at, folderAct.get(f.id)); folderAct.set(e.source, Math.max(folderAct.get(e.source) || 0, folderAct.get(f.id))); }
  for (const [fid, last] of folderAct) { const f = visible.get(fid); f.activity = {state: 'contains', at: last, basis: 'contained_activity'}; f.age = age(f.activity); f.last_at = last; }
  for (const f of drawn) if (!f.meta.anchor && !folderAct.has(f.id)) visible.delete(f.id);
  for (const e of chain.values()) if (visible.has(e.source) && visible.has(e.target)) edges.push({...e, activity_at: e.last_at, age: age({at: e.last_at}), dotted: false});
  for (const edge of t.edges.values()) {
    if (edge.first_at > at) continue;
    const act = edgeActivityAt(t, edge, at);
    if (!visible.has(edge.target)) continue;
    if (at - act >= lifespan && edge.rel !== 'anchored') continue;
    if (!visible.has(edge.source)) {
      const src = t.nodes.get(edge.source);
      if (!src || src.first_at > at) continue;
      // A visible descendant keeps a subdued ancestor stub instead of floating; the node explains its retained context.
      const s = stateAt(src, at) || {state: 'observed', at: src.first_at};
      visible.set(src.id, {...hide(src), activity: s, age: 1, stub: true, retained: `Retained because a ${edge.rel === 'spawned' ? 'spawned task' : 'related item'} is still visible. Last observed ${new Date(s.at).toLocaleTimeString()}.`});
      stubs.add(src.id);
    }
    edges.push({...edge, activity_at: act, age: age({at: act}), dotted: REL[edge.rel]?.dotted || false});
  }
  if (groupAgents) groupAgentProjection(visible, edges, expanded, age, agentPages, agentPageSize);
  const tree = flood(visible, edges, {focus});
  // A lane root hangs from its Box port on a stem. The stem is the workspace attachment (this item was observed in this Box),
  // drawn distinctly and never counted as a recorded relationship.
  const stems = [...tree.roots].filter(id => visible.has(id)).map(id => { const n = visible.get(id); return {id: `root:${BOX}->${id}`, rel: 'root', source: BOX, target: id, first_at: n.first_at, last_at: n.activity.at, count: 0, evidence: {basis: 'lane_root'}, activity_at: n.activity.at, age: n.age ?? 0, dotted: false, tree: true, synthetic: true}; });
  const shown = assoc ? edges.map(e => ({...e, tree: tree.treeEdges.has(e.id)})) : edges.filter(e => tree.treeEdges.has(e.id) || e.rel === 'association').map(e => ({...e, tree: tree.treeEdges.has(e.id)}));
  const drawnRelationshipIds=new Set(shown.flatMap(edge=>edge.relationshipIds || (t.edges.has(edge.id)?[edge.id]:[])));
  const drawnRecorded=drawnRelationshipIds.size;
  return {nodes: [...visible.values()], edges: [...stems, ...shown],
    associations: edges.filter(e => !tree.treeEdges.has(e.id)), depth: tree.depth, parent: tree.parent, port: tree.port, order: tree.order, stubs, at, historical,
    coverage:{...t.coverage,recorded_relationships:t.edges.size,drawn_relationships:drawnRecorded,relationships_not_drawn:Math.max(0,t.edges.size-drawnRecorded)}};
}

/** Group only the visible projection. The audit record retains every original session and action. */
function groupAgentProjection(visible, edges, expanded, age, agentPages, pageSize) {
  const groups = new Map(), groupOfAgent = new Map();
  for (const node of visible.values()) {
    if (node.kind !== 'agent') continue;
    const label = agentGroupLabel(node.meta), id = agentGroupId(label);
    if (!groups.has(id)) groups.set(id, {id, label, agents: []});
    groups.get(id).agents.push(node);
    groupOfAgent.set(node.id, id);
  }
  if (!groups.size) return;
  for (const group of groups.values()) {
    const first = Math.min(...group.agents.map(node => node.first_at));
    const latest = group.agents.reduce((best, node) => node.activity.at > best.activity.at ? node : best);
    group.agents.sort((a,b)=>b.activity.at-a.activity.at || a.id.localeCompare(b.id));
    const opened = expanded.has(group.id), pages = Math.max(1, Math.ceil(group.agents.length / pageSize));
    const page = Math.max(0, Math.min(pages - 1, agentPages.get(group.id) || 0));
    const shown = new Set(opened ? group.agents.slice(page * pageSize, (page + 1) * pageSize).map(node=>node.id) : []);
    visible.set(group.id, {id: group.id, kind: 'agent_group', first_at: first, last_at: latest.activity.at,
      meta: {label: group.label, count: group.agents.length, expanded: opened, page, pages}, marks: [], activity: {...latest.activity}, age: age(latest.activity)});
    if (opened) for (const node of group.agents) if (shown.has(node.id)) edges.push({id: `member:${group.id}->${node.id}`, rel: 'member', source: group.id, target: node.id,
      first_at: node.first_at, last_at: node.activity.at, activity_at: node.activity.at, count: 0, evidence: {basis: 'display_group'}, age: node.age, synthetic: true});
    for (const node of group.agents) if (!shown.has(node.id)) visible.delete(node.id);
  }
  const transformed = new Map();
  for (const edge of edges) {
    if (edge.rel === 'member') { transformed.set(edge.id, edge); continue; }
    if (edge.rel === 'spawned' && (!visible.has(edge.source) || !visible.has(edge.target))) continue;
    if (edge.rel === 'works_in' && !visible.has(edge.source)) continue;
    if (edge.rel !== 'acted') { transformed.set(edge.id, edge); continue; }
    const source = visible.has(edge.source) ? edge.source : groupOfAgent.get(edge.source);
    if (!source || !visible.has(edge.target)) continue;
    const id = `association:${source}->${edge.target}`, previous = transformed.get(id);
    transformed.set(id, previous ? {...previous, first_at: Math.min(previous.first_at, edge.first_at),
      last_at: Math.max(previous.last_at, edge.last_at), activity_at: Math.max(previous.activity_at, edge.activity_at),
      count: previous.count + edge.count, age: Math.min(previous.age, edge.age), observations:[...(previous.observations || []),...(edge.observations || [])], sessionIds: [...previous.sessionIds, edge.source], relationshipIds:[...previous.relationshipIds,edge.id]} :
      {...edge, id, rel: 'association', source, sessionIds: [edge.source], relationshipIds:[edge.id]});
  }
  edges.splice(0, edges.length, ...transformed.values());
}

/**
 * Directed flood from the Box over observed relationships. Phase 1 seeds the Box, then every true root (a node with no
 * incoming tree-capable relationship, such as a top-level session), and reaches nodes breadth first with a visited set.
 * Phase 2 gives each reached node exactly one tree parent: its incoming relationships ordered by priority, then earliest
 * observation, then id, skipping any that would close a cycle. Phase 3 sets d(v) = d(parent) + w(rel), the sibling order
 * and the port, which is inherited from the branch root and never recomputed from a position.
 */
export function flood(visible, edges, {focus = null} = {}) {
  const priority = {spawned: 0, member: 1, acted: 2, transformed: 3, contains: 4, anchored: 5, sent: 6};
  const tie = (a, b) => (priority[a.rel] ?? 9) - (priority[b.rel] ?? 9) || a.first_at - b.first_at || (a.id < b.id ? -1 : 1);
  const treeable = edges.filter(e => REL[e.rel]?.tree && visible.has(e.source) && visible.has(e.target));
  const incoming = new Map(), outgoing = new Map();
  for (const e of treeable) { (incoming.get(e.target) || incoming.set(e.target, []).get(e.target)).push(e); (outgoing.get(e.source) || outgoing.set(e.source, []).get(e.source)).push(e); }
  for (const l of incoming.values()) l.sort(tie); for (const l of outgoing.values()) l.sort(tie);
  const laneOf = n => n.kind === 'destination' ? 'e' : n.kind === 'folder' && n.meta?.anchor ? 'w' : ['agent','agent_group','request'].includes(n.kind) ? 'n' : 's';
  const seen = new Set([BOX]), discovered = [BOX], seeds = new Set();
  const bfs = start => { const q = [start]; while (q.length) { const u = q.shift(); for (const e of outgoing.get(u) || []) if (!seen.has(e.target)) { seen.add(e.target); discovered.push(e.target); q.push(e.target); } } };
  bfs(BOX);
  const rest = () => [...visible.keys()].filter(id => !seen.has(id)).sort();
  for (let pending = rest(); pending.length; pending = rest()) {
    const roots = pending.filter(id => !(incoming.get(id) || []).length);
    const seed = (roots.length ? roots : pending)[0];
    seen.add(seed); discovered.push(seed); seeds.add(seed); bfs(seed);
  }
  const parent = new Map(), via = new Map();
  const closes = (u, v) => { for (let c = u, i = 0; c && i < 10000; c = parent.get(c), i++) if (c === v) return true; return false; };
  for (const v of discovered) {
    if (v === BOX) continue;
    const pick = (incoming.get(v) || []).find(e => seen.has(e.source) && !closes(e.source, v));
    parent.set(v, pick ? pick.source : BOX); if (pick) via.set(v, pick);
  }
  const depth = new Map([[BOX, 0]]), port = new Map(), order = new Map(), treeEdges = new Set([...via.values()].map(e => e.id));
  const depthOf = v => { if (depth.has(v)) return depth.get(v); const p = parent.get(v), e = via.get(v), d = (p === undefined ? 0 : depthOf(p)) + (e ? REL[e.rel].w : 1); depth.set(v, d); return d; };
  const portOf = v => { if (port.has(v)) return port.get(v); const p = parent.get(v); const value = p === BOX || p === undefined ? laneOf(visible.get(v)) : portOf(p); port.set(v, value); return value; };
  const kids = new Map();
  for (const v of discovered) { if (v === BOX) continue; depthOf(v); portOf(v); const p = parent.get(v); (kids.get(p) || kids.set(p, []).get(p)).push(v); }
  for (const list of kids.values()) { list.sort((a, b) => (visible.get(a)?.first_at || 0) - (visible.get(b)?.first_at || 0) || (a < b ? -1 : 1)); list.forEach((v, i) => order.set(v, i)); }
  // Lane roots: nodes that hang directly from the Box without a recorded relationship (top-level sessions, outside groups).
  const roots = new Set([...parent].filter(([v, p]) => p === BOX && !via.has(v)).map(([v]) => v));
  return {depth, parent, port, order, treeEdges, seeds, roots};
}
function isDescendant(parent, candidate, of) { for (let c = candidate, i = 0; c && i < 10000; c = parent.get(c), i++) if (c === of) return true; return false; }

/** Recorded history is never trimmed by the visible window; Audit reads the same record. */
export function audit(t, {query = ''} = {}) {
  const q = query.toLowerCase();
  const rows = [...t.edges.values()].map(e => ({...e, source_kind: t.nodes.get(e.source)?.kind, target_kind: t.nodes.get(e.target)?.kind}));
  return rows.filter(r => !q || `${r.id} ${JSON.stringify(r.evidence || {})}`.toLowerCase().includes(q)).sort((a, b) => b.last_at - a.last_at);
}
