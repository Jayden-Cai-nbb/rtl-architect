import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';import {tmpdir} from 'node:os';
import {Repository} from '../src/workspace/repository';
import {runVerification} from '../src/workspace/verification';
import {importReplay,replayRecords} from '../src/workspace/transactionReplay';
import {replayTransactions,replaySamplesSchema} from '../src/core/transactionReplay';
import {modelHash} from '../src/core/export';
const root=process.env.RTLARCH_REPLAY_WORKSPACE??await mkdtemp(join(tmpdir(),'rtlarch-replay-'));
const evidence=process.env.RTLARCH_REPLAY_EVIDENCE;let count=0;
if(process.env.RTLARCH_REPLAY_WORKSPACE){assert.equal(dirname(resolve(root)),resolve(tmpdir()),'保留的浏览器副本必须直接位于系统临时目录');assert(basename(root).startsWith('rtlarch-'));await mkdir(root);}
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++count}: ${name}`)};
try{
 await cp('examples/external-axis',root,{recursive:true});for(const file of ['tb_replay.sv','replay-profile.json'])await cp(`examples/transaction-replay/${file}`,join(root,file));
 const repo=new Repository(root),base=await repo.getModel(),path=await json('examples/transaction-replay/path.json'),mapping=await json('examples/transaction-replay/mapping.json');
 const proposal={baseHash:base.modelHash,reason:'临时事务回放合同检查',commands:[{op:'update_contract',moduleId:'top',contract:{...base.model.modules[0].contract,transactionPaths:[path]}}]};
 const preview=await repo.preview(proposal);assert.equal((await repo.getModel()).modelHash,base.modelHash);
 const saved=await repo.commit({proposal,candidateHash:preview.candidateHash});assert.notEqual(saved.reviewStatus,'APPROVED');
 const profile=await json(join(root,'replay-profile.json'));
 const upstream=await readFile(join(root,'vendor/axis_register.v'),'utf8');
 let good:Awaited<ReturnType<typeof importReplay>>;
 await check('real external RTL records pre/post edges, backpressure recovery and reset cancellation',async()=>{
  const run=await runVerification(root,profile);assert.equal(run.status,'passed');mapping.runId=run.id;
  good=await importReplay(root,mapping);assert.equal(good.assurance,'OBSERVED',JSON.stringify(good.result.issues));
  assert(good.result.events.some(e=>e.kind==='cancel'));assert(good.result.rows.some(r=>r.blocked.length));assert(good.result.events.some(e=>e.kind==='consume'&&e.edge>19));
  assert.equal(good.result.inFlight.length,0);
  const accepted=good.result.events.filter(e=>e.kind==='accept').map(e=>e.transaction),ended=good.result.events.filter(e=>e.kind==='consume'||e.kind==='cancel').map(e=>e.transaction);
  assert.deepEqual([...accepted].sort(),[...ended].sort());assert.equal(new Set(accepted).size,accepted.length);
  assert(good.result.events.some(e=>e.kind==='visible'&&e.phase==='post'&&good.result.events.some(a=>a.kind==='accept'&&a.edge===e.edge&&a.transaction===e.transaction)));
  if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'good.json'),JSON.stringify(good,null,2));}
 });
 await check('unknown, missing maps, edge gaps and manual origin never become simulation PASS',async()=>{
  const artifact=await json(join(root,'evidence/runs',mapping.runId,'trace.json')),bad=structuredClone(artifact);bad.rows[3].post.v1='x';
  assert.equal(replayTransactions(saved.model,path,mapping,replaySamplesSchema.parse(bad)).status,'UNKNOWN');
  bad.rows[3].edge=9;assert.throws(()=>replayTransactions(saved.model,path,mapping,bad));
  assert.throws(()=>replayTransactions(saved.model,path,{...mapping,points:[]},artifact));
  assert.throws(()=>replayTransactions(saved.model,path,mapping,{...artifact,clock:{id:path.clock,edge:'falling'}}));
  const manual=await importReplay(root,{...mapping,origin:'manual'});assert.equal(manual.assurance,'MANUAL');
  await assert.rejects(importReplay(root,{...mapping,configuration:'not-an-input'}));
  await assert.rejects(importReplay(root,{...mapping,artifact:'../../architecture/model.json'}));
  const wrong=structuredClone(mapping);wrong.points[1].model.data='s_axis_tdata';assert.throws(()=>replayTransactions(saved.model,path,wrong,artifact));
  const initial=structuredClone(artifact);initial.rows[0].pre.rst='0';initial.rows[0].post.rst='0';assert.equal(replayTransactions(saved.model,path,mapping,initial).status,'UNKNOWN');
  const invalid={...path,clock:'unmapped_clock'};await assert.rejects(repo.preview({baseHash:saved.modelHash,reason:'不支持的域不能猜测',commands:[{op:'update_contract',moduleId:'top',contract:{...saved.model.modules[0].contract,transactionPaths:[invalid]}}]}));
 });
 for(const fault of ['valid_phase','blocked_overwrite'])await check(`real RTL fault ${fault} identifies transaction, edge and state`,async()=>{
  // Mutate only REG_TYPE=1 inside the temporary upstream copy. Original fixture is untouched.
  const start=upstream.indexOf('end else if (REG_TYPE == 1)'),head=upstream.slice(0,start),tail=upstream.slice(start);
  assert(start>0);
  const changed=fault==='valid_phase'?tail.replace("always @(posedge clk) begin","reg replay_delay=0;\n    always @(posedge clk) begin\n        replay_delay <= rst ? 0 : m_axis_tvalid_next;").replace("m_axis_tvalid_reg <= m_axis_tvalid_next;","m_axis_tvalid_reg <= replay_delay;") : tail.replace('if (store_axis_input_to_output) begin','if (1) begin');
  assert.notEqual(changed,tail);await writeFile(join(root,'vendor/axis_register.v'),head+changed);
  const run=await runVerification(root,profile);assert.equal(run.status,'passed');
  const replay=await importReplay(root,{...mapping,runId:run.id});assert.equal(replay.assurance,'FAILED');
  const issue=replay.result.issues.find(i=>i.code===(fault==='valid_phase'?'VALID_PHASE':'BLOCKED_PAYLOAD_OVERWRITE')&&i.transaction);
  assert(issue,JSON.stringify(replay.result.issues));assert(issue.edge>=1);assert(issue.state.localSignalId.endsWith(fault==='valid_phase'?'_valid_q':'_data_q'));
  if(evidence)await writeFile(join(evidence,`${fault}.json`),JSON.stringify(replay,null,2));
 });
 await check('source changes stale old observations, model changes stale all; original hashes preserved',async()=>{
  const records=await replayRecords(root);assert(records.records.some(r=>r.id===good.id&&r.assurance==='STALE'));
  const current=await repo.getModel(),p={baseHash:current.modelHash,reason:'临时版本过期检查',commands:[{op:'rename_module',moduleId:'top',name:'changed'}]};const v=await repo.preview(p);await repo.commit({proposal:p,candidateHash:v.candidateHash});assert((await replayRecords(root)).records.every(r=>r.assurance==='STALE'));
  assert.equal(modelHash(base.model),base.modelHash);assert.equal(await readFile('examples/external-axis/vendor/axis_register.v','utf8'),upstream);
 });
 // Restore only this temporary fixture via preview/commit, then run a fresh good replay for browser review.
 if(process.env.RTLARCH_REPLAY_WORKSPACE){await writeFile(join(root,'vendor/axis_register.v'),upstream);const current=await repo.getModel(),p={baseHash:current.modelHash,reason:'恢复临时回放样例',commands:[{op:'replace_architecture',model:saved.model}]};const v=await repo.preview(p);await repo.commit({proposal:p,candidateHash:v.candidateHash});const run=await runVerification(root,profile);assert.equal(run.status,'passed');await importReplay(root,{...mapping,runId:run.id});}
 console.log(`完成 ${count} 组事务回放检查；只在临时副本提交，无批准。`);
}finally{if(!process.env.RTLARCH_REPLAY_WORKSPACE)await rm(root,{recursive:true,force:true});}
