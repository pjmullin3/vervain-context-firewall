/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
// Deterministic synthetic activity for the harness and tests. A scenario is a list of recorded observations; snapshotAt(T)
// projects it the way /api/activity does (one summary per actor from its latest event at or before T, parent_id from any
// event, first observation, relationships aggregated over everything at or before T). Nothing here is real traffic.
const R = '/Users/pj/Desktop/vervain', SITE = '/Users/pj/Desktop/vervain-site', HOME = '/Users/pj';
const iso = t => new Date(t).toISOString();
const STATE = {session_end: 'ended', subagent_stop: 'ended', turn_complete: 'idle_observed', turn_interrupted: 'interrupted_observed'};
const WRITE = new Set(['write', 'create', 'delete', 'move_from', 'move_to']);
export function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** @returns {{observations:any[], t0:number, span:number, title:string}} */
export function scenario(name = 'lifecycle', t0 = Date.parse('2026-09-16T08:00:00Z'), seed = 7, {count = 24} = {}) {
  const M = 60000, obs = [], rnd = mulberry(seed);
  const ev = (agent, dt, kind, opts = {}) => obs.push({agent, at: t0 + dt, kind, ...opts});
  const file = (agent, dt, path, op = 'write', status = 'completed', opts = {}) => ev(agent, dt, op === 'read' ? 'file_read' : 'file_write', {path, op, status, ...opts});
  if (name === 'lifecycle' || name === 'dense' || name === 'partial') {
    ev('P', 0, 'session_start', {project: R}); ev('P', 0.2 * M, 'user_prompt', {project: R});
    file('P', 0.5 * M, `${R}/README.md`, 'read');
    ev('C1', 1 * M, 'subagent_start', {parent: 'P', project: R});
    file('C1', 1.5 * M, `${R}/src/vervain/egress/proxy.py`, 'read', 'completed', {parent: 'P', bytes: 18200});
    file('C1', 2 * M, `${R}/src/vervain/egress/proxy.py`, 'write', 'completed', {parent: 'P', bytes: 18450});
    file('C1', 2.5 * M, `${R}/tests/egress/test_proxy.py`, 'write', 'completed', {parent: 'P', bytes: 6100});
    ev('C2', 2.2 * M, 'subagent_start', {parent: 'P', project: R});
    file('C2', 2.8 * M, `${R}/docs/egress-withhold.md`, 'write', 'completed', {parent: 'P', bytes: 9100});
    ev('C1', 3 * M, 'subagent_stop', {parent: 'P'});                      // child completes before parent
    file('P', 3.5 * M, `${HOME}/.claude/CLAUDE.md`, 'read', 'completed', {bytes: 2600});
    file('C2', 4 * M, `${R}/docs/egress-withhold.md`, 'write', 'denied', {parent: 'P'});
    ev('C3', 4.2 * M, 'subagent_stop', {parent: 'P'});                    // observed only at completion: no manufactured start
    ev('P', 5 * M, 'turn_complete', {project: R});
    ev('Q', 5.5 * M, 'session_start', {project: SITE, client: 'codex'});
    file('Q', 6 * M, `${SITE}/src/pages/index.tsx`, 'write', 'completed', {bytes: 5200});
    file('Q', 6.3 * M, `${SITE}/package.json`, 'read', 'completed', {bytes: 0});
    ev('P', 7 * M, 'session_end', {project: R});                          // parent completes while C2 remains active
    file('C2', 8 * M, `${R}/docs/egress-withhold.md`, 'read', 'completed', {parent: 'P'});
    ev('C2', 9 * M, 'subagent_stop', {parent: 'P'});                      // all complete
    ev('Q', 9.5 * M, 'session_end', {project: SITE, client: 'codex'});
  }
  if (name === 'dense') {
    const n = count;
    for (let i = 0; i < n; i++) {
      const a = `S${i}`, start = 10 * M + i * 0.7 * M, proj = i % 3 ? R : SITE;
      ev(a, start, 'session_start', {project: proj, client: i % 2 ? 'codex' : 'claude-code'});
      for (let k = 0; k < 2 + Math.floor(rnd() * 4); k++) { const dir = ['src/a', 'src/b', 'docs', 'tests', 'ui/src'][Math.floor(rnd() * 5)]; file(a, start + (k + 1) * 0.3 * M, `${proj}/${dir}/f${Math.floor(rnd() * 40)}.${['py', 'md', 'json', 'tsx'][Math.floor(rnd() * 4)]}`, rnd() < 0.5 ? 'read' : 'write', 'completed', {bytes: Math.floor(rnd() * 200000)}); }
      if (i % 4 === 0) { ev(`${a}c`, start + 0.5 * M, 'subagent_start', {parent: a, project: proj}); file(`${a}c`, start + 0.9 * M, `${proj}/src/c/g${i}.py`, 'write', 'completed', {parent: a, bytes: 3000 + i * 500}); ev(`${a}c`, start + 1.4 * M, 'subagent_stop', {parent: a}); }
      ev(a, start + 2.5 * M, 'session_end', {project: proj, client: i % 2 ? 'codex' : 'claude-code'});
    }
  }
  const span = Math.max(...obs.map(o => o.at)) - t0 + 2 * M;
  return {observations: obs.sort((a, b) => a.at - b.at || (a.agent < b.agent ? -1 : 1)), t0, span, title: name};
}

