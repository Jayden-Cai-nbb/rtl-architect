import type { scopeDiagram } from './scopeDiagram';
type Point = { x: number; y: number };
const interior = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);
export function diagramQuality(graph: ReturnType<typeof scopeDiagram>) {
  const nodes = graph.nodes.filter(n => !['frame','region'].includes(n.data.kind));
  const boxes = nodes.map(n => ({ id: n.id, left: n.position.x, top: n.position.y, right: n.position.x + n.data.geometry.width, bottom: n.position.y + n.data.geometry.height }));
  const overlaps: string[][] = [], nodeHits: { edge: string; node: string }[] = [];
  for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
    const a = boxes[i];
    if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps.push([a.id, b.id]);
  }
  const segments = graph.edges.flatMap(edge => {
    const points = edge.data?.routePoints as Point[] | undefined;
    return (points?.slice(1) ?? []).map((b, i) => ({ edge, a: points![i], b }));
  });
  for (const { edge, a, b } of segments) for (const box of boxes) {
    if (box.id === edge.source || box.id === edge.target) continue;
    const hit = a.x === b.x ? interior(a.x, box.left, box.right) && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.bottom
      : interior(a.y, box.top, box.bottom) && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.right;
    if (hit && !nodeHits.some(h => h.edge === edge.id && h.node === box.id)) nodeHits.push({ edge: edge.id, node: box.id });
  }
  let crossings = 0, sharedLength = 0;
  for (let i = 0; i < segments.length; i++) for (const t of segments.slice(i + 1)) {
    const s = segments[i]; if (s.edge.id === t.edge.id) continue;
    const sh = s.a.y === s.b.y, th = t.a.y === t.b.y;
    if (sh !== th) {
      const h = sh ? s : t, v = sh ? t : s;
      if (interior(v.a.x, h.a.x, h.b.x) && interior(h.a.y, v.a.y, v.b.y)) crossings++;
    } else if (sh ? s.a.y === t.a.y : s.a.x === t.a.x) {
      const axis = sh ? 'x' : 'y';
      // Shared source stems are allowed; unrelated overlaps remain visible in the report.
      if (s.edge.data?.netKey && s.edge.data.netKey === t.edge.data?.netKey) continue;
      sharedLength += Math.max(0, Math.min(Math.max(s.a[axis], s.b[axis]), Math.max(t.a[axis], t.b[axis])) - Math.max(Math.min(s.a[axis], s.b[axis]), Math.min(t.a[axis], t.b[axis])));
    }
  }
  const unrouted = graph.edges.filter(e => e.data?.routingFallback || !e.data?.routePoints).map(e => e.id);
  const sharedLabels=graph.edges.filter(e=>e.data?.labelSharedWith).map(e=>({edge:e.id,namedBy:e.data!.labelSharedWith}));
  const labelStatus=graph.edges.some(e=>e.label&&e.data?.labelHidden)?'needs_attention':'named';
  return { sharedLabels, labelStatus, status: overlaps.length || nodeHits.length || unrouted.length ? 'failed' : 'passed', overlaps, nodeHits, unrouted,
    crossings, unrelatedSharedLength: sharedLength, bends: segments.length - graph.edges.filter(e => e.data?.routePoints).length,
    wireLength: segments.reduce((n, s) => n + Math.abs(s.a.x - s.b.x) + Math.abs(s.a.y - s.b.y), 0),
    hiddenLabels: graph.edges.filter(e => e.label && e.data?.labelHidden).map(e => e.id),
    folded: { auxiliary: graph.auxiliaryCount, local: graph.foldedLocalCount },
    connections: graph.inspection.stored.map(l => ({ id: l.id, from: l.from, to: l.to, visibleIn: graph.edges.filter(e => (e.data?.connectionIds as string[] | undefined)?.includes(l.id)).map(e => e.id) })),
    visualReview: 'not_run', note: '几何检查不证明文字可读、硬件正确或所有交叉可辨认。' };
}
