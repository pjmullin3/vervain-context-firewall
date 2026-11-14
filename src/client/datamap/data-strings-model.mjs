/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
import {visibleAt,lastObservation,lineageForest,GRAPH_DEFAULTS} from './graph-experience.mjs';
import {sessionLabel} from './agent-workspace-model.mjs';
// Live data graph ("strings of nodes") for egress withholding, VVN-46.
// Egress provenance and received native hook resources share stable actor/file nodes.
// No session alone establishes file access or ongoing activity. React lives in DataStrings.jsx.

export const STATE_RANK = Object.freeze({idle: 0, in_context: 1, reading: 2, editing: 3});
const RANK_STATE = ['idle', 'in_context', 'reading', 'editing'];
export const STATE_LABEL = Object.freeze({editing: 'Write observed', reading: 'Read observed', in_context: 'Context observed', idle: 'No recent completed action'});
export const LIVE_STATES = new Set(['editing', 'reading']);
export const LAYER_Z = Object.freeze({idle: 0, withheld: 1, live: 2});
export const NODE_SIZE = Object.freeze({
  box: {width: 196, height: 176},
  folder: {width: 236, height: 94},
  file: {width: 236, height: 94},
  more: {width: 132, height: 34},
  destination: {width: 236, height: 94},
  agent: {width: 244, height: 112},
  agentGroup: {width: 232, height: 252},
});
export const AGENT_PAGE_SIZE = 4;
export const BOX_ID = 'box';
// A new-file review hold is sent when its time runs out; every other hold is withheld.
export const REVIEW_RULE_ID = 'review:new_file';
export const folderId = path => `folder:${path}`;
export const fileId = path => `file:${path}`;
export const moreId = parentId => `more:${parentId}`;
export const destinationId = upstream => `destination:${upstream}`;
export const agentId = id => `agent:${id}`;
export const agentGroupId = label => `agent-group:${encodeURIComponent(label)}`;

/** Group by a known model for local runtimes, otherwise by connected client. */
export function agentGroupLabel(session) {
  const client=agentName(session?.client || session?.runtime);
  if (client==='Claude' || client==='Codex') return client;
  const model=String(session?.model || session?.model_id || '').trim();
  if (model) return model.replace(/[_-]+/g,' ').replace(/\bqwen\b/i,'Qwen');
  return client;
}

export function fileObservationLabel(file) {
  const outcome=file?.last_outcome;
  return ({attempted:'Action attempted',denied:'Action denied',failed:'Action failed',awaiting_permission:'Awaiting native permission',in_progress_observed:'Tool reported in progress',unknown:'Outcome unknown'})[outcome] || STATE_LABEL[file?.state] || 'Outcome unknown';
}
export function forwardingLabel(data) {
  if(data?.forwarding_observed===false)return 'Cloud forwarding unobserved';
  if (!data || !Object.hasOwn(data,'prepared_bytes')) return `${formatBytes(data?.sent_bytes)} · forwarding unconfirmed`;
  return `${formatBytes(data.sent_bytes)} forwarded${data.prepared_bytes ? ` · ${formatBytes(data.prepared_bytes)} unconfirmed` : ''}${data.source_bytes_unknown ? ' · source bytes unknown' : ''}`;
}

/** Join received hook resources; this never infers file access from a session alone. */
export function mergeAgentActivity(live, sessions=[], events=[]) {
  if (!sessions.length && !events.length) return live;
  const base=live || {files:[],sessions:[],rules:[],anchors:[],holds:[],destinations:[]};
  const actors=new Map((base.sessions || []).filter(s=>s?.key).map(s=>[s.key,{...s,id:s.key,client:s.runtime,project:s.cwd,last_observed_at:s.last_at}]));
  for(const session of sessions) if(session?.id) actors.set(session.id,{...actors.get(session.id),...session,key:session.id,runtime:session.client,cwd:session.project});
  const files=new Map((base.files || []).map(f=>[f.path,{...f}])),links=new Map();
  const ordered=[...events].sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  for(const event of ordered) {
    if (!event?.agent_id) continue;
    if(!actors.has(event.agent_id))actors.set(event.agent_id,{id:event.agent_id,key:event.agent_id,client:'Unknown client',last_observed_at:event.at,state:'Observed session'});
    for(const resource of event.resources || []) {
      if(typeof resource?.path!=='string' || !resource.path.startsWith('/'))continue;
      const old=files.get(resource.path) || {path:resource.path,first_at:event.at,state:'idle',kinds:[],sessions:[],prepared_bytes:0,sent_bytes:0,withheld_bytes:0,forwarding_observed:false};
      const latest=!old.last_at || String(event.at)>=String(old.last_at);
      const complete=event.status==='completed';
      const state=complete && ['write','create','delete','move_from','move_to'].includes(resource.operation)?'editing':complete && resource.operation==='read'?'reading':'idle';
      files.set(resource.path,{...old,project:resource.project || old.project,forceVisible:true,
        sessions:[...new Set([...(old.sessions || []),event.agent_id])],
        ...(latest?{state,last_outcome:event.status || 'unknown',last_at:event.at,version:resource.version}:{}),
      });
      links.set(`${event.agent_id}\0${resource.path}`,{agent_id:event.agent_id,path:resource.path,status:event.status || 'unknown',operation:resource.operation || event.kind,at:event.at,event_id:event.id});
    }
  }
  return {...base,sessions:[...actors.values()],files:[...files.values()],observed_agents:[...actors.values()],observed_links:[...links.values()],
    anchors:[...new Set([...(base.anchors || []),...sessions.map(s=>s.project).filter(Boolean)])]};
}

/** A visible session window; the received history is never mutated or discarded. */
export function scopeAgentGraph(live,{mode='recent',focusId=null,now=Date.now(),prefs=GRAPH_DEFAULTS,retainedPaths=new Set()}={}) {
  const actors=live?.observed_agents || live?.sessions || [],key=s=>s.id || s.key;
  const ordered=[...actors].sort((a,b)=>lastObservation(b)-lastObservation(a) || String(key(a)).localeCompare(String(key(b))));
  const keep=new Set((mode==='focused'?[]:mode==='all'?ordered:ordered.filter(s=>visibleAt(s,now,prefs))).map(key));
  if(mode==='focused' && focusId){keep.add(focusId);const focused=actors.find(s=>key(s)===focusId);if(focused?.parent_id)keep.add(focused.parent_id);}
  if(!live)return {view:live,total:0,shown:0,actors:ordered};
  const selected=actors.filter(s=>keep.has(key(s)));
  const links=(live.observed_links || []).filter(link=>keep.has(link.agent_id) && (mode==='all' || visibleAt(link,now,prefs)));
  const paths=new Set(links.map(link=>link.path));
  const files=(live.files || []).filter(file=>(mode==='all' || visibleAt(file,now,prefs)) && (mode!=='focused' || paths.has(file.path)))
    // Keep observed file blocks for the entire time window, including after a task
    // becomes idle or ends. The short live-highlight timer never removes a block.
    .map(file=>retainedPaths.has(file.path) || paths.has(file.path)?{...file,forceVisible:true}:file);
  const anchors=(live.anchors || []).filter(anchor=>mode==='all' || anchor===live.root || files.some(file=>within(file.path,trimPath(anchor))) || selected.some(s=>(s.project || s.cwd)===anchor));
  const destinations=(live.destinations || []).filter(d=>mode==='all' || visibleAt(d,now,prefs));
  return {view:{...live,now:new Date(now).toISOString(),sessions:selected,observed_agents:selected,observed_links:links,files,anchors,destinations},total:actors.length,shown:selected.length,actors:ordered};
}

