import {z} from 'zod';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hashSchema,idSchema,modelSchema} from '../core/schema';
import {hashValue,modelHash} from '../core/export';
import {inputFile,newArtifactDirectory,workspacePath} from './artifacts';
import {ToolError} from './environment';
const exec=promisify(execFile),text=z.string().trim().min(1);
export const verificationProfileSchema=z.strictObject({schemaVersion:z.literal(1),name:text,stage:z.enum(['compile','elaboration','lint','simulation','synthesis','timing','formal']),moduleIds:z.array(idSchema).min(1),inputs:z.array(text).min(1).max(10000),timeoutMs:z.number().int().min(100).max(3600000),commands:z.array(z.strictObject({program:text,args:z.array(z.string()).max(1000),versionArgs:z.array(z.string()).max(20).optional()})).min(1).max(20),checks:z.array(z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('exit_code')}),z.strictObject({kind:z.literal('contains'),file:text,text}),z.strictObject({kind:z.literal('junit'),file:text})])).min(1).max(30)});
const snapshot=async(workspace:string,paths:string[])=>Promise.all(paths.map(async file=>{const {sha256}=await inputFile(workspace,file);return {file,sha256};}));
const json=(x:unknown)=>JSON.stringify(x,null,2)+'\n';
async function command(program:string,args:string[],cwd:string,timeoutMs:number){
 return new Promise<{exitCode:number|null;signal:string|null;stdout:string;stderr:string;timedOut:boolean;outputLimit:boolean}>((resolve)=>{
  const child=spawn(program,args,{cwd,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let stdout='',stderr='',size=0,timedOut=false,outputLimit=false,finished=false;
  const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
  const collect=(chunk:Buffer,stream:'stdout'|'stderr')=>{size+=chunk.length;if(size>4*1024*1024){outputLimit=true;kill();return;}if(stream==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();};
  child.stdout.on('data',c=>collect(c,'stdout'));child.stderr.on('data',c=>collect(c,'stderr'));
  const done=(exitCode:number|null,signal:string|null)=>{if(finished)return;finished=true;clearTimeout(timer);resolve({exitCode,signal,stdout,stderr,timedOut,outputLimit});};
  child.on('error',e=>{stderr+=String(e);done(null,null);});child.on('close',(code,signal)=>done(code,signal));
 });
}
export async function runVerification(workspace:string,input:unknown){
 const profile=verificationProfileSchema.parse(input),model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())),hash=modelHash(model);
 if(profile.moduleIds.some(id=>!model.modules.some(m=>m.id===id)))throw new ToolError('MODULE_NOT_FOUND','验证清单引用不存在的模块');
 if(new Set(profile.inputs).size!==profile.inputs.length)throw new ToolError('INPUT_DUPLICATE','验证输入清单含重复文件');
 const before=await snapshot(workspace,profile.inputs),id=`run_${Date.now()}_${randomUUID().replaceAll('-','')}`;
 // Resolve the evidence parent before accepting it as a workspace-owned destination.
 await mkdir(join(workspace,'evidence'),{recursive:true});await workspacePath(workspace,'evidence');await mkdir(join(workspace,'evidence/runs'),{recursive:true});await workspacePath(workspace,'evidence/runs');
 const dir=await newArtifactDirectory(workspace,join(workspace,'evidence/runs',id)),startedAt=new Date().toISOString(),start=Date.now();
 const steps:Record<string,unknown>[]=[],checks:Record<string,unknown>[]=[],artifacts:{file:string;sha256:string}[]=[];let failure:string|undefined;
 for(const [index,c] of profile.commands.entries()){
  const program=c.program.replaceAll('{runDir}',dir),args=c.args.map(a=>a.replaceAll('{runDir}',dir));
  let toolVersion='unknown';if(c.versionArgs){const v=await command(program,c.versionArgs,workspace,Math.min(5000,profile.timeoutMs));toolVersion=v.exitCode===0?(v.stdout||v.stderr).trim().slice(0,2000):'version probe failed';}
  const remaining=profile.timeoutMs-(Date.now()-start);if(remaining<=0){failure='timeout';break;}
  const result=await command(program,args,workspace,remaining);
  for(const stream of ['stdout','stderr'] as const){const file=`step-${index}.${stream}.log`;await writeFile(join(dir,file),result[stream]);artifacts.push({file,sha256:(await inputFile(dir,file)).sha256});}
  steps.push({program,args,cwd:workspace,toolVersion,exitCode:result.exitCode,signal:result.signal,timedOut:result.timedOut,outputLimit:result.outputLimit});
  if(result.timedOut||result.outputLimit||result.exitCode!==0){failure=result.timedOut?'timeout':result.outputLimit?'output_limit':'command_failed';break;}
 }
 if(!failure)for(const check of profile.checks){if(Date.now()-start>=profile.timeoutMs){failure='timeout';break;}try{
  if(check.kind==='exit_code'){checks.push({...check,passed:true});continue;}
  const content=await inputFile(dir,check.file,8*1024*1024);artifacts.push({file:check.file,sha256:content.sha256});
  if(check.kind==='contains'){const passed=content.bytes.toString().includes(check.text);checks.push({...check,passed});if(!passed)failure='check_failed';}
  else {
   const script="import json,sys,xml.etree.ElementTree as E\ns=open(sys.argv[1],encoding='utf-8').read()\nif '<!DOCTYPE' in s.upper() or '<!ENTITY' in s.upper(): raise ValueError('DTD/entity declarations are not supported')\nr=E.fromstring(s)\nc=[e for e in r.iter() if e.tag.split('}')[-1]=='testcase']\nf=sum(any(n.tag.split('}')[-1] in ('failure','error') for n in e) for e in c)\nsuite_problem=any(any(int(e.get(k,'0'))!=0 for k in ('failures','errors','skipped','disabled')) for e in r.iter() if e.tag.split('}')[-1] in ('testsuite','testsuites'))\nsk=sum(any(n.tag.split('}')[-1]=='skipped' for n in e) for e in c)\nreport_problem=suite_problem or any(e.tag.split('}')[-1] in ('failure','error','skipped') for e in r.iter())\nprint(json.dumps(dict(tests=len(c),failed=f,skipped=sk,reportProblem=report_problem)))";
   const result=JSON.parse((await exec('python3',['-c',script,await workspacePath(dir,check.file)],{timeout:Math.max(1,Math.min(10000,profile.timeoutMs-(Date.now()-start))),maxBuffer:1024*1024})).stdout);
   const passed=result.tests>0&&result.failed===0&&result.skipped===0&&!result.reportProblem;checks.push({...check,...result,passed});if(!passed)failure='check_failed';
  }
 }catch(error){checks.push({...check,passed:false,error:String(error)});failure='check_failed';}}
 let after:typeof before=[];try{after=await snapshot(workspace,profile.inputs);if(hashValue(after)!==hashValue(before))failure='inputs_changed';}catch(e){failure='inputs_unavailable';}
 try{if(modelHash(modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())))!==hash)failure='model_changed';}catch{failure='model_unavailable';}
 if(Date.now()-start>profile.timeoutMs&&!failure)failure='timeout';
 const record={schemaVersion:1,id,name:profile.name,stage:profile.stage,moduleIds:profile.moduleIds,modelHash:hash,profileHash:hashValue(profile),profile,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-start,status:failure??'passed',inputs:before,inputsAfter:after,steps,checks,artifacts,note:'只证明声明命令和检查在本次显式输入下的结果；未自动发现依赖，不改变架构批准或模型验证声明。'};
 await writeFile(join(dir,'run.json'),json(record),{flag:'wx'});return {...record,directory:dir};
}
const runSchema=z.object({schemaVersion:z.literal(1),id:idSchema,name:text,stage:text,moduleIds:z.array(idSchema),modelHash:hashSchema,status:text,finishedAt:text,durationMs:z.number(),inputs:z.array(z.object({file:text,sha256:hashSchema})),artifacts:z.array(z.object({file:text,sha256:hashSchema}))});
export async function verificationRuns(workspace:string,currentHash:string){
 const names=await readdir(join(workspace,'evidence/runs')).catch(e=>{if(e.code==='ENOENT')return [] as string[];throw e;});
 const summaries=[];
 for(const id of names.filter(n=>/^run_\d+_[a-f0-9]{32}$/.test(n)).sort().reverse().slice(0,100)){
  try{
   const r=runSchema.parse(JSON.parse((await inputFile(workspace,`evidence/runs/${id}/run.json`)).bytes.toString()));if(r.id!==id)throw new Error('运行标识不匹配');
   const changed:string[]=[];
   for(const input of r.inputs){try{if((await inputFile(workspace,input.file)).sha256!==input.sha256)changed.push(input.file);}catch{changed.push(input.file);}}
   for(const artifact of r.artifacts){try{if((await inputFile(await workspacePath(workspace,`evidence/runs/${id}`),artifact.file)).sha256!==artifact.sha256)changed.push(`报告:${artifact.file}`);}catch{changed.push(`报告:${artifact.file}`);}}
   summaries.push({id,name:r.name,stage:r.stage,moduleIds:r.moduleIds,modelHash:r.modelHash,status:r.status,finishedAt:r.finishedAt,durationMs:r.durationMs,fresh:r.modelHash===currentHash&&!changed.length,changedFiles:changed,record:`evidence/runs/${id}/run.json`});
  }catch(e){summaries.push({id,name:id,status:'unreadable',fresh:false,error:String(e)});}
 }
 return summaries;
}
