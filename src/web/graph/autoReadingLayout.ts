import type { Model } from '../../core/schema';
import { scopeDiagram, type Positions } from './scopeDiagram';
import { elkLayout } from './elkLayout';
import { wireSpacing } from './ports';

/** Display hints from declared kinds and actual connections, never from RTL/name patterns.
 * All edges remain in scopeDiagram; this projection only chooses block positions.
 */
export async function autoReadingLayout(model: Model, scope: string): Promise<Positions> {
  const initial = Object.fromEntries(model.modules.filter(m => m.parent === scope).sort((a,b) => a.id.localeCompare(b.id)).map((m,i) => [m.id,{x:i*420,y:120}]));
  const measure = (positions: Positions = initial) => scopeDiagram(model, scope, { positions, measureOnly: true });
  let graph = measure();
  let nodes = graph.nodes.filter(n => !n.data.boundary && !n.data.localId).sort((a,b) => a.id.localeCompare(b.id));
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
  const control = new Set(nodes.filter(n => n.data.kind === 'controller' && !rvNodes.has(n.id) && !incident(n.id).some(e => ['data','writeback'].includes(String(e.data?.category)))).map(n => n.id));
  if (control.size === nodes.length) control.clear();
  const adjacent = new Map<string,string>();
  for (const n of nodes.filter(n => n.data.kind === 'memory')) {
    const peers = new Set(incident(n.id).filter(e => !control.has(peer(e,n.id))).map(e => peer(e,n.id)));
    const anchor = [...peers][0];
    // Boundary-connected/shared/in-line memories stay in the main topology.
    if (peers.size === 1 && ids.has(anchor) && nodes.find(n => n.id === anchor)?.data.kind !== 'memory') adjacent.set(n.id, anchor);
  }
  const body = nodes.filter(n => !control.has(n.id) && !adjacent.has(n.id));
  const bodyIds = new Set(body.map(n => n.id));
  const bodyEdges = edges.filter(e => bodyIds.has(e.source) && bodyIds.has(e.target));
  const forwardPairs = new Set(bodyEdges.filter(e => ['data','request'].includes(String(e.data?.category))).map(e => `${e.source}>${e.target}`));
  const orderingEdges = bodyEdges.filter(e => !(['response','writeback'].includes(String(e.data?.category)) && forwardPairs.has(`${e.target}>${e.source}`)));
  const pairCount = new Map<string,number>();
  for (const e of orderingEdges) {const pair=`${e.source}>${e.target}`;pairCount.set(pair,(pairCount.get(pair)??0)+1);}
  const alignLayers = orderingEdges.every(e => e.data?.category==='data' || (e.data?.category==='other' && pairCount.get(`${e.source}>${e.target}`)===1));
  const busiest = Math.max(1,...nodes.map(n => incident(n.id).length));
  const spacing = { nodes: Math.max(100, Math.min(384, busiest * 16)), layers: Math.max(220, Math.min(640, busiest * wireSpacing)) };
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
    const minX = Math.min(0,...Object.values(positions).map(p => p.x));
    const bodyY = control.size ? Math.max(...[...control].map(id => size(id).height)) + controlGap : 100;
    // Preserve ELK's branch order and layers, then align their centers. Fixed pins from
    // control/memory edges must not turn a simple data path into a staircase.
    if (alignLayers) {
      const columns = new Map<number,string[]>();
      for (const id of bodyIds) { const x=positions[id].x; columns.set(x,[...columns.get(x)??[],id]); }
      const columnHeight = (column:string[]) => column.reduce((h,id)=>h+size(id).height,0)+Math.max(0,column.length-1)*spacing.nodes;
      const rowHeight = Math.max(0,...[...columns.values()].map(columnHeight));
      for (const column of columns.values()) {
        column.sort((a,b)=>positions[a].y-positions[b].y||a.localeCompare(b));
        let y=bodyY+(rowHeight-columnHeight(column))/2;
        for (const id of column) { positions[id]={x:positions[id].x-minX,y};y+=size(id).height+spacing.nodes; }
      }
    } else {
      const minY = Math.min(0,...Object.values(positions).map(p=>p.y));
      for (const p of Object.values(positions)) {p.x-=minX;p.y+=bodyY-minY;}
    }
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
  return positions;
}