/** Focus only received direct file associations and the declared parent. */
export function agentFocusNodes(graph,id) {
  const actor=agentId(id),ids=new Set([actor]);
  const session=graph.nodes.find(node=>node.id===actor);
  if(session?.data?.groupId)ids.add(session.data.groupId);
  for(const edge of graph.edges) {
    if((edge.source===actor || edge.data?.sessionIds?.includes(id)) && edge.target.startsWith('file:') && ['observed-action','source-association'].includes(edge.data?.kind))ids.add(edge.target);
    if(edge.target===actor && edge.data?.kind==='agent-parent')ids.add(edge.source);
  }
  return graph.nodes.filter(node=>ids.has(node.id)).map(node=>({id:node.id}));
}

const SHOW_MORE_LIMIT = 120;
// Folders that only hold projects: group outside files one level deeper than these.
const CONTAINER_DIRS = new Set(['Desktop', 'Documents', 'Downloads', 'Projects', 'projects', 'code', 'Code',
  'dev', 'Developer', 'src', 'work', 'repos', 'git', 'GitHub', 'Sites', 'Library']);
const SYSTEM_ROOTS = new Set(['private', 'Volumes', 'Users', 'home', 'var', 'opt', 'mnt']);

// ---------- paths ----------
export function trimPath(path) {
  if (typeof path !== 'string' || !path) return '';
  return path.replace(/\/+$/, '') || '/';
}
export function within(path, folder) {
  if (!folder) return false;
  if (folder === '/') return path.startsWith('/');
  return path === folder || path.startsWith(`${folder}/`);
}
export function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}
export const baseName = path => (path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1));
function relative(path, folder) {
  if (path === folder) return '';
  return folder === '/' ? path.slice(1) : path.slice(folder.length + 1);
}
export function homePath(path, home) {
  if (home && within(path, home)) return path === home ? '~' : `~${path.slice(home.length)}`;
  return path;
}
export function guessHome(live) {
  const candidates = [live?.root, ...(live?.anchors || []), ...(live?.sessions || []).map(s => s?.cwd),
    ...(live?.files || []).slice(0, 50).map(f => f?.path)];
  for (const path of candidates) {
    const match = typeof path === 'string' && /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/.exec(path);
    if (match) return match[1];
  }
  return null;
}
/** Nearest meaningful parent for a file outside every Box folder, e.g. ~/.claude or ~/Desktop/site. */
export function outsideGroup(path, home) {
  const dir = parentOf(path);
  if (home && within(dir, home)) {
    const parts = relative(dir, home).split('/').filter(Boolean);
    if (!parts.length) return home;
    const take = CONTAINER_DIRS.has(parts[0]) && parts.length > 1 ? 2 : 1;
    return `${home}/${parts.slice(0, take).join('/')}`;
  }
  const parts = dir.split('/').filter(Boolean);
  if (!parts.length) return '/';
  const take = SYSTEM_ROOTS.has(parts[0]) && parts.length > 1 ? 2 : 1;
  return `/${parts.slice(0, take).join('/')}`;
}

