import {hardwareView} from '../../core/hardwareView';
import {useMemo} from 'react';
import type {Endpoint,Model} from '../../core/schema';
import {inspectScope,interfaceGroup,type Inspection} from '../../core/inspection';
import {endpointLabel} from '../../core/signals';
import {PageList} from './Issues';
import {RelatedEvidence} from './Evidence';
export function SignalInspection({model,scope,inspection,inspect,choose,navigateEndpoint,arrayControlsId}:{model:Model;scope:string;inspection?:Inspection;arrayControlsId?:string;inspect:(value:Inspection|undefined)=>void;choose:(id:string)=>void;navigateEndpoint:(endpoint:Endpoint)=>void}){
 const detail=useMemo(()=>inspectScope(model,scope,inspection),[model,scope,inspection]);
 const hardware=useMemo(()=>hardwareView(model,scope),[model,scope]);
 const boundaryPorts=inspection?.kind==='boundary'?model.modules.find(m=>m.id===scope)!.interfaces.filter(p=>p.role===inspection.role&&(!inspection.groupId||interfaceGroup(model,{moduleId:scope,interfaceId:p.id}).id===inspection.groupId)):[];
 const boundaryName=boundaryPorts[0]?interfaceGroup(model,{moduleId:scope,interfaceId:boundaryPorts[0].id}).label:'';
 if(!inspection)return <p className="hint">在主图点选模块或连接。查看具体信号会保留模块位置和视口。</p>;
 const display=(e:Endpoint)=>endpointLabel({...e,moduleId:model.modules.find(m=>m.id===e.moduleId)?.name??e.moduleId});
 const array=detail.array,relatedArrays=model.modules.filter(m=>m.instances&&detail.links.some(l=>[l.from,l.to].some(e=>e.moduleId===m.id)));
 const focusLink=(id:string)=>{inspect({kind:'connection',ids:[id],...(array?{index:array}:{})});choose(id)};
 return <section className="signal-inspection" data-testid="signal-inspection"><div className="section-title"><h3>{array?(arrayControlsId===array.moduleId?'连接与缺口':`元素 [${array.index}]`):inspection.kind==='boundary'?`${inspection.role==='consumer'?'输入':'输出'}${inspection.groupId?' · '+boundaryName:''}`:'信号详情'}</h3><button onClick={()=>inspect(undefined)}>返回总览</button></div>
 {inspection.kind==='local'&&inspection.purpose&&<p className="hint" data-testid="state-trace-purpose">{inspection.purpose==='data'?'突出当前状态的写入值及其来源。':'突出当前状态的更新条件与复位。'}当前状态按显式规则展开，上游寄存状态默认停止；淡化的背景关系仍保留。</p>}<p className="hint">当前追踪 {detail.depth} 层组合依赖；{inspection.crossState?'已允许跨寄存器，依赖不代表同周期逻辑锥。':'遇到寄存状态停止。'}未声明规则的状态仅有输入集合，不声称精确字段依赖。</p>
 {!!detail.stateBoundaries.length&&<p className="hint">状态边界：{detail.stateBoundaries.join('、')}</p>}
 {!!detail.limited.length&&<p className="hint">{detail.limited.length} 项到达深度或规模上限；完整连接仍保留在模型中。</p>}
 <div className="actions"><button disabled={detail.depth>=8} onClick={()=>inspect({...inspection,depth:detail.depth+1})}>再追一层</button>{!!detail.stateBoundaries.length&&<button onClick={()=>inspect({...inspection,crossState:true,depth:detail.depth+1})}>跨状态继续</button>}</div>
 {array?<p>{detail.links.length} 条本元素连接；数组共记录 {detail.summaryCount} 条规则。{arrayControlsId!==array.moduleId&&<button onClick={()=>inspect({kind:'module',id:array.moduleId})}>回到数组汇总</button>}</p>:<p>{detail.links.length} 条模型连接规则。显示分组仅用于阅读；每条仍对应原始端口。</p>}
 {relatedArrays.filter(m=>m.id!==arrayControlsId).map(m=><label key={m.id}>{m.name} 索引<input aria-label={`检查 ${m.id} 索引`} type="number" min={m.instances!.from} max={m.instances!.to} value={array?.moduleId===m.id?array.index:''} placeholder="数组汇总" onChange={e=>{const index=Number(e.target.value);if(e.target.value!==''&&Number.isSafeInteger(index)&&index>=m.instances!.from&&index<=m.instances!.to)inspect(inspection.kind==='connection'?{...inspection,index:{moduleId:m.id,index}}:{kind:'array',id:m.id,index})}}/></label>)}
 {array&&<div className={detail.missing.length?'warning-box':'hint'} data-testid="element-coverage">{detail.missing.length?`该元素有 ${detail.missing.length} 个必连端口尚未完整导入；以下是模型缺口，不能据此判断 RTL 悬空。`:'该元素的模型必连端口已记录连接；行为和源码覆盖仍需核对。'}{detail.missing.length>0&&<details><summary>查看缺口</summary><PageList items={detail.missing} render={item=><p key={item.interfaceId}>{item.interfaceId} · {item.bits.map(b=>`[${b.msb}:${b.lsb}]`).join(', ')}</p>}/></details>}</div>}
 {inspection.kind==='boundary'&&<><p>{boundaryPorts.length} 个端口{inspection.groupId&&<button onClick={()=>inspect({kind:'boundary',role:inspection.role})}>查看全部{inspection.role==='consumer'?'输入':'输出'}</button>}</p><PageList key={`${inspection.role}-${inspection.groupId}`} items={boundaryPorts} render={p=><p key={p.id}><strong>{p.id}</strong><button onClick={()=>inspect({kind:'connection',ids:model.connections.filter(l=>l.scope===scope&&[l.from,l.to].some(e=>!e.local&&e.moduleId===scope&&e.interfaceId===p.id)).map(l=>l.id)})}>查看连线</button></p>}/></>}
 <PageList items={detail.resolved} render={({link,width,group},i)=><article className="signal-row" key={`${link.id}-${i}`}><button className="text-button" title={`${endpointLabel(link.from)} → ${endpointLabel(link.to)}`} onClick={()=>focusLink(link.id)}>{display(link.from)} → {display(link.to)}</button><p>{group.label} · {width??'待求值'} 位 · <code>{link.id}</code></p>{hardware.relationships.filter(r=>r.id===link.id).map(r=><div key={r.id} className="hint"><p>{r.meaning}</p>{r.kind==='ready_valid'&&<p data-testid="rv-members">data [{width??'?'}b] → · valid [1b] → · ready [1b] ←</p>}{r.classification==='conflict'&&<p>两端分组冲突，请核对用途。</p>}<small>来源：当前模型连接 {r.id}{r.evidenceIds.length?`；关联证据 ${r.evidenceIds.join('、')}（新鲜度需另核对）`:'；尚无直接关联证据'}。</small></div>)}<RelatedEvidence model={model} kind="connection" itemId={link.id}/>{[link.from,link.to].filter(e=>!e.local&&model.modules.find(m=>m.id===e.moduleId)?.kind==='subsystem').map((e,n)=><button key={n} onClick={()=>navigateEndpoint(e)}>{e.moduleId===scope?'到父层':'进入模块'} · {e.interfaceId}</button>)}</article>}/>
 {!detail.links.length&&<p className="warning-box">此范围没有已记录的连接。请核对导入范围和源码，不会借用其他元素的连线。</p>}
 </section>;
}
