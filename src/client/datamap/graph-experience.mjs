/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
import {compareObservedEvents} from './agent-workspace-model.mjs';
export const GRAPH_SETTINGS_KEY = 'vervain.graph.visibility.v2';
/** @type {{lifespan:number,showEnded:boolean,fade:boolean,physics:boolean,playback:boolean}} */
export const GRAPH_DEFAULTS = Object.freeze({lifespan:15, showEnded:false, fade:true, physics:true, playback:true});
export const LIFESPANS = [15,30,60,120,240,480,720];
export function graphSettings(value={}) {
  const flag=k=>typeof value?.[k]==='boolean'?value[k]:GRAPH_DEFAULTS[k];
  return {lifespan:LIFESPANS.includes(Number(value?.lifespan))?Number(value.lifespan):GRAPH_DEFAULTS.lifespan,
    showEnded:flag('showEnded'),fade:flag('fade'),physics:flag('physics'),playback:flag('playback')};
}
export const timestamp = value => typeof value==='number' ? (value<1e12?value*1000:value) : Date.parse(value || '') || 0;
/** Search only nodes currently drawn on the Graph. Hidden or unobserved files are never invented as results. */
export function findVisibleGraphNodes(nodes, query, limit=8) {
  const needle=String(query || '').trim().toLowerCase();
  if(!needle)return [];
  return nodes.filter(node=>node.type!=='box' && node.type!=='more' &&
    [node.id,node.type,node.data?.label,node.data?.path,node.data?.title,node.data?.host,node.data?.upstream,
      node.data?.agentId,node.data?.session?.client,node.data?.session?.model].filter(Boolean).join(' ').toLowerCase().includes(needle)).slice(0,limit);
}
export const lastObservation = value => timestamp(value?.last_observed_at || value?.last_at || value?.at || value?.started_at);
export const ended = value => ['ended','completed','stopped','interrupted','interrupted_observed','failed'].includes(value?.state);
export function visibleAt(value,now,prefs=GRAPH_DEFAULTS) {
  const at=lastObservation(value);
  // A session label is not process liveness. Only an explicitly verified running process survives the window.
  const current=(value?.process_state==='running' || value?.controls?.process?.running===true) && !ended(value);
  return (prefs.showEnded || !ended(value)) && (current || (at>0 && at<=now && now-at<prefs.lifespan*60000));
}
export function ageStyle(at,now,prefs=GRAPH_DEFAULTS) {
  if(!prefs.fade)return {opacity:1,filter:'none'};
  const age=Math.max(0,Math.min(1,(now-timestamp(at))/(prefs.lifespan*60000)));
  return {opacity:Math.max(.18,1-age*.82),filter:`grayscale(${age})`};
}

/** Reconstruct only observations available at the cursor, never today's state or future file versions. */
export function replayActivity(sessions,events,at) {
  const metadata=new Map(sessions.map(s=>[s.id || s.key,s])),actors=new Map();
  const before=events.filter(e=>timestamp(e.at)<=at).sort(compareObservedEvents);
  for(const event of before) {
    if(!event.agent_id)continue;
    const source=metadata.get(event.agent_id) || {},previous=actors.get(event.agent_id);
    const state=({session_end:'ended',subagent_stop:'ended',turn_complete:'idle_observed',turn_interrupted:'interrupted_observed'})[event.kind] || 'observed';
    actors.set(event.agent_id,{id:event.agent_id,key:event.agent_id,client:source.client || source.runtime,
      project:event.project || event.resources?.find(r=>r.project)?.project || previous?.project,
      session_id:source.session_id,parent_id:event.parent_id || previous?.parent_id,
      last_observed_at:event.at,state,process_state:'unverified',action:event.summary});
  }
  return {sessions:[...actors.values()],events:before};
}

/** One incoming visible lineage edge; all underlying observations remain in Audit. */
export function lineageForest(nodes,edges) {
  const ids=new Set(nodes.map(n=>n.id)),parents=new Map();
  const priority={'agent-parent':0,'observed-action':1,child:3,through:4,parent:5,outside:5,destination:5,agent:6,'source-association':7,more:8};
  const candidates=[...edges].sort((a,b)=>(priority[a.data?.kind]??9)-(priority[b.data?.kind]??9) || timestamp(b.data?.observation?.at)-timestamp(a.data?.observation?.at));
  const result=[];
  for(const edge of candidates) {
    if(!ids.has(edge.source)||!ids.has(edge.target)||parents.has(edge.target)||edge.source===edge.target)continue;
    let cursor=edge.source;const seen=new Set([edge.target]);
    while(cursor && !seen.has(cursor)){seen.add(cursor);cursor=parents.get(cursor);}
    if(cursor)continue;
    parents.set(edge.target,edge.source);result.push(edge);
  }
  return result;
}

/** Keep a drag's resting position; children continue to follow a moved family hub. */
export function releasePhysicsBody(bodies,id,position) {
  const b=bodies.get(id);if(!b)return;
  const parent=bodies.get(b.parent);
  b.x=position.x;b.y=position.y;b.dragging=false;
  b.offsetX=b.x-b.homeX-(parent?parent.x-parent.homeX:0);
  b.offsetY=b.y-b.homeY-(parent?parent.y-parent.homeY:0);
  b.vx=Math.max(-450,Math.min(450,b.vx));b.vy=Math.max(-450,Math.min(450,b.vy));
  b.placed=true;
}

/** Damped springs and soft card collisions. Coordinates and velocity use pixels and seconds. */
export function stepPhysics(bodies,seconds) {
  const dt=Math.min(1/30,Math.max(0,seconds)),rows=[...bodies.values()];let moving=false;
  const forces=new Map();
  for(const b of rows) {
    const p=bodies.get(b.parent);
    const tx=b.homeX+(b.offsetX||0)+(p?p.x-p.homeX:0),ty=b.homeY+(b.offsetY||0)+(p?p.y-p.homeY:0);
    const spring=b.hub?4:7;
    forces.set(b.id,{x:(tx-b.x)*spring,y:(ty-b.y)*spring});
  }
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++) {
    const a=rows[i],b=rows[j],dx=a.x+a.width/2-b.x-b.width/2,dy=a.y+a.height/2-b.y-b.height/2;
    const ox=(a.width+b.width)/2+18-Math.abs(dx),oy=(a.height+b.height)/2+18-Math.abs(dy);
    if(ox<=0||oy<=0)continue;
    const axis=ox<oy?'x':'y',push=(ox<oy?ox:oy)*70*Math.sign((ox<oy?dx:dy)||1);
    forces.get(a.id)[axis]+=push;forces.get(b.id)[axis]-=push;
  }
  for(const b of rows) {
    if(b.fixed||b.dragging)continue;
    const f=forces.get(b.id),damping=Math.exp(-5.5*dt);
    b.vx=(b.vx+f.x*dt)*damping;b.vy=(b.vy+f.y*dt)*damping;
    if(Math.abs(b.vx)+Math.abs(b.vy)>.12 || Math.abs(f.x)+Math.abs(f.y)>.2){b.x+=b.vx*dt;b.y+=b.vy*dt;moving=true;}
    else {b.vx=0;b.vy=0;}
  }
  return moving;
}
