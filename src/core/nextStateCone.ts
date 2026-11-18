import type {Model,SignalValue} from './schema';
import {resolveEndpoint} from './endpoints';
import {widthValue} from './parameters';
import {localSignalAnalysis,endpointLabel,signalChildren} from './signals';
import {dependencyRoles} from './hardwareView';
import {stateDescription} from './stateUpdates';
import type {StateComparison,Bit} from './stateObservation';
export type ConeNode={id:string;kind:string;label:string;width:number|null;signed:boolean|null;origin:string;references?:{path:string;consumer:string;role?:string}[];detail?:string;expandState?:string;priority?:number};
export type ConeEdge={source:string;target:string;role:string};
export type StateCone={source:'model_ast'|'rtl_observation';identity:string;nodes:ConeNode[];edges:ConeEdge[];boundaries:string[];rules:NonNullable<ReturnType<typeof stateDescription>>['rows'];note:string};
function builder(source:StateCone['source'],identity:string){
 const cone:StateCone={source,identity,nodes:[],edges:[],boundaries:[],rules:[],note:source==='model_ast'?'模型声明的下一状态表达式；不是综合后门级结构。Q 为沿前值，D 在有效沿写入；位置不代表优先级或周期。':'已有 observe-state 展开产物的有限投影；不是工艺映射门级结构，也不证明完整时序等价。'};
 const add=(kind:string,label:string,width:number|null,signed:boolean|null,origin:string,extra:Partial<ConeNode>={})=>{const n={id:`n${cone.nodes.length}`,kind,label,width,signed,origin,...extra};cone.nodes.push(n);return n.id};
 const boundary=(reason:string,origin:string,width:number|null=null)=>{cone.boundaries.push(reason);return add('boundary','UNKNOWN / 边界',width,null,origin,{detail:reason})};
 const edge=(source:string,target:string,role:string)=>cone.edges.push({source,target,role});
 return {cone,add,boundary,edge};
}
/** No persisted semantics. Every result type is obtained from the existing AST analyzer. */
export function modelStateCone(model:Model,scope:string,id:string,identity:string,expanded:string[]=[]):StateCone{
 const {cone,add,boundary,edge}=builder('model_ast',identity),analysis=localSignalAnalysis(model,(s,e)=>resolveEndpoint(model,s,e));
 cone.note+=` 来源完整性：${model.provenance?.fidelity??'UNKNOWN'}。`;
 const locals=new Map((model.localSignals??[]).filter(s=>s.scope===scope).map(s=>[s.id,s]));
 const owner=model.modules.find(m=>m.id===scope),qs=new Map<string,string>(),endpoints=new Map<string,string>();let budget=0;let exhausted:string|undefined;let consumer=id;
 const roles=new Map([...locals].map(([key,local])=>[key,dependencyRoles(local)]));
 const reference=(nodeId:string,path:string,label:string,usedBy:string)=>{const n=cone.nodes.find(n=>n.id===nodeId)!;n.references??=[];if(!n.references.some(r=>r.path===path&&r.consumer===usedBy))n.references.push({path,consumer:usedBy,role:roles.get(usedBy)?.get(label)});return nodeId};
 const width=(key:string)=>{try{return owner?widthValue(model,owner,locals.get(key)!.width):null}catch{return null}};
 const q=(key:string)=>{if(qs.has(key))return qs.get(key)!;const n=add('Q',`${key} · Q（沿前）`,width(key),false,`local:${scope}:${key}`,{expandState:key!==id?key:undefined});qs.set(key,n);return n};
 function value(v:SignalValue,path:string,stack:string[],depth=0,usedBy=consumer):string{
  if(++budget>128||depth>24)return exhausted??=boundary('达到 128 表达式 / 24 层预算；未展开部分不代表不存在',path);
  let type:{width:number;signed:boolean};try{type=analysis.value(scope,v)}catch(e){return boundary(String(e),path)}
  if(v.kind==='endpoint'){
   const e=v.endpoint,local=e.local?locals.get(e.interfaceId):undefined;
   if(e.local&&!local)return boundary('缺失本层局部信号',path,type.width);
   const key=JSON.stringify([scope,e.moduleId,e.interfaceId,e.local===true,e.index??null,e.slice?[e.slice.msb,e.slice.lsb]:null]);
   const remember=(nodeId:string)=>{endpoints.set(key,nodeId);return reference(nodeId,path,endpointLabel(e),usedBy)};
   if(local?.driver.kind==='comb'&&stack.includes(local.id))return boundary('组合依赖环',path,type.width);
   if(endpoints.has(key))return reference(endpoints.get(key)!,path,endpointLabel(e),usedBy);
   if(local?.driver.kind==='register'){
    const from=q(local.id);if(!e.slice)return remember(from);
    const n=add('slice',`切片 [${e.slice.msb}:${e.slice.lsb}]`,type.width,false,path);edge(from,n,'data');return remember(n);
   }
   const n=remember(add('endpoint',endpointLabel(e),type.width,false,path));
   if(local?.driver.kind==='comb'){
    edge(value(local.driver.value,`local:${scope}:${local.id}/value`,[...stack,local.id],depth+1,local.id),n,e.slice?`slice [${e.slice.msb}:${e.slice.lsb}] → unsigned`:'位向量 → unsigned');
   }
   return n;
  }
  const label=v.kind==='constant'?v.value:v.kind==='cast'?`${v.mode}${v.mode==='truncate'?` [${v.width-1}:0]`:''}`:v.kind==='concat'?'concat（高位到低位）':v.operator==='mux'?'MUX':v.operator;
  const n=add(v.kind,label,type.width,type.signed,path);
  signalChildren(v).slice(0,64).forEach((child,i)=>{const role=v.kind==='operator'&&v.operator==='mux'?['select','data:1','data:0'][i]:v.kind==='operator'&&['<<','>>','>>>'].includes(v.operator)&&i===1?'shift amount':`data:${i}`;edge(value(child,`${path}/${i}`,stack,depth+1,usedBy),n,role)});
  if(signalChildren(v).length>64)edge(boundary(`另有 ${signalChildren(v).length-64} 个操作数达到显示预算`,path),n,'未展开操作数');
  return n;
 }
 for(const key of [...new Set([id,...expanded])].slice(0,9)){
  consumer=key;
  const local=locals.get(key),d=add('D',`${key} · D（下一沿）`,width(key),false,`local:${scope}:${key}/D`);
  if(local?.driver.kind==='register')q(key);
  if(!local||local.driver.kind!=='register'||!local.driver.update){edge(boundary('缺少 register.update；sourceText 不执行',key),d,'data');continue;}
  if(key===id)cone.rules=stateDescription(local)!.rows;
  try{analysis.local(key)}catch(e){edge(boundary(String(e),key),d,'data');continue;}
  const u=local.driver.update;
  const hold=add('hold','保持 Q',width(key),false,`${key}/otherwise`);edge(q(key),hold,'hold');let next=hold;
  for(let i=u.branches.length-1;i>=0;i--){
   const b=u.branches[i],origin=`local:${scope}:${key}/update/branches/${i}`;
   const mux=add('mux',`MUX · 优先级 ${i+(u.reset?2:1)} · ${b.id}`,width(key),false,origin,{priority:i+(u.reset?2:1)});
   edge(value(b.condition,origin+'/condition',[]),mux,'condition / select');edge(value(b.value,origin+'/value',[]),mux,'data:1');edge(next,mux,'data:0');next=mux;
  }
  if(u.reset){
   const path=`local:${scope}:${key}/update/reset`,mux=add('reset','同步复位 MUX · 优先级 1',width(key),false,path,{priority:1});
   let condition=value({kind:'endpoint',endpoint:u.reset.signal},path+'/signal',[]);
   if(u.reset.activeLevel==='low'){const invert=add('operator','!（低有效复位）',1,false,path+'/activeLevel');edge(condition,invert,'condition');condition=invert;}
   edge(condition,mux,'reset / select');edge(value(u.reset.value,path+'/value',[]),mux,'data:1');edge(next,mux,'data:0');next=mux;
  }
  edge(next,d,'data');
 }
 if(expanded.length>8)cone.boundaries.push('最多显式扩展 8 个上游状态');
 return cone;
}
/** Read existing observation vectors/cells only. No HDL parsing or semantic comparison here. */
export function observedStateCone(observed:StateComparison['observed'],status:string,reason:string,identity:string):StateCone{
 const {cone,add,boundary,edge}=builder('rtl_observation',identity);
 cone.note+=` 观察结论：${status}；${reason}。`;
 const d=add('D','RTL D',observed?.width??null,false,'nextBits');
 if(!observed||!['MATCH','MISMATCH','EXTRACTED'].includes(status)){edge(boundary(`${status}: ${reason}`,'observation'),d,'data');return cone;}
 const q=add('Q','RTL Q（沿前）',observed.width,false,'stateBits');
 const same=(a:Bit[],b:Bit[])=>JSON.stringify(a)===JSON.stringify(b),memo=new Map<string,string>(),active=new Set<string>();let count=0;
 const supported=new Set(['$mux','$pmux','$not','$logic_not','$reduce_and','$reduce_or','$reduce_xor','$reduce_xnor','$reduce_bool','$pos','$and','$or','$xor','$xnor','$logic_and','$logic_or','$add','$sub','$eq','$ne','$lt','$le','$gt','$ge','$shl','$shr','$sshl','$sshr']);
 function vector(bits:Bit[],depth=0):string{
  if(++count>128||depth>24)return boundary('观察范围达到预算','bits',bits.length);
  if(same(bits,observed!.stateBits))return q;
  if(bits.some(b=>b==='x'||b==='z'))return boundary('观察产物包含 X/Z',JSON.stringify(bits),bits.length);
  if(bits.every(b=>b==='0'||b==='1'))return add('constant',`0b${[...bits].reverse().join('')}`,bits.length,false,'constant bits');
  const key=JSON.stringify(bits);
  const drivers=observed!.cells.filter(c=>same(c.connections.Y??[],bits));
  if(drivers.length!==1){
   if(bits.every(b=>typeof b==='number'&&observed!.leafBits.includes(b))){cone.boundaries.push('输入 / 上游状态边界：'+key);return add('boundary','输入 / 上游状态边界',bits.length,false,key,{detail:'已有观察仅保存叶位；未猜测输入名或上游状态映射。'});}
   return boundary('位序、切片或驱动无法由完整向量唯一对应；保留真实位清单',key,bits.length);
  }
  const c=drivers[0];if(memo.has(key)&&!active.has(c.name))return memo.get(key)!;if(!supported.has(c.type)||active.has(c.name))return boundary('未支持单元或依赖环：'+c.type,c.name,bits.length);
  active.add(c.name);
  const n=add(c.type==='$mux'||c.type==='$pmux'?'mux':'operator',c.type,bits.length,null,c.name,{detail:`产物未记录表达式结果 signedness；不从端口位向量推断。运算扩展/符号参数：${JSON.stringify(c.parameters)}\n${c.source??'源码位置未知'}`});
  memo.set(key,n);
  for(const [port,input] of Object.entries(c.connections))if(port!=='Y'){
   const hold=c.type==='$mux'&&['A','B'].includes(port)&&same(input,observed!.stateBits);
   const role=port==='S'?'select S':c.type==='$mux'?(port==='A'?'data:0 A':'data:1 B'):['$shl','$shr','$sshl','$sshr'].includes(c.type)&&port==='B'?'shift amount B':`data ${port}`;
   edge(vector(input,depth+1),n,(hold?'hold Q / ':same(input,observed!.stateBits)?'old Q / ':'')+role);
  }
  active.delete(c.name);return n;
 }
 edge(vector(observed.nextBits),d,'data');return cone;
}
