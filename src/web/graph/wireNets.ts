import type {Edge} from '@xyflow/react';
type Point={x:number;y:number};
type Segment={a:Point;b:Point;edge:Edge};
const on=(p:Point,s:Segment)=>s.a.x===s.b.x?p.x===s.a.x&&p.y>=Math.min(s.a.y,s.b.y)&&p.y<=Math.max(s.a.y,s.b.y):p.y===s.a.y&&p.x>=Math.min(s.a.x,s.b.x)&&p.x<=Math.max(s.a.x,s.b.x);
/** A junction is allowed only for the exact same recorded source set, never merely the same color. */
export function annotateWireNets(edges:Edge[]){
 const drawn:Segment[]=[];
 for(const edge of edges){
  const points=(edge.data?.routePoints as Point[])??[],segments=points.slice(1).map((b,i)=>({a:points[i],b,edge})),crossings=new Map<string,Point>();
  for(const a of segments)for(const b of drawn){
   if(edge.data?.netKey&&edge.data.netKey===b.edge.data?.netKey)continue;
   const ah=a.a.y===a.b.y,bh=b.a.y===b.b.y;if(ah===bh)continue;
   const h=ah?a:b,v=ah?b:a,p={x:v.a.x,y:h.a.y};
   if(on(p,a)&&on(p,b)&&![points[0],points.at(-1)].some(q=>q?.x===p.x&&q?.y===p.y))crossings.set(`${p.x},${p.y}`,p);
  }
  edge.data={...edge.data,crossings:[...crossings.values()]};drawn.push(...segments);
 }
 const nets=new Map<string,Edge[]>();
 for(const e of edges)if(e.data?.netKey)nets.set(String(e.data.netKey),[...nets.get(String(e.data.netKey))??[],e]);
 const junctions=new Map<string,Point&{color:string}>();
 for(const members of nets.values()){
  if(members.length<2)continue;
  const segments=members.flatMap(edge=>{const p=(edge.data?.routePoints as Point[])??[];return p.slice(1).map((b,i)=>({a:p[i],b,edge}));});
  for(let i=0;i<segments.length;i++)for(const b of segments.slice(i+1)){
   const a=segments[i];if(a.edge===b.edge)continue;
   for(const p of [a.a,a.b,b.a,b.b]){
    if(!on(p,a)||!on(p,b))continue;
    // Straight overlap endpoints alone are not junctions; require at least three incident directions.
    const directions=new Set<string>();
    for(const s of segments.filter(s=>on(p,s)))for(const q of [s.a,s.b]){if(q.x!==p.x)directions.add(q.x<p.x?'W':'E');if(q.y!==p.y)directions.add(q.y<p.y?'N':'S');}
    if(directions.size>=3)junctions.set(`${p.x},${p.y}`,{...p,color:String(a.edge.data?.color)});
   }
  }
  // Reuse a name only for a traceable, connected fanout with that exact name already visible.
  for(const e of members.filter(e=>e.data?.labelHidden)){
   const labeled=members.find(other=>other!==e&&other.label===e.label&&other.data?.labelBox&&!other.data?.labelHidden&&!other.data?.labelSharedWith);
   if(labeled)e.data={...e.data,labelHidden:false,labelSharedWith:labeled.id};
  }
 }
 if(edges.length)edges[edges.length-1].data={...edges[edges.length-1].data,junctions:[...junctions.values()]};
}
