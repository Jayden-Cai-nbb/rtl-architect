import { z } from 'zod';
import { hashSchema,idSchema } from './schema';
const positive=z.number().int().safe().positive().max(1e9),nonnegative=z.number().int().safe().nonnegative().max(1e9);
export const studyOptionSchema=z.strictObject({id:idSchema,label:z.string().trim().min(1).max(120),compute:z.strictObject({lanes:positive,operationsPerItem:positive,cyclesPerOperation:positive,overheadCycles:nonnegative}),memory:z.strictObject({words:positive,width:positive,copies:positive,readsPerItem:nonnegative,writesPerItem:nonnegative,readPorts:nonnegative,writePorts:nonnegative}).optional(),flow:z.strictObject({producedPerCycle:nonnegative,maxStallCycles:nonnegative,inFlight:nonnegative,capacity:nonnegative}).optional(),runIds:z.array(idSchema).max(20).default([])});
export const studySchema=z.strictObject({id:idSchema,title:z.string().trim().min(1).max(240),modelHash:hashSchema,moduleIds:z.array(idSchema).min(1).max(100),configuration:z.string().trim().min(1).max(2000),assumptions:z.array(z.string().trim().min(1).max(2000)).min(1).max(30),workItems:positive,options:z.array(studyOptionSchema).min(2).max(6)}).refine(s=>new Set(s.options.map(o=>o.id)).size===s.options.length,'方案 ID 不能重复');
export type Study=z.infer<typeof studySchema>;
const exact=(n:number)=>{if(!Number.isSafeInteger(n))throw new Error('预算超过安全整数范围，请缩小计算范围或分阶段计算');return n;};
export function evaluateStudy(input:Study){
 const study=studySchema.parse(input);
 return {id:study.id,modelHash:study.modelHash,configuration:study.configuration,assumptions:study.assumptions,options:study.options.map(o=>{
  const computeII=exact(o.compute.operationsPerItem*o.compute.cyclesPerOperation)/o.compute.lanes;
  const mem=o.memory,unavailable=!!mem&&((mem.readsPerItem>0&&mem.readPorts===0)||(mem.writesPerItem>0&&mem.writePorts===0));
  const memoryII=mem&&!unavailable?Math.max(mem.readsPerItem?mem.readsPerItem/mem.readPorts:0,mem.writesPerItem?mem.writesPerItem/mem.writePorts:0):0;
  const intervalLowerBound=unavailable?null:Math.max(computeII,memoryII);
  // Integer ceiling avoids rounding away a fractional cycle near Number.MAX_SAFE_INTEGER.
  const ceiling=(work:number,units:number)=>Number((BigInt(exact(work))+BigInt(units)-1n)/BigInt(units));
  const computeWork=exact(exact(study.workItems*o.compute.operationsPerItem)*o.compute.cyclesPerOperation);
  const computeCycles=ceiling(computeWork,o.compute.lanes);
  const memoryCycles=mem&&!unavailable?Math.max(
   mem.readsPerItem?ceiling(exact(study.workItems*mem.readsPerItem),mem.readPorts):0,
   mem.writesPerItem?ceiling(exact(study.workItems*mem.writesPerItem),mem.writePorts):0,
  ):0;
  const cyclesLowerBound=unavailable?null:exact(Math.max(computeCycles,memoryCycles)+o.compute.overheadCycles);
  const requiredCapacity=o.flow?exact(exact(o.flow.producedPerCycle*o.flow.maxStallCycles)+o.flow.inFlight):null;
  return {id:o.id,label:o.label,classification:'derived' as const,computeII,memoryII:unavailable?null:memoryII,intervalLowerBound,cyclesLowerBound,storageBits:mem?exact(exact(mem.words*mem.width)*mem.copies):null,requiredCapacity,capacitySufficient:o.flow?o.flow.capacity>=requiredCapacity!:null,feasible:!unavailable&&(!o.flow||o.flow.capacity>=requiredCapacity!),bottleneck:unavailable?'缺少存储端口':memoryII>computeII?'存储端口':memoryII===computeII?'计算与存储':'计算资源',runIds:o.runIds};
 }),note:'资源服务量下界：假设同构运算可分配到独立单元、读写端口独立、各阶段可重叠，overheadCycles 为不可重叠开销；未计入未声明的依赖、仲裁或同址冲突。不能作为实测 II、延迟或频率保证。缓存按停顿期间持续产生数据的假设计算。'};
}
