import type { Edge } from '@xyflow/react';
import type { ScopeLayout } from '../../core/schema';

export type Reading = NonNullable<ScopeLayout['reading']>;
export type ConstraintStatus = 'applied' | 'internal_to_group' | 'not_applicable' | 'unsupported';
type Kind = 'mainPath' | 'control' | 'adjacent' | 'stages' | 'parallel' | 'shared' | 'feedback';
export type ReadingConstraint = {
  kind: Kind;
  index: number;
  original: string[];
  projected: string[];
  status: ConstraintStatus;
  reason?: string;
  edges?: string[];
  side?: 'top' | 'bottom';
};

/** One record per original declaration. A mainPath is one ordered constraint. */
export function readingConstraints(reading?: Reading): ReadingConstraint[] {
  if (!reading) return [];
  const entry = (kind: Kind, index: number, original: string[]): ReadingConstraint => ({
    kind, index, original, projected: [...original], status: 'applied',
  });
  return [
    entry('mainPath', 0, reading.mainPath),
    ...reading.control.map((id, i) => entry('control', i, [id])),
    ...reading.adjacent.map(({ node, anchor }, i) => entry('adjacent', i, [node, anchor])),
    ...(reading.stages ?? []).map(({ nodes }, i) => entry('stages', i, nodes)),
    ...(reading.parallel ?? []).map(({ nodes }, i) => entry('parallel', i, nodes)),
    ...(reading.shared ?? []).map(({ node, clients }, i) => entry('shared', i, [node, ...clients])),
    ...(reading.feedback ?? []).map(({ from, to, side }, i) => ({ ...entry('feedback', i, [from, to]), side })),
  ];
}

const unique = (ids: string[]) => [...new Set(ids)];
const reject = (row: ReadingConstraint, reason: string) => { row.status = 'unsupported'; row.reason = reason; };

/** Work on display IDs only. Derived constraints never enter the saved layout schema. */
export function projectReadingConstraints(
  reading: Reading, nodeFor: Record<string, string>, focus: ReadonlySet<string> | undefined,
  edges: Edge[],
) {
  const constraints = readingConstraints(reading);
  const plan: Reading = {
    modelHash: reading.modelHash, reason: reading.reason, mainPath: [], control: [], adjacent: [],
    stages: [], parallel: [], shared: [], feedback: [],
  };
  for (const row of constraints) {
    row.projected = row.original.map(id => nodeFor[id]);
    if (row.kind !== 'stages' && new Set(row.original).size > 1 && unique(row.projected).length === 1) {
      row.status = 'internal_to_group';
      row.reason = '涉及的成员已归入同一个阅读集合。';
    } else if (focus && !row.original.some(id => focus.has(id))) {
      row.status = 'not_applicable';
      row.reason = '原约束只涉及当前状态局部范围之外的对象。';
    }
  }
  const active = (kind: Kind) => constraints.filter(c => c.kind === kind && c.status === 'applied');
  for (const row of active('mainPath')) {
    const path = row.projected.filter((id, i, ids) => i === 0 || id !== ids[i - 1]);
    if (unique(path).length !== path.length) reject(row, '主线反复经过同一个投影节点，无法保留原顺序。');
    else plan.mainPath = path;
  }
  const main = new Set(plan.mainPath);
  for (const row of active('control')) {
    const [id] = row.projected;
    if (main.has(id)) reject(row, '投影节点同时包含主线和控制对象。');
    else if (!plan.control.includes(id)) plan.control.push(id);
  }
  const controls = new Set(plan.control);
  const adjacent = active('adjacent');
  for (const row of adjacent) {
    const [node, anchor] = row.projected;
    if (!main.has(anchor) || main.has(node) || controls.has(node)) {
      reject(row, '邻接锚点不在投影主线上，或邻接对象与主线、控制位置冲突。');
    } else if (adjacent.some(other => other.projected[0] === node && other.projected[1] !== anchor)) {
      reject(row, '同一投影节点被指定到不同邻接锚点。');
    } else if (!plan.adjacent.some(p => p.node === node)) {
      plan.adjacent.push({ node, anchor });
    }
  }
  const peripheral = new Set([...controls, ...plan.adjacent.map(a => a.node)]);
  const stages = active('stages');
  for (const row of stages) {
    const nodes = unique(row.projected);
    if (stages.some(other => other !== row && other.projected.some(id => nodes.includes(id)))) {
      reject(row, '同一投影节点横跨多个原分区，无法保留分区顺序。');
    } else {
      plan.stages!.push({ ...reading.stages![row.index], nodes });
    }
  }
  const stageOf = new Map(plan.stages!.flatMap(stage => stage.nodes.map(id => [id, stage.id] as const)));
  const parallel = active('parallel');
  for (const row of parallel) {
    const nodes = unique(row.projected);
    if (nodes.filter(id => main.has(id)).length > 1 || nodes.some(id => peripheral.has(id)) ||
        new Set(nodes.map(id => stageOf.get(id))).size > 1 ||
        parallel.some(other => other !== row && other.projected.some(id => nodes.includes(id)))) {
      reject(row, '投影并排位置与主线、分区、其他并排或外围位置约束冲突。');
    } else {
      plan.parallel!.push({ ...reading.parallel![row.index], nodes });
    }
  }
  const parallelNodes = new Set(plan.parallel!.flatMap(p => p.nodes));
  const shared = active('shared');
  const resources = new Set(shared.map(s => s.projected[0]));
  // Track original directed pairs through bundles so a different member cannot stand in for a folded relation.
  const pairKey = (from: string, to: string) => JSON.stringify([from, to]);
  const visiblePairs = new Map<string, Edge[]>();
  for (const edge of edges) {
    const members = edge.data!.relationMembers as { source: string; target: string }[];
    for (const { source, target } of members) {
      const key = pairKey(source, target);
      const visible = visiblePairs.get(key) ?? [];
      if (!visible.includes(edge)) visible.push(edge);
      visiblePairs.set(key, visible);
    }
  }
  for (const row of shared) {
    const [node, ...clients] = row.projected;
    if (main.has(node) || peripheral.has(node) || parallelNodes.has(node) || stageOf.has(node) ||
        clients.some(id => resources.has(id) || peripheral.has(id)) ||
        shared.some(other => other !== row && other.projected[0] === node)) {
      reject(row, '共享资源或使用方与其他投影位置重合，无法保留单独的共享位置。');
    } else if (row.original.slice(1).some(client => !visiblePairs.has(pairKey(client, row.original[0])) &&
        !visiblePairs.has(pairKey(row.original[0], client)))) {
      reject(row, '至少一个原使用方的连接在当前图中折叠。');
    } else {
      plan.shared!.push({ node, clients: unique(clients) });
    }
  }
  for (const row of active('feedback')) {
    const [from, to] = row.projected;
    const { side } = reading.feedback![row.index];
    const returns = visiblePairs.get(pairKey(row.original[0], row.original[1]));
    if (!returns?.length || returns.some(e => e.data?.readingFeedback !== side)) {
      reject(row, '原返回关系在当前图中没有可走指定通道的边。');
    } else {
      row.edges = returns.map(e => e.id);
      plan.feedback!.push({ from, to, side });
    }
  }
  return { plan, constraints };
}
