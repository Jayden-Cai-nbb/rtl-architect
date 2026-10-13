import type ELK from 'elkjs/lib/elk-api.js';
import type { Edge } from '@xyflow/react';
import type { RtlNode } from './types';
let engine:Promise<InstanceType<typeof ELK>>|undefined;
function layoutEngine(){
 if(!engine)engine=(async()=>{
  // The bundled fake worker detects `self` and installs its own onmessage inside a
  // real Worker. Use ELK's documented worker factory here, keeping our task channel intact.
  if(typeof self!=='undefined'&&typeof document==='undefined'){
   const {default:Elk}=await import('elkjs/lib/elk-api.js');
   return new Elk({workerFactory:()=>new Worker(new URL('../../../node_modules/elkjs/lib/elk-worker.min.js',import.meta.url))});
  }
  const {default:Elk}=await import('elkjs/lib/elk.bundled.js');return new Elk();
 })();
 return engine;
}
export function elkGraph(nodes: RtlNode[], edges: Edge[], spacing = { nodes: 45, layers: 145 }) {
  return { id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': String(spacing.nodes), 'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing.layers) }, children: [...nodes].sort((a,b)=>a.id.localeCompare(b.id)).map(n => ({ id: n.id, width: n.data.geometry.width, height: n.data.geometry.height, layoutOptions: { 'org.eclipse.elk.portConstraints': 'FIXED_POS' }, ports: n.data.geometry.ports.map(p => ({ id: `${n.id}/${p.id}`, x: p.x, y: p.y, width: 0, height: 0, layoutOptions: { 'org.eclipse.elk.port.side': p.side } })) })), edges: [...edges].sort((a,b)=>a.id.localeCompare(b.id)).map(e => ({ id: e.id, sources: [`${e.source}/${e.sourceHandle}`], targets: [`${e.target}/${e.targetHandle}`] })) };
}
export async function elkLayout(nodes: RtlNode[], edges: Edge[], spacing?: { nodes: number; layers: number }) {
  const result = await (await layoutEngine()).layout(elkGraph(nodes, edges, spacing));
  return Object.fromEntries((result.children ?? []).map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}
export type LayoutTicket = { scope: string; modelHash: string; version: number };
export const ticketMatches = (a: LayoutTicket, b: LayoutTicket) => a.scope === b.scope && a.modelHash === b.modelHash && a.version === b.version;