// ---------- labels ----------
export function agentName(runtime) {
  const text = String(runtime || '');
  if (/claude/i.test(text)) return 'Claude';
  if (/codex|chatgpt|openai/i.test(text)) return 'Codex';
  return text || 'Agent';
}
export function formatBytes(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
export function hostOf(upstream) {
  try { return new URL(upstream).host || upstream; } catch { return String(upstream || ''); }
}

// ---------- rules ----------
/** Active withhold rules indexed so the most specific one wins: exact path, then the longest folder. */
/** @param {any[]} [rules] @param {{boxId?: string|null}} [options] */
export function withholdIndex(rules = [], {boxId = null} = {}) {
  const exact = new Map(), prefixes = [];
  for (const rule of rules || []) {
    if (!rule || rule.action !== 'withhold' || rule.removed_at || (rule.kind !== 'path' && rule.kind !== 'prefix')) continue;
    const scope = rule.scope || 'all';
    let session = null;
    if (scope.startsWith('box:')) { if (!boxId || scope.slice(4) !== boxId) continue; }
    else if (scope.startsWith('session:') && scope.length > 8) session = scope.slice(8);
    else if (scope !== 'all') continue;
    const target = trimPath(rule.target);
    if (!target) continue;
    if (rule.kind === 'path') {
      if (!exact.has(target)) exact.set(target, []);
      exact.get(target).push({session, rule});
    } else prefixes.push({folder: target, session, rule});
  }
  const newest = (a, b) => String(b.rule.created_at || '').localeCompare(String(a.rule.created_at || ''));
  for (const list of exact.values()) list.sort(newest);
  prefixes.sort((a, b) => b.folder.length - a.folder.length || newest(a, b));
  const applies = (entry, sessions) => entry.session === null || (sessions || []).includes(entry.session);
  return {
    file(path, sessions = []) {
      const hit = (exact.get(path) || []).find(entry => applies(entry, sessions))
        || prefixes.find(entry => within(path, entry.folder) && applies(entry, sessions));
      return hit ? hit.rule : null;
    },
    /** A branch rule covering this folder (its own or an ancestor's). */
    folder(path) {
      const hit = prefixes.find(entry => entry.session === null && within(path, entry.folder));
      return hit ? hit.rule : null;
    },
    /** A branch rule whose folder lies on the string from parentPath (exclusive) to path (inclusive). */
    cut(parentPath, path) {
      const hit = prefixes.find(entry => entry.session === null && within(path, entry.folder)
        && !(parentPath && within(parentPath, entry.folder)));
      return hit ? hit.rule : null;
    },
  };
}

/** Overlay rule and hold changes the user just made, until the next poll confirms them. */
/** @param {any} live @param {any} [pending] */
export function applyPending(live, pending = {}) {
  if (!live) return live;
  const added = pending.added || [], removed = pending.removed || new Set(), decided = pending.decided || new Set();
  if (!added.length && !removed.size && !decided.size) return live;
  const known = new Set((live.rules || []).map(rule => rule.id));
  const rules = [...(live.rules || []).filter(rule => !removed.has(rule.id)), ...added.filter(rule => !known.has(rule.id) && !removed.has(rule.id))];
  const files = removed.size ? (live.files || []).map(file => (removed.has(file.withheld_by) ? {...file, withheld_by: null} : file)) : live.files;
  const holds = (live.holds || []).filter(hold => !decided.has(hold.id));
  return {...live, rules, files, holds};
}

// ---------- expansion ----------
/** Double-click toggles one folder. Folding a folder also folds everything opened beneath it. */
export function toggleExpanded(expanded, id) {
  const next = new Set(expanded);
  if (typeof id !== 'string' || !id.startsWith('folder:')) return next;
  const path = id.slice(7);
  const beneath = [...next].filter(other => other.startsWith('folder:') && within(other.slice(7), path));
  if (beneath.length) for (const other of beneath) next.delete(other);
  else next.add(id);
  return next;
}

// ---------- graph ----------
function makeDir(path) {
  return {path, dirs: new Map(), files: [], count: 0, rank: 0, withheld: 0, holds: 0, minOrder: Infinity, lastAt: ''};
}
function aggregate(dir) {
  let count = dir.files.length, rank = 0, withheld = 0, holds = 0, minOrder = Infinity, lastAt = '';
  for (const entry of dir.files) {
    rank = Math.max(rank, entry.rank);
    if (entry.rule) withheld++;
    holds += Number(entry.file.held) || 0;
    minOrder = Math.min(minOrder, entry.order);
    if ((entry.file.last_at || '') > lastAt) lastAt = entry.file.last_at;
  }
  for (const child of dir.dirs.values()) {
    aggregate(child);
    count += child.count; rank = Math.max(rank, child.rank); withheld += child.withheld; holds += child.holds;
    minOrder = Math.min(minOrder, child.minOrder);
    if (child.lastAt > lastAt) lastAt = child.lastAt;
  }
  Object.assign(dir, {count, rank, withheld, holds, minOrder, lastAt});
}
/** A folder with no files of its own and one subfolder is drawn as one node: src/vervain/egress. */
function compress(dir) {
  let node = dir;
  while (node.files.length === 0 && node.dirs.size === 1) node = node.dirs.values().next().value;
  return node;
}
function pick(list, limit, pinned) {
  const chosen = new Set(list.slice(0, Math.max(0, limit)));
  for (const item of list) if (pinned(item)) chosen.add(item);
  return list.filter(item => chosen.has(item));
}
const byOrder = (a, b) => (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const layerFor = (rank, withheld) => (rank >= STATE_RANK.reading ? 'live' : withheld ? 'withheld' : 'idle');
function isRecent(at, now, seconds) {
  const a = Date.parse(at), n = Date.parse(now);
  return Number.isFinite(a) && Number.isFinite(n) && n - a <= seconds * 1000;
}

/**
 * @param {any} live egress live payload
 * @param {{expanded?: Set<string>, expandedAgents?: Set<string>, agentPages?: Map<string,number>, focusAgentId?: string|null, showMore?: Set<string>, cap?: number, liveCap?: number, home?: string|null, boxId?: string|null}} [options]
 * @returns {{nodes: any[], edges: any[]}}
 */
export function buildStrings(live, {expanded = new Set(), expandedAgents = new Set(), agentPages = new Map(), focusAgentId = null, showMore = new Set(), cap = 6, liveCap = 8, home = null, boxId = null} = {}) {
  const nodes = [], edges = [];
  if (!live) return {nodes, edges};
  home = home || guessHome(live);
  const active = new Map((live.rules || []).filter(rule => rule && !rule.removed_at).map(rule => [rule.id, rule]));
  const index = withholdIndex(live.rules || [], {boxId});
  const runtimeOf = new Map((live.sessions || []).map(s => [s.key, s.runtime]));
  const entries = (live.files || [])
    .filter(file => file && typeof file.path === 'string' && file.path.startsWith('/'))
    .map(file => ({
      file,
      order: Number.isFinite(file.order) ? file.order : Infinity,
      rank: STATE_RANK[file.state] ?? 0,
      rule: index.file(file.path, file.sessions) || (file.withheld_by && active.get(file.withheld_by)) || null,
    }));

  // Containers: Box folders (anchors) first, in their stable order, then outside groups.
  const anchorPaths = [...new Set([live.root, ...(live.anchors || [])].map(trimPath).filter(p => p.startsWith('/')))];
  const deepestFirst = [...anchorPaths].sort((a, b) => b.length - a.length);
  const containers = new Map(anchorPaths.map(path => [path, Object.assign(makeDir(path), {anchor: true, outside: false})]));
  for (const entry of entries) {
    const path = entry.file.path;
    const top = deepestFirst.find(anchor => anchor !== path && within(path, anchor)) || outsideGroup(path, home);
    /** @type {any} */
    let dir = containers.get(top);
    if (!dir) { dir = Object.assign(makeDir(top), {anchor: false, outside: true}); containers.set(top, dir); }
    const rel = relative(parentOf(path), top);
    if (rel) for (const name of rel.split('/')) {
      let next = dir.dirs.get(name);
      if (!next) { next = makeDir(dir.path === '/' ? `/${name}` : `${dir.path}/${name}`); dir.dirs.set(name, next); }
      dir = next;
    }
    dir.files.push(entry);
  }
  for (const dir of containers.values()) aggregate(dir);

  // A folder opened deep inside a container keeps its ancestors open, up to the container.
  const containerPaths = new Set(containers.keys());
  const open = new Set();
  for (const id of expanded || []) {
    if (typeof id !== 'string' || !id.startsWith('folder:')) continue;
    for (let p = trimPath(id.slice(7)); p; p = p === '/' ? '' : parentOf(p)) {
      if (open.has(p)) break;
      open.add(p);
      if (containerPaths.has(p)) break;
    }
  }

  const visibleFolders = new Map(), visibleFiles = new Set(), segmentsShown = new Set(), queue = [];
  const edge = (source, target, data) => {
    const layer = data.layer || 'idle';
    return {id: `edge:${source}->${target}`, source, target, zIndex: LAYER_Z[layer], className: `ds-layer-${layer}`,
      data: {cut: false, cutRuleId: null, withheld: false, order: null, segment: null, showSegment: false, label: null, ...data, layer}};
  };
  const addFolder = (dir, parentId, parentPath, kind) => {
    const id = folderId(dir.path);
    const covering = index.folder(dir.path), cutRule = index.cut(parentPath, dir.path);
    const isOpen = open.has(dir.path);
    nodes.push({id, type: 'folder', data: {
      kind: 'folder', path: dir.path, label: parentPath ? relative(dir.path, parentPath) : homePath(dir.path, home),
      title: homePath(dir.path, home), sessions:[...new Set(entries.filter(entry=>within(entry.file.path,dir.path)).flatMap(entry=>entry.file.sessions || []))], anchor: !!dir.anchor, outside: !!dir.outside, expanded: isOpen,
      last_at: dir.lastAt || (live.sessions || []).filter(s=>(s.project || s.cwd)===dir.path).sort((a,b)=>lastObservation(b)-lastObservation(a))[0]?.last_observed_at || null, count: dir.count, state: RANK_STATE[dir.rank], withheld: !!covering, withheldBy: covering?.id ?? null,
      cutRuleId: cutRule?.id ?? null, withheldCount: dir.withheld, holds: dir.holds,
      cutRuleTarget:cutRule?.target || null,cutRuleScope:cutRule?.scope || null,
      order: Number.isFinite(dir.minOrder) ? dir.minOrder : null, parentId}});
    visibleFolders.set(dir.path, id);
    edges.push(edge(parentId, id, {kind, layer: layerFor(dir.rank, covering || cutRule), withheld: !!(covering || cutRule),
      cut: !!cutRule, cutRuleId: cutRule?.id ?? null}));
    if (isOpen) queue.push(dir);
  };
  const addFile = (entry, parentId, parentPath, kind, segment = null) => {
    const {file, rule} = entry, id = fileId(file.path);
    if (visibleFiles.has(id)) return;
    visibleFiles.add(id);
    const agents = [...new Set((file.sessions || []).map(key => agentName(runtimeOf.get(key))))];
    const explicitRoots=[...new Set((live.sessions || []).filter(s=>(file.sessions || []).includes(s.key)).map(s=>s.cwd).filter(p=>typeof p==='string' && p.startsWith('/') && within(file.path,trimPath(p))))];
    const project=file.project || (live.root && within(file.path,trimPath(live.root))?trimPath(live.root):explicitRoots.length===1?trimPath(explicitRoots[0]):null);
    nodes.push({id, type: 'file', data: {
      kind: 'file', path: file.path, label: baseName(file.path), folder: homePath(parentOf(file.path), home),
      state: RANK_STATE[entry.rank], last_outcome:file.last_outcome, project, version:file.version,
      withheld: !!rule, withheldBy: rule?.id ?? null, withheldRuleKind: rule?.kind ?? null,
      withheldTarget: rule ? trimPath(rule.target) : null, order: Number.isFinite(entry.order) ? entry.order : null,
      sessions: file.sessions || [], agents, kinds: file.kinds || [], sent_bytes: file.sent_bytes || 0,
      withheld_bytes: file.withheld_bytes || 0, held: file.held || 0, protection: file.protection ?? null,
      ...(Object.hasOwn(file,'prepared_bytes')?{prepared_bytes:file.prepared_bytes,source_bytes_unknown:file.source_bytes_unknown}:{}),
      forwarding_observed:file.forwarding_observed,
      last_at: file.last_at || null, through: kind === 'through', parentId}});
    // Strings that pass through the same closed folders share one path label.
    const segmentKey = segment ? `${parentId}|${segment}` : null;
    const showSegment = !!segmentKey && !segmentsShown.has(segmentKey);
    if (segmentKey) segmentsShown.add(segmentKey);
    edges.push(edge(parentId, id, {kind, layer: layerFor(entry.rank, rule), withheld: !!rule,
      order: Number.isFinite(entry.order) ? entry.order : null, segment, showSegment}));
  };
  const addMore = (parentId, hidden) => {
    const id = moreId(parentId);
    nodes.push({id, type: 'more', data: {kind: 'more', folderId: parentId, hidden, canShowMore: !showMore.has(parentId)}});
    edges.push(edge(parentId, id, {kind: 'more', layer: 'idle'}));
  };

  // Project context stays in Memory Space. It is not an agent and has no
  // synthetic center or relationship lines in the observed activity graph.
  // Level one: every Box folder, then outside groups up to the cap (groups with live files always).
  for (const dir of containers.values()) if (dir.anchor && dir.count) addFolder(dir, BOX_ID, null, 'parent');
  const outside = [...containers.values()].filter(dir => dir.outside)
    .map(dir => ({dir, order: dir.minOrder, name: dir.path, live: dir.rank >= STATE_RANK.reading})).sort(byOrder);
  const shownOutside = pick(outside, showMore.has(BOX_ID) ? SHOW_MORE_LIMIT : cap, item => item.live);
  for (const item of shownOutside) addFolder(item.dir, BOX_ID, null, 'outside');
  if (outside.length > shownOutside.length) addMore(BOX_ID, outside.length - shownOutside.length);

  // Opened folders, one level each, breadth first so near strings are placed before far ones.
  while (queue.length) {
    const dir = queue.shift(), parentId = folderId(dir.path);
    /** @type {any[]} */
    const children = [
      ...[...dir.dirs.values()].map(child => { const shown = compress(child); return {dir: shown, order: shown.minOrder, name: shown.path, live: false}; }),
      ...dir.files.map(entry => ({entry, order: entry.order, name: entry.file.path, live: entry.rank >= STATE_RANK.reading})),
    ].sort(byOrder);
    const shown = pick(children, showMore.has(parentId) ? SHOW_MORE_LIMIT : cap, item => item.live);
    for (const item of shown) item.dir ? addFolder(item.dir, parentId, dir.path, 'child') : addFile(item.entry, parentId, dir.path, 'child');
    if (children.length > shown.length) addMore(parentId, children.length - shown.length);
  }

  // Live files are never hidden: attach through the nearest visible folder, newest first.
  const hiddenLive = entries.filter(e => (e.rank >= STATE_RANK.reading || e.file.forceVisible) && !visibleFiles.has(fileId(e.file.path)))
    .sort((a, b) => String(b.file.last_at || '').localeCompare(String(a.file.last_at || '')) || (a.order - b.order));
  for (const entry of hiddenLive.filter((entry,i)=>entry.file.forceVisible || i<Math.max(0,liveCap))) {
    const dir = parentOf(entry.file.path);
    let host = null;
    for (let p = dir; ; p = parentOf(p)) {
      if (visibleFolders.has(p)) { host = p; break; }
      if (p === '/') break;
    }
    const segment = host ? relative(dir, host) : homePath(dir, home);
    addFile(entry, host ? visibleFolders.get(host) : BOX_ID, host, 'through', segment || null);
  }

  // Cloud destinations, only when requests were observed.
  for (const d of live.destinations || []) {
    if (!d?.upstream || !(Number(d.requests) > 0)) continue;
    const id = destinationId(d.upstream), recent = isRecent(d.last_at, live.now, 15);
    nodes.push({id, type: 'destination', data: {kind: 'destination', upstream: d.upstream, host: hostOf(d.upstream),
      requests: d.requests, sent_bytes: d.sent_bytes || 0, withheld_bytes: d.withheld_bytes || 0, last_at: d.last_at || null, live: recent,
      ...(Object.hasOwn(d,'prepared_bytes')?{prepared_bytes:d.prepared_bytes,source_bytes_unknown:d.source_bytes_unknown,forwarded_requests:d.forwarded_requests,sent_basis:d.sent_basis}: {})}});
    edges.push(edge(BOX_ID, id, {kind: 'destination', layer: recent ? 'live' : 'idle',
      label: `${forwardingLabel(d)} · ${formatBytes(d.withheld_bytes)} withheld`}));
  }
  // Agent groups are the visible top-level actors. The layout tree stays separate
  // from observed associations so a shared file can retain every real link.
  const actors=live.observed_agents || live.sessions || [], actorByKey=new Map(actors.map(s=>[s.id || s.key,s]));
  const groups=new Map();
  for(const session of actors) {
    const key=session.id || session.key;if(!key)continue;
    const label=agentGroupLabel(session),id=agentGroupId(label);
    if(!groups.has(id))groups.set(id,{id,label,sessions:[]});
    groups.get(id).sessions.push(session);
  }
  const shownSessionKeys=new Set();
  for(const group of groups.values()) {
    const opened=expandedAgents.has(group.id) || group.sessions.some(s=>(s.id || s.key)===focusAgentId);
    group.sessions.sort((a,b)=>lastObservation(b)-lastObservation(a) || String(a.id || a.key).localeCompare(String(b.id || b.key)));
    const focusIndex=group.sessions.findIndex(s=>(s.id || s.key)===focusAgentId);
    const pageCount=Math.max(1,Math.ceil(group.sessions.length/AGENT_PAGE_SIZE));
    const page=focusIndex>=0?Math.floor(focusIndex/AGENT_PAGE_SIZE):Math.min(Math.max(0,agentPages.get(group.id) || 0),pageCount-1);
    const start=page*AGENT_PAGE_SIZE,shown=opened?group.sessions.slice(start,start+AGENT_PAGE_SIZE):[];
    const last_at=group.sessions.map(s=>s.last_observed_at || s.last_at).filter(Boolean).sort().at(-1) || null;
    const sessionKeys=new Set(group.sessions.map(s=>s.id || s.key));
    const observedFiles=entries.filter(entry=>(entry.file.sessions || []).some(key=>sessionKeys.has(key))).length;
    nodes.push({id:group.id,type:'agentGroup',data:{kind:'agentGroup',groupId:group.id,label:group.label,sessionKeys:[...sessionKeys],count:group.sessions.length,observedFiles,expanded:opened,page,pageCount,from:start+1,to:Math.min(start+AGENT_PAGE_SIZE,group.sessions.length),last_at}});
    if(!opened)continue;
    for(const session of shown) {
      const key=session.id || session.key,id=agentId(key);
      shownSessionKeys.add(key);
      nodes.push({id,type:'agent',data:{kind:'agent',agentId:key,groupId:group.id,session:{...session,last_observed_at:session.last_observed_at || session.last_at},label:session.name || session.task_label || agentName(session.client || session.runtime),project:session.project || session.cwd || null,
        parentId:session.parent_id || null,last_at:session.last_observed_at || session.last_at || null}});
      edges.push(edge(group.id,id,{kind:'agent',layer:'idle'}));
    }
  }
  const visibleActor=new Map(actors.map(s=>{const key=s.id || s.key,id=agentGroupId(agentGroupLabel(s));return [key,shownSessionKeys.has(key)?agentId(key):id];}));
  const visibleIds=new Set(nodes.map(n=>n.id));
  const associations=new Map();
  const addAssociation=(key,path,kind,observation=null)=>{
    const source=visibleActor.get(key);
    const target=visibleFiles.has(fileId(path))?fileId(path):[...visibleFolders.entries()].filter(([folder])=>within(path,folder)).sort((a,b)=>b[0].length-a[0].length)[0]?.[1];
    if(!source || !target || !visibleIds.has(source))return;
    const pair=`${source}\0${target}`,old=associations.get(pair);
    const ids=[...new Set([...(old?.data.sessionIds || []),key])];
    const paths=[...new Set([...(old?.data.paths || []),path])];
    const observations=observation?[...(old?.data.observations || []),observation]:old?.data.observations || [];
    const newest=!old?.data.observation || (observation && String(observation.at)>=String(old.data.observation.at));
    associations.set(pair,edge(source,target,{kind:newest?kind:old.data.kind,layer:'idle',sessionIds:ids,paths,collapsed:target.startsWith('folder:'),
      observation:newest?observation:old.data.observation,observations,label:ids.length>1?`${ids.length} observed sessions`:observation?`${observation.operation} · ${observation.status}`:'Source association observed'}));
  };
  const linked=new Set();
  for(const link of live.observed_links || []) {
    linked.add(`${link.agent_id}\0${link.path}`);
    addAssociation(link.agent_id,link.path,'observed-action',link);
  }
  for(const entry of entries) for(const key of entry.file.sessions || []) if(actorByKey.has(key) && !linked.has(`${key}\0${entry.file.path}`))addAssociation(key,entry.file.path,'source-association');
  for(const session of actors) if(session.parent_id && actorByKey.has(session.parent_id)) {
    const parent=visibleActor.get(session.parent_id),child=visibleActor.get(session.id || session.key);
    if(parent && child && parent!==child && visibleIds.has(parent) && visibleIds.has(child))associations.set(`parent:${parent}:${child}`,edge(parent,child,{kind:'agent-parent',layer:'idle',label:'Observed parent'}));
  }
  const parentLinks=[...associations.values()].filter(e=>e.data.kind==='agent-parent');
  return {nodes,edges:[...lineageForest(nodes,edges),...[...associations.values()].filter(e=>e.data.kind!=='agent-parent'),...lineageForest(nodes,parentLinks)]};
}

/** Preserve the September 15 branch vocabulary: folder chains, through-folder
 * strings, session membership and every received association stay visible.
 * Cycle rejection happens in the structural/parent model, not by hiding branches.
 */
export function displayGraphEdges(graph,selected=null) {
  return graph.edges;
}

// ---------- layout ----------
function directionOf(x,y) {
  if(Math.abs(x)>=Math.abs(y)*1.6)return x<=0?'w':'e';
  return y<0?'n':'s';
}

/** Equal angular spacing: opposed pairs, triangles, diamonds, then a ring. */
export function familyCenters(ids,radius=1100) {
  const sorted=[...ids].sort(),count=sorted.length;
  return new Map(sorted.map((id,i)=>{
    const angle=count===2?Math.PI+i*Math.PI:-Math.PI/2+i*Math.PI*2/Math.max(1,count);
    return [id,{x:count===1?0:Math.cos(angle)*radius,y:count===1?0:Math.sin(angle)*radius}];
  }));
}

/** Deterministic seed positions around observed agent families. Physics uses
 * layoutParent only as a spatial relationship, never an audit/lineage claim.
 * Existing satellite positions survive polls; new nodes occupy free ring slots.
 */
export function layoutStrings(nodes,edges,previous=null) {
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const hubs=nodes.filter(n=>n.type==='agentGroup').map(n=>n.id).sort();
  const structural=new Map(edges.filter(e=>!['observed-action','source-association','agent-parent'].includes(e.data?.kind)).map(e=>[e.target,e.source]));
  const family=new Map(hubs.map(id=>[id,id]));
  const sessionFamilies=new Map(nodes.filter(n=>n.type==='agentGroup').flatMap(n=>(n.data.sessionKeys || []).map(key=>[key,n.id])));
  for(const node of nodes)if(node.data?.groupId)family.set(node.id,node.data.groupId);
  const observed=[...edges].filter(e=>['observed-action','source-association'].includes(e.data?.kind)).sort((a,b)=>lastObservation(a.data?.observation)-lastObservation(b.data?.observation));
  for(const edge of observed)if(family.has(edge.source))family.set(edge.target,family.get(edge.source));
  // A folder is placed near its received files, without inventing an agent link.
  for(const node of nodes.filter(n=>n.type==='folder')) {
    const counts=new Map();
    for(const key of node.data.sessions || [])if(sessionFamilies.has(key)){const id=sessionFamilies.get(key);counts.set(id,(counts.get(id)||0)+1);}
    for(const file of nodes)if(file.type==='file' && within(file.data.path,node.data.path) && family.has(file.id)) {
      const id=family.get(file.id);counts.set(id,(counts.get(id)||0)+1);
    }
    if(counts.size)family.set(node.id,[...counts].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))[0][0]);
  }
  for(let i=0;i<3;i++)for(const node of nodes)if(!family.has(node.id) && family.has(structural.get(node.id)))family.set(node.id,family.get(structural.get(node.id)));
  const biggest=Math.max(1,...hubs.map(id=>[...family.values()].filter(v=>v===id).length));
  const clusterRadius=Math.max(300,Math.sqrt(biggest)*85);
  const radius=hubs.length>1?Math.max(900,(clusterRadius+500)/Math.sin(Math.PI/hubs.length)):0;
  const centers=familyCenters(hubs,radius),prior=previous instanceof Map?previous:new Map(Object.entries(previous||{}));
  const placed=new Map(),rects=[],sizeOf=n=>NODE_SIZE[n.type]||NODE_SIZE.file;
  const free=(cx,cy,size)=>!rects.some(q=>q.l<cx+size.width/2+30 && q.r>cx-size.width/2-30 && q.t<cy+size.height/2+30 && q.b>cy-size.height/2-30);
  const occupy=(node,cx,cy)=>{const size=sizeOf(node);placed.set(node.id,{cx,cy});rects.push({l:cx-size.width/2,r:cx+size.width/2,t:cy-size.height/2,b:cy+size.height/2});};
  for(const id of hubs){const p=centers.get(id);occupy(byId.get(id),p.x,p.y);}
  const satellites=[],visited=new Set(hubs);
  const visit=node=>{if(!node || visited.has(node.id))return;visited.add(node.id);visit(byId.get(structural.get(node.id)));satellites.push(node);};
  nodes.filter(n=>!centers.has(n.id)).sort((a,b)=>lastObservation(a.data)-lastObservation(b.data)||a.id.localeCompare(b.id)).forEach(visit);
  for(const node of satellites) {
    const p=prior.get(node.id),size=sizeOf(node),group=family.get(node.id),oldHub=prior.get(group),hub=centers.get(group);
    if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))continue;
    const dx=oldHub && hub?hub.x-oldHub.x-NODE_SIZE.agentGroup.width/2:0;
    const dy=oldHub && hub?hub.y-oldHub.y-NODE_SIZE.agentGroup.height/2:0;
    const cx=p.x+size.width/2+dx,cy=p.y+size.height/2+dy;
    if(free(cx,cy,size))occupy(node,cx,cy);
  }
  const counts=new Map();
  for(const node of satellites) {
    if(placed.has(node.id))continue;
    const group=family.get(node.id),center=centers.get(group)||{x:0,y:0};
    const size=sizeOf(node),start=counts.get(group)||0;let spot;
    const parentId=structural.get(node.id),from=placed.get(parentId);
    // Preserve the September 15 outward folder fan; only independent branches
    // use family-ring slots. A folder remains the spatial parent of its files.
    if(from && !centers.has(parentId)) {
      const dir=directionOf(from.cx-center.x,from.cy-center.y);
      for(let round=1;!spot && round<=8;round++)for(let k=0;!spot && k<60;k++) {
        const lateral=k%2?-(k+1)/2:k/2;
        const cx=dir==='w'?from.cx-330*round:dir==='e'?from.cx+330*round:from.cx+lateral*240;
        const cy=dir==='n'?from.cy-140*round:dir==='s'?from.cy+140*round:from.cy+lateral*90;
        if(free(cx,cy,size))spot={cx,cy};
      }
    }
    for(let slot=start;!spot && slot<start+5000;slot++) {
      // Rings have more slots as their circumference grows; alternating offsets
      // avoid spokes while keeping enough room for readable text labels.
      const ring=Math.floor(Math.sqrt(slot/6)),first=6*ring*ring,n=6*(2*ring+1);
      const angle=(slot-first)*Math.PI*2/n+ring*.43;
      const reach=230+ring*130,cx=center.x+Math.cos(angle)*reach,cy=center.y+Math.sin(angle)*reach;
      if(free(cx,cy,size)){spot={cx,cy};counts.set(group,slot+1);break;}
    }
    spot ||= {cx:center.x,cy:center.y+rects.length*160+400};
    occupy(node,spot.cx,spot.cy);
  }
  return nodes.map(node=>{const size=sizeOf(node),p=placed.get(node.id),center=centers.get(family.get(node.id))||{x:0,y:0};return {...node,
    position:{x:Math.round(p.cx-size.width/2),y:Math.round(p.cy-size.height/2)},
    layoutParent:node.type==='agentGroup'?null:structural.get(node.id)||family.get(node.id)||null,
    layoutDir:directionOf(p.cx-center.x,p.cy-center.y)};});
}

