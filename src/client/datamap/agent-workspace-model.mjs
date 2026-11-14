/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
/** Observed activity never establishes a complete process or filesystem inventory. */
export function compareObservedEvents(a,b) {
  return (Date.parse(a.at) || 0)-(Date.parse(b.at) || 0)
    || String(a.box_id || '').localeCompare(String(b.box_id || ''))
    || (Number(a.journal_seq) || 0)-(Number(b.journal_seq) || 0)
    || String(a.id || '').localeCompare(String(b.id || ''));
}

const INTERMEDIATE_ACTION_STATUSES = new Set(['attempted','awaiting_permission','checked']);
const sameRecordedSession = (a,b) => a?.box_id===b?.box_id && a?.session_id===b?.session_id && a?.agent_id===b?.agent_id;

/**
 * Present actions by their final recorded outcome. Raw pre-tool attempts stay
 * in the journal, but they are not a user-facing result. Older guard records
 * did not copy the denied path onto the policy row, so bind only the immediately
 * adjacent same-tool attempt from the same journal session.
 */
export function resolvedActivityEvents(events = []) {
  const ordered=[...events].sort(compareObservedEvents);
  const records=new Map(ordered.map(event=>[`${event?.box_id || ''}:${event?.session_id || ''}:${Number(event?.journal_seq)}`,event]));
  const resolved=ordered.map(event=>{
    if(event?.kind!=='policy_decision' || event?.evidence?.decision!=='deny')return event;
    let source=event;
    if(!(event.resources || []).length){
      const next=records.get(`${event?.box_id || ''}:${event?.session_id || ''}:${Number(event?.journal_seq)+1}`);
      const adjacent=next && sameRecordedSession(event,next)
        && next.kind==='tool_attempt' && next.tool===event.tool
        && Number(next.journal_seq)===Number(event.journal_seq)+1;
      if(adjacent)source={...event,resources:next.resources || [],tool_call_id:next.tool_call_id || null,
        evidence:{...event.evidence,outcome_binding:'adjacent_same_session_tool'}};
    }
    return {...source,status:'blocked',summary:`${source.tool || 'Action'}: blocked`};
  });
  return resolved.filter(event=>event?.kind!=='tool_attempt'
    && !(event?.kind==='policy_decision' && event?.evidence?.decision==='allow'));
}

export function resolvedActivitySnapshot(snapshot = {}) {
  return {...snapshot,
    events:resolvedActivityEvents(snapshot.events || []),
    relationships:(snapshot.relationships || []).filter(row=>!INTERMEDIATE_ACTION_STATUSES.has(row?.status)),
  };
}
export function mergeActivity(previous, incoming, older = false) {
  const clearLabel = row => Object.fromEntries(Object.entries(row).filter(([key])=>key!=='task_label' && !key.startsWith('label_')));
  const previousRows = rows => older ? rows : rows.map(clearLabel);
  const merge = (a, b) => [...new Map([...a, ...b].map(row => [row.id, row])).values()];
  const overlap=previous?.events?.some(old=>incoming.events?.some(row=>row.id===old.id));
  const gap=Boolean(previous?.events?.length && incoming.events?.length && !overlap && incoming.next_cursor);
  return {...incoming, sessions: merge(previousRows(previous?.sessions || []), incoming.sessions || []),
    events: merge(previousRows(previous?.events || []), incoming.events || []).sort((a,b)=>compareObservedEvents(b,a)),
    next_cursor: older || !previous || gap ? incoming.next_cursor : previous.next_cursor};
}
export function agentControls(session) {
  return {interrupt: session?.controls?.interrupt === true,
    block: session?.controls?.block_next === true || session?.controls?.block_supported === true,
    blocked: session?.controls?.blocked === true};
}
export function agentState(session, now = Date.now()) {
  if (session?.controls?.blocked) return 'Next actions blocked';
  if (['ended','completed','stopped','interrupted','failed'].includes(session?.state)) return session.state;
  const age=now-Date.parse(session?.last_observed_at);
  if (!Number.isFinite(age)) return 'Freshness unknown';
  if (age > 60000) return 'No recent observation';
  return session?.state === 'active' || session?.state === 'running' ? 'Recently active' : (session?.state || 'Observed');
}
export function clientLabel(client) {return client==='claude-code'?'Claude Code':client==='codex'?'Codex':client || 'Unknown client';}
export function fileLabel(path) {return String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || 'Unknown file';}
export function fileIcon(path) {
  const name=fileLabel(path), extension=name.split('.').at(-1)?.toLowerCase();
  if (['md','txt','rst'].includes(extension)) return '¶';
  if (['json','toml','yaml','yml','ini','env'].includes(extension) || name.startsWith('.env')) return '{}';
  if (['png','jpg','jpeg','svg','webp'].includes(extension)) return '▧';
  if (['py','js','jsx','ts','tsx','rs','go','sh','css','html'].includes(extension)) return '</>';
  return '▤';
}
export function activityGraph(sessions,events,slots = new Map()) {
  const files=new Map(), edges=new Map();
  for (const event of events) for (const resource of event.resources || []) {
    if (!resource.path) continue;
    if (!files.has(resource.path)) files.set(resource.path,{id:resource.path,...resource,event});
    const key=`${event.agent_id}:${resource.path}`;
    if (!edges.has(key)) edges.set(key,{id:key,agent_id:event.agent_id,path:resource.path,event});
  }
  const position=(id,column)=>{if(!slots.has(id))slots.set(id,{x:column==='agent'?44:454,y:55+[...slots.keys()].filter(k=>k.startsWith(`${column}:`)).length*128});return slots.get(id);};
  return {agents:sessions.map(s=>({...s,...position(`agent:${s.id}`,'agent')})),files:[...files.values()].map(f=>({...f,...position(`file:${f.path}`,'file')})),edges:[...edges.values()]};
}
export function eventLabel(event) {
  if (event?.summary) return event.summary;
  if ((event?.tool==='Bash' || event?.tool==='shell' || event?.tool==='exec_command') && !event?.resources?.length) return 'Command observed; file effects unknown';
  return String(event?.kind || 'Observed event').replaceAll('_',' ');
}
export function controlMessage(result,action) {
  const status=result?.status || result?.state || 'unknown';
  if (result?.message) return `${result.message} (${status})`;
  if (action==='block' && ['blocked','ok','applied','confirmed','next_actions_blocked'].includes(status)) return 'Next covered actions blocked. Current work may still be running.';
  if (action==='resume' && ['resumed','ok','applied','confirmed'].includes(status)) return 'Vervain session block removed. Native permissions still apply.';
  if (action==='interrupt' && ['interrupted','confirmed_interrupted'].includes(status)) return 'Interruption confirmed for the selected session. Completed effects remain.';
  if (action==='interrupt' && ['requested','acknowledged','signal_sent','interrupt_requested'].includes(status)) return 'Interrupt requested. Completion is not yet confirmed.';
  return `${action}: ${status}. ${result?.reason || 'Inspect the recorded result.'}`;
}

export function sessionLabel(session) {return session?.name || session?.task_label || `${clientLabel(session?.client || session?.runtime)} · ${String(session?.session_id || session?.id || session?.key || 'unidentified').slice(0,12)}`;}
