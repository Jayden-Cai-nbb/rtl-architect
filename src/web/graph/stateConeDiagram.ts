import type {Edge} from '@xyflow/react';
import type {StateCone} from '../../core/nextStateCone';
import type {RtlNode,PortGeometry} from './types';
import {routeEdges} from './orthogonal';
import {geometryQuality} from './quality';
type Geometry=ReturnType<typeof geometryQuality>;
/** Keep a stable order when objectives tie. No names, timing or rule priority inferred. */
function pack(column:RtlNode[],desired:Map<string,number>){
 column.sort((a,b)=>desired.get(a.id)!-desired.get(b.id)!);
 // Isotonic projection of desired positions with the actual node heights and a 48px gap.
 const blocks:{from:number;to:number;sum:number;count:number}[]=[],offsets:number[]=[];let offset=0;
 column.forEach((n,i)=>{offsets.push(offset);blocks.push({from:i,to:i,sum:desired.get(n.id)!-offset,count:1});offset+=n.data.geometry.height+48;
  while(blocks.length>1){const b=blocks.at(-1)!,a=blocks.at(-2)!;if(a.sum/a.count<=b.sum/b.count)break;blocks.splice(-2,2,{from:a.from,to:b.to,sum:a.sum+b.sum,count:a.count+b.count});}
 });
 for(const b of blocks)for(let i=b.from;i<=b.to;i++)column[i].position.y=b.sum/b.count+offsets[i];
 const shift=Math.max(0,40-(column[0]?.position.y??40));for(const n of column)n.position.y=Math.round(n.position.y+shift);
}
function better(a:Geometry,b:Geometry){
 const failures=(q:Geometry)=>q.overlaps.length+q.nodeHits.length+q.unrouted.length;
 if(failures(a))return false;if(failures(b))return true;
 const fields=['crossings','maxRouteLength','wireLength','unrelatedSharedLength'] as const;
 return fields.every(k=>a[k]<=b[k])&&fields.some(k=>a[k]<b[k]);
}
/** Bounded layout candidates, all using the existing obstacle router and exact dependency handles. */
export function stateConeDiagram(cone:StateCone){
 const incoming=new Map(cone.nodes.map(n=>[n.id,cone.edges.map((e,i)=>({e,i})).filter(({e})=>e.target===n.id)]));
 const outgoing=new Map(cone.nodes.map(n=>[n.id,cone.edges.map((e,i)=>({e,i})).filter(({e})=>e.source===n.id)]));
 const early=new Map<string,number>(),visiting=new Set<string>();
 const rank=(id:string):number=>{if(early.has(id))return early.get(id)!;if(visiting.has(id))throw Error('投影出现环；不推断下一拍展开');visiting.add(id);const r=Math.max(0,...incoming.get(id)!.map(({e})=>rank(e.source)+1));visiting.delete(id);early.set(id,r);return r};
 cone.nodes.forEach(n=>rank(n.id));
 const late=new Map<string,number>();
 const nearConsumer=(id:string):number=>{if(late.has(id))return late.get(id)!;const next=outgoing.get(id)!;const r=next.length?Math.min(...next.map(({e})=>nearConsumer(e.target)-1)):early.get(id)!;late.set(id,r);return r};
 function draw(ranks:Map<string,number>,ordered:boolean,sortPorts:boolean){
  const ys=new Map<number,number>();
  const nodes:RtlNode[]=cone.nodes.map(n=>{
   const inputs=incoming.get(n.id)!,height=116+Math.max(0,inputs.length-1)*22,r=ranks.get(n.id)!,y=ys.get(r)??40;ys.set(r,y+height+48);
   const ports:PortGeometry[]=[{id:'out',direction:'source',side:'EAST',x:270,y:height/2},...inputs.map(({e,i},j)=>({id:`in:${i}`,direction:'target' as const,side:'WEST' as const,x:0,y:96+j*22,label:e.role}))];
   return {id:n.id,type:'rtlModule',position:{x:48+r*370,y},width:270,height,data:{label:n.label,moduleId:'projection',kind:n.kind,boundary:false,summary:'表达式投影',geometry:{width:270,height,ports},ports:ports.map(p=>({id:p.id,width:undefined}))}};
  });
  const byId=new Map(nodes.map(n=>[n.id,n])),levels=[...new Set(ranks.values())].sort((a,b)=>a-b);
  const portY=(id:string,handle:string)=>{const n=byId.get(id)!;return n.position.y+n.data.geometry.ports.find(p=>p.id===handle)!.y};
  if(ordered)for(let pass=0;pass<4;pass++){
   if(sortPorts)for(const n of nodes){const inputs=[...incoming.get(n.id)!].sort((a,b)=>portY(a.e.source,'out')-portY(b.e.source,'out')||a.i-b.i);inputs.forEach(({i},j)=>{n.data.geometry.ports.find(p=>p.id===`in:${i}`)!.y=96+j*22});}
   for(const reverse of [true,false])for(const r of reverse?[...levels].reverse():levels){
    const column=nodes.filter(n=>ranks.get(n.id)===r),desired=new Map<string,number>();
    for(const n of column){const targets=reverse?outgoing.get(n.id)!.map(({e,i})=>portY(e.target,`in:${i}`)-n.data.geometry.height/2):incoming.get(n.id)!.map(({e,i})=>portY(e.source,'out')-n.data.geometry.ports.find(p=>p.id===`in:${i}`)!.y);desired.set(n.id,targets.length?targets.reduce((a,b)=>a+b,0)/targets.length:n.position.y);}
    pack(column,desired);
   }
  }
  const edges:Edge[]=cone.edges.map((e,i)=>({id:`cone:${i}`,source:e.source,target:e.target,sourceHandle:'out',targetHandle:`in:${i}`,data:{semanticKind:'dependency',role:e.role}}));
  routeEdges(nodes,edges);return {nodes,edges};
 }
 let chosen=draw(early,false,false),quality=geometryQuality(chosen),strategy='baseline';
 const baseline=quality,candidates:{strategy:string;quality:Geometry}[]=[{strategy,quality}];
 // Bound router calls independently of graph selection/zoom. Large cones keep the baseline.
 if(cone.nodes.length<=64&&cone.edges.length<=96){
  cone.nodes.forEach(n=>nearConsumer(n.id));
  for(const ports of [false,true]){const graph=draw(late,true,ports),q=geometryQuality(graph),name=ports?'consumer-aligned-ports':'consumer-aligned';candidates.push({strategy:name,quality:q});if(better(q,quality)){chosen=graph;quality=q;strategy=name;}}
 }
 const {nodes,edges}=chosen,points=edges.flatMap(e=>e.data?.routePoints as {x:number;y:number}[]??[]);
 const left=Math.min(0,...points.map(p=>p.x-20)),top=Math.min(0,...points.map(p=>p.y-20));
 return {nodes,edges,left,top,width:Math.max(400,...nodes.map(n=>n.position.x+290),...points.map(p=>p.x+20))-left,height:Math.max(200,...nodes.map(n=>n.position.y+n.data.geometry.height+20),...points.map(p=>p.y+20))-top,
  optimization:{strategy,candidates,baseline,quality,budget:{maxNodes:64,maxEdges:96,maxCandidates:3,sweeps:4},note:'布局层级不代表周期或规则优先级；只接受几何完整且交叉、最长/总路径及共线长度均不变差的候选。'}};
}
