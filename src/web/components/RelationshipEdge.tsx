import {BaseEdge,type EdgeProps} from '@xyflow/react';
import {relationshipRoute} from '../graph/route';
export function RelationshipEdge(props:EdgeProps){
 const {sourceX:sx,sourceY:sy,targetX:tx,targetY:ty,data}=props;
 const leader=data?.labelLeader as {x1:number;y1:number;x2:number;y2:number}|undefined;
 const {path,x,y}=relationshipRoute(sx,sy,tx,ty,data);
 return <g>{leader&&!data?.labelHidden&&!data?.labelSharedWith&&<line {...leader} stroke={String(data?.color??'#64758b')} strokeWidth={1}/>}<title>{String(data?.title??props.label??'连接')} · 点击查看信号</title>{((data?.crossings as {x:number;y:number}[])??[]).map((p,i)=><circle key={`cross-${i}`} cx={p.x} cy={p.y} r={3.5} fill="white" pointerEvents="none"/>)}<BaseEdge id={props.id} path={path} label={data?.labelHidden||data?.labelSharedWith?undefined:props.label} labelX={x} labelY={y} markerEnd={props.markerEnd} style={props.style} labelStyle={{fontSize:16,fill:'#345469'}} labelBgStyle={{fill:'#fff',fillOpacity:0.96}} interactionWidth={18}/>{((data?.junctions as {x:number;y:number;color:string}[])??[]).map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={2.6} fill={p.color} pointerEvents="none"/>)}</g>;
}