/**
 * Bezier string between two rectangles, attached to the facing sides, or to the sides the tree
 * grows from (w or e: left and right; n or s: top and bottom). Points along it place labels.
 * @param {{x: number, y: number, width: number, height: number}} a
 * @param {{x: number, y: number, width: number, height: number}} b
 * @param {string|null} [dir]
 */
export function stringPath(a, b, dir = null) {
  const acx = a.x + a.width / 2, acy = a.y + a.height / 2, bcx = b.x + b.width / 2, bcy = b.y + b.height / 2;
  const dx = bcx - acx, dy = bcy - acy;
  const gapX = Math.abs(dx) - (a.width + b.width) / 2, gapY = Math.abs(dy) - (a.height + b.height) / 2;
  let s, t, sd, td;
  const horizontal = dir === 'w' || dir === 'e' ? true : dir === 'n' || dir === 's' ? false : gapX >= gapY;
  if (horizontal) {
    const sign = dir==='w'?-1:dir==='e'?1:dx >= 0 ? 1 : -1;
    s = {x: acx + sign * a.width / 2, y: acy}; t = {x: bcx - sign * b.width / 2, y: bcy};
    sd = {x: sign, y: 0}; td = {x: -sign, y: 0};
  } else {
    const sign = dir==='n'?-1:dir==='s'?1:dy >= 0 ? 1 : -1;
    s = {x: acx, y: acy + sign * a.height / 2}; t = {x: bcx, y: bcy - sign * b.height / 2};
    sd = {x: 0, y: sign}; td = {x: 0, y: -sign};
  }
  const k = Math.max(24, Math.min(150, Math.hypot(t.x - s.x, t.y - s.y) * 0.45));
  const c1 = {x: s.x + sd.x * k, y: s.y + sd.y * k}, c2 = {x: t.x + td.x * k, y: t.y + td.y * k};
  const at = u => {
    const v = 1 - u;
    return {x: v * v * v * s.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * t.x,
      y: v * v * v * s.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * t.y};
  };
  const r = n => Math.round(n * 10) / 10;
  return {d: `M${r(s.x)},${r(s.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(t.x)},${r(t.y)}`,
    source: s, target: t, mid: at(0.5), near: at(0.82), at};
}

