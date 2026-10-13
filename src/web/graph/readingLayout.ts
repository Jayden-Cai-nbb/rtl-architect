import {stageLayout} from './stageLayout';
import type { Model, ScopeLayout } from '../../core/schema';
import { scopeDiagram, type Positions,type DiagramOptions } from './scopeDiagram';
import {wireSpacing} from './ports';
import { autoReadingLayout } from './autoReadingLayout';

/** Shared online/offline layout: explicit plans take priority over automatic display hints. */
export async function arrangeScope(model: Model, scope: string, hash: string, reading?: ScopeLayout['reading'],options:DiagramOptions={}): Promise<Positions> {
  const diagram = scopeDiagram(model, scope,{...options,measureOnly:true,reading}), nodes = diagram.nodes.filter(n => !n.data.boundary);
  const ids = new Set(nodes.map(n => n.id));
  if (!reading) return autoReadingLayout(model, scope,options);
  if (reading.modelHash !== hash) throw new Error('阅读布局对应旧模型；核对展示约束并更新布局版本后重试。');
  if(reading.stages?.length)return stageLayout(model,scope,reading,options);
  const controls=new Set(reading.control);
  const controlNets=new Set(diagram.edges.filter(e=>(controls.has(e.source)&&ids.has(e.target))||(controls.has(e.target)&&ids.has(e.source))).map(e=>e.data?.netKey??e.id));
  const channelHeight=Math.max(180,controlNets.size*wireSpacing),gap=220;
  const dimensions=new Map(nodes.map(n=>[n.id,{width:240,height:120}]));
  const place=()=>{
    const size=(id:string)=>dimensions.get(id)!;
    const positions:Positions={}, mainY=reading.control.length?Math.max(...reading.control.map(id=>size(id).height))+channelHeight:100;
    let x=0;
    for(const id of reading.mainPath){positions[id]={x,y:mainY};x+=size(id).width+gap;}
    const middle=reading.mainPath[Math.floor(reading.mainPath.length/2)];
    let controlX=middle?positions[middle].x:0;
    if(reading.control.length>1)controlX=Math.max(0,(x-gap-reading.control.reduce((n,id)=>n+size(id).width+100,0)+100)/2);
    for(const id of reading.control){positions[id]={x:controlX,y:0};controlX+=size(id).width+100;}
    const nextY=new Map<string,number>(),rowHeight=Math.max(88,...reading.mainPath.map(id=>size(id).height));
    for(const {node,anchor} of reading.adjacent){
      const y=nextY.get(anchor)??mainY+rowHeight+180;
      positions[node]={x:positions[anchor].x,y};nextY.set(anchor,y+size(node).height+110);
    }
    const bottom=Math.max(100,...Object.entries(positions).map(([id,p])=>p.y+size(id).height))+140;
    const remaining=nodes.filter(n=>!positions[n.id]).sort((a,b)=>a.id.localeCompare(b.id));
    const step=Math.max(240,...remaining.map(n=>size(n.id).width))+gap;
    remaining.forEach((n,i)=>{positions[n.id]={x:(i%3)*step,y:bottom+Math.floor(i/3)*(Math.max(...remaining.map(n=>size(n.id).height))+110)};});
    return positions;
  };
  // Measure ports in the intended rows before choosing row spacing, without doing routing twice.
  const draft=place();
  for(const n of scopeDiagram(model,scope,{...options,positions:draft,measureOnly:true,reading}).nodes)if(ids.has(n.id))dimensions.set(n.id,n.data.geometry);
  return place();
}
