import type {Edge} from '@xyflow/react';
import type {RtlNode} from './types';
/** Choose layout constraints, not circuit edges. Every relation is still drawn by scopeDiagram. */
export function orderingRelations(nodes:RtlNode[],edges:Edge[],mainPath:string[]=[]):Edge[]{
 const byId=new Map(nodes.map(n=>[n.id,n])),pairs=new Map<string,Edge>();
 const weight=(e:Edge)=>(e.data?.layoutOnly?100:({data:12,request:10,other:6,control:3,response:2,writeback:1}[String(e.data?.category)]??6))+(byId.get(e.target)?.data.kind==='state'?2:0);
 for(const edge of edges.filter(e=>byId.has(e.source)&&byId.has(e.target)&&e.source!==e.target)){
  const key=`${edge.source}>${edge.target}`,previous=pairs.get(key);
  if(!previous||weight(edge)>weight(previous)||(weight(edge)===weight(previous)&&edge.id<previous.id))pairs.set(key,edge);
 }
 for(let i=1;i<mainPath.length;i++){
  const source=mainPath[i-1],target=mainPath[i];if(!byId.has(source)||!byId.has(target))continue;
  pairs.set(`${source}>${target}`,{id:`reading-order:${source}>${target}`,source,target,sourceHandle:'out',targetHandle:'in',data:{layoutOnly:true}});
 }
 const successors=new Map<string,string[]>(),result:Edge[]=[];
 const reachable=(from:string,target:string)=>{const queue=[from],seen=new Set<string>();while(queue.length){const id=queue.pop()!;if(id===target)return true;if(seen.has(id))continue;seen.add(id);queue.push(...successors.get(id)??[]);}return false;};
 for(const e of [...pairs.values()].sort((a,b)=>weight(b)-weight(a)||a.id.localeCompare(b.id))){
  if(reachable(e.target,e.source))continue;
  result.push(e);successors.set(e.source,[...successors.get(e.source)??[],e.target]);
 }
 return result;
}

/** ELK centers unequal-width nodes in a layer; equal x is not a layer identity. */
export function alignColumns(nodes:RtlNode[],positions:Record<string,{x:number;y:number}>,gap:number,top=0){
 const columns:{left:number;right:number;nodes:RtlNode[]}[]=[];
 for(const n of [...nodes].sort((a,b)=>positions[a.id].x-positions[b.id].x||a.id.localeCompare(b.id))){
  const left=positions[n.id].x,right=left+n.data.geometry.width,last=columns.at(-1);
  if(last&&left<last.right-1){last.right=Math.max(last.right,right);last.nodes.push(n);}
  else columns.push({left,right,nodes:[n]});
 }
 const height=(column:typeof columns[number])=>column.nodes.reduce((sum,n)=>sum+n.data.geometry.height,0)+Math.max(0,column.nodes.length-1)*gap;
 const total=Math.max(0,...columns.map(height)),left=Math.min(0,...columns.map(c=>c.left));
 for(const column of columns){
  column.nodes.sort((a,b)=>positions[a.id].y-positions[b.id].y||a.id.localeCompare(b.id));let y=top+(total-height(column))/2;
  for(const n of column.nodes){positions[n.id]={x:column.left-left,y};y+=n.data.geometry.height+gap;}
 }
}