/** Keep the original cubic strings; move labels to unobstructed points or omit them. */
export function routedStringPath(a,b,obstacles=[],dir=null,label='') {
  const path=stringPath(a,b,dir);
  const rects=[a,b,...obstacles];
  const clear=(point,text)=>{
    const width=Math.min(32,String(text).length)*5.6+16;
    return rects.every(rect=>point.x+width/2<rect.x-6 || point.x-width/2>rect.x+rect.width+6 || point.y+12<rect.y-6 || point.y-12>rect.y+rect.height+6);
  };
  const labelAt=(text,preferred=.5)=>{
    if(!text)return null;
    const offsets=[0,-.08,.08,-.16,.16,-.24,.24,-.32,.32];
    for(const offset of offsets){const u=preferred+offset;if(u<=.08 || u>=.92)continue;const point=path.at(u);if(clear(point,text))return point;}
    return null;
  };
  return {...path,labelAt:labelAt(label,.5),segmentAt:labelAt(label,.3),orderAt:labelAt('3',.82)};
}

// ---------- API ----------
/**
 * Client for the egress routes. `request` is fetch-compatible, (path, init) => Promise<Response>.
 * The host app supplies it along with any credentials; this module never reads or stores a token.
 * Every POST body is JSON with Content-Type application/json.
 * @param {(path: string, init: any) => Promise<any>} request
 */
