import type { scopeDiagram } from './scopeDiagram';
import {readingAudit} from './readingAudit';
type Point = { x: number; y: number };
const interior = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);
export function geometryQuality(graph: Pick<ReturnType<typeof scopeDiagram>,'nodes'|'edges'>) {
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
  const routeLengths=graph.edges.map(edge=>{const points=edge.data?.routePoints as Point[]|undefined;const length=(points?.slice(1)??[]).reduce((n,b,i)=>n+Math.abs(b.x-points![i].x)+Math.abs(b.y-points![i].y),0);return {id:edge.id,length};});
  return {overlaps,nodeHits,unrouted,crossings,unrelatedSharedLength:sharedLength,
    bends:segments.length-graph.edges.filter(e=>e.data?.routePoints).length,
    wireLength:routeLengths.reduce((n,r)=>n+r.length,0),maxRouteLength:Math.max(0,...routeLengths.map(r=>r.length)),routeLengths};
}
export function diagramQuality(graph: ReturnType<typeof scopeDiagram>) {
  const {overlaps,nodeHits,unrouted,crossings,unrelatedSharedLength:sharedLength,bends,wireLength,maxRouteLength,routeLengths}=geometryQuality(graph);
  const routes=routeLengths.map(({id,length})=>{
    const edge=graph.edges.find(e=>e.id===id)!,points=edge.data?.routePoints as Point[]|undefined;
    const first=points?.[0],last=points?.at(-1),directLength=first&&last?Math.abs(last.x-first.x)+Math.abs(last.y-first.y):0;
    return {id,label:String(edge.label??''),source:edge.source,target:edge.target,length,
      directLength,detour:length-directLength,ratio:directLength?length/directLength:null,
      routed:!unrouted.includes(id),connectionIds:edge.data?.connectionIds??[],
      dependencyEndpoints:edge.data?.dependencyEndpoints??[],relationMembers:edge.data?.relationMembers??[]};
  }).sort((a,b)=>b.length-a.length||a.id.localeCompare(b.id));
  // These are drawing units, never physical wire delay or the number of register stages.
  const routeReview={units:'diagram_units',routes,longest:routes.filter(r=>r.routed).slice(0,5).map(r=>r.id),
    detours:routes.filter(r=>r.routed&&r.detour>=256&&r.ratio!==null&&r.ratio>=2).map(r=>r.id),
    note:'最长关系用于定位；绕行提示阈值为多走至少 256 图单位且达到端点曼哈顿距离的 2 倍，不是 RTL 时序或失败判据。'};
  const sharedLabels=graph.edges.filter(e=>e.data?.labelSharedWith).map(e=>({edge:e.id,namedBy:e.data!.labelSharedWith}));
  const labelStatus=graph.edges.some(e=>e.label&&e.data?.labelHidden)?'needs_attention':'named';
  const omissions=new Set(graph.omissions.map(o=>o.connectionId)),expected=new Map(graph.semantics.relationships.map(r=>[r.id,r]));
  const represented=new Map<string,string[]>(),wrongEndpoints:string[]=[];
  const scope=graph.nodes[0].data.moduleId;
  const originalNodeFor=(e:typeof graph.semantics.relationships[number]['from'],role?:string)=>e.local?`local:${scope}:${e.interfaceId}`:e.moduleId===scope?`rack:${scope}:${role}`:e.moduleId;
  const nodeFor=(e:typeof graph.semantics.relationships[number]['from'],role?:string)=>{const id=originalNodeFor(e,role);return graph.projection?.nodeFor[id]??id;};
  for(const group of Object.values(graph.projection?.internal??{}))for(const member of group)for(const id of member.connectionIds)represented.set(id,[...represented.get(id)??[],member.id]);
  for(const edge of graph.edges)for(const id of (edge.data?.connectionIds as string[]??[])){
   represented.set(id,[...represented.get(id)??[],edge.id]);const r=expected.get(id);
   if(r&&(nodeFor(r.from,r.fromRole)!==edge.source||nodeFor(r.to,r.toRole)!==edge.target))wrongEndpoints.push(id);
  }
  const missing=[...expected.keys()].filter(id=>!represented.has(id)&&!omissions.has(id)),extra=[...represented.keys()].filter(id=>!expected.has(id)),duplicates=[...represented].filter(([,edges])=>edges.length!==1).map(([id])=>id);
  const structuralFidelity={status:missing.length||extra.length||duplicates.length||wrongEndpoints.length?'failed':'passed',missing,extra,duplicates,wrongEndpoints,omissions:graph.omissions,note:'仅检查当前视图及聚合清单对应模型连接；折叠有明确原因，不证明 RTL 覆盖。'};
  const semanticClarity={status:graph.semantics.issues.length?'needs_review':'no_detected_issue',issues:graph.semantics.issues,humanReview:'not_run'};
  const geometricReadability={status:overlaps.length||nodeHits.length||unrouted.length?'blocked':labelStatus!=='named'||crossings>0||sharedLength>0?'needs_review':'clear',note:'交叉、共线和隐藏线名与基本几何完整性分开；仍需沿真实事务人工阅读。'};
  return {readingConstraints:readingAudit(graph),structuralFidelity,semanticClarity,geometricReadability, sharedLabels, labelStatus, status: overlaps.length || nodeHits.length || unrouted.length ? 'failed' : 'passed', overlaps, nodeHits, unrouted,
    crossings, unrelatedSharedLength: sharedLength, bends,wireLength,maxRouteLength,routeReview,
    hiddenLabels: graph.edges.filter(e => e.label && e.data?.labelHidden).map(e => e.id),
    folded: { auxiliary: graph.auxiliaryCount, local: graph.foldedLocalCount },
    connections: graph.inspection.stored.map(l => ({ id: l.id, from: l.from, to: l.to, retainedIn: Object.entries(graph.projection?.internal??{}).filter(([,members])=>members.some(m=>m.connectionIds.includes(l.id))).map(([id])=>id), visibleIn: graph.edges.filter(e => (e.data?.connectionIds as string[] | undefined)?.includes(l.id)).map(e => e.id) })),
    visualReview: 'not_run', note: '几何检查不证明文字可读、硬件正确或所有交叉可辨认。' };
}
