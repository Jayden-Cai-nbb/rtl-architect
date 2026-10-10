import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge } from '@xyflow/react';
import type { RtlNode } from './types';
const elk = new ELK();
export function elkGraph(nodes: RtlNode[], edges: Edge[]) {
  return { id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '45', 'elk.layered.spacing.nodeNodeBetweenLayers': '145' }, children: [...nodes].sort((a,b)=>a.id.localeCompare(b.id)).map(n => ({ id: n.id, width: n.data.geometry.width, height: n.data.geometry.height, layoutOptions: { 'org.eclipse.elk.portConstraints': 'FIXED_POS' }, ports: n.data.geometry.ports.map(p => ({ id: `${n.id}/${p.id}`, x: p.x, y: p.y, width: 0, height: 0, layoutOptions: { 'org.eclipse.elk.port.side': p.side } })) })), edges: [...edges].sort((a,b)=>a.id.localeCompare(b.id)).map(e => ({ id: e.id, sources: [`${e.source}/${e.sourceHandle}`], targets: [`${e.target}/${e.targetHandle}`] })) };
}
export async function elkLayout(nodes: RtlNode[], edges: Edge[]) {
  const result = await elk.layout(elkGraph(nodes, edges));
  return Object.fromEntries((result.children ?? []).map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}
export type LayoutTicket = { scope: string; modelHash: string; version: number };
export const ticketMatches = (a: LayoutTicket, b: LayoutTicket) => a.scope === b.scope && a.modelHash === b.modelHash && a.version === b.version;
