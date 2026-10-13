import {ToolError} from './environment';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {Snapshot} from '../core/api';
import {verificationRuns,verificationProfileSchema} from './verification';
import {evaluateConformance} from './conformance';
import {inputFile} from './artifacts';
import {loadChecks} from './contractChecks';
export async function assurance(workspace:string,snapshot:Snapshot,moduleId?:string){
 if(moduleId&&!snapshot.model.modules.some(m=>m.id===moduleId))throw new ToolError('MODULE_NOT_FOUND','模块不存在');
 const runs=await verificationRuns(workspace,snapshot.modelHash),records=await Promise.all(runs.map(async run=>{try{return {run,record:JSON.parse((await inputFile(workspace,`evidence/runs/${run.id}/run.json`)).bytes.toString())};}catch{return {run,record:null};}}));
 const modules=snapshot.model.modules.filter(m=>!moduleId||m.id===moduleId),behavior=[];
 for(const m of modules)for(const o of m.contract.obligations??[]){
  const relevant=records.filter(({run,record})=>run.status==='unreadable'||record?.moduleIds?.includes(m.id)&&record?.profile?.checks?.some((c:{kind:string})=>c.kind==='obligations'));
  let result:{status:string;reason:string;record?:string}={status:'NOT_RUN',reason:'尚无关联的可执行检查'};
  for(const {run,record} of relevant){
   if(run.status==='unreadable'||!record){result={status:'INCONCLUSIVE',reason:'较新的运行记录不可读，无法确定是否涉及本义务'};break;}
   const refers=record.obligationTargets?.some((i:{moduleId:string;obligationId:string})=>i.moduleId===m.id&&i.obligationId===o.id);
   if(!refers)continue;
   result={status:'INCONCLUSIVE',reason:'关联证据不完整',record:`evidence/runs/${run.id}/run.json`};
   if(!run.fresh)result={...result,status:'STALE',reason:'模型、声明输入或报告已经变化'};
   else if(run.status!=='passed')result={...result,status:'FAILED',reason:'最新关联运行未通过；未将失败擅自归因到某个义务'};
   else try{
    const profile=verificationProfileSchema.parse(record.profile);
    const evaluated=record.checks?.flatMap((c:{results?:{moduleId:string;obligationId:string;passed:boolean;fingerprint:string}[]})=>c.results??[]).find((i:{moduleId:string;obligationId:string})=>i.moduleId===m.id&&i.obligationId===o.id);
    for(const c of profile.checks)if(c.kind==='obligations')await loadChecks(workspace,c.metadata,profile.inputs);
    if(evaluated?.passed&&run.inputClosure==='declared_complete'&&run.toolVersionsKnown)result={...result,status:'PASSED',reason:'当前声明输入下，监视器被触发且本次运行通过'};
    else result.reason='未声明完整输入、工具版本不明或监视器未被触发';
   }catch{result.status='STALE';result.reason='生成检查器已无法与当前义务和生成规则核对';}
   break;
  }
  behavior.push({moduleId:m.id,obligationId:o.id,description:o.description,kind:o.kind,...result});
 }
 const names=(await readdir(join(workspace,'evidence/conformance')).catch(()=>[])).filter(n=>/^conform_\d+_[a-f0-9]{32}$/.test(n)).sort().reverse().slice(0,100);
 let structural:{status:string;reason:string;record?:string;scope?:unknown}={status:'NOT_RUN',reason:'尚无显式结构比较'};
 for(const name of names)try{
  const file=`evidence/conformance/${name}/report.json`,saved=JSON.parse((await inputFile(workspace,file)).bytes.toString());
  if(moduleId&&!saved.manifest?.mappings?.some((m:{moduleId:string})=>m.moduleId===moduleId))continue;
  if(saved.modelHash!==snapshot.modelHash){structural={status:'STALE',reason:'模型已变化',record:file};break;}
  const current=await evaluateConformance(workspace,saved.manifest);
  structural={status:current.modelHash!==snapshot.modelHash||!current.producerInputsCurrent?'STALE':current.status,reason:current.producerReason,record:file,scope:current.scope};break;
 }catch{structural={status:'UNKNOWN',reason:'最新结构报告不可读取'};break;}
 return {modelHash:snapshot.modelHash,moduleId:moduleId??null,approval:{status:moduleId?snapshot.moduleReviews.find(r=>r.moduleId===moduleId)?.status??'DRAFT':snapshot.reviewStatus,assurance:'local_record',note:'本地审阅记录；身份未经认证，不代表 RTL 验证。'},structural,behavior,limitations:['最多读取最近 100 次运行及结构报告；缺少记录保持未知。','输入闭包由清单作者声明；工具未自动发现全部构建依赖。','仿真通过仅适用于实际运行场景，不是形式证明或行为等价。']};
}
