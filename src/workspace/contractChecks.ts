import {renderStateCheck} from './stateChecks';
import {z} from 'zod';
import {writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {idSchema,modelSchema,endpointSchema,type Model} from '../core/schema';
import {hashValue,modelHash} from '../core/export';
import {widthValue} from '../core/parameters';
import {validateModel} from '../core/engine';
import {inputFile,newArtifactDirectory} from './artifacts';
import {ToolError} from './environment';
const identifier=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),path=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);
const pins=z.strictObject({data:identifier,valid:identifier,ready:identifier});
export const checkBindingsSchema=z.strictObject({schemaVersion:z.literal(1),testbench:identifier,bindings:z.array(z.strictObject({moduleId:idSchema,obligationId:idSchema,instancePath:path,clock:identifier,reset:identifier,interfaces:z.record(idSchema,pins),state:identifier.optional(),signals:z.array(z.strictObject({endpoint:endpointSchema,pin:identifier})).max(4096).optional()})).min(1).max(256)});
export type CheckBindings=z.infer<typeof checkBindingsSchema>;
export function renderChecks(model:Model,input:unknown){
 const manifest=checkBindingsSchema.parse(input),seen=new Set<string>(),items:{moduleId:string;obligationId:string;fingerprint:string;marker:string}[]=[];
 if(validateModel(model).some(i=>i.blocks.includes('commit')))throw new ToolError('CHECK_MODEL_INVALID','请先修复模型结构错误');
 const blocks=manifest.bindings.map((b,n)=>{
  const m=model.modules.find(m=>m.id===b.moduleId),o=m?.contract.obligations?.find(o=>o.id===b.obligationId),key=b.moduleId+'/'+b.obligationId;
  if(!m||!o||seen.has(key))throw new ToolError('CHECK_BINDING_INVALID','义务不存在或重复绑定：'+key);seen.add(key);
  if(o.kind==='state_transition'){
   if(b.instancePath.split('.')[0]!==manifest.testbench)throw new ToolError('CHECK_BINDING_INVALID','instancePath 必须从 testbench 开始');
   const fingerprint=hashValue({modelHash:modelHash(model),obligation:o,binding:b}),marker=`RTLARCH_OBL_PASS ${b.moduleId}/${o.id} ${fingerprint}`;
   items.push({moduleId:b.moduleId,obligationId:o.id,fingerprint,marker});
   return renderStateCheck(model,b,o.localSignalId,n,marker);
  }
  const clock=model.clocks.find(c=>c.id===m.clock),reset=model.resets.find(r=>r.id===m.reset);
  if(m.instances||!clock||!reset||!reset.synchronous||reset.clock!==clock.id)throw new ToolError('CHECK_UNSUPPORTED','检查器仅支持单实例、同域同步复位；未生成近似替代');
  if(b.instancePath.split('.')[0]!==manifest.testbench)throw new ToolError('CHECK_BINDING_INVALID','instancePath 必须从 testbench 开始');
  const pin=(id:string)=>{const p=b.interfaces[id];if(!p)throw new ToolError('CHECK_BINDING_INVALID','缺少接口映射：'+id);return Object.fromEntries(Object.entries(p).map(([k,v])=>[k,`${b.instancePath}.${v}`])) as Record<'data'|'valid'|'ready',string>;};
  const outId=o.kind==='fifo_ordering'?o.outputInterfaceId:o.interfaceId,out=pin(outId),width=widthValue(model,m,m.interfaces.find(p=>p.id===outId)!.width);
  const fingerprint=hashValue({module:m,obligation:o,binding:b,clock,reset}),marker=`RTLARCH_OBL_PASS ${b.moduleId}/${b.obligationId} ${fingerprint}`;
  items.push({moduleId:b.moduleId,obligationId:o.id,fingerprint,marker});
  const fail=(why:string)=>`$fatal(1, "RTLARCH_OBL_FAIL ${key}: ${why}");`,rst=`${b.instancePath}.${b.reset} === 1'b${reset.activeLevel==='low'?'0':'1'}`;
  let declarations='',resetBody='',body='',end='';
  const pinChecks=[`$bits(${out.data}) != ${width}`,`$bits(${out.valid}) != 1`,`$bits(${out.ready}) != 1`,`$bits(${b.instancePath}.${b.clock}) != 1`,`$bits(${b.instancePath}.${b.reset}) != 1`];
  if(o.kind==='ready_valid_stability'){
   declarations=`bit held=0; logic [${width-1}:0] previous;`;resetBody='held=0;';
   body=`if (held) begin if (${out.valid} !== 1'b1 || ${out.data} !== previous) ${fail('changed while stalled')} hits++; end\nheld=(${out.valid} === 1'b1 && ${out.ready} === 1'b0); previous=${out.data};`;
  }else if(o.kind==='reset_flush'){
   declarations='bit was_reset=0;';resetBody='was_reset=1;';body=`if (was_reset) begin if (${out.valid} !== 1'b0) ${fail('valid on first sample after reset')} hits++; end was_reset=0;`;
  }else{
   const inp=pin(o.inputInterfaceId),capacity=widthValue(model,m,o.capacity);
   pinChecks.push(`$bits(${inp.data}) != ${width}`,`$bits(${inp.valid}) != 1`,`$bits(${inp.ready}) != 1`);
   declarations=`logic [${width-1}:0] expected[$]; logic [${width-1}:0] value;`;resetBody='expected.delete();';
   body=`if (${inp.valid} === 1'b1 && ${inp.ready} === 1'b1) expected.push_back(${inp.data});
if (${out.valid} === 1'b1 && ${out.ready} === 1'b1) begin
 if (expected.size()==0) ${fail('output without accepted input')}
 value=expected.pop_front(); if (${out.data} !== value) ${fail('payload or ordering mismatch')} hits++;
end
if (expected.size()>${capacity}) ${fail('capacity exceeded')}`;
   end=`if (expected.size()!=0) ${fail('test ended with outstanding transactions')}`;
  }
  // Explicit harness instantiation avoids tool-specific bind/hierarchical synthesis support.
  return `begin : obligation_${n}
 integer hits=0; bit initialized=0; ${declarations}
 initial if (${pinChecks.join(' || ')}) ${fail('mapped pin width differs from contract')}
 always @(${clock.edge==='rising'?'posedge':'negedge'} ${b.instancePath}.${b.clock}) begin
  if (${rst}) begin initialized=1; ${resetBody} end
  else if (initialized) begin ${body} end
 end
 final begin
  if (!initialized || hits==0) ${fail('not exercised: reset and trigger required')}
  ${end}
  $display("${marker} hits=%0d", hits);
 end
end`;
 });
 const stateMode=manifest.bindings.some(b=>model.modules.find(m=>m.id===b.moduleId)?.contract.obligations?.some(o=>o.id===b.obligationId&&o.kind==='state_transition'));
 const source='`timescale 1ns/1ps\n// Instantiate rtlarch_contract_checks checks(); inside the declared testbench.\n'+(stateMode?'// State checks capture at the active edge and compare at the opposite edge; finish after comparison.':'// Sample before sequential NBA updates; reset must be sampled before checks start.')+'\nmodule rtlarch_contract_checks;\ngenerate\n'+blocks.join('\n')+'\nendgenerate\nendmodule\n';
 return {source,metadata:{schemaVersion:1 as const,modelHash:modelHash(model),manifest,items,sourceHash:hashValue(source),scope:stateMode?'Finite state monitors: capture at active edge, compare at opposite edge; every declared branch/reset/hold must be exercised; no formal or continuous-time proof.':'Finite simulation monitors; sampled synchronous reset required; no formal, liveness or CDC proof.'}};
}
export async function generateChecks(workspace:string,input:unknown,destination:string){
 const model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())),result=renderChecks(model,input),dir=await newArtifactDirectory(workspace,destination);
 await writeFile(join(dir,'checks.sv'),result.source,{flag:'wx'});await writeFile(join(dir,'checks.json'),JSON.stringify(result.metadata,null,2)+'\n',{flag:'wx'});
 return {directory:dir,metadata:relative(workspace,join(dir,'checks.json')),source:relative(workspace,join(dir,'checks.sv')),obligations:result.metadata.items,note:'在 testbench 中显式实例化 rtlarch_contract_checks；生成不等于通过。verify 使用 obligations 检查并声明全部源码、TB、配置和这两个生成文件。'};
}
/** Re-render from current authority: stale or edited generated checkers never certify an obligation. */
export async function loadChecks(workspace:string,file:string,inputs:string[]){
 const metadata=JSON.parse((await inputFile(workspace,file)).bytes.toString()),model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())),expected=renderChecks(model,metadata.manifest),sv=file.replace(/checks\.json$/,'checks.sv');
 if(!file.endsWith('/checks.json')||!inputs.includes(file)||!inputs.includes(sv)||hashValue(metadata)!==hashValue(expected.metadata)||(await inputFile(workspace,sv)).bytes.toString()!==expected.source)throw new ToolError('CHECK_STALE','生成检查器、模型或输入清单不匹配；重新生成并声明检查器输入');
 return expected.metadata;
}
