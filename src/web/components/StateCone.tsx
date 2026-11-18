import type {stateConeDiagram} from '../graph/stateConeDiagram';
import {useEffect,useMemo,useRef,useState} from 'react';
import {modelStateCone,observedStateCone,type StateCone} from '../../core/nextStateCone';
import type {Model} from '../../core/schema';
import type {StateComparison} from '../../core/stateObservation';
function ConeDiagram({cone,expand}:{cone:StateCone;expand?:(id:string)=>void}){
 const [selected,setSelected]=useState<string>();
 const [drawing,setDrawing]=useState<{cone:StateCone;graph:ReturnType<typeof stateConeDiagram>}>(),[error,setError]=useState('');
 const [zoom,setZoom]=useState<number|'fit'>(1),[availableWidth,setAvailableWidth]=useState(1000);
 const scroll=useRef<HTMLDivElement>(null);
 // Never look up new nodes in geometry belonging to the previous projection.
 const geometry=drawing?.cone===cone?drawing.graph:undefined;
 useEffect(()=>{setDrawing(undefined);setError('');const worker=new Worker(new URL('../graph/stateCone.worker.ts',import.meta.url),{type:'module'});worker.onmessage=e=>{if(e.data.error)setError(e.data.error);else setDrawing({cone,graph:e.data.graph});worker.terminate()};worker.onerror=e=>{setError(e.message);worker.terminate()};worker.postMessage(cone);return()=>worker.terminate()},[cone]);
 useEffect(()=>{const target=scroll.current;if(!target)return;const resize=new ResizeObserver(()=>setAvailableWidth(target.clientWidth));resize.observe(target);return()=>resize.disconnect()},[]);
 const scale=zoom==='fit'&&geometry?Math.min(1,Math.max(1,availableWidth-16)/geometry.width,500/geometry.height):zoom==='fit'?1:zoom;
 const n=cone.nodes.find(n=>n.id===selected);
 const incident=cone.edges.filter(e=>e.source===selected||e.target===selected);
 function locate(id:string){setSelected(id);const node=geometry?.nodes.find(n=>n.id===id);if(node&&geometry)scroll.current?.scrollTo({left:Math.max(0,(node.position.x-geometry.left)*scale-40),top:Math.max(0,(node.position.y-geometry.top)*scale-40),behavior:'auto'})}
 return <section className="state-cone" data-testid="state-cone" data-source={cone.source}>
 <p><strong>{cone.source==='model_ast'?'来源：模型 AST / register.update':'来源：RTL observe-state 观察产物'}</strong><br/><code>{cone.identity}</code></p><p>{cone.note}</p>
 {cone.boundaries.length>0&&<p role="status">存在 {cone.boundaries.length} 项 UNKNOWN / 范围边界；未补猜测逻辑。</p>}
 <div className="cone-tools">
 <button onClick={()=>{setZoom('fit');scroll.current?.scrollTo(0,0)}}>全图</button><button onClick={()=>setZoom(1)}>阅读大小</button>
 <button aria-label="缩小逻辑锥" disabled={scale<=.1} onClick={()=>setZoom(Math.max(.1,scale/1.25))}>−</button><output>{Math.round(scale*100)}%</output><button aria-label="放大逻辑锥" disabled={scale>=2} onClick={()=>setZoom(Math.min(2,scale*1.25))}>＋</button>
 <label>定位状态或规则 <select aria-label="定位状态或规则" value={selected??''} onChange={e=>locate(e.target.value)}><option value="">选择节点</option>{cone.nodes.filter(node=>['D','Q','hold'].includes(node.kind)||node.priority!==undefined||node.id===selected).map(node=><option key={node.id} value={node.id}>{node.label} · {node.origin.split('/')[0]}</option>)}</select></label>
 <span>{cone.nodes.length} 个表达式/边界节点 · {cone.edges.length} 条依赖；选择仅高亮直接依赖。</span>
 </div>
 {error&&<p role="alert">{error}</p>}{!geometry&&!error&&<p role="status">正在准备有限逻辑锥…</p>}
 <div className="cone-scroll" ref={scroll}>{geometry&&<svg width={geometry.width*scale} height={geometry.height*scale} viewBox={`${geometry.left} ${geometry.top} ${geometry.width} ${geometry.height}`} role="img" aria-label="有限下一状态逻辑锥">
 {geometry.edges.map(e=>{const points=e.data?.routePoints as {x:number;y:number}[]|undefined;const end=points?.at(-1),active=e.source===selected||e.target===selected;const color=active?'#146e89':/select|condition|reset/.test(String(e.data?.role))?'#9c6a32':'#527c91';return <g key={e.id} data-edge-id={e.id}><path d={String((e.data?.route as {path?:string})?.path??'')} fill="none" stroke={color} strokeWidth={active?3:1}/>{end&&<path d={`M${end.x-6},${end.y-3} L${end.x},${end.y} L${end.x-6},${end.y+3}`} fill="none" stroke={color}/>}<title>{e.source} → {e.target} · {String(e.data?.role)}</title></g>})}
 {cone.nodes.map(node=>{const box=geometry.nodes.find(g=>g.id===node.id)!,p=box.position,g=box.data.geometry;return <g key={node.id} data-node-id={node.id} role="button" aria-pressed={selected===node.id} tabIndex={0} aria-label={node.label} onClick={()=>setSelected(node.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(node.id)}}}>
 <title>{node.label+'\n'+node.origin+'\n'+(node.detail??'')}</title><rect x={p.x} y={p.y} width={g.width} height={g.height} rx={5} fill={node.kind==='boundary'?'#fff3df':node.kind==='Q'||node.kind==='D'?'#eaf4ea':'#f2f7fa'} stroke={selected===node.id?'#146e89':'#a1b4c0'} strokeWidth={selected===node.id?3:1}/>
 <text x={p.x+10} y={p.y+22} fontSize={12}>{node.kind} · {node.id}{node.priority!==undefined?` · 优先级 ${node.priority}`:''}</text><text x={p.x+10} y={p.y+47} fontSize={13}>{node.label.length>26?node.label.slice(0,25)+'…':node.label}</text><text x={p.x+10} y={p.y+75} fontSize={12}>{node.width??'?'} bit · {node.signed===null?'signedness UNKNOWN':node.signed?'signed':'unsigned'}{(node.references?.length??0)>1?` · ${node.references!.length} 处引用`:''}</text>
 {g.ports.filter(p=>p.direction==='target').map(port=><text key={port.id} x={p.x+12} y={p.y+port.y+4} fontSize={11}>{port.label}</text>)}</g>})}
 </svg>}</div>
 {geometry?.edges.some(e=>e.data?.routingFallback)&&<p>部分依赖未找到避障路径；保留端点清单，不视为几何通过。</p>}
 {n&&<div className="cone-detail" data-testid="cone-detail"><strong>{n.label}</strong><p><code>{n.origin}</code> · {n.detail}</p>
 {n.references&&<details><summary>{n.references.length} 处引用与声明角色（身份相同才共用显示节点）</summary><ul>{n.references.map((r,i)=><li key={i}><code>{r.path}</code> · {r.consumer} · {r.role??'未声明额外角色'}</li>)}</ul></details>}
 {incident.length>0&&<ul>{incident.map((e,i)=><li key={i}>{e.source===n.id?'流向':'来自'} <button onClick={()=>locate(e.source===n.id?e.target:e.source)}>{cone.nodes.find(node=>node.id===(e.source===n.id?e.target:e.source))?.label}</button> · {e.role}</li>)}</ul>}
 {n.expandState&&expand&&<button onClick={()=>expand(n.expandState!)}>显式展开 {n.expandState} 的下一状态（Q 仍为沿前值）</button>}</div>}
 <details><summary>完整节点、端点角色与规则顺序</summary><pre>{JSON.stringify(cone,null,2)}</pre></details></section>;
}
export function ModelStateCone({model,scope,id,modelHash}:{model:Model;scope:string;id:string;modelHash:string}){
 const [open,setOpen]=useState(false),[expanded,setExpanded]=useState<string[]>([]);
 const cone=useMemo(()=>open?modelStateCone(model,scope,id,modelHash,expanded):undefined,[open,model,scope,id,modelHash,expanded]);
 return <section><button aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'收起':'查看'}模型下一状态逻辑锥</button>{expanded.length>0&&<button onClick={()=>setExpanded([])}>收回上游展开</button>}{cone&&<ConeDiagram cone={cone} expand={key=>setExpanded(ids=>ids.includes(key)?ids:[...ids,key])}/>}</section>;
}
export function ObservedStateCone({observed,status,reason,identity}:{observed?:StateComparison['observed'];status:string;reason:string;identity:string}){
 const [open,setOpen]=useState(false),cone=useMemo(()=>open?observedStateCone(observed,status,reason,identity):undefined,[open,observed,status,reason,identity]);
 return <section><button aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'收起':'查看'} RTL 观察逻辑锥</button>{cone&&<div className="modal-backdrop"><section role="dialog" aria-label="RTL 观察逻辑锥" className="modal wide cone-dialog"><button onClick={()=>setOpen(false)}>关闭观察逻辑锥</button><ConeDiagram cone={cone}/></section></div>}</section>;
}
