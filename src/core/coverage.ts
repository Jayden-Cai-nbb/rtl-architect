import type {Model} from './schema';
import {connectionFacts} from './connectivity';
import {physicalInstanceCount} from './parameters';
export function coverageReport(model:Model,facts=connectionFacts(model)){
 const p=model.provenance,assessments=p?.coverage.assessments;
 const covered=facts.ports.reduce((n,r)=>n+r.covered,0),declared=facts.ports.reduce((n,r)=>n+(r.fullWidth??0),0);
 const required=facts.ports.filter(r=>r.intf.required&&r.missing.length);
 const state=(key:keyof NonNullable<NonNullable<typeof p>['coverage']['assessments']>)=>assessments?.[key]?.status??(p?.fidelity==='partial'?'partial':'unknown');
 const count=(kind:string)=>p?.evidence.filter(e=>e.targets?.some(t=>t.kind===kind)).length??0;
 return {
  instances:{represented:physicalInstanceCount(model),declared:p?.coverage.representedInstances??null,expected:p?.coverage.elaboratedInstances??null,status:p&&p.coverage.elaboratedInstances===physicalInstanceCount(model)&&p.coverage.representedInstances===physicalInstanceCount(model)?'complete':'unknown'},
  portBits:{status:required.length?'partial':state('portBits'),covered,declared,missingRequiredPorts:required.length,missingRequiredBits:required.reduce((n,r)=>n+r.missing.reduce((sum,b)=>sum+b.msb-b.lsb+1,0),0),expected:assessments?.portBits?.expected??null},
  localDrivers:{status:state('localDrivers'),modeled:model.localSignals?.length??0,withEvidence:model.localSignals?.filter(s=>s.evidenceIds.length).length??0,expected:assessments?.localDrivers?.expected??null},
  parameterBindings:{status:state('parameterBindings'),modeled:model.modules.reduce((n,m)=>n+Object.keys(m.parameterBindings??{}).length,0),expected:assessments?.parameterBindings?.expected??null},
  behavior:{status:state('behavior'),evidence:count('contract'),expected:assessments?.behavior?.expected??null},
  verification:p?.verification.map(v=>({stage:v.stage,target:v.target??null,status:v.status,executedAt:v.executedAt??null,batchId:v.batchId??null}))??[],
  gaps:p?.unsupportedStructures.map(u=>({id:u.id,category:u.category??'unclassified',description:u.description,moduleIds:u.moduleIds}))??[],
  note:'端口位数只统计当前模型，父子边界分别计数；源码的总位数未知时不计算 RTL 完整率。'
 };
}
