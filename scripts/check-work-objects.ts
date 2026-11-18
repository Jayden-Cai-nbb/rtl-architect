import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Repository} from '../src/workspace/repository';
import {makeWorkObject,sameWorkObject,workbenchSchema,emptyWorkbench,type WorkTarget} from '../src/core/workbench';
import {hashValue} from '../src/core/export';
const root=await mkdtemp(join(tmpdir(),'rtlarch-work-objects-'));let count=0;
const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++count}: ${name}`)};
try{
 await cp('examples/external-axis',root,{recursive:true});const repo=new Repository(root),base=await repo.getModel();
 const model=structuredClone(base.model);model.specification={summary:'对象协作检查',requirements:[{id:'payload',text:'保持数据',acceptance:'阻塞期间不变',moduleIds:['stage0','stage1']}],decisions:[],openQuestions:[]};
 model.modules.find(m=>m.id==='stage0')!.contract.obligations=[{kind:'state_transition',id:'state_rule',description:'核对更新',localSignalId:'stage0_data_q'}];
 const proposal={baseHash:base.modelHash,reason:'临时对象检查',commands:[{op:'replace_architecture',model}]},p=await repo.preview(proposal),saved=await repo.commit({proposal,candidateHash:p.candidateHash});
 const target=(scope:string,kind:'local_state'|'update_branch'|'requirement'|'obligation',id:string,stateId?:string):WorkTarget=>({modelHash:saved.modelHash,moduleId:scope,connectionIds:[],object:makeWorkObject(saved.model,{scope,kind,id,...(stateId?{stateId}:{})})});
 const a=target('stage0','local_state','stage0_data_q'),b=target('stage1','local_state','stage1_data_q');
 const branch=target('stage0','update_branch','load','stage0_data_q');
 const ask=async(t:WorkTarget,title='关于同名状态')=>repo.updateWorkbench({baseHash:(await repo.getWorkbench()).workbenchHash,action:{kind:'ask',target:t,title,text:'核对这个具体对象'}});
 await check('same RTL definition and state display name remain distinct instances',async()=>{
  assert.equal(model.modules[1].rtlModule,model.modules[2].rtlModule);
  assert.equal(model.localSignals!.find(s=>s.id==='stage0_data_q')!.name,model.localSignals!.find(s=>s.id==='stage1_data_q')!.name);
  await ask(a);const w=await ask(b);assert.equal(w.workbench.threads.filter(t=>sameWorkObject(t.target,a)).length,1);assert.equal(w.workbench.threads.filter(t=>sameWorkObject(t.target,b)).length,1);
  const wrong=structuredClone(a);wrong.object!.instancePath[1].moduleId='stage1';await assert.rejects(ask(wrong));
  const cross=target('stage1','local_state','stage0_data_q');await assert.rejects(ask(cross));
 });
 await check('branch, requirement, obligation and checkpoint restore exact identities',async()=>{
  await ask(branch);await ask(target('top','requirement','payload'));await ask(target('stage0','obligation','state_rule'));
  const w=await repo.getWorkbench();await repo.updateWorkbench({baseHash:w.workbenchHash,action:{kind:'checkpoint',target:branch,intent:'检查装载',nextStep:'核对优先级'}});
  const restored=await new Repository(root).getResume();assert.deepEqual(restored.workbench.checkpoint!.target,branch);assert(restored.checkpointState?.canLocate);assert(restored.threadStates.every(t=>t.canLocate));
 });
 await check('changed/deleted branch and same display name never rebind old questions',async()=>{
  const locals=structuredClone(model.localSignals!);const local=locals.find(l=>l.id==='stage0_data_q')!;assert(local.driver.kind==='register');local.driver.update!.branches[0].id='replacement';
  const change={baseHash:saved.modelHash,reason:'临时分支替换',commands:[{op:'update_local_signals',localSignals:locals}]},preview=await repo.preview(change);await repo.commit({proposal:change,candidateHash:preview.candidateHash});
  const w=await repo.getWorkbench();assert(w.threadStates.every(t=>!t.canLocate&&t.versionChanged));assert(w.checkpointState!.missingTargets.some(x=>x.includes('load')));assert.deepEqual(w.workbench.checkpoint!.target,branch);await assert.rejects(ask(a));
 });
 await check('legacy workbench hash is unchanged and discussions preserve model and approval bytes',async()=>{
  const old=emptyWorkbench();assert.equal(hashValue(workbenchSchema.parse(old)),hashValue(old));
  const dir=join(root,'approved');await mkdir(join(dir,'architecture'),{recursive:true});await cp('examples/packet-pipeline/model.json',join(dir,'architecture/model.json'));
  const r=new Repository(dir),s=await r.getModel();for(const m of s.model.modules)await r.reviewModule({modelHash:s.modelHash,moduleId:m.id,reviewer:'temporary fixture'});await r.review({modelHash:s.modelHash,reviewer:'temporary fixture'});
  const files=['model.json','review.json','module-reviews.json'],before=await Promise.all(files.map(f=>readFile(join(dir,'architecture',f))));
  await r.updateWorkbench({baseHash:(await r.getWorkbench()).workbenchHash,action:{kind:'ask',target:{modelHash:s.modelHash,moduleId:s.model.design.top,connectionIds:[]},title:'普通讨论',text:'不改变批准'}});
  for(const [i,f] of files.entries())assert.deepEqual(await readFile(join(dir,'architecture',f)),before[i]);assert.equal((await r.getModel()).reviewStatus,'APPROVED');
 });
 console.log(`完成第一步 ${count} 组对象协作检查；所有提交与批准仅在临时 fixture。`);
}finally{await rm(root,{recursive:true,force:true});}
