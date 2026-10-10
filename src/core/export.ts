import { parameterValue, instanceCount } from './parameters';
import { createHash } from 'node:crypto';
import { stableStringify } from './diff';
import { resolveWidth } from './engine';
import type { Issue, Model, ReviewStatus } from './schema';
import { specMarkdown } from './spec';
const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function canonicalModel(model: Model) {
  return { ...model, ...(model.localSignals?{localSignals:byId(model.localSignals)}:{}), ...(model.specification ? { specification: { ...model.specification, requirements: byId(model.specification.requirements).map(r => ({ ...r, moduleIds: [...r.moduleIds].sort() })), decisions: byId(model.specification.decisions).map(d => ({ ...d, moduleIds: [...d.moduleIds].sort() })) } } : {}), modules: byId(model.modules).map(m => ({ ...m, interfaces: byId(m.interfaces) })), connections: byId(model.connections), clocks: byId(model.clocks), resets: byId(model.resets) };
}
export const hashValue = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
export const modelHash = (model: Model) => hashValue(canonicalModel(model));
export function contractData(model: Model) {
  const sorted = canonicalModel(model);
  return { schemaVersion: model.schemaVersion === 3 ? 3 : 2, modelHash: modelHash(model), design: model.design, specification: model.specification ?? null, ...(model.provenance ? { provenance: model.provenance } : {}), ...(sorted.localSignals?{localSignals:sorted.localSignals}:{}), clocks: sorted.clocks, resets: sorted.resets, connections: sorted.connections, modules: sorted.modules.map(m => ({ ...m, ...(m.parameterBindings?{resolvedParameters:Object.fromEntries(Object.keys(m.parameters).map(k=>[k,parameterValue(model,m,k,m.instances?.from)]))}:{}), ...(m.instances?{instanceResolution:Array.from({length:instanceCount(m)},(_,i)=>{const index=m.instances!.from+i;return {index,parameters:Object.fromEntries(Object.keys(m.parameters).map(k=>[k,parameterValue(model,m,k,index)])),widths:Object.fromEntries(m.interfaces.map(p=>[p.id,resolveWidth(m,p,model,index)]))}})}:{}), interfaces: m.interfaces.map(i => ({ ...i, width: m.instances?i.width:resolveWidth(m, i, model) })), adjacentConnections: sorted.connections.filter(l => l.from.moduleId === m.id || l.to.moduleId === m.id) })) };
}
export function specText(model: Model, status: ReviewStatus, issues: Issue[]): string {
  return specMarkdown(model, modelHash(model), status, issues);
}