export function createEgressApi(request) {
  /** @param {string} method @param {string} path @param {any} [body] @param {any} [signal] */
  async function call(method, path, body = undefined, signal = undefined) {
    /** @type {any} */
    const init = {method, headers: {Accept: 'application/json'}, cache: 'no-store'};
    if (signal) init.signal = signal;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await request(path, init);
    let value = null;
    try { value = await response.json(); } catch { /* empty or non JSON body */ }
    if (!response.ok) throw new Error(value?.error || `Vervain answered ${response.status}`);
    return value;
  }
  return {
    /** @param {{root?: string|null, box?: string|null, window?: number}} [query] @param {any} [signal] */
    live({root = null, box = null, window = 600} = {}, signal = undefined) {
      const query = new URLSearchParams({window: String(window)});
      if (root) query.set('root', root);
      if (box) query.set('box', box);
      return call('GET', `/api/egress/live?${query}`, undefined, signal);
    },
    /** @param {{kind: string, target: string, action: string, scope?: string, note?: string}} rule */
    addRule: ({kind, target, action, scope, note}) => call('POST', '/api/egress/rules', {kind, target, action, ...(scope ? {scope} : {}), ...(note ? {note} : {})}),
    /** @param {string} id */
    removeRule: id => call('POST', `/api/egress/rules/${encodeURIComponent(id)}/remove`, {}),
    /** @param {string} id @param {string} decision @param {boolean} [remember] */
    decideHold: (id, decision, remember = false) => call('POST', `/api/egress/holds/${encodeURIComponent(id)}`, remember ? {decision, remember: true} : {decision}),
    /** @param {string} boxId @param {string} path */
    setAnchor: (boxId, path) => call('POST', '/api/egress/anchors', {box_id: boxId, path}),
    /** @param {string} boxId @param {string} path */
    removeAnchor: (boxId, path) => call('POST', '/api/egress/anchors/remove', {box_id: boxId, path}),
  };
}

