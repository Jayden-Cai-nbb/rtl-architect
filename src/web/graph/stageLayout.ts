import type {Model,ScopeLayout} from '../../core/schema';
import {scopeDiagram,type Positions,type DiagramOptions} from './scopeDiagram';
import {elkLayout} from './elkLayout';
import {orderingRelations,alignColumns} from './topology';
/** Semantic reading regions constrain columns. RTL nodes and edges retain their identities. */
export async function stageLayout(model:Model,scope:string,reading:NonNullable<ScopeLayout['reading']>,options:DiagramOptions={}):Promise<Positions>{
 let graph=scopeDiagram(model,scope,{...options,reading,measureOnly:true});
 const regions=reading.stages??[],assigned=new Set(regions.flatMap(r=>r.nodes));
 const loose=graph.nodes.filter(n=>!n.data.boundary&&!assigned.has(n.id)).map(n=>n.id);
 const groups=[...regions.map(r=>r.nodes),...(loose.length?[loose]:[])];
 let positions:Positions={};
 for(let pass=0;pass<3;pass++){
  const plans=[];
  for(const ids of groups){
   const nodes=graph.nodes.filter(n=>ids.includes(n.id)),edges=graph.edges.filter(e=>ids.includes(e.source)&&ids.includes(e.target));
   const path=reading.mainPath.filter(id=>ids.includes(id));
   const controls=nodes.filter(n=>reading.control.includes(n.id)&&!path.includes(n.id)),controlIds=new Set(controls.map(n=>n.id));
   const body=nodes.filter(n=>!controlIds.has(n.id));
   const constraints=orderingRelations(body,edges,path);
   const placed=await elkLayout(body,constraints,{nodes:80,layers:240});
   // Keep straight flow within each layer; fixed pin offsets must not introduce a staircase.
   alignColumns(body,placed,80);
   // Fold a short pre-register chain within a region, keeping its state at the right boundary.
   if(body.length===3&&path.length===3){
    const [first,second,state]=path.map(id=>body.find(n=>n.id===id)!);
    if(first.data.kind!=='state'&&second.data.kind!=='state'&&state.data.kind==='state'){
     placed[first.id]={x:0,y:0};placed[second.id]={x:0,y:first.data.geometry.height+84};
     placed[state.id]={x:Math.max(first.data.geometry.width,second.data.geometry.width)+180,y:placed[second.id].y+(second.data.geometry.height-state.data.geometry.height)/2};
    }
   }
   if(controls.length){
    const controlHeight=Math.max(...controls.map(n=>n.data.geometry.height));
    for(const p of Object.values(placed))p.y+=controlHeight+96;
    let right=-64;
    for(const n of controls.sort((a,b)=>a.id.localeCompare(b.id))){
     const peers=[...new Set(edges.filter(e=>e.source===n.id||e.target===n.id).flatMap(e=>[e.source,e.target]))].filter(id=>placed[id]);
     const x=peers.length?peers.reduce((sum,id)=>sum+placed[id].x,0)/peers.length:0;
     placed[n.id]={x:Math.max(x,right+64),y:0};right=placed[n.id].x+n.data.geometry.width;
    }
   }
   const anchor=nodes.find(n=>n.id===path.at(-1))??nodes[0];
   const center=anchor?placed[anchor.id].y+anchor.data.geometry.height/2:0;
   const left=Math.min(0,...Object.values(placed).map(p=>p.x)),width=Math.max(0,...nodes.map(n=>placed[n.id].x+n.data.geometry.width))-left;
   plans.push({nodes,placed,left,width,center});
  }
  const baseline=Math.max(100,...plans.map(p=>p.center))+80;let x=0;positions={};
  for(const plan of plans){for(const n of plan.nodes)positions[n.id]={x:x+plan.placed[n.id].x-plan.left,y:baseline+plan.placed[n.id].y-plan.center};x+=plan.width+220;}
  if(pass<2)graph=scopeDiagram(model,scope,{...options,positions,reading,measureOnly:true});
 }
 return positions;
}
