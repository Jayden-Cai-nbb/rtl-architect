import type {Model,Endpoint} from '../../core/schema';
import {interfaceGroup,linkGroup} from '../../core/inspection';
import type {RtlNode,PortGeometry} from './types';
export const portDetailZoom=.9;
export const wireSpacing=32;
const short=(name:string)=>name.length>17?name.slice(0,14)+'…':name;
/** Display-only geometry from all stored links; zoom/selection never changes pin placement. */
export function orientPorts(nodes:RtlNode[],model:Model,scope:string,links:Model['connections'],nodeId:(e:Endpoint)=>string){
 const byId=new Map(nodes.map(n=>[n.id,n]));
 const neighbors=new Map<string,{x:number;y:number}[]>(),names=new Map<string,Set<string>>(),categories=new Map<string,string>();
 const returns=new Map<string,Set<PortGeometry['side']>>();
 for(const link of links)for(const [end,other,direction] of [[link.from,link.to,'out'],[link.to,link.from,'in']] as const){
  const n=byId.get(nodeId(end)),o=byId.get(nodeId(other));if(!n)continue;
  const relation=linkGroup(model,link),group=end.moduleId===scope&&!end.local?interfaceGroup(model,end).id:relation.id,key=`${n.id}/${direction}:${group}`;
  const entry=names.get(key)??new Set<string>();entry.add(end.interfaceId);names.set(key,entry);categories.set(key,relation.category);
  if(!o)continue;
  if(relation.category==='response'){
   const a=byId.get(nodeId(link.from)),b=byId.get(nodeId(link.to));
   if(a&&b&&!a.data.boundary&&b.data.kind==='controller'&&a.position.y>b.position.y+100){
    // A lateral producer approaches the facing side, not the far side of the controller.
    const ax=a.position.x+a.data.geometry.width/2,bx=b.position.x+b.data.geometry.width/2;
    const offset=ax-bx,apart=Math.abs(offset)>(a.data.geometry.width+b.data.geometry.width)/4;
    const choices=returns.get(key)??new Set<PortGeometry['side']>();choices.add(apart?(direction==='out'?(offset<0?'EAST':'WEST'):(offset<0?'WEST':'EAST')):'EAST');returns.set(key,choices);
   }
  }
  neighbors.set(key,[...neighbors.get(key)??[],{x:o.position.x+o.data.geometry.width/2,y:o.position.y+o.data.geometry.height/2}]);
 }
 for(const n of nodes){
  if(n.data.boundary)continue;
  const g=n.data.geometry,cx=n.position.x+g.width/2,cy=n.position.y+g.height/2;
  const sides=new Map<PortGeometry['side'],{p:PortGeometry;order:number}[]>();
  for(const p of g.ports){
   if(!p.id.includes(':'))continue;
   const key=`${n.id}/${p.id}`,peers=neighbors.get(key);let side=p.side,order=0;
   p.interfaceIds=[...names.get(key)??[]].sort();p.label=p.interfaceIds.length?short(p.interfaceIds[0])+(p.interfaceIds.length>1?` +${p.interfaceIds.length-1}`:''):undefined;p.category=categories.get(key);
   if(peers?.length){
    const x=peers.reduce((v,p)=>v+p.x,0)/peers.length,y=peers.reduce((v,p)=>v+p.y,0)/peers.length;
    if(Math.abs(y-cy)>g.height+30){side=y<cy?'NORTH':'SOUTH';order=x;}
    else {side=x<cx?'WEST':'EAST';order=y;}
   }
   const choices=returns.get(key);if(choices?.size===1)side=[...choices][0];else if(choices?.size)side=(peers!.reduce((v,p)=>v+p.x,0)/peers!.length)<cx?'WEST':'EAST';p.side=side;sides.set(side,[...sides.get(side)??[],{p,order}]);
  }
  const labelWidth=(p:PortGeometry)=>[...(p.label??'')].reduce((v,c)=>v+(c.charCodeAt(0)>255?12:7.2),0);
  const sideWidth=(side:PortGeometry['side'])=>Math.max(0,...(sides.get(side)??[]).map(({p})=>labelWidth(p)));
  const rowWidth=(side:PortGeometry['side'])=>(sides.get(side)??[]).reduce((v,{p})=>v+Math.max(48,labelWidth(p)+28),0)+32;
  const north=!!sides.get('NORTH')?.length,south=!!sides.get('SOUTH')?.length,sideCount=Math.max(sides.get('WEST')?.length??0,sides.get('EAST')?.length??0);
  g.captionY=north?40:24;const start=g.captionY+72;
  g.height=Math.max(g.captionY+66,sideCount?start+(sideCount-1)*36+18:0)+(south?26:0);n.height=g.height;
  g.width=Math.max(240,rowWidth('NORTH'),rowWidth('SOUTH'),sideWidth('WEST')+sideWidth('EAST')+44);n.width=g.width;
  for(const [side,entries] of sides){
   entries.sort((a,b)=>a.order-b.order||a.p.id.slice(a.p.id.indexOf(':')+1).localeCompare(b.p.id.slice(b.p.id.indexOf(':')+1)));
   const horizontal=side==='NORTH'||side==='SOUTH',slots=entries.map(({p})=>Math.max(48,labelWidth(p)+28)),total=slots.reduce((a,b)=>a+b,0);let cursor=(g.width-total)/2;
   entries.forEach(({p},i)=>{
    const at=horizontal?cursor+slots[i]/2:start+i*36;cursor+=slots[i];
    p.x=horizontal?at:side==='WEST'?0:g.width;p.y=horizontal?(side==='NORTH'?0:g.height):at;
    p.labelX=horizontal?p.x:side==='WEST'?10:g.width-10;p.labelY=horizontal?(side==='NORTH'?16:g.height-10):p.y+4;p.textAnchor=horizontal?'middle':side==='WEST'?'start':'end';
   });
  }
  for(const p of g.ports.filter(p=>!p.id.includes(':'))){p.x=p.direction==='source'?g.width:0;p.y=g.height-12;}
 }
}
