import {z} from 'zod';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {endpointSchema,idSchema,modelSchema} from '../core/schema';
import {hashValue,modelHash} from '../core/export';
import {validateModel} from '../core/engine';
import {compareState,observeState,stateInventory,type Definition} from '../core/stateObservation';
import {netlistSchema} from './importYosys';
import {verificationRuns} from './verification';
import {verificationBasis} from './verificationBasis';
import {inputFile,newArtifactDirectory,workspacePath} from './artifacts';
import {toolVersion} from './environment';
const engine='yosys-proc-bdd-v2';
const name=z.string().trim().min(1),bits=z.array(z.union([z.number().int().nonnegative().safe(),z.enum(['0','1','x','z'])])).max(65536);
const mappingSchema=z.strictObject({moduleId:idSchema,localSignalId:idSchema,state:name,clock:name,signals:z.array(z.strictObject({endpoint:endpointSchema,pin:name})).max(128)});
const scopeSchema=z.strictObject({instancePath:z.array(name).max(64),mappings:z.array(mappingSchema).max(32)});
const producerFields={runId:z.string().regex(/^run_\d+_[a-f0-9]{32}$/),netlist:name,top:name};
export const stateObservationSchema=z.discriminatedUnion('schemaVersion',[
 z.strictObject({schemaVersion:z.literal(1),...producerFields,...scopeSchema.shape}),
 z.strictObject({schemaVersion:z.literal(2),...producerFields,scopes:z.array(scopeSchema).min(1).max(16)})
]).refine(m=>observationScopes(m).reduce((n,s)=>n+s.mappings.length,0)<=32,'每份报告最多映射 32 个状态');
export function observationScopes(m:{schemaVersion:1;instancePath:string[];mappings:z.infer<typeof mappingSchema>[]} | {schemaVersion:2;scopes:z.infer<typeof scopeSchema>[]}){return m.schemaVersion===1?[{instancePath:m.instancePath,mappings:m.mappings}]:m.scopes;}

