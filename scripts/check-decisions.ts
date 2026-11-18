import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Repository} from '../src/workspace/repository';
import {runVerification} from '../src/workspace/verification';
import {studyMatchesCandidates,type Study} from '../src/core/studies';
import {hardwareChangeSummary,semanticDiff} from '../src/core/diff';
import type {DecisionInput} from '../src/core/decisions';
import type {Model} from '../src/core/schema';
const root=await mkdtemp(join(tmpdir(),'rtlarch-decisions-'));let checks=0;
const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++checks}: ${name}`)};
try{
 await mkdir(join(root,'architecture'));await cp('examples/packet-pipeline/model.json',join(root,'architecture/model.json'));const repo=new Repository(root),base=await repo.getModel();
 const a=structuredClone(base.model),b=structuredClone(base.model);a.modules[0].name='候选 A';b.modules[0].name='候选 B';
 const commit=async(model:Model)=>{const current=await repo.getModel(),proposal={baseHash:current.modelHash,reason:'临时版本记录检查',commands:[{op:'replace_architecture',model}]},p=await repo.preview(proposal);return repo.commit({proposal,candidateHash:p.candidateHash});};
 await writeFile(join(root,'probe.cjs'),"console.log('version-binding fixture, not RTL verification');process.exit(process.argv.includes('--fail')?1:0)");
 const profile=(fail=false)=>({schemaVersion:1,name:'候选证据绑定检查（非 RTL）',stage:'lint',moduleIds:base.model.modules.map(m=>m.id),inputs:['probe.cjs'],inputClosure:{status:'declared_complete',note:'仅检查本地记录隔离'},timeoutMs:5000,commands:[{program:process.execPath,args:['probe.cjs',...(fail?['--fail']:[])],versionArgs:['--version']}],checks:[{kind:'exit_code'}]});
 await commit(a);const runA=await runVerification(root,profile());await commit(b);const runB=await runVerification(root,profile(true));await commit(base.model);
 for(const m of base.model.modules)await repo.reviewModule({modelHash:base.modelHash,moduleId:m.id,reviewer:'temporary fixture'});await repo.review({modelHash:base.modelHash,reviewer:'temporary fixture'});
 const files=['model.json','review.json','module-reviews.json'],bytes=await Promise.all(files.map(f=>readFile(join(root,'architecture',f))));
 const register=async(model:Model,reason:string)=>{const p=await repo.registerProposal({baseHash:base.modelHash,reason,commands:[{op:'replace_architecture',model}]});return {proposalId:p.id,modelHash:p.candidateHash};};
 const ca=await register(a,'方案 A'),cb=await register(b,'方案 B');
 const save=async(action:unknown)=>repo.updateWorkbench({baseHash:(await repo.getWorkbench()).workbenchHash,action});
 await save({kind:'ask',target:{modelHash:base.modelHash,moduleId:base.model.design.top,connectionIds:[]},title:'选择哪一个候选？',text:'按本次假设比较'});
 const threadId=(await repo.getWorkbench()).workbench.threads[0].id;
 const study:Study={id:'bound_budget',title:'条件化预算',modelHash:base.modelHash,moduleIds:[base.model.design.top],configuration:'相同工作量',assumptions:['工作项独立'],workItems:16,options:[{id:'a',label:'A',candidate:ca,compute:{lanes:1,operationsPerItem:1,cyclesPerOperation:1,overheadCycles:0},runIds:[runA.id]},{id:'b',label:'B',candidate:cb,compute:{lanes:2,operationsPerItem:1,cyclesPerOperation:1,overheadCycles:0},runIds:[runB.id]}]};
 const decision:DecisionInput={id:'decision',title:'记录 A/B 取舍',threadIds:[threadId],options:[ca,cb].map((candidate,i)=>({id:i?'b':'a',label:i?'B':'A',candidate,budget:{studyId:study.id,optionId:i?'b':'a'},assumptions:['只核对显式版本'],risks:['非 RTL 实验不能证明硬件性能'],experiments:[{runId:i?runB.id:runA.id,modelHash:candidate.modelHash}]}))};
 await check('read-only candidate evaluation isolates A/B hashes and preserves failed evidence',async()=>{
  assert.equal(runA.status,'passed');assert.notEqual(runB.status,'passed');
  const report=await repo.compareCandidates({before:a,after:b});assert(report.readOnly);assert.deepEqual(report.before.runs.map(r=>r.id),[runA.id]);assert.deepEqual(report.after.runs.map(r=>r.id),[runB.id]);
  assert.equal(report.after.runs[0].status,runB.status);assert.deepEqual(report.diff,semanticDiff(a,b));
  await save({kind:'study',study});await save({kind:'decision',decision});
 });
 await check('A evidence or budget cannot be attached to B and mismatched candidate hashes fail',async()=>{
  const wrong=structuredClone(decision);wrong.id='wrong_run';wrong.options[1].experiments=[{runId:runA.id,modelHash:cb.modelHash}];await assert.rejects(save({kind:'decision',decision:wrong}));
  wrong.id='wrong_budget';wrong.options[1].experiments=[];wrong.options[1].budget!.optionId='a';await assert.rejects(save({kind:'decision',decision:wrong}));
  const s=structuredClone(study);s.id='wrong_hash';s.options[0].candidate!.modelHash=cb.modelHash;await assert.rejects(save({kind:'study',study:s}));
 });
 await check('explicit user choice is append-only and does not resolve, commit or approve',async()=>{
  await save({kind:'choose_decision',decisionId:decision.id,optionId:'a',reason:'保留当前资源预算，后续独立验证'});
  const w=await new Repository(root).getWorkbench();assert.equal(w.workbench.decisions![0].choices.length,1);assert.equal(w.workbench.threads[0].status,'open');assert.equal(w.decisionStates[0].options[1].experiments[0].status,runB.status);
  for(const [i,file] of files.entries())assert.deepEqual(await readFile(join(root,'architecture',file)),bytes[i]);assert.equal((await repo.getModel()).reviewStatus,'APPROVED');
 });
 await check('candidate revision invalidates old comparison budgets; stale inputs retain historical failures',async()=>{
  const changed=structuredClone(b);changed.modules[0].name='候选 B 修订';const cb2=await register(changed,'修订 B');assert(!studyMatchesCandidates(study,[ca,cb2]));assert(studyMatchesCandidates(study,[ca,cb]));
  const d=structuredClone(decision);d.id='new_candidate_old_budget';d.options[1].candidate=cb2;d.options[1].experiments=[];await assert.rejects(save({kind:'decision',decision:d}));
  await writeFile(join(root,'probe.cjs'),'// changed source');let w=await repo.getWorkbench();assert(w.studyStates[0].stale);assert(w.decisionStates[0].options.every(o=>o.stale));assert.equal(w.decisionStates[0].options[1].experiments[0].status,runB.status);
  await assert.rejects(save({kind:'choose_decision',decisionId:decision.id,optionId:'a',reason:'不可静默复用旧来源'}));await commit(changed);w=await repo.getWorkbench();assert(w.studyStates.every(s=>s.stale));assert.equal(w.workbench.decisions![0].choices.length,1);
 });
 await check('deterministic summary covers rule order, state, width, truncation and full connections',async()=>{
  const before:Model=JSON.parse(await readFile('examples/typed-expressions/architecture/model.json','utf8')),after=structuredClone(before);
  const local=after.localSignals!.find(l=>l.driver.kind==='register')!;assert(local.driver.kind==='register');const first=local.driver.update!.branches[0];local.driver.update!.branches.unshift({...structuredClone(first),id:'earlier'});
  local.width=typeof local.width==='number'?local.width+1:16;
  let found=false;const walk=(v:any)=>{if(!v||typeof v!=='object')return;if(v.kind==='cast'&&v.mode==='truncate'&&!found){v.width++;found=true;}for(const child of Object.values(v))walk(child);};walk(after.localSignals);assert(found);
  after.connections[0].to={...after.connections[0].to,slice:{msb:0,lsb:0}};
  const raw=semanticDiff(before,after),summary=hardwareChangeSummary(before,after);for(const kind of ['state','priority','width','truncation','connection'])assert(summary.items.some(i=>i.category===kind));
  assert.deepEqual(semanticDiff(before,after),raw);const shuffled=structuredClone(after);shuffled.modules.reverse();shuffled.connections.reverse();shuffled.localSignals!.reverse();assert.deepEqual(hardwareChangeSummary(before,shuffled),summary);
  assert(summary.items.find(i=>i.category==='priority')!.text.includes('真实规则'));assert(summary.note.includes('没有推断端到端'));
 });
 console.log(`完成第二步 ${checks} 组决策检查；实验为本地记录隔离 fixture，不声称 RTL 验证。`);
}finally{await rm(root,{recursive:true,force:true});}
