import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {modelSchema} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {validateModel} from '../src/core/engine';
import {runVerification} from '../src/workspace/verification';
import {evaluateStateObservation,runStateObservation,latestStateObservation,stateObservationSchema} from '../src/workspace/stateObservation';
const root=await mkdtemp(join(tmpdir(),'rtlarch-external-axis-'));
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
let groups=0;const check=async(name:string,fn:()=>unknown)=>{await fn();console.log(`PASS ${++groups}: ${name}`)};
try{
 await cp('examples/external-axis',root,{recursive:true});
 const read=async(name:string)=>JSON.parse(await readFile(join(root,name),'utf8'));
 const model=modelSchema.parse(await read('architecture/model.json')),hash=modelHash(model),upstream=await read('upstream.json');
 const profile=await read('elaboration.json'),simulation=await read('verification.json'),mapping=await read('state-mapping.json');
 const file=join(root,upstream.vendoredFile),original=await readFile(file,'utf8');
 await check('pinned MIT upstream is unchanged; explicit partial model validates',()=>{
  assert.equal(createHash('sha256').update(original).digest('hex'),upstream.sha256);assert.equal(upstream.commit,'48ff7a7e2ef782cf778d47910cf85835c64b1bce');assert(original.includes('Permission is hereby granted'));
  assert.deepEqual(validateModel(model).filter(i=>i.blocks.includes('commit')),[]);
 });
 await check('unpruned unreachable X remains UNKNOWN; opt_muxtree is explicit in the producer record',async()=>{
  const raw={...profile,commands:profile.commands.map((c:{args:string[]})=>({...c,args:c.args.map(a=>a.replace('opt_muxtree; ',''))}))};const run=await runVerification(root,raw);assert.equal(run.status,'passed');const report=await evaluateStateObservation(root,{...mapping,runId:run.id});assert(report.results.some(r=>r.status==='UNKNOWN'&&r.reason.includes('X/Z')));
 });
 const run=await runVerification(root,profile);assert.equal(run.status,'passed',json(run));mapping.runId=run.id;
 await check('two identical parameterized instances compare independently, retaining unmodeled RTL state counts',async()=>{
  const r=await runStateObservation(root,mapping);assert.equal(r.status,'MATCH',json(r.results.map(({moduleId,localSignalId,status,reason})=>({moduleId,localSignalId,status,reason}))));assert.equal(r.scopes.length,2);assert.equal(r.results.length,6);assert(r.scope.stateCount>r.scope.mappedCount);assert.equal(r.basis.kind,'as_built');
  assert.deepEqual(r.scopes.map(s=>s.instancePath),[['stage0'],['stage1']]);assert.equal((await latestStateObservation(root,hash)).coverage.matched,6);
 });
 await check('duplicate scopes/model targets and missing instance paths cannot pass',async()=>{
  const duplicate={...mapping,scopes:[mapping.scopes[0],mapping.scopes[0]]};assert.equal((await evaluateStateObservation(root,duplicate)).status,'UNKNOWN');
  const missing={...mapping,scopes:[{...mapping.scopes[0],instancePath:['absent']}]};assert.equal((await evaluateStateObservation(root,missing)).status,'UNKNOWN');
  const missingDiscovery={...mapping,scopes:[...mapping.scopes,{instancePath:['absent'],mappings:[]}]};const missingReport=await evaluateStateObservation(root,missingDiscovery);assert.equal(missingReport.status,'UNKNOWN');assert.equal(missingReport.discoveryComplete,false);
  const cross={...mapping,scopes:[mapping.scopes[0],{...mapping.scopes[1],mappings:mapping.scopes[0].mappings}]};assert.equal((await evaluateStateObservation(root,cross)).status,'UNKNOWN');
  assert(!stateObservationSchema.safeParse({...mapping,scopes:Array.from({length:12},()=>mapping.scopes[0])}).success);
 });
 await check('independent transaction scoreboard exercises backpressure, order and reset cancellation',async()=>{
  const r=await runVerification(root,simulation);assert.equal(r.status,'passed',json(r));console.log((await readFile(join(r.directory,'step-1.stdout.log'),'utf8')).split('\n').find(l=>l.startsWith('EXTERNAL_AXIS_PASS')));
 });
 await check('paired inversions cancel end-to-end but remain local state differences',async()=>{
  await writeFile(file,original.replaceAll('m_axis_tdata_reg <= s_axis_tdata;','m_axis_tdata_reg <= s_axis_tdata ^ 1;'));
  const run=await runVerification(root,profile);assert.equal(run.status,'passed');const compared=await evaluateStateObservation(root,{...mapping,runId:run.id});assert.equal(compared.results.filter(r=>r.status==='MISMATCH').length,2);
  const sim=await runVerification(root,simulation);assert.equal(sim.status,'passed',json(sim));
 });
 await writeFile(file,original.replaceAll('m_axis_tdata_reg <= s_axis_tdata;','m_axis_tdata_reg <= s_axis_tdata + 1;'));
 await check('source mutation stales both instances; single-step comparison and independent scoreboard detect corruption',async()=>{
  const stale=await latestStateObservation(root,hash);assert.equal(stale.status,'STALE');assert.equal(stale.coverage.stale,6);
  const run=await runVerification(root,profile);assert.equal(run.status,'passed');mapping.runId=run.id;
  const r=await runStateObservation(root,mapping);assert.equal(r.status,'MISMATCH');assert.equal(r.results.filter(s=>s.status==='MISMATCH').length,2);
  const sim=await runVerification(root,simulation);assert.equal(sim.status,'command_failed');
  await runStateObservation(root,{...mapping,scopes:[{...mapping.scopes[1],mappings:mapping.scopes[1].mappings.slice(1)}]});
  const summary=await latestStateObservation(root,hash);assert.equal(summary.coverage.mismatched,2);assert.equal(summary.results[0].status,'MISMATCH');assert.equal((await latestStateObservation(root,hash,'stage0')).status,'MISMATCH');
 });
 await writeFile(file,original);
 await check('repair needs fresh elaboration/comparison; partial repair never hides stale states',async()=>{
  assert.equal((await latestStateObservation(root,hash)).status,'STALE');
  const run=await runVerification(root,profile);assert.equal(run.status,'passed');mapping.runId=run.id;
  await runStateObservation(root,{...mapping,scopes:[mapping.scopes[0]]});const partial=await latestStateObservation(root,hash);assert.equal(partial.status,'STALE');assert.equal(partial.coverage.matched,3);assert.equal(partial.coverage.stale,3);
  assert.equal((await latestStateObservation(root,hash,'stage0')).status,'MATCH');
  const report=await runStateObservation(root,mapping);assert.equal(report.status,'MATCH');assert.equal((await latestStateObservation(root,hash)).status,'MATCH');
  const sim=await runVerification(root,simulation);assert.equal(sim.status,'passed',json(sim));
  const saved=JSON.parse(await readFile(join(root,report.record),'utf8'));await writeFile(join(root,report.record),json({...saved,engine:'old-comparator'}));assert.equal((await latestStateObservation(root,hash)).coverage.stale,6);
  await writeFile(join(root,report.record),json({...saved,manifestHash:'0'.repeat(64)}));assert.notEqual((await latestStateObservation(root,hash)).status,'MATCH');
  await writeFile(join(root,report.record),'{bad');assert.notEqual((await latestStateObservation(root,hash)).status,'MATCH');
  assert.equal(modelHash(modelSchema.parse(await read('architecture/model.json'))),hash);assert.equal(await readFile(join(root,'architecture/review.json'),'utf8').catch(()=>null),null);
 });
 console.log(json({groups,passed:true,upstream:upstream.commit,humanReview:'not_run',scope:'REG_TYPE=1, two instances, six modeled states, finite transaction scenarios; excludes sidebands, initial values, skid buffers, cross-instance equivalence and full AXI conformance.'}));
}finally{await rm(root,{recursive:true,force:true});}
