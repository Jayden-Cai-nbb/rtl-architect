import {useEffect} from 'react';
import {Handle,Position,useStore,useUpdateNodeInternals,type NodeProps} from '@xyflow/react';
import type {RtlNode} from '../graph/types';
import {portDetailZoom} from '../graph/ports';
import {diagramColors} from '../graph/scopeDiagram';
import {kindLabel} from '../reading';
export function ModuleNode({id,data,selected}:NodeProps<RtlNode>){
 const details=useStore(state=>state.transform[2]>=portDetailZoom);
 const side={WEST:Position.Left,EAST:Position.Right,NORTH:Position.Top,SOUTH:Position.Bottom};
 const update=useUpdateNodeInternals();useEffect(()=>{update(id)},[id,data.geometry,update]);
 if(data.kind==='region')return <div className="reading-region" style={{width:data.geometry.width,height:data.geometry.height}}><strong>{data.label}</strong><small>{data.summary}</small></div>;
 if(data.kind==='frame')return <div className="scope-frame" style={{width:data.geometry.width,height:data.geometry.height}}><strong title={data.label}>{data.label}</strong><small>{data.summary}</small></div>;
 if(data.kind==='rack')return <div className="boundary-rack" data-testid={`boundary-${data.role}`} style={{width:data.geometry.width,height:data.geometry.height}}><strong>{data.label}</strong>{(data.groups as {id:string;label:string;count:number}[]).map(group=><button type="button" className="boundary-group nodrag" data-group-id={group.id} key={group.id} title={`${group.label} · ${group.count} 个端口`} onClick={event=>{event.stopPropagation();(data.inspectGroup as ((id:string)=>void)|undefined)?.(group.id)}}><span>{group.label}</span><small>{group.count>1?group.count:''}</small></button>)}{data.geometry.ports.map(p=><Handle key={p.id} id={p.id} type={p.direction} position={side[p.side]} style={{left:p.x,top:p.y,transform:'translate(-50%,-50%)'}}/>)}</div>;
 const inspected=data.inspectedPorts as string[]|undefined;
 return <div data-testid={`module-${id}`} title={String(data.title??data.label)} className={`module-node kind-${data.kind} ${data.boundary?'boundary':''} ${data.mainDiagram?'main-module':''} ${selected?'selected':''}`} style={{width:data.geometry.width,height:data.geometry.height}}>
 {!data.boundary&&!data.localId&&<span className={`node-review ${data.reviewStatus??'DRAFT'}`} title={String(data.reviewStatus??'DRAFT')}/>}
 <div className="node-caption" style={data.mainDiagram?{position:'absolute',top:(data.geometry.captionY??24)-12,left:16,right:16}:undefined}><small className="node-kind">{kindLabel[data.kind]??data.kind}{Number(data.instanceCount)>1?` ×${data.instanceCount}${data.arrayIndex!==undefined?` · 元素 ${data.arrayIndex}`:''}`:''}</small><strong title={data.label}>{data.label}</strong></div>
 {!data.boundary&&!data.mainDiagram&&<div className="parameter-summary" title={data.summary}>{data.summary}</div>}
 {!!data.mainDiagram&&<svg className="module-port-names" style={{display:details?'block':'none'}} width={data.geometry.width} height={data.geometry.height} aria-label="模块接口名">{data.geometry.ports.filter(p=>p.label&&(data.activeHandles as string[]|undefined)?.includes(p.id)).map(p=><text key={p.id} data-port-id={p.id} x={p.labelX} y={p.labelY} textAnchor={p.textAnchor} fill={diagramColors[p.category??'other']}><title>{p.direction==='target'?'输入':'输出'}：{p.interfaceIds?.join(', ')}</title>{p.label}</text>)}</svg>}
 {data.geometry.ports.map(p=><div key={p.id}><Handle id={p.id} type={p.direction} position={side[p.side]} style={{left:p.x-1,top:p.y-1,transform:'translate(-50%,-50%)',opacity:(data.activeHandles as string[]|undefined)?.includes(p.id)?1:0}} data-testid={`handle-${id}-${p.id}`}/>{!data.mainDiagram&&<span className={`port-label ${p.side.toLowerCase()}`} style={{top:p.y-10}}>{data.compact?(data.ports.find(i=>i.id===p.id) as {label?:string})?.label:`${p.id} [${data.ports.find(i=>i.id===p.id)?.width??'?'}]`}</span>}</div>)}
 {inspected?.length?<div className="inspected-ports" title={inspected.join('\n')}>{inspected.slice(0,1).map(p=><small key={p}>{p}</small>)}{inspected.length>1&&<small>另 {inspected.length-1} 项 · 右侧查看</small>}</div>:null}
 </div>;
}
