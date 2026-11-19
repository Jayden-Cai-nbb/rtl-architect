import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';import {tmpdir} from 'node:os';
import {Repository} from '../src/workspace/repository';
import {runVerification} from '../src/workspace/verification';
import {importReplay,replayRecords} from '../src/workspace/transactionReplay';
import {REPLAY_CHECKER_VERSION,replayTransactions,replaySamplesSchema,type ReplaySamples} from '../src/core/transactionReplay';
import {hashValue,modelHash} from '../src/core/export';
import {validateModel} from '../src/core/engine';
import {stateUpdateReads} from '../src/core/signals';
import type {Model} from '../src/core/schema';
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
  const {coverage,environment}=good.result;
  assert.equal(environment.status,'CHECKED');
  assert(coverage.accepted>0&&coverage.consumed>0&&coverage.blocked>0&&coverage.recovered>0&&coverage.cancelled>0);
  assert(coverage.inputBlockedEdges>0&&coverage.inputRecovered>0);
  assert.equal(coverage.accepted,coverage.consumed+coverage.cancelled);
  assert.equal(good.result.inFlight.length,0);
  const accepted=good.result.events.filter(e=>e.kind==='accept').map(e=>e.transaction),ended=good.result.events.filter(e=>e.kind==='consume'||e.kind==='cancel').map(e=>e.transaction);
  assert.deepEqual([...accepted].sort(),[...ended].sort());assert.equal(new Set(accepted).size,accepted.length);
  assert(good.result.events.some(e=>e.kind==='visible'&&e.phase==='post'&&good.result.events.some(a=>a.kind==='accept'&&a.edge===e.edge&&a.transaction===e.transaction)));
  if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'good.json'),JSON.stringify(good,null,2));}
 });
 const sample=(overrides:Record<string,string>={})=>({rst:'0',d0:'0',v0:'0',r0:'0',d1:'0',v1:'0',r1:'1',d2:'0',v2:'0',r2:'1',...overrides});
 const reset=sample({rst:'1'});
 const rows=[
  {edge:0,pre:reset,post:reset},
  {edge:1,pre:sample({d0:'42',v0:'1',r0:'1'}),post:sample({d0:'42',v0:'1',d1:'42',v1:'1'})},
 ];
 const replay=(rows:ReplaySamples['rows'],model=saved.model)=>replayTransactions(model,path,mapping,{format:'rtlarch-rv-samples-v1',
  clock:{id:'clk',edge:'rising'},sampling:'pre_edge_handshake_post_edge_settled',rows});
 const dataState=(model:Model)=>model.localSignals!.find(s=>s.id==='stage0_data_q')!;
 await check('equivalent parameter and expression widths resolve in the state scope, mismatches fail',()=>{
  const model=structuredClone(saved.model);
  const parent=model.modules.find(m=>m.id==='top')!;
  const stage=model.modules.find(m=>m.id==='stage0')!;
  parent.parameters.DATA_BITS=8;
  stage.parameters.LOCAL_BITS=1;
  stage.parameterBindings={LOCAL_BITS:{reference:'DATA_BITS',scope:'parent',type:'number'}};
  for(const width of [{param:'LOCAL_BITS'},{expr:'LOCAL_BITS * 2 / 2'}]){
   dataState(model).width=width;
   assert.deepEqual(validateModel(model).filter(i=>i.blocks.includes('commit')),[]);
   assert.equal(replay(rows,model).status,'OBSERVED');
  }
  for(const width of [{expr:'LOCAL_BITS + 1'},{param:'UNDECLARED'}]){
   dataState(model).width=width;
   assert(validateModel(model).some(i=>i.code==='TRANSACTION_PATH'&&i.message.includes('位宽')));
   assert.throws(()=>replay(rows,model),/位宽/);
  }
 });
 await check('constant-zero and shadowed load declarations reject instead of reporting a matching branch',()=>{
  for(const shadowed of [false,true]){
   const model=structuredClone(saved.model);
   const driver=dataState(model).driver;
   assert(driver.kind==='register'&&driver.update);
   const load=driver.update.branches.find(b=>b.id==='load')!;
   if(shadowed)driver.update.branches.unshift({...load,id:'always_first',condition:{kind:'constant',value:'1',width:1}});
   else load.condition={kind:'constant',value:'0',width:1};
   driver.inputs=stateUpdateReads(driver.update);
   const validation=validateModel(model).filter(i=>i.blocks.includes('commit'));
   assert.deepEqual(validation.map(i=>i.code),['TRANSACTION_PATH']);
   assert.match(validation[0].message,shadowed?/常量 1 分支/:/常量 0/);
   assert.throws(()=>replay(rows,model),/装载分支不可达/);
  }
  const observed=replay(rows);
  assert.equal(observed.events.find(e=>e.kind==='accept')?.branch,null);
  const visible=observed.events.find(e=>e.kind==='visible')!;
  assert.equal(visible.branch,'load');
  assert.deepEqual(visible.observation,{phase:'post',valid:'MATCH',data:'MATCH'});
  assert(!Object.hasOwn(visible,'matched'));
  const incorrectData=structuredClone(rows);
  incorrectData[1].post.d1='43';
  assert.deepEqual(replay(incorrectData).events.find(e=>e.kind==='visible')?.observation,{phase:'post',valid:'MATCH',data:'MISMATCH'});
  incorrectData[1].post.v1='0';
  assert.deepEqual(replay(incorrectData).events.find(e=>e.kind==='visible')?.observation,{phase:'post',valid:'MISMATCH',data:null});
 });
 await check('reset-only is uncovered, accepted finite prefix can retain a beat',()=>{
  const empty=replay(rows.slice(0,1));
  assert.equal(empty.status,'COVERAGE_INCOMPLETE');
  assert.equal(empty.coverage.resetEdges,1);
  assert.equal(empty.coverage.accepted,0);
  assert.equal(empty.observations.valid.matched,2);
  const partial=replay(rows);
  assert.equal(partial.status,'OBSERVED');
  assert.equal(partial.coverage.accepted,1);
  assert.equal(partial.coverage.consumed,0);
  assert.equal(partial.coverage.cancelled,0);
  assert.deepEqual(partial.inFlight,[{id:'T0',payload:'42'}]);
 });
 await check('source must hold valid and payload until acceptance, with no downstream attribution or reset carry-over',()=>{
  const blocked=sample({d0:'17',v0:'1'});
  const over=replay([rows[0],{edge:1,pre:blocked,post:{...blocked,d0:'42',v1:'1'}}]);
  assert.equal(over.status,'ENVIRONMENT_VIOLATION');
  assert.deepEqual(over.environment.violation,{code:'INPUT_PAYLOAD_CHANGED',edge:1,phase:'post',stalledAt:1,
   endpoint:{moduleId:'top',interfaceId:'s_axis_tdata'},expected:'17',actual:'42'});
  assert.deepEqual(over.issues,[]);
  assert.equal(over.coverage.checkedEdges,1);
  const earlierFault=replay([{...rows[0],post:{...reset,v1:'1'}},{edge:1,pre:blocked,post:{...blocked,d0:'42',v2:'1'}}]);
  assert.equal(earlierFault.status,'ENVIRONMENT_VIOLATION');
  assert.deepEqual(earlierFault.issues.map(i=>[i.edge,i.code,i.state.localSignalId]),[[0,'VALID_PHASE','stage0_valid_q']]);
  const waited={edge:1,pre:blocked,post:blocked};
  const withdrawn=replay([rows[0],waited,{edge:2,pre:sample(),post:sample({v2:'1'})}]);
  assert.equal(withdrawn.status,'ENVIRONMENT_VIOLATION');
  assert.equal(withdrawn.environment.violation?.code,'INPUT_VALID_DROPPED');
  assert.equal(withdrawn.environment.violation?.endpoint.interfaceId,'s_axis_tvalid');
  assert.equal(withdrawn.environment.violation?.phase,'pre');
  assert.deepEqual(withdrawn.issues,[]);
  const premature=replay([rows[0],waited,{...rows[1],edge:2}]);
  assert.equal(premature.status,'ENVIRONMENT_VIOLATION');
  assert.equal(premature.coverage.accepted,0);
  assert.equal(premature.environment.violation?.phase,'pre');
  const legal=replay([rows[0],waited,{edge:2,pre:sample({rst:'1',d0:'99'}),post:reset},{...rows[1],edge:3}]);
  assert.equal(legal.status,'OBSERVED');
  assert.equal(legal.coverage.inputRecovered,0);
  assert.equal(legal.coverage.inputBlockedEdges,1);
 });
 await check('checker versions invalidate history while the latest 100 follow time and their exact producer',async()=>{
  const dir=join(root,'evidence/replays'),source=join(dir,good.id);
  const metadata=await json(join(source,'record.json')),result=await json(join(source,'result.json'));
  assert.equal(metadata.checkerVersion,REPLAY_CHECKER_VERSION);
  const savedPaths:string[]=[];
  const save=async(id:string,record:unknown,result:unknown)=>{
   const path=join(dir,id);
   await mkdir(path);savedPaths.push(path);
   await writeFile(join(path,'record.json'),JSON.stringify(record));
   await writeFile(join(path,'result.json'),JSON.stringify(result));
  };
  const id=(index:number)=>'replay_'+index.toString(16).padStart(32,'0');
  try{
   const legacyId=id(500),mismatchedId=id(501),previousId=id(502);
   const {checkerVersion:_version,...legacy}=metadata;
   const legacyResult={status:'OBSERVED',events:[],rows:[],issues:[],note:'保存的早期结果',unprocessed:0,inFlight:[]};
   await save(legacyId,{...legacy,id:legacyId,resultDigest:hashValue(legacyResult)},legacyResult);
   await save(mismatchedId,{...metadata,id:mismatchedId,checkerVersion:REPLAY_CHECKER_VERSION+1},result);
   const previousResult={...result,checkerVersion:2};
   await save(previousId,{...metadata,id:previousId,checkerVersion:2,resultDigest:hashValue(previousResult)},previousResult);
   const archived=await replayRecords(root);
   for(const id of [legacyId,mismatchedId,previousId]){
    const entry=archived.records.find(r=>r.id===id);
    assert(entry&&'result' in entry);
    assert.equal(entry.result.status,'OBSERVED');assert.equal(entry.assurance,'STALE');
    assert.equal(entry.fresh,false);assert.equal(entry.staleReason,'CHECKER_VERSION');
   }
   for(let i=0;i<=100;i++){
    const time=Date.parse(good.createdAt)+1000*(101-i);
    const createdAt=i===99?new Date(time+8*3600000).toISOString().replace('Z','+08:00'):new Date(time).toISOString();
    await save(id(i),{...metadata,id:id(i),createdAt},result);
    const unrelated=join(root,'evidence/runs',`run_${Date.now()+60000+i}_${i.toString(16).padStart(32,'0')}`);
    await mkdir(unrelated);savedPaths.push(unrelated);
   }
   const listing=await replayRecords(root);
   assert.equal(listing.limited,true);
   assert.deepEqual(listing.records.map(r=>r.id),Array.from({length:100},(_,i)=>id(i)));
   assert(listing.records.every(r=>'fresh' in r&&r.fresh&&r.assurance==='OBSERVED'));
  }finally{
   for(const path of savedPaths)await rm(path,{recursive:true,force:true});
  }
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
  assert(issue&&'state' in issue,JSON.stringify(replay.result.issues));assert(issue.edge>=1);assert(issue.state.localSignalId.endsWith(fault==='valid_phase'?'_valid_q':'_data_q'));
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
