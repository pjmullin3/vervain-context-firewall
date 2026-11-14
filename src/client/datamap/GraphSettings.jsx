/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
import React,{useEffect,useState} from 'react';
import {GRAPH_SETTINGS_KEY,graphSettings,LIFESPANS} from './graph-experience.mjs';
const read=()=>{try{return graphSettings(JSON.parse(localStorage.getItem(GRAPH_SETTINGS_KEY) || '{}'));}catch{return graphSettings();}};
export function useGraphSettings(){
  const [prefs,setPrefs]=useState(read);
  useEffect(()=>{const sync=()=>setPrefs(read());window.addEventListener('vervain-graph-settings',sync);window.addEventListener('storage',sync);return()=>{window.removeEventListener('vervain-graph-settings',sync);window.removeEventListener('storage',sync);};},[]);
  function update(patch){const next=graphSettings({...prefs,...patch});setPrefs(next);try{localStorage.setItem(GRAPH_SETTINGS_KEY,JSON.stringify(next));}catch{}window.dispatchEvent(new Event('vervain-graph-settings'));}
  return /** @type {const} */ ([prefs,update]);
}
export function GraphSettings(){
  const [prefs,update]=useGraphSettings();
  return <div className="settings-group graph-settings"><h3>Graph visibility and motion</h3><p>Display preferences for this app. Audit keeps the complete recorded history.</p>
    <div className="settings-row"><div><strong>Node lifespan</strong><small>Show up to 12 hours of activity. Verified running sessions stay visible. Playback uses the same span; older records remain in Audit.</small></div><select aria-label="Node lifespan" value={prefs.lifespan} onChange={e=>update({lifespan:Number(e.target.value)})}>{LIFESPANS.map(n=><option value={n} key={n}>{n<60?`${n} minutes`:`${n/60} hour${n>60?'s':''}`}</option>)}</select></div>
    {[['showEnded','Show recently ended sessions','Ended sessions fade out within the selected lifespan.'],['fade','Fade nodes with age','Older observations become dimmer and greyer.'],['physics','Fluid dragging and throw','Nodes spring back to their original branch after a throw.'],['playback','Graph playback','Replay recorded activity with a time slider.']].map(([key,label,detail])=><div className="settings-row" key={key}><div><strong>{label}</strong><small>{detail}</small></div><input type="checkbox" role="switch" aria-label={label} checked={prefs[key]} onChange={e=>update({[key]:e.target.checked})}/></div>)}
  </div>;
}