/** Project a scenario into the /api/activity shape at time T. `drop` (0 to 1) simulates an incomplete poll; `shuffle` an out-of-order feed. */
export function snapshotAt(sc, T, {drop = 0, shuffle = false, seed = 3, limit = 100} = {}) {
  const rnd = mulberry(seed), rows = sc.observations.filter(o => o.at <= T);
  const events = rows.map((o, i) => ({id: `fx:${i}`, agent_id: o.agent, at: iso(o.at), kind: o.kind, status: o.status || (o.kind === 'file_read' || o.kind === 'file_write' ? 'completed' : 'observed'), parent_id: o.parent || null, project: o.project || null, summary: o.kind,
    resources: o.path ? [{path: o.path, operation: o.op, project: o.path.startsWith(R) ? R : o.path.startsWith(SITE) ? SITE : null, version: o.bytes != null ? {state: 'sampled', bytes: o.bytes, sha256: `v${o.at % 9973}`} : {state: 'unavailable'}}] : []}));
  const actors = new Map();
  for (const e of events) {
    const a = actors.get(e.agent_id) || {id: e.agent_id, client: rows.find(o => o.agent === e.agent_id && o.client)?.client || 'claude-code', project: null, parent_id: null, first_observed_at: e.at, process_state: 'unverified'};
    a.last_observed_at = e.at; a.state = STATE[e.kind] || 'observed'; a.parent_id = e.parent_id || a.parent_id; a.project = e.project || e.resources[0]?.project || a.project; a.action = e.summary;
    actors.set(e.agent_id, a);
  }
  const rel = new Map();
  for (const e of events) for (const r of e.resources) { const k = `${e.agent_id}|${r.path}|${r.operation}`; const x = rel.get(k) || {agent_id: e.agent_id, path: r.path, operation: r.operation, status: e.status, project: r.project, first_at: e.at, last_at: e.at, count: 0, parent_id: e.parent_id, basis: 'received_hook_resource'}; x.count++; x.last_at = e.at; x.status = e.status; rel.set(k, x); }
  let out = {schema: 'vervain.activity/1', sessions: [...actors.values()].sort((a, b) => b.last_observed_at.localeCompare(a.last_observed_at)), events: [...events].reverse().slice(0, limit), relationships: [...rel.values()], now: iso(T),
    coverage: {basis: 'synthetic_fixture'}, limits: ['Fixture data. Not real agent traffic.']};
  if (drop) out = {...out, sessions: out.sessions.filter(() => rnd() >= drop), events: out.events.filter(() => rnd() >= drop), relationships: out.relationships.filter(() => rnd() >= drop)};
  if (shuffle) for (const key of ['sessions', 'events', 'relationships']) out[key] = [...out[key]].sort(() => rnd() - 0.5);
  return out;
}
