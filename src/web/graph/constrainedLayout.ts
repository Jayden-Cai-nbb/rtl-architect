import type {Edge} from '@xyflow/react';
import type {Model,ScopeLayout} from '../../core/schema';
import type {RtlNode} from './types';
import {scopeDiagram,type DiagramOptions,type Positions} from './scopeDiagram';
import {elkLayout} from './elkLayout';
import {alignColumns,orderingRelations} from './topology';

/** Collapse display lanes only for ordering. The projected circuit retains every node and edge. */
export async function constrainedLayout(model:Model,scope:string,reading:NonNullable<ScopeLayout['reading']>,options:DiagramOptions):Promise<Positions>{
 let positions:Positions|undefined;
 const sizes=new Map<string,{width:number;height:number}>();
 for(let pass=0;pass<3;pass++){
  const graph=scopeDiagram(model,scope,{...options,positions,reading,measureOnly:true});
  const nodes=graph.nodes.filter(n=>!n.data.boundary),byId=new Map(nodes.map(n=>[n.id,n]));
  for(const n of nodes){const old=sizes.get(n.id);sizes.set(n.id,{width:Math.max(old?.width??0,n.data.geometry.width),height:Math.max(old?.height??0,n.data.geometry.height)});}
  const size=(id:string)=>sizes.get(id)!;
  const peripheral=new Set([...reading.control,...reading.adjacent.map(a=>a.node),...(reading.shared??[]).map(s=>s.node)]);
  const groups=new Map<string,string[]>(),unitOf=new Map<string,string>();
  for(const p of reading.parallel??[])groups.set(`parallel:${p.id}`,p.nodes);
  for(const n of nodes)if(!peripheral.has(n.id)&&![...groups.values()].some(ids=>ids.includes(n.id)))groups.set(n.id,[n.id]);
  for(const [id,members] of groups)for(const member of members)unitOf.set(member,id);
  const units:RtlNode[]=[...groups].map(([id,members])=>{
   const width=Math.max(...members.map(m=>size(m).width)),height=members.reduce((v,m)=>v+size(m).height,0)+(members.length-1)*128;
   return {...byId.get(members[0])!,id,position:{x:0,y:0},width,height,data:{...byId.get(members[0])!.data,geometry:{width,height,ports:[{id:'in',direction:'target',side:'WEST',x:0,y:height/2},{id:'out',direction:'source',side:'EAST',x:width,y:height/2}]}}};
  });
  const hard:Edge[]=[],add=(source:string,target:string)=>{if(source!==target)hard.push({id:`constraint:${source}>${target}`,source,target,sourceHandle:'out',targetHandle:'in',data:{layoutOnly:true}});};
  for(let i=1;i<reading.mainPath.length;i++)add(unitOf.get(reading.mainPath[i-1])!,unitOf.get(reading.mainPath[i])!);
  const stages=(reading.stages??[]).map(s=>[...new Set(s.nodes.flatMap(id=>unitOf.has(id)?[unitOf.get(id)!]:[]))]).filter(s=>s.length);
  for(let i=1;i<stages.length;i++)for(const a of stages[i-1])for(const b of stages[i])add(a,b);
  const successors=new Map<string,Set<string>>();for(const e of hard)successors.set(e.source,new Set([...(successors.get(e.source)??[]),e.target]));
  const visited=new Set<string>(),active=new Set<string>();
  const visit=(id:string)=>{if(active.has(id))throw new Error('主线与阅读分区顺序冲突；请修正约束。');if(visited.has(id))return;active.add(id);for(const next of successors.get(id)??[])visit(next);active.delete(id);visited.add(id);};
  for(const id of groups.keys())visit(id);
  const relations=graph.edges.filter(e=>unitOf.has(e.source)&&unitOf.has(e.target)&&!e.data?.readingFeedback).map(e=>({...e,source:unitOf.get(e.source)!,target:unitOf.get(e.target)!,sourceHandle:'out',targetHandle:'in'}));
  const order=orderingRelations(units,[...relations,...hard]);
  const labelWidth=Math.max(0,...graph.edges.map(e=>[...String(e.label??'')].reduce((v,c)=>v+(c.charCodeAt(0)>255?16:8.5),0)));
  const placed=await elkLayout(units,order,{nodes:128,layers:Math.max(240,labelWidth+90)});
  alignColumns(units,placed,128,reading.control.length?Math.max(...reading.control.map(id=>size(id).height))+220:100);
  positions={};
  for(const [id,members] of groups){let y=placed[id].y;for(const member of members){positions[member]={x:placed[id].x,y};y+=size(member).height+128;}}
  const center=(id:string)=>positions![id].x+size(id).width/2;
  const average=(ids:string[])=>ids.reduce((v,id)=>v+center(id),0)/ids.length;
  const row=(entries:{id:string;x:number}[],y:number)=>{let right=-Infinity;for(const {id,x} of entries.sort((a,b)=>a.x-b.x||a.id.localeCompare(b.id))){positions![id]={x:Math.max(0,x-size(id).width/2,right+128),y};right=positions![id].x+size(id).width;}};
  const peers=(id:string)=>[...new Set(graph.edges.flatMap(e=>e.source===id&&positions![e.target]?[e.target]:e.target===id&&positions![e.source]?[e.source]:[]))];
  row(reading.control.map(id=>({id,x:peers(id).length?average(peers(id)):0})),0);
  let bottom=Math.max(0,...Object.entries(positions).map(([id,p])=>p.y+size(id).height))+200;
  const below:{id:string;x:number}[]=[];
  for(const shared of reading.shared??[]){
   const xs=shared.clients.map(id=>positions![id].x);
   if(Math.max(...xs)-Math.min(...xs)>1){below.push({id:shared.node,x:average(shared.clients)});continue;}
   // Stacked clients face one shared object to their right, avoiding long U turns.
   const id=shared.node,y=Math.max(100,shared.clients.reduce((v,c)=>v+positions![c].y+size(c).height/2,0)/shared.clients.length-size(id).height/2);
   let x=Math.max(...shared.clients.map(c=>positions![c].x+size(c).width))+240;
   for(const [other,p] of Object.entries(positions).sort((a,b)=>a[1].x-b[1].x))if(y<p.y+size(other).height+96&&y+size(id).height+96>p.y&&x<p.x+size(other).width+128&&x+size(id).width+128>p.x)x=p.x+size(other).width+240;
   positions[id]={x,y};
  }
  bottom=Math.max(bottom,...Object.entries(positions).map(([id,p])=>p.y+size(id).height+200));
  row(below,bottom);
  bottom=Math.max(bottom,...Object.entries(positions).map(([id,p])=>p.y+size(id).height))+160;
  row(reading.adjacent.map(a=>({id:a.node,x:center(a.anchor)})),bottom);
 }
 return positions!;
}
