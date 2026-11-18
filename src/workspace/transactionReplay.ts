import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hashSchema,modelSchema} from '../core/schema';
import {hashValue,modelHash} from '../core/export';
import {replayMappingSchema,replaySamplesSchema,replayTransactions,transactionPathIssues} from '../core/transactionReplay';
import {inputFile,newArtifactDirectory,workspacePath} from './artifacts';
import {verificationRuns} from './verification';
const recordSchema=z.strictObject({schemaVersion:z.literal(1),id:z.string().regex(/^replay_[a-f0-9]{32}$/),createdAt:z.string(),modelHash:hashSchema,sourceDigest:hashSchema,runDigest:hashSchema,artifactDigest:hashSchema,pathDigest:hashSchema,mapping:replayMappingSchema,resultDigest:hashSchema});
export async function importReplay(workspace:string,input:unknown){
 const mapping=replayMappingSchema.parse(input),model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())),hash=modelHash(model);
 const path=model.modules.find(m=>m.id===mapping.moduleId)?.contract.transactionPaths?.find(p=>p.id===mapping.pathId);
 if(!path)throw new Error('未声明事务路径；先通过 preview/commit 更新 contract.transactionPaths');
 const errors=transactionPathIssues(model,mapping.moduleId,path);if(errors.length)throw new Error(errors.join('；'));
 const runs=await verificationRuns(workspace,hash),run=runs.find(r=>r.id===mapping.runId);
 if(!run||!('stage' in run)||run.stage!=='simulation'||!run.fresh)throw new Error('需要当前模型和来源新鲜的 simulation verify 运行');
 const dir=await workspacePath(workspace,`evidence/runs/${mapping.runId}`),runFile=await inputFile(dir,'run.json');
 const raw=JSON.parse(runFile.bytes.toString());
 const artifact=await inputFile(dir,mapping.artifact,8*1024*1024);
 if(!raw.artifacts.some((a:{file:string;sha256:string})=>a.file===mapping.artifact&&a.sha256===artifact.sha256))throw new Error('轨迹必须是 verify 清单核对过的产物');
 // Configuration is an explicit run input, not a free-form claim added after simulation.
 if(!raw.inputs.some((a:{file:string})=>a.file===mapping.configuration))throw new Error('configuration 必须指向本次 verify 输入文件');
 const samples=replaySamplesSchema.parse(JSON.parse(artifact.bytes.toString())),result=replayTransactions(model,path,mapping,samples);
 const resultText=JSON.stringify(result,null,2)+'\n';
 if(Buffer.byteLength(resultText)>8*1024*1024)throw new Error('回放结果超过 8 MiB 限额；请缩短显式场景，不截断记录');
 const id='replay_'+randomUUID().replaceAll('-','');
 const record={schemaVersion:1 as const,id,createdAt:new Date().toISOString(),modelHash:hash,sourceDigest:hashValue(raw.inputs),runDigest:runFile.sha256,artifactDigest:artifact.sha256,pathDigest:hashValue(path),mapping,resultDigest:hashValue(result)};
 await mkdir(join(workspace,'evidence'),{recursive:true});await workspacePath(workspace,'evidence');await mkdir(join(workspace,'evidence/replays'),{recursive:true});await workspacePath(workspace,'evidence/replays');
 const output=await newArtifactDirectory(workspace,join(workspace,'evidence/replays',id));
 await writeFile(join(output,'result.json'),resultText,{flag:'wx'});await writeFile(join(output,'record.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
 return {...record,result,verificationStatus:run.status,assurance:mapping.origin==='manual'?'MANUAL':run.status!=='passed'?'FAILED':run.inputClosure!=='declared_complete'||!run.toolVersionsKnown?'UNKNOWN':result.status};
}
export async function replayRecords(workspace:string){
 const model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())),hash=modelHash(model),runs=await verificationRuns(workspace,hash);
 const names=await readdir(join(workspace,'evidence/replays')).catch(e=>{if(e.code==='ENOENT')return [] as string[];throw e;});
 const records=[];
 for(const id of names.filter(n=>/^replay_[a-f0-9]{32}$/.test(n)).sort().slice(-100))try{
  const record=recordSchema.parse(JSON.parse((await inputFile(workspace,`evidence/replays/${id}/record.json`,8*1024*1024)).bytes.toString()));
  if(record.id!==id)throw new Error('回放 ID 不符');
  const result=JSON.parse((await inputFile(workspace,`evidence/replays/${id}/result.json`,8*1024*1024)).bytes.toString()) as ReturnType<typeof replayTransactions>;
  if(hashValue(result)!==record.resultDigest)throw new Error('回放结果摘要不符');
  const run=runs.find(r=>r.id===record.mapping.runId);
  let stale=record.modelHash!==hash||!run?.fresh;
  try{const r=await inputFile(workspace,`evidence/runs/${record.mapping.runId}/run.json`);stale ||= r.sha256!==record.runDigest;}catch{stale=true;}
  records.push({...record,result,fresh:!stale,verificationStatus:run?.status??'UNKNOWN',assurance:stale?'STALE':record.mapping.origin==='manual'?'MANUAL':run?.status!=='passed'?'FAILED':!('inputClosure' in run)||run.inputClosure!=='declared_complete'||!run.toolVersionsKnown?'UNKNOWN':result.status});
 }catch(e){records.push({id,assurance:'UNKNOWN',error:String(e)});}
 return {modelHash:hash,records:records.sort((a,b)=>('createdAt' in b?b.createdAt:'').localeCompare('createdAt' in a?a.createdAt:'')),limited:names.length>100};
}