const extended=netlistSchema.extend({modules:z.record(z.string(),netlistSchema.shape.modules.valueType.extend({netnames:z.record(z.string(),z.object({bits,attributes:z.record(z.string(),z.union([z.string(),z.number()])).default({}),hide_name:z.number().optional()})).default({}),processes:z.record(z.string(),z.unknown()).optional()}))});
export async function evaluateStateObservation(workspace:string,input:unknown){
 const manifest=stateObservationSchema.parse(input),model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())),hash=modelHash(model);
 const run=(await verificationRuns(workspace,hash)).find(r=>r.id===manifest.runId);
 const record=JSON.parse((await inputFile(workspace,`evidence/runs/${manifest.runId}/run.json`)).bytes.toString());
 const file=await inputFile(await workspacePath(workspace,`evidence/runs/${manifest.runId}`),manifest.netlist,8*1024*1024);
 const scopes=observationScopes(manifest),mappings=scopes.flatMap(s=>s.mappings);
 const trusted=!!(run?.fresh&&run.status==='passed'&&run.stage==='elaboration'&&run.inputClosure==='declared_complete'&&run.toolVersionsKnown&&mappings.every(m=>record.moduleIds?.includes(m.moduleId))&&record.artifacts?.some((a:{file:string;sha256:string})=>a.file===manifest.netlist&&a.sha256===file.sha256));
 const net=extended.parse(JSON.parse(file.bytes.toString()));
 const basis=await verificationBasis(workspace,model),basisLabel=basis.kind==='as_built'?'还原模型一致性':basis.kind==='approved_intent'?'当前已批准的设计声明':basis.kind==='unreviewed_design'?'未批准的设计声明':'设计来源未知';
 const invalid=validateModel(model).some(i=>i.blocks.includes('commit'));
 const duplicateModel=new Set(mappings.map(m=>m.moduleId+'/'+m.localSignalId)).size!==mappings.length;
 const duplicateScopes=new Set(scopes.map(s=>JSON.stringify(s.instancePath))).size!==scopes.length;
 let remaining=64;
 const scopeReports=scopes.map(scope=>{
  let def:Definition|undefined=net.modules[manifest.top];
  for(const name of scope.instancePath){const cell:Definition['cells'][string]|undefined=def?.cells[name];def=cell?net.modules[cell.type]:undefined;}
  const targetBits=scope.mappings.map(m=>(def?.netnames[m.state]??def?.ports[m.state])?.bits);
  const duplicate=duplicateModel||duplicateScopes||new Set(scope.mappings.map(m=>m.state)).size!==scope.mappings.length||targetBits.some((bits,i)=>bits&&targetBits.slice(0,i).some(other=>hashValue(bits)===hashValue(other??null)));
  const inventory=def?stateInventory(def):[],observations=inventory.slice(0,remaining).map(s=>({...s,instancePath:scope.instancePath,...observeState(def!,s.cell)}));remaining-=observations.length;
  const results=scope.mappings.map(mapping=>{
   const comparison:ReturnType<typeof compareState>=def&&!invalid&&!duplicate?compareState(model,def,mapping):{status:'UNKNOWN' as const,reason:!def?'RTL 顶层或实例路径不存在':invalid?'当前模型有结构错误':'状态、实例路径或模型对象重复映射'};
   return {moduleId:mapping.moduleId,localSignalId:mapping.localSignalId,state:mapping.state,instancePath:scope.instancePath,...comparison,status:trusted?comparison.status:'UNKNOWN' as const,reason:trusted?comparison.reason:'生产记录过期、不完整或摘要不符；需重新 verify 展开',observedHash:comparison.observed?hashValue(comparison.observed):null};
  });
  return {instancePath:scope.instancePath,found:!!def,stateCount:inventory.length,observedCount:observations.length,mappedCount:results.length,truncated:inventory.length>observations.length,observations,results};
 });
 const results=scopeReports.flatMap(s=>s.results),observations=scopeReports.flatMap(s=>s.observations);
 const inventoryCount=scopeReports.reduce((n,s)=>n+s.stateCount,0),truncated=scopeReports.some(s=>s.truncated);
 const status=results.some(r=>r.status==='MISMATCH')?'MISMATCH':!results.length||scopeReports.some(s=>!s.found)||duplicateScopes||results.some(r=>r.status==='UNKNOWN')?'UNKNOWN':'MATCH';
 return {schemaVersion:1,engine,toolVersion,modelHash:hash,manifest,manifestHash:hashValue(manifest),producerRun:manifest.runId,producerFresh:trusted,producerInputsCurrent:!!run?.fresh,producer:{netlistHash:file.sha256,profileHash:record.profileHash,inputs:record.inputs,tools:record.steps?.map((s:{program:string;toolVersion:string})=>({program:s.program,version:s.toolVersion}))},basis:{kind:basis.kind,label:basisLabel,reviewRecordHash:basis.reviewRecordHash},status,discoveryComplete:scopeReports.every(s=>s.found)&&!duplicateScopes,scope:{stateCount:inventoryCount,observedCount:observations.length,truncated,mappedCount:results.length},scopes:scopeReports.map(({observations,results,...s})=>s),observations,results,limitations:['逐实例独立比较作用域内完整 $dff 的二态单步函数；不跨层拼接逻辑锥；其他寄存器类型、X/Z、不支持的运算及预算超限为 UNKNOWN。','所有输入和旧状态作为自由变量；反例未判断可达性，不是完整时序等价、需求或器件验收。','需要显式完整构建输入、参数/宏配置和工具版本；声明完整不是自动依赖发现。','观察快照是派生证据，不覆盖 register.update、不改变批准；未映射状态未与设计比较。']};
}
export async function runStateObservation(workspace:string,input:unknown){
 const result=await evaluateStateObservation(workspace,input);
 await mkdir(join(workspace,'evidence'),{recursive:true});await workspacePath(workspace,'evidence');await mkdir(join(workspace,'evidence/state-observation'),{recursive:true});await workspacePath(workspace,'evidence/state-observation');
 const id=`state_${Date.now()}_${randomUUID().replaceAll('-','')}`,dir=await newArtifactDirectory(workspace,join(workspace,'evidence/state-observation',id));
 await writeFile(join(dir,'report.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {...result,record:`evidence/state-observation/${id}/report.json`};
}
type ObservationReport=Awaited<ReturnType<typeof evaluateStateObservation>>;
type StateEvidence=Omit<ObservationReport['results'][number],'status'>&{status:'MATCH'|'MISMATCH'|'UNKNOWN'|'STALE'|'NOT_RUN';record?:string;basis?:ObservationReport['basis']};
/** Latest evidence per declared state, never latest-file-wins. A partial rerun cannot hide another failure. */
export async function latestStateObservation(workspace:string,hash:string,moduleId?:string){
 const model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString()));
 const declared=(model.localSignals??[]).filter(s=>s.driver.kind==='register'&&s.driver.update&&(!moduleId||s.scope===moduleId));
 const pending=new Map(declared.map(s=>[s.scope+'/'+s.id,s])),rows=new Map<string,StateEvidence>();
 const allNames=(await readdir(join(workspace,'evidence/state-observation')).catch(()=>[])).filter(n=>/^state_\d+_[a-f0-9]{32}$/.test(n)).sort().reverse();
 const names=allNames.slice(0,100),issues:string[]=[];
 const producers=await verificationRuns(workspace,hash);
 let discovery:ObservationReport['scope']|undefined,record:string|undefined;
 const rtlScopes=new Map<string,ObservationReport['scopes'][number]>();
 for(const name of names){
  const file=`evidence/state-observation/${name}/report.json`;
  try{
   const saved=JSON.parse((await inputFile(workspace,file)).bytes.toString()),manifest=stateObservationSchema.parse(saved.manifest);
   if(saved.manifestHash!==hashValue(manifest))throw new Error('状态映射摘要不符');
   const mappings=observationScopes(manifest).flatMap(s=>s.mappings.map(m=>({...m,instancePath:s.instancePath}))),relevant=mappings.filter(m=>pending.has(m.moduleId+'/'+m.localSignalId));
   if(!relevant.length&&mappings.length)continue;
   const producer=producers.find(r=>r.id===manifest.runId);
   const stale=saved.modelHash!==hash||saved.engine!==engine?'模型或比较器版本已变化，请重新比较当前声明':!producer?.fresh?'源码、构建配置或展开产物已变化，请重新展开并比较':undefined;
   let report:ObservationReport|undefined;
   if(!stale)report=await evaluateStateObservation(workspace,manifest);
   if(!mappings.length){if(!discovery&&report){discovery=report.scope;record??=file;}continue;}
   if(report)for(const scope of report.scopes){if(!relevant.some(m=>JSON.stringify(m.instancePath)===JSON.stringify(scope.instancePath)))continue;const key=JSON.stringify([manifest.top,scope.instancePath]);if(!rtlScopes.has(key))rtlScopes.set(key,scope);}
   const basis=report&&hashValue(report.basis)===hashValue(saved.basis)?report.basis:{kind:'unknown',label:'比较时的审阅依据已变化',reviewRecordHash:null};
   for(const m of relevant){
    const key=m.moduleId+'/'+m.localSignalId,comparison=report?.results.find(r=>r.moduleId===m.moduleId&&r.localSignalId===m.localSignalId);
    rows.set(key,{moduleId:m.moduleId,localSignalId:m.localSignalId,state:m.state,instancePath:m.instancePath,observedHash:null,...comparison,status:stale?'STALE':comparison?.status??'UNKNOWN',reason:stale??comparison?.reason??'无法读取本状态比较',record:file,basis});pending.delete(key);
   }
   record??=file;
  }catch{issues.push(`状态观察记录不可读取，不能将汇总判为通过：${file}`);}
  if(!pending.size&&declared.length)break;
 }
 for(const [key,s] of pending)rows.set(key,{moduleId:s.scope,localSignalId:s.id,state:'未映射',instancePath:[],observedHash:null,status:'NOT_RUN',reason:allNames.length>100?'最近 100 份报告没有本状态证据；请重新比较':'本状态尚未比较；其他状态通过不代表它通过'});
 const priority={MISMATCH:0,STALE:1,UNKNOWN:2,NOT_RUN:3,MATCH:4};
 const results=[...rows.values()].sort((a,b)=>priority[a.status]-priority[b.status]||(a.moduleId+'/'+a.localSignalId).localeCompare(b.moduleId+'/'+b.localSignalId)),counts={declared:declared.length,matched:results.filter(r=>r.status==='MATCH').length,mismatched:results.filter(r=>r.status==='MISMATCH').length,unknown:results.filter(r=>r.status==='UNKNOWN').length,stale:results.filter(r=>r.status==='STALE').length,notRun:results.filter(r=>r.status==='NOT_RUN').length};
 const status=counts.mismatched?'MISMATCH':counts.stale?'STALE':issues.length||counts.unknown||counts.notRun&&counts.notRun<counts.declared?'UNKNOWN':counts.matched?'MATCH':'NOT_RUN';
 const bases=results.flatMap(r=>r.basis?[r.basis]:[]),basis=bases.length&&bases.every(b=>hashValue(b)===hashValue(bases[0]))?bases[0]:{kind:'unknown',label:'逐状态查看比较依据',reviewRecordHash:null};
 return {status,reason:issues[0]??(results.length?'逐状态汇总最新证据；仅覆盖已声明更新规则的有限二态单步函数':discovery?'仅完成状态发现；尚无声明的更新规则':'尚无声明的更新规则或状态比较'),record,basis,scope:rtlScopes.size?{stateCount:[...rtlScopes.values()].reduce((n,s)=>n+s.stateCount,0),observedCount:[...rtlScopes.values()].reduce((n,s)=>n+s.observedCount,0),mappedCount:counts.declared-counts.notRun,truncated:[...rtlScopes.values()].some(s=>s.truncated)}:discovery,coverage:counts,results,issues};
}
