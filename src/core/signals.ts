import type { Endpoint, Interface, Link, Model, Module, SignalValue, StateUpdate } from './schema';
import { widthValue } from './parameters';
export function endpointInstances(model:Model,endpoint:Endpoint):Endpoint[]{
 const m=model.modules.find(m=>m.id===endpoint.moduleId);
 if(endpoint.index!=='all')return [endpoint];
 if(!m?.instances)throw new Error('all 索引只适用于实例数组');
 const count=m.instances.to-m.instances.from+1;if(count<1||count>4096)throw new Error('实例数组范围须为1..4096个元素');
 return Array.from({length:count},(_,i)=>({...endpoint,index:m.instances!.from+i}));
}
// Resolve one rule to concrete endpoints. IDs remain the stored connection ID.
export function expandLink(model:Model,link:Link,selection?:{moduleId:string;index:number}):Link[]{
 const from=endpointInstances(model,link.from),to=endpointInstances(model,link.to);
 if(from.length>1&&to.length>1&&from.length!==to.length)throw new Error('逐元素连接的数组长度必须一致');
 const count=Math.max(from.length,to.length),links:Link[]=[];
 for(let i=0;i<count;i++){
  const a=from[from.length===1?0:i],b=to[to.length===1?0:i];
  if(selection&&![a,b].some(e=>e.moduleId===selection.moduleId&&e.index===selection.index))continue;
  const mapped=(endpoint:Endpoint):Endpoint=>{
   const rule=endpoint.sliceMapping;if(!rule)return endpoint;
   if(endpoint.slice)throw new Error('固定切片和索引切片规则不能同时设置');
   const source=[a,b].find(e=>e.moduleId===rule.arrayModuleId&&typeof e.index==='number');
   if(!source||!model.modules.find(m=>m.id===rule.arrayModuleId)?.instances)throw new Error('切片规则必须引用此连接的数组端点');
   const lsb=(source.index as number)*rule.stride+rule.offset,msb=lsb+rule.width-1;
   if(!Number.isSafeInteger(lsb)||!Number.isSafeInteger(msb)||lsb<0)throw new Error(`索引 ${source.index} 的切片超出安全非负整数范围`);
   const {sliceMapping:_,...rest}=endpoint;return {...rest,slice:{msb,lsb}};
  };
  links.push({...link,from:mapped(a),to:mapped(b)});
 }return links;
}
export function signalReads(value:SignalValue):Endpoint[]{
 return value.kind==='endpoint'?[value.endpoint]:value.kind==='constant'?[]:(value.kind==='concat'?value.parts:value.operands).flatMap(signalReads);
}
export function stateUpdateReads(update:StateUpdate,purpose?:'data'|'control'):Endpoint[]{
 return [...(update.reset?(purpose==='data'?signalReads(update.reset.value):purpose==='control'?[update.reset.signal]:[update.reset.signal,...signalReads(update.reset.value)]):[]),...update.branches.flatMap(b=>purpose==='data'?signalReads(b.value):purpose==='control'?signalReads(b.condition):[...signalReads(b.condition),...signalReads(b.value)])];
}
export function driverReads(local:NonNullable<Model['localSignals']>[number]):Endpoint[]{
 return local.driver.kind==='comb'?signalReads(local.driver.value):local.driver.update?stateUpdateReads(local.driver.update):local.driver.inputs;
}
export type ResolvedSignal={module:Module;intf:Interface;direction:string;width:number|undefined;fullWidth:number|undefined};
export function localSignalAnalysis(model:Model,resolve:(scope:string,e:Endpoint)=>ResolvedSignal|undefined){
 const memo=new Map<string,{width:number;reads:Endpoint[]}>(),visiting=new Set<string>();let budget=0;
 function local(id:string):{width:number;reads:Endpoint[]}{
  if(memo.has(id))return memo.get(id)!;if(visiting.has(id))throw new Error(`局部组合驱动依赖环 ${id}`);
  const item=model.localSignals?.find(x=>x.id===id),scope=model.modules.find(m=>m.id===item?.scope);if(!item||!scope)throw new Error(`局部信号不存在 ${id}`);
  visiting.add(id);
  try {
   const declared=widthValue(model,scope,item.width);
   const result=item.driver.kind==='comb'?value(item.scope,item.driver.value):{width:declared,reads:driverReads(item).flatMap(e=>value(item.scope,{kind:'endpoint',endpoint:e}).reads)};
   if(item.driver.kind==='register'&&item.driver.update){
    const update=item.driver.update,keys=(items:Endpoint[])=>[...new Set(items.map(endpointLabel))].sort().join('|');
    if(keys(item.driver.inputs)!==keys(stateUpdateReads(update)))throw new Error('状态更新规则与 inputs 依赖集合不一致，不能遗漏或夹带输入');
    if(new Set(update.branches.map(b=>b.id)).size!==update.branches.length)throw new Error('状态分支 ID 必须唯一');
    for(const b of update.branches){if(value(item.scope,b.condition).width!==1)throw new Error('状态更新条件必须为 1 位');if(value(item.scope,b.value).width!==declared)throw new Error('状态写入值位宽与寄存器不一致');}
    if(update.reset){
     if(value(item.scope,{kind:'endpoint',endpoint:update.reset.signal}).width!==1||value(item.scope,update.reset.value).width!==declared)throw new Error('状态复位信号或复位值位宽不匹配');
     const reset=model.resets.find(r=>r.id===scope.reset);
     if(!reset||!reset.synchronous||reset.clock!==scope.clock||reset.activeLevel!==update.reset.activeLevel)throw new Error('显式状态更新当前仅支持同域同步复位，极性须与作用域一致');
    }
   }
   if(result.width!==declared)throw new Error(`局部信号 ${id} 位宽 ${declared} 与驱动 ${result.width} 不符`);
   const clocks=new Set(result.reads.map(e=>resolve(item.scope,e)?.module.clock).filter(Boolean));if(clocks.size>1||(scope.clock&&[...clocks].some(c=>c!==scope.clock)))throw new Error(`局部信号 ${id} 涉及不同声明时钟域`);
   memo.set(id,result);return result;
  }finally{visiting.delete(id)}
 }
 function value(scope:string,v:SignalValue,depth=0):{width:number;reads:Endpoint[]}{
  if(++budget>100000||depth>64)throw new Error('局部表达式超过支持的大小或深度');
  if(v.kind==='constant'){const number=BigInt(v.value);if(number<0n||number.toString(2).length>v.width)throw new Error('常量超过声明位宽，禁止静默截断');return {width:v.width,reads:[]};}
  if(v.kind==='endpoint'){
   if(v.endpoint.sliceMapping)throw new Error('局部表达式使用具体切片；索引切片规则只用于连接');
   if(v.endpoint.index==='all')throw new Error('局部表达式需明确数组单元素索引');
   const resolved=resolve(scope,v.endpoint);if(!resolved||resolved.direction!=='source'||resolved.intf.protocol!=='signal'||!resolved.width)throw new Error('表达式输入须为本 scope 的 signal source');
   if(v.endpoint.local){const item=model.localSignals?.find(x=>x.id===v.endpoint.interfaceId);if(item?.driver.kind==='comb')local(item.id);}
   return {width:resolved.width,reads:[v.endpoint]};
  }
  const args=(v.kind==='concat'?v.parts:v.operands).map(x=>value(scope,x,depth+1));
  const reads=args.flatMap(x=>x.reads);let width:number;
  if(v.kind==='concat')width=args.reduce((n,a)=>n+a.width,0);
  else {
   const unary=['~','!'].includes(v.operator),mux=v.operator==='mux';if(args.length!==(unary?1:mux?3:2))throw new Error('局部运算符操作数数量不符');
   if(!['!','&&','||'].includes(v.operator)&&(!mux?args.some(a=>a.width!==args[0].width):args[0].width!==1||args[1].width!==args[2].width))throw new Error('局部运算宽度不匹配，需显式切片/拼接');
   width=['!','&&','||'].includes(v.operator)?1:mux?args[1].width:args[0].width;
  }
  if(width<1||width>65536)throw new Error('局部表达式位宽超出1..65536');return {width,reads};
 }
 return {local,value};
}

export const endpointLabel=(e:Endpoint)=>`${e.moduleId}${e.index!==undefined?`[${e.index}]`:''}.${e.local?'local:':''}${e.interfaceId}${e.slice?`[${e.slice.msb}:${e.slice.lsb}]`:e.sliceMapping?`[${e.sliceMapping.arrayModuleId}索引×${e.sliceMapping.stride}+${e.sliceMapping.offset}，${e.sliceMapping.width}位]`:''}`;

export function signalText(value:SignalValue):string {
 if(value.kind==='endpoint'){const e=value.endpoint;return `${e.local?'local':e.moduleId}.${e.interfaceId}${e.index!==undefined?`[${e.index}]`:''}${e.slice?`[${e.slice.msb}:${e.slice.lsb}]`:''}`}
 if(value.kind==='constant')return `${value.width}bit(${value.value})`;
 if(value.kind==='concat')return `{${value.parts.map(signalText).join(', ')}}`;
 const args=value.operands.map(signalText);return value.operator==='mux'?`(${args[0]} ? ${args[1]} : ${args[2]})`:args.length===1?`${value.operator}${args[0]}`:`(${args.join(' '+value.operator+' ')})`;
}
