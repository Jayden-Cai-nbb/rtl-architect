import {coverageNextSteps,type StateCoverageResult} from '../core/stateCoverage';
import {latestStateObservation} from './stateObservation';
import {verificationBasis} from './verificationBasis';
import {ToolError} from './environment';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {Snapshot} from '../core/api';
import {verificationRuns,verificationProfileSchema} from './verification';
import {evaluateConformance} from './conformance';
import {inputFile} from './artifacts';
import {loadChecks} from './contractChecks';
type BehaviorResult={moduleId:string;obligationId:string;description:string;kind:string;requirements:NonNullable<Snapshot['model']['specification']>['requirements'];basis:{kind:string;label:string;reason:string};coverage?:StateCoverageResult;nextSteps:ReturnType<typeof coverageNextSteps>;checkerFingerprint?:string;status:string;reason:string;record?:string};
export async function assurance(workspace:string,snapshot:Snapshot,moduleId?:string){
 if(moduleId&&!snapshot.model.modules.some(m=>m.id===moduleId))throw new ToolError('MODULE_NOT_FOUND','模块不存在');
 const runs=await verificationRuns(workspace,snapshot.modelHash),records=await Promise.all(runs.map(async run=>{try{return {run,record:JSON.parse((await inputFile(workspace,`evidence/runs/${run.id}/run.json`)).bytes.toString())};}catch{return {run,record:null};}}));
 const currentBasis=await verificationBasis(workspace,snapshot.model);
 const modules=snapshot.model.modules.filter(m=>!moduleId||m.id===moduleId),behavior:BehaviorResult[]=[];
 for(const m of modules)for(const o of m.contract.obligations??[]){
  const relevant=records.filter(({run,record})=>run.status==='unreadable'||record?.moduleIds?.includes(m.id)&&record?.profile?.checks?.some((c:{kind:string})=>c.kind==='obligations'));
  let basis={kind:currentBasis.origin==='as_built'?'as_built':currentBasis.origin==='design'?'unreviewed_design':'unknown',label:currentBasis.origin==='as_built'?'还原模型一致性':'未绑定运行前批准',reason:'尚无运行前设计承诺记录'};
  let coverage:StateCoverageResult|undefined,checkerFingerprint:string|undefined;
  let result:{status:string;reason:string;record?:string}={status:'NOT_RUN',reason:'尚无关联的可执行检查'};
  for(const {run,record} of relevant){
   if(run.status==='unreadable'||!record){result={status:'INCONCLUSIVE',reason:'较新的运行记录不可读，无法确定是否涉及本义务'};break;}
   const refers=record.obligationTargets?.some((i:{moduleId:string;obligationId:string})=>i.moduleId===m.id&&i.obligationId===o.id);
   if(!refers)continue;
   const evaluated=record.checks?.flatMap((c:{results?:{moduleId:string;obligationId:string;passed:boolean;fingerprint:string;coverage?:StateCoverageResult}[]})=>c.results??[]).find((i:{moduleId:string;obligationId:string})=>i.moduleId===m.id&&i.obligationId===o.id);
   coverage=evaluated?.coverage;checkerFingerprint=record.obligationTargets.find((i:{moduleId:string;obligationId:string})=>i.moduleId===m.id&&i.obligationId===o.id)?.fingerprint;
   const saved=record.basis;
   if(currentBasis.origin==='as_built')basis={kind:'as_built',label:'还原模型一致性',reason:'规则来自对实现的描述；即使场景通过，也不能证明原始需求正确'};
   else if(saved?.kind==='approved_intent'&&saved.modelHash===snapshot.modelHash&&currentBasis.kind==='approved_intent'&&saved.reviewRecordHash===currentBasis.reviewRecordHash)basis={kind:'approved_intent',label:'运行前已批准的设计声明',reason:'绑定本地批准和需求；需求文字与规则是否对应仍需人工核对'};
   else basis={...basis,reason:'运行前未记录有效批准、来源不明或审阅记录已变化；事后批准不能提升旧运行结论'};
   result={status:'INCONCLUSIVE',reason:'关联证据不完整',record:`evidence/runs/${run.id}/run.json`};
   if(!run.fresh)result={...result,status:'STALE',reason:'模型、声明输入或报告已经变化'};
   else if(run.status==='coverage_incomplete')result={...result,status:'COVERAGE_INCOMPLETE',reason:'本次状态覆盖未完成；检查未命中或未知的目标，不据此断言 RTL 有错'};
   else if(run.status!=='passed')result={...result,status:'FAILED',reason:'最新关联运行未通过；未将失败擅自归因到某个义务'};
   else try{
    const profile=verificationProfileSchema.parse(record.profile);

    for(const c of profile.checks)if(c.kind==='obligations')await loadChecks(workspace,c.metadata,profile.inputs);
    if(evaluated?.passed&&run.inputClosure==='declared_complete'&&run.toolVersionsKnown)result={...result,status:'PASSED',reason:'当前声明输入下，监视器被触发且本次运行通过'};
    else result.reason='未声明完整输入、工具版本不明或监视器未被触发';
   }catch{result.status='STALE';result.reason='生成检查器已无法与当前义务和生成规则核对';}
   break;
  }
  const requirements=(o.requirementIds??[]).map(id=>snapshot.model.specification!.requirements.find(r=>r.id===id)!);
  const nextSteps=coverage&&result.status==='COVERAGE_INCOMPLETE'?coverageNextSteps(coverage):[];
  behavior.push({moduleId:m.id,obligationId:o.id,description:o.description,kind:o.kind,requirements,basis,coverage,nextSteps,checkerFingerprint,...result});
 }
 const requirements=(snapshot.model.specification?.requirements??[]).filter(r=>!moduleId||r.moduleIds.includes(moduleId)).map(r=>{const linked=behavior.filter(o=>o.requirements.some(q=>q.id===r.id));return {...r,status:!linked.length?'NO_CHECK':linked.every(o=>o.status==='PASSED'&&o.basis.kind==='approved_intent')?'SCENARIO_SUPPORTED':'NOT_VERIFIED',obligations:linked.map(o=>({moduleId:o.moduleId,obligationId:o.obligationId,status:o.status}))};});
 const names=(await readdir(join(workspace,'evidence/conformance')).catch(()=>[])).filter(n=>/^conform_\d+_[a-f0-9]{32}$/.test(n)).sort().reverse().slice(0,100);
 let structural:{status:string;reason:string;record?:string;scope?:unknown}={status:'NOT_RUN',reason:'尚无显式结构比较'};
 for(const name of names)try{
  const file=`evidence/conformance/${name}/report.json`,saved=JSON.parse((await inputFile(workspace,file)).bytes.toString());
  if(moduleId&&!saved.manifest?.mappings?.some((m:{moduleId:string})=>m.moduleId===moduleId))continue;
  if(saved.modelHash!==snapshot.modelHash){structural={status:'STALE',reason:'模型已变化',record:file};break;}
  const current=await evaluateConformance(workspace,saved.manifest);
  structural={status:current.modelHash!==snapshot.modelHash||!current.producerInputsCurrent?'STALE':current.status,reason:current.producerReason,record:file,scope:current.scope};break;
 }catch{structural={status:'UNKNOWN',reason:'最新结构报告不可读取'};break;}
 return {modelHash:snapshot.modelHash,moduleId:moduleId??null,approval:{status:moduleId?snapshot.moduleReviews.find(r=>r.moduleId===moduleId)?.status??'DRAFT':snapshot.reviewStatus,assurance:'local_record',note:'本地审阅记录；身份未经认证，不代表 RTL 验证。'},structural,stateObservation:await latestStateObservation(workspace,snapshot.modelHash,moduleId),behavior,requirements,limitations:['最多读取最近 100 次运行及结构报告；缺少记录保持未知。','输入闭包由清单作者声明；工具未自动发现全部构建依赖。','仿真通过仅适用于实际运行场景，不是形式证明或行为等价。']};
}
