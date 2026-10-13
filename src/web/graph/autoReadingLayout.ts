import {refineSpacing} from './layoutFeedback';
import {orderingRelations,alignColumns} from './topology';
import type { Model } from '../../core/schema';
import { scopeDiagram, type Positions, type DiagramOptions } from './scopeDiagram';
import { elkLayout } from './elkLayout';
import { wireSpacing } from './ports';

/** Display hints from declared kinds and actual connections, never from RTL/name patterns.
 * All edges remain in scopeDiagram; this projection only chooses block positions.
 */
export async function autoReadingLayout(model: Model, scope: string,options:DiagramOptions={}): Promise<Positions> {
  const initial = Object.fromEntries(model.modules.filter(m => m.parent === scope).sort((a,b) => a.id.localeCompare(b.id)).map((m,i) => [m.id,{x:i*420,y:120}]));
  const measure = (positions: Positions = initial) => scopeDiagram(model, scope, {...options, positions, measureOnly: true });
  let graph = measure();
  let nodes = graph.nodes.filter(n => !n.data.boundary).sort((a,b) => a.id.localeCompare(b.id));
  if (!nodes.length) return {};
  const ids = new Set(nodes.map(n => n.id));
  const edges = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target));
  const incident = (id: string) => graph.edges.filter(e => e.source === id || e.target === id);
  const peer = (e: typeof edges[number], id: string) => e.source === id ? e.target : e.source;
  const rvNodes = new Set(model.connections.filter(l => l.scope === scope).flatMap(l => {
    const rv = [l.from, l.to].some(e => model.modules.find(m => m.id === e.moduleId)?.interfaces.some(p => p.id === e.interfaceId && p.protocol === 'rv'));
    return rv ? [l.from.moduleId, l.to.moduleId] : [];
  }));
  // A controller carrying declared data stays in the topology instead of being lifted out.
  const control = new Set(nodes.filter(n => n.data.kind === 'controller' && !rvNodes.has(n.id) && incident(n.id).length>0 && incident(n.id).every(e=>['control','request','response','configuration','clock_reset'].includes(String(e.data?.category)))).map(n => n.id));
  if (control.size === nodes.length) control.clear();
  const adjacent = new Map<string,string>();
  for (const n of nodes.filter(n => n.data.kind === 'memory')) {
    const peers = new Set(incident(n.id).filter(e => !control.has(peer(e,n.id))).map(e => peer(e,n.id)));
    const anchor = [...peers][0];
    // Boundary-connected/shared/in-line memories stay in the main topology.
    if (!rvNodes.has(n.id)&&!incident(n.id).some(e=>e.data?.category==='data'||e.data?.category==='writeback')&&peers.size === 1 && ids.has(anchor) && nodes.find(n => n.id === anchor)?.data.kind !== 'memory') adjacent.set(n.id, anchor);
  }
  const body = nodes.filter(n => !control.has(n.id) && !adjacent.has(n.id));
  const bodyIds = new Set(body.map(n => n.id));
  const bodyEdges = edges.filter(e => bodyIds.has(e.source) && bodyIds.has(e.target));
  const orderingEdges = orderingRelations(body,bodyEdges);
  const busiest = Math.max(1,...nodes.map(n => new Set(incident(n.id).map(e=>peer(e,n.id))).size));
  const labelRoom=Math.min(360,Math.max(0,...edges.map(e=>[...String(e.label??'')].reduce((w,c)=>w+(c.charCodeAt(0)>255?16:8.5),12)))+96);
  const spacing = { nodes: Math.max(80, Math.min(220, busiest * 24)), layers: Math.max(180, labelRoom, Math.min(380, busiest * wireSpacing)) };
  const controlNets = new Set(edges.filter(e => control.has(e.source) || control.has(e.target)).map(e => e.data?.netKey ?? e.id));
  const controlGap = Math.max(180, controlNets.size * wireSpacing);
  const sizes = new Map(nodes.map(n => [n.id, {width:n.data.geometry.width,height:n.data.geometry.height}]));
  let positions: Positions = {};
  // Reserve the largest measured box across passes: moving ports to another side must not
  // make neighboring blocks overlap. The final pass uses that reservation unchanged.
  for (let pass = 0; pass < 3; pass++) {
    const sized = nodes.map(n => ({...n,data:{...n.data,geometry:{...n.data.geometry,...sizes.get(n.id)!}}}));
    const size = (id: string) => sizes.get(id)!;
    positions = await elkLayout(sized.filter(n => bodyIds.has(n.id)), orderingEdges, spacing);
    const bodyY = control.size ? Math.max(...[...control].map(id => size(id).height)) + controlGap : 100;
    // Preserve ELK's branch order and layers, then align their centers. Fixed pins from
    // control/memory edges must not turn a simple data path into a staircase.
    alignColumns(sized.filter(n=>bodyIds.has(n.id)),positions,spacing.nodes,bodyY);
    const center = (id: string) => {
      const peers = [...new Set(incident(id).map(e => peer(e,id)))].filter(p => positions[p]);
      return peers.length ? peers.reduce((sum,p) => sum + positions[p].x + size(p).width/2,0)/peers.length : 0;
    };
    const controllers = [...control].map(id => ({id,x:Math.max(0,center(id)-size(id).width/2)})).sort((a,b) => a.x-b.x || a.id.localeCompare(b.id));
    let right = -spacing.nodes;
    for (const c of controllers) { const x = Math.max(c.x,right+spacing.nodes); positions[c.id]={x,y:0}; right=x+size(c.id).width; }
    const bottom = Math.max(bodyY,...[...bodyIds].map(id => positions[id].y+size(id).height));
    const placed: string[] = [];
    for (const [id,anchor] of adjacent) {
      const x = positions[anchor].x; let y = bottom + spacing.nodes + 80;
      for (const prev of placed) if (x < positions[prev].x + size(prev).width + spacing.nodes && x + size(id).width + spacing.nodes > positions[prev].x) y = Math.max(y,positions[prev].y+size(prev).height+spacing.nodes);
      positions[id]={x,y}; placed.push(id);
    }
    if (pass === 2) break;
    graph = measure(positions);
    nodes = graph.nodes.filter(n => ids.has(n.id)).sort((a,b) => a.id.localeCompare(b.id));
    let grew = false;
    for (const n of nodes) { const old = size(n.id), g = n.data.geometry; if (g.width>old.width || g.height>old.height) grew=true; sizes.set(n.id,{width:Math.max(old.width,g.width),height:Math.max(old.height,g.height)}); }
    if (!grew) break;
  }
  return refineSpacing(model,scope,positions,options).positions;
}