// ---------- fixture ----------
/**
 * In-page simulated feed for the harness (?fixture=1). Not real traffic: the UI labels it
 * "Fixture data". It answers the same routes the app API does, so every button works.
 * @param {{still?: boolean, expand?: string|null, hold?: string|null, now?: () => number}} [options]
 */
export function createFixtureFeed({still = false, expand = null, hold: holdKind = null, now = () => Date.now()} = {}) {
  const home = '/Users/pj', root = `${home}/Desktop/vervain`, site = `${home}/Desktop/vervain-site`, box = `${home}/Desktop/vervain-box`;
  const claude = 'c1a2b3c4d5e6f7a8b9c0d1e2', codex = 'f0e1d2c3b4a5968778695a4b';
  const started = now(), iso = ms => new Date(ms).toISOString();
  /** @type {Array<[string, string, number]>} */
  const plan = [
    [`${root}/README.md`, claude, 4200], [`${home}/.claude/CLAUDE.md`, claude, 2600], [`${root}/docs/egress-withhold.md`, claude, 9100],
    [`${site}/package.json`, codex, 1300], [`${root}/src/vervain/egress/schema.py`, claude, 7400], [`${box}/notes.md`, claude, 1840],
    [`${root}/src/vervain/egress/proxy.py`, claude, 18200], [`${site}/src/pages/index.tsx`, codex, 5200], [`${root}/src/vervain/egress/payloads.py`, claude, 11800],
    [`${root}/internal/customers/acme-call.md`, claude, 6400], [`${root}/src/vervain/egress/decide.py`, claude, 8300], [`${site}/src/components/Hero.tsx`, codex, 3900],
    [`${root}/src/vervain/egress/provenance.py`, claude, 9900], [`${home}/.claude/settings.json`, claude, 900], [`${root}/src/vervain/egress/strings.py`, claude, 10400],
    [`${box}/internal/box/MORNING.md`, claude, 5100], [`${root}/src/vervain/developer/activity.py`, codex, 12600], [`${site}/src/styles/site.css`, codex, 2700],
    [`${root}/src/vervain/developer/store.py`, claude, 7700], [`${root}/internal/pricing.md`, claude, 3300], [`${root}/src/vervain/cli.py`, claude, 15400],
    [`${box}/src/assembler.py`, claude, 8800], [`${root}/tests/egress/test_proxy.py`, claude, 6100], [`${site}/content/pricing.md`, codex, 2100],
    [`${root}/tests/egress/test_decide.py`, claude, 4300], [`${home}/.claude/projects/-Users-pj/memory/MEMORY.md`, claude, 3600], [`${root}/ui/audit/src/DataStrings.jsx`, claude, 13900],
    [`${box}/src/gateway.py`, claude, 9200], [`${root}/ui/audit/src/canvas.css`, claude, 5800], [`${root}/pyproject.toml`, claude, 1500],
  ];
  const anchors = [root, site, box];
  const rules = [
    {id: 'rule_fixture_internal', kind: 'prefix', target: `${root}/internal`, action: 'withhold', scope: 'all', note: null, created_by: 'user', created_at: iso(started - 420e3), removed_at: null},
    {id: 'rule_fixture_notes', kind: 'path', target: `${box}/notes.md`, action: 'hold', scope: 'all', note: null, created_by: 'user', created_at: iso(started - 300e3), removed_at: null},
  ];
  const holds = [{id: 'hold_fixture_notes', request_id: 'req_fixture_41', chunk_idx: 3, source_path: `${box}/notes.md`,
    rule_id: holdKind === 'review' ? REVIEW_RULE_ID : 'rule_fixture_notes',
    bytes: 1840, preview: 'Call notes, Sept 12: renewal terms and the contact list.', created_at: iso(started - 4000), deadline_at: iso(started + 26000),
    decision: null, decided_at: null, decided_by: null, runtime: 'claude-code', session_key: claude}];
  let made = 0;
  const clock = () => (still ? started : now());
  function live() {
    const t = clock(), tick = Math.max(0, Math.floor((t - started) / 1000));
    for (const hold of holds) {
      if (!hold.decision && Date.parse(hold.deadline_at) <= t) {
        Object.assign(hold, {decision: hold.rule_id === REVIEW_RULE_ID ? 'release' : 'withhold', decided_at: iso(t), decided_by: 'timeout'});
      }
    }
    const rotation = Math.floor(tick / 8) % 3;
    const editing = [`${root}/src/vervain/egress/strings.py`, `${root}/ui/audit/src/DataStrings.jsx`, `${root}/src/vervain/egress/proxy.py`][rotation];
    const reading = [[`${root}/src/vervain/egress/decide.py`, `${site}/src/components/Hero.tsx`],
      [`${root}/src/vervain/egress/schema.py`, `${site}/src/styles/site.css`],
      [`${root}/docs/egress-withhold.md`, `${site}/src/pages/index.tsx`]][rotation];
    const inContext = new Set([`${root}/README.md`, `${root}/src/vervain/egress/payloads.py`, `${box}/notes.md`, `${home}/.claude/CLAUDE.md`, `${root}/internal/pricing.md`]);
    const index = withholdIndex(rules);
    const files = plan.map(([path, key, bytes], i) => {
      const first = started - (590 - i * 18) * 1000;
      const state = path === editing ? 'editing' : reading.includes(path) ? 'reading' : inContext.has(path) ? 'in_context' : 'idle';
      const last = state === 'editing' || state === 'reading' ? t - 2000 : state === 'in_context' ? t - 40000 : first + 45000;
      const kinds = state === 'editing' ? ['edit', 'in_context', 'read'] : state === 'reading' ? ['read'] : ['in_context'];
      const rule = index.file(path, [key]);
      return {path, order: i + 1, state, kinds, sessions: [key], first_at: iso(first), last_at: iso(Math.max(first, last)),
        sent_bytes: rule ? 0 : bytes, withheld_bytes: rule ? bytes : 0, withheld_by: rule?.id ?? null,
        held: holds.filter(h => !h.decision && h.source_path === path).length, protection: null};
    });
    return {
      now: iso(t), root, anchors: [...anchors],
      sessions: [{key: claude, runtime: 'claude-code', cwd: root, last_at: iso(t - 1000), requests: 42 + Math.floor(tick / 5), live: true},
        {key: codex, runtime: 'codex', cwd: site, last_at: iso(t - 3000), requests: 17 + Math.floor(tick / 9), live: true}],
      files,
      destinations: [{upstream: 'https://api.anthropic.com', requests: 42 + Math.floor(tick / 5), last_at: iso(t - 1000),
        sent_bytes: 1_874_000 + tick * 5200, withheld_bytes: files.reduce((n, f) => n + f.withheld_bytes, 0)}],
      holds: holds.filter(h => !h.decision).map(h => ({...h})),
      rules: rules.filter(r => !r.removed_at).map(r => ({...r})),
    };
  }
  /** @param {string} method @param {string} path @param {any} [body] */
  function answer(method, path, body = {}) {
    if (method === 'GET' && path.startsWith('/api/egress/live')) return live();
    if (method === 'POST' && (path === '/api/egress/anchors' || path === '/api/egress/anchors/remove')) {
      const folder = trimPath(body.path);
      if (!folder.startsWith('/')) throw new Error('path must be an absolute path');
      if (path === '/api/egress/anchors') {
        if (!anchors.includes(folder)) anchors.push(folder);
        return {box_id: body.box_id, path: folder};
      }
      const at = anchors.indexOf(folder);
      if (at > 0) anchors.splice(at, 1);
      return {removed: at > 0 ? folder : null};
    }
    if (method === 'POST' && path === '/api/egress/rules') {
      const rule = {id: `rule_fixture_${++made}`, kind: body.kind, target: body.target, action: body.action, scope: body.scope || 'all',
        note: body.note || null, created_by: 'user', created_at: iso(clock() + made), removed_at: null};
      rules.push(rule);
      return {...rule};
    }
    const removal = /^\/api\/egress\/rules\/([^/]+)\/remove$/.exec(path);
    if (method === 'POST' && removal) {
      const rule = rules.find(r => r.id === decodeURIComponent(removal[1]) && !r.removed_at);
      if (!rule) throw new Error('That rule is no longer active');
      rule.removed_at = iso(clock());
      return {removed: rule.id};
    }
    const decision = /^\/api\/egress\/holds\/([^/]+)$/.exec(path);
    if (method === 'POST' && decision) {
      const hold = holds.find(h => h.id === decodeURIComponent(decision[1]));
      if (!hold || hold.decision) throw new Error('That hold already ended');
      Object.assign(hold, {decision: body.decision, decided_at: iso(clock()), decided_by: 'user'});
      if (body.decision === 'withhold' && body.remember && hold.source_path) {
        rules.push({id: `rule_fixture_${++made}`, kind: 'path', target: hold.source_path, action: 'withhold', scope: 'all', note: 'remembered from a hold',
          created_by: 'user', created_at: iso(clock() + made), removed_at: null});
      }
      return {...hold};
    }
    throw new Error(`Fixture does not answer ${method} ${path}`);
  }
  const reply = (status, value) => ({ok: status < 300, status, json: async () => value});
  /** Fetch-compatible, the same shape a host app supplies. @param {string} path @param {any} [init] */
  async function request(path, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { return reply(400, {error: 'The body must be JSON'}); }
    try { return reply(200, answer(method, path, body)); } catch (error) { return reply(409, {error: error.message}); }
  }
  return {fixture: true, still, expand, boxId: 'fixture', live, request};
}
