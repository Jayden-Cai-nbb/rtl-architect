import type { Model } from './schema';
export type Change = { kind: 'create' | 'delete' | 'rename' | 'update' | 'connect' | 'disconnect'; target: string; before?: unknown; after?: unknown };
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function semanticDiff(before: Model, after: Model): Change[] {
  const result: Change[] = [];
  for (const key of ['schemaVersion', 'design', 'specification', 'provenance', 'localSignals', 'clocks', 'resets'] as const) {
    if (stableStringify(before[key]) !== stableStringify(after[key])) result.push({ kind: 'update', target: key, before: before[key], after: after[key] });
  }
  for (const id of [...new Set([...before.modules, ...after.modules].map(m => m.id))].sort()) {
    const a = before.modules.find(m => m.id === id), b = after.modules.find(m => m.id === id);
    if (!a) result.push({ kind: 'create', target: id, after: b });
    else if (!b) result.push({ kind: 'delete', target: id, before: a });
    else {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof typeof a>) {
        if (stableStringify(a[key]) === stableStringify(b[key])) continue;
        if (key === 'parameters') {
          for (const parameter of [...new Set([...Object.keys(a.parameters), ...Object.keys(b.parameters)])].sort()) if (a.parameters[parameter] !== b.parameters[parameter]) result.push({ kind: 'update', target: `${id}.parameters.${parameter}`, before: a.parameters[parameter], after: b.parameters[parameter] });
        } else result.push({ kind: key === 'name' ? 'rename' : 'update', target: `${id}.${key}`, before: a[key], after: b[key] });
      }
    }
  }
  for (const id of [...new Set([...before.connections, ...after.connections].map(l => l.id))].sort()) {
    const a = before.connections.find(l => l.id === id), b = after.connections.find(l => l.id === id);
    if (stableStringify(a) === stableStringify(b)) continue;
    if (a) result.push({ kind: 'disconnect', target: id, before: a });
    if (b) result.push({ kind: 'connect', target: id, after: b });
  }
  return result;
}
