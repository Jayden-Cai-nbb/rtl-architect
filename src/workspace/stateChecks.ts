import type {Model,Endpoint,SignalValue} from '../core/schema';
import type {CheckBindings} from './contractChecks';
import {resolveEndpoint} from '../core/endpoints';
import {widthValue} from '../core/parameters';
import {endpointLabel,localSignalAnalysis} from '../core/signals';
import {ToolError} from './environment';
/** Whole-vector synchronous state rules only. No sourceText evaluation or guessed signal mapping. */
export function renderStateCheck(model:Model,b:CheckBindings['bindings'][number],localId:string,n:number,marker:string){
 const local=model.localSignals?.find(l=>l.id===localId&&l.scope===b.moduleId),m=model.modules.find(m=>m.id===b.moduleId)!;
 if(!local||local.driver.kind!=='register'||!local.driver.update||!b.state||m.instances)throw new ToolError('CHECK_STATE_UNSUPPORTED','需要单实例、完整向量更新规则及显式 state 引脚映射');
 const u=local.driver.update,clock=model.clocks.find(c=>c.id===m.clock);
 if(!clock)throw new ToolError('CHECK_STATE_UNSUPPORTED','状态监视器需要明确的时钟沿');
 const width=widthValue(model,m,local.width),analysis=localSignalAnalysis(model,(scope,e)=>resolveEndpoint(model,scope,e)),mapping=new Map<string,string>(),pinChecks=[`$bits(${b.instancePath}.${b.state}) != ${width}`,`$bits(${b.instancePath}.${b.clock}) != 1`];
 for(const entry of b.signals??[]){
  const e=entry.endpoint,r=resolveEndpoint(model,b.moduleId,e),key=endpointLabel(e);
  if(e.index!==undefined||e.slice||e.sliceMapping||mapping.has(key)||!r||r.direction!=='source'||r.intf.protocol!=='signal')throw new ToolError('CHECK_BINDING_INVALID','状态引脚映射需唯一、完整 signal source；暂不支持数组实例');
  if(e.local&&model.localSignals?.find(l=>l.id===e.interfaceId)?.driver.kind==='comb')throw new ToolError('CHECK_BINDING_INVALID','组合表达式由模型内联，不能用引脚替换其规则');
  mapping.set(key,`${b.instancePath}.${entry.pin}`);pinChecks.push(`$bits(${b.instancePath}.${entry.pin}) != ${r.width}`);
 }
 const state=`${b.instancePath}.${b.state}`;const own={moduleId:b.moduleId,interfaceId:local.id,local:true as const};
 if(mapping.has(endpointLabel(own)))throw new ToolError('CHECK_BINDING_INVALID','被检查状态由 state 映射，不能重复指定');
 mapping.set(endpointLabel(own),state);
 let budget=0;
 const render=(v:SignalValue,depth=0):string=>{
  if(++budget>4000||depth>64)throw new ToolError('CHECK_STATE_UNSUPPORTED','内联状态表达式超过检查器预算');
  if(v.kind==='constant')return `${v.width}'h${BigInt(v.value).toString(16)}`;
  if(v.kind==='endpoint'){
   const e=v.endpoint;if(e.index!==undefined||e.sliceMapping)throw new ToolError('CHECK_STATE_UNSUPPORTED','监视器暂不支持数组端点');
   const {slice,...whole}=e,source=e.local?model.localSignals?.find(l=>l.id===e.interfaceId&&l.scope===b.moduleId):undefined;
   const text=source?.driver.kind==='comb'?render(source.driver.value,depth+1):mapping.get(endpointLabel(whole));
   if(!text)throw new ToolError('CHECK_BINDING_INVALID','缺少状态表达式引脚映射：'+endpointLabel(whole));
   return slice?`${slice.msb-slice.lsb+1}'($unsigned(${text}) >> ${slice.lsb})`:`$unsigned(${text})`;
  }
  const args=(v.kind==='concat'?v.parts:v.operands).map(a=>render(a,depth+1)),w=analysis.value(b.moduleId,v).width;
  const text=v.kind==='concat'?`{${args.join(', ')}}`:v.operator==='mux'?`(${args[0]} ? ${args[1]} : ${args[2]})`:args.length===1?`(${v.operator}${args[0]})`:`(${args.join(' '+v.operator+' ')})`;
  return `${w}'(${text})`;
 };
 const reset=u.reset?render({kind:'endpoint',endpoint:u.reset.signal}):undefined;
 if(u.reset&&mapping.get(endpointLabel(u.reset.signal))!==`${b.instancePath}.${b.reset}`)throw new ToolError('CHECK_BINDING_INVALID','复位信号必须对应本绑定的 reset 引脚');
 const branches=u.branches.map(b=>({condition:render(b.condition),value:render(b.value)}));
 const fail=(why:string)=>`$fatal(1, "RTLARCH_OBL_FAIL ${b.moduleId}/${localId}: ${why}");`;
 let updateBody=`begin expected=${state}; hold_hits++; end`;
 for(let i=branches.length-1;i>=0;i--){const x=branches[i];updateBody=`begin if ($isunknown(${x.condition})) ${fail('unknown update condition')} if (${x.condition}) begin expected=${x.value}; branch_hits[${i}]++; end else ${updateBody} end`;}
 if(u.reset)updateBody=`begin if ($isunknown(${reset})) ${fail('unknown reset')} if (${reset} == 1'b${u.reset.activeLevel==='low'?'0':'1'}) begin expected=${render(u.reset.value)}; reset_hits++; end else ${updateBody} end`;
 const compare=`if (pending) begin if (${state} !== expected) ${fail('state transition mismatch')} hits++; pending=0; end`;
 return `begin : obligation_${n}
 integer hits=0, reset_hits=0, hold_hits=0; integer branch_hits[${branches.length}]='{default:0};
 logic [${width-1}:0] expected; bit pending=0;
 initial if (${pinChecks.join(' || ')}) ${fail('mapped pin width differs from state model')}
 // Capture pre-update state/inputs at the active edge; compare after NBA at the opposite edge.
 always @(${clock.edge==='rising'?'posedge':'negedge'} ${b.instancePath}.${b.clock}) begin
  if (pending) ${fail('previous update was not observed')}
  ${updateBody}
  if ($isunknown(expected)) ${fail('unknown expected state')}
  pending=1;
 end
 always @(${clock.edge==='rising'?'negedge':'posedge'} ${b.instancePath}.${b.clock}) begin ${compare} end
 final begin
  if (pending || hits==0 || hold_hits==0${u.reset?' || reset_hits==0':''}${branches.map((_,i)=>` || branch_hits[${i}]==0`).join('')}) ${fail('not exercised: every declared branch, reset, hold and observation required')}
  $display("RTLARCH_STATE_COVER ${b.moduleId}/${localId} reset=%0d hold=%0d${branches.map((_,i)=>` branch${i}=%0d`).join('')}", reset_hits, hold_hits${branches.map((_,i)=>`, branch_hits[${i}]`).join('')});
  $display("${marker} hits=%0d", hits);
 end
end`;
}
