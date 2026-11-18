import { z } from 'zod';
import { hashSchema,idSchema } from './schema';
import {positive,nonnegative,computeTimingSchema,launchesSchema,feedbackSchema,memoryOrganizationSchema,accessesSchema,sustainedSchema,resourceConstraint,recurrenceConstraint,memoryConstraint,sustainedConstraint,exact,ceiling} from './studyConstraints';
export const candidateRefSchema=z.strictObject({proposalId:hashSchema,modelHash:hashSchema});
export type CandidateRef=z.infer<typeof candidateRefSchema>;
const memoryBase={words:positive,width:positive,copies:positive,readsPerItem:nonnegative,writesPerItem:nonnegative};
// Alternative forms: never infer a bank organization from old independent-port totals.
export const studyMemorySchema=z.union([
 z.strictObject({...memoryBase,readPorts:nonnegative,writePorts:nonnegative}),
 z.strictObject({...memoryBase,organization:memoryOrganizationSchema,accesses:accessesSchema.optional()}),
]);
export const studyOptionSchema=z.strictObject({
 id:idSchema,candidate:candidateRefSchema.optional(),label:z.string().trim().min(1).max(120),
 compute:z.strictObject({lanes:positive,operationsPerItem:positive,cyclesPerOperation:positive,overheadCycles:nonnegative,timing:computeTimingSchema.optional(),launches:launchesSchema.optional()}),
 memory:studyMemorySchema.optional(),feedback:feedbackSchema.optional(),
 flow:z.strictObject({producedPerCycle:nonnegative,maxStallCycles:nonnegative,inFlight:nonnegative,capacity:nonnegative,sustained:sustainedSchema.optional()}).optional(),
 runIds:z.array(idSchema).max(20).default([]),
}).superRefine((o,ctx)=>{
 const issue=(path:(string|number)[],message:string)=>ctx.addIssue({code:'custom',path,message});
 const unique=(values:string[],path:(string|number)[])=>{if(new Set(values).size!==values.length)issue(path,'ID 不能重复');};
 unique((o.compute.launches??[]).map(l=>l.id),['compute','launches']);
 for(const [i,l] of (o.compute.launches??[]).entries())if(l.lane>=o.compute.lanes)issue(['compute','launches',i,'lane'],'资源编号必须在 0..lanes-1 内');
 unique((o.feedback??[]).map(f=>f.id),['feedback']);
 if(o.memory&&'organization' in o.memory){
  const {organization:g,words,copies,accesses}=o.memory;
  unique(g.bankIds,['memory','organization','bankIds']);
  if(copies!==g.bankIds.length)issue(['memory','copies'],'显式存储中 copies 必须等于独立 bank 数；每 bank 容量为 words × width');
  if(new Set(g.mapping.map(m=>m.address)).size!==g.mapping.length)issue(['memory','organization','mapping'],'同一逻辑地址不能有多个映射');
  for(const [i,m] of g.mapping.entries()){
   if(!g.bankIds.includes(m.bank))issue(['memory','organization','mapping',i,'bank'],'映射必须引用已声明 bank');
   if(m.word>=words)issue(['memory','organization','mapping',i,'word'],'bank 内 word 地址超出深度');
  }
  unique((accesses??[]).map(a=>a.id),['memory','accesses']);
 }
});
export const studySchema=z.strictObject({id:idSchema,title:z.string().trim().min(1).max(240),modelHash:hashSchema,moduleIds:z.array(idSchema).min(1).max(100),configuration:z.string().trim().min(1).max(2000),assumptions:z.array(z.string().trim().min(1).max(2000)).min(1).max(30),workItems:positive,options:z.array(studyOptionSchema).min(2).max(6)}).refine(s=>new Set(s.options.map(o=>o.id)).size===s.options.length,'方案 ID 不能重复');
export type Study=z.infer<typeof studySchema>;
export type StudyOption=z.infer<typeof studyOptionSchema>;
export function evaluateStudy(input:Study){
 const study=studySchema.parse(input);
 return {id:study.id,modelHash:study.modelHash,configuration:study.configuration,assumptions:study.assumptions,options:study.options.map(o=>{
  const resource=resourceConstraint(o.compute,study.workItems),recurrence=recurrenceConstraint(o.feedback),sustained=sustainedConstraint(o.flow);
  const computeII=resource.intervalLowerBound,mem=o.memory,explicit=mem&&'organization' in mem?mem:undefined,legacy=mem&&'readPorts' in mem?mem:undefined;
  const unavailable=!!legacy&&((legacy.readsPerItem>0&&legacy.readPorts===0)||(legacy.writesPerItem>0&&legacy.writePorts===0));
  const portWork=explicit?explicit.organization.kind==='independent_1r1w'?Math.max(explicit.readsPerItem,explicit.writesPerItem):exact(explicit.readsPerItem+explicit.writesPerItem):0;
  const portUnits=explicit?explicit.organization.bankIds.length*(explicit.organization.kind==='true_dual_2rw'?2:1):1;
  const memoryII=explicit?portWork/portUnits:legacy&&!unavailable?Math.max(legacy.readsPerItem?legacy.readsPerItem/legacy.readPorts:0,legacy.writesPerItem?legacy.writesPerItem/legacy.writePorts:0):0;
  const intervalLowerBound=unavailable?null:Math.max(computeII,memoryII,recurrence.intervalLowerBound??0);
  // Preserve the original reservation/service-work budget; it is not a finite result latency.
  const computeWork=exact(exact(study.workItems*o.compute.operationsPerItem)*o.compute.cyclesPerOperation);
  const computeCycles=ceiling(computeWork,o.compute.lanes);
  const memoryCycles=explicit?ceiling(exact(study.workItems*portWork),portUnits):legacy&&!unavailable?Math.max(
   legacy.readsPerItem?ceiling(exact(study.workItems*legacy.readsPerItem),legacy.readPorts):0,
   legacy.writesPerItem?ceiling(exact(study.workItems*legacy.writesPerItem),legacy.writePorts):0,
  ):0;
  const cyclesLowerBound=unavailable?null:exact(Math.max(computeCycles,memoryCycles)+o.compute.overheadCycles);
  const requiredCapacity=o.flow?exact(exact(o.flow.producedPerCycle*o.flow.maxStallCycles)+o.flow.inFlight):null;
  const memoryTrace=explicit?memoryConstraint(explicit.organization,explicit.accesses):null;
  const unmodeled=[
   '未求解完整调度、运算间数据依赖、仲裁、公平性、跨时钟、启动/排空和背压耦合；不保证下界可达。',
   '有限请求是用户声明的尝试时刻，不自动重排；没有证明它覆盖整个工作量或可周期重复。',
   ...(!o.compute.timing?['未声明运算 latency/II；只沿用旧独占服务量下界。']:!resource.timingComplete?['运算 latency 或 II 为 UNKNOWN。']:[]),
   ...(!o.feedback?.length?['未声明反馈依赖；不能据此认定工作项互相独立。']:recurrence.status==='unknown'?['存在未知反馈 latency；已知递推下界不完整。']:[]),
   ...(legacy?['旧存储输入假设总读/写端口独立；bank、读延迟和同址语义未建模，副本数不自动增加端口。']:!mem?['未计入存储约束。']:[]),
   ...(explicit?[`显式存储仅支持单时钟、整 word、每端口每拍一个请求；每 bank 深度 ${mem!.words}，不表达复制一致性或字节写掩码。`,...(!explicit.accesses?.length?['未提供有限存储访问序列，bank 冲突检查未运行。']:[]),...(explicit.organization.readLatencyCycles===null?['RAM 读延迟 UNKNOWN。']:[]),...(explicit.organization.sameAddressReadWrite==='unknown'?['RAM 同址读写语义 UNKNOWN。']:[])]:[]),
   ...(!o.flow?.sustained?['未声明持续到达率与消费率；缓存停顿预算不证明长期稳定。']:['持续流率不涵盖突发分布、消费抖动或流控响应。']),
  ];
  return {id:o.id,label:o.label,...(o.candidate?{candidate:o.candidate}:{}),classification:'derived' as const,computeII,memoryII:unavailable?null:memoryII,intervalLowerBound,integerIILowerBound:intervalLowerBound===null?null:Math.ceil(intervalLowerBound),cyclesLowerBound,storageBits:mem?exact(exact(mem.words*mem.width)*mem.copies):null,requiredCapacity,capacitySufficient:o.flow?o.flow.capacity>=requiredCapacity!:null,
   bottleneck:unavailable?'缺少存储端口':(recurrence.intervalLowerBound??0)>Math.max(computeII,memoryII)?'反馈递推':memoryII>computeII?'存储端口':memoryII===computeII?'计算与存储':'计算资源',runIds:o.runIds,
   constraints:{resource,recurrence,memory:{intervalLowerBound:unavailable?null:memoryII,status:!mem?'not_declared':unavailable?'missing_ports':'aggregate_lower_bound',trace:memoryTrace,explanation:explicit?`总端口下界 = ${explicit.organization.kind==='independent_1r1w'?'max(每项读, 每项写)':'每项读 + 每项写'} / ${portUnits}。这是理想分布下界；实际 bank 占用与同址冲突另查，不能被总端口数抵消。`:'沿用旧总独立读写端口的服务量下界。'},capacity:{stallRequired:requiredCapacity,stallCapacitySufficient:o.flow?o.flow.capacity>=requiredCapacity!:null,sustained}},
   scheduleStatus:'not_proven' as const,unmodeled,
  };
 }),note:'资源服务量下界与有限请求检查，非完整调度可行性结论。cyclesLowerBound 保留原服务量/独占周期口径（不含结果启动排空）；latency、启动间隔、递推和长期容量分别报告。所有新输入都是工作记录中的显式假设，不修改硬件模型、批准或证据。'};
}
export function studyMatchesCandidates(study:Study,candidates:(CandidateRef|undefined)[]){return study.options.length===candidates.length&&study.options.every((o,i)=>o.candidate?.proposalId===candidates[i]?.proposalId&&o.candidate?.modelHash===candidates[i]?.modelHash);}
