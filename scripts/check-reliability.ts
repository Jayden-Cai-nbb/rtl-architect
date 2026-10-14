import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelSchema,type Model,type SignalValue} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {validateModel} from '../src/core/engine';
import {stateUpdateReads} from '../src/core/signals';
import {readStateCoverage} from '../src/core/stateCoverage';
import {generateChecks,renderChecks} from '../src/workspace/contractChecks';
import {runVerification} from '../src/workspace/verification';
import {assurance} from '../src/workspace/assurance';
import {Repository} from '../src/workspace/repository';
const root=await mkdtemp(join(tmpdir(),'rtlarch-reliability-'));let groups=0;
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
const check=async(name:string,fn:()=>unknown)=>{await fn();console.log(`PASS ${++groups}: ${name}`);};
const base=modelSchema.parse(JSON.parse(await readFile('examples/state-updates/architecture/model.json','utf8')));
const bindings=JSON.parse(await readFile('examples/state-updates/bindings.json','utf8'));bindings.bindings=bindings.bindings.slice(0,1);
const profile=JSON.parse(await readFile('examples/state-updates/verification.json','utf8'));
const rtl=await readFile('examples/state-updates/rtl/add_const.sv','utf8');
const ep=(id:string,local=false):SignalValue=>({kind:'endpoint',endpoint:{moduleId:'top',interfaceId:id,...(local?{local:true}: {})}});
const constant=(width:number,value:string):SignalValue=>({kind:'constant',width,value});
const driver=(m:Model)=>{const d=m.localSignals!.find(l=>l.id==='out_data')!.driver;if(d.kind!=='register'||!d.update)throw Error('fixture');return d as typeof d & {update:NonNullable<typeof d.update>};};
const stateModel=()=>{const m=structuredClone(base);m.modules[0].contract.obligations=m.modules[0].contract.obligations!.slice(0,1);return m;};
const tb=(stimulus:string)=>`\`timescale 1ns/1ps
module tb;
 logic clk=0,rst_n=0; always #5 clk=~clk;
 logic [7:0] s_data=0,m_data; logic s_valid=0,s_ready,m_valid,m_ready=0;
 add_const dut(.*); rtlarch_contract_checks checks();
 initial begin repeat(2) @(negedge clk); rst_n=1; ${stimulus} @(negedge clk); #2; $finish; end
 initial begin #2000; $fatal(1,"TIMEOUT"); end
endmodule\n`;
const replaceState=(body:string)=>rtl.replace("      out_data <= '0;",'').replace('      if (s_valid) out_data <= s_data + CONST;','').replace('endmodule',`always_ff @(posedge clk) begin ${body} end\nendmodule`);
async function fixture(name:string,model:Model,code=rtl,bench?:string){
 const dir=join(root,name);await cp('examples/state-updates',dir,{recursive:true});
 await writeFile(join(dir,'architecture/model.json'),json(model));await writeFile(join(dir,'rtl/add_const.sv'),code);
 if(bench)await writeFile(join(dir,'tb.sv'),bench);
 await generateChecks(dir,bindings,join(dir,'checks'));return dir;
}
const report=async(dir:string)=>assurance(dir,await new Repository(dir).getModel());
async function approve(dir:string){const repo=new Repository(dir),hash=(await repo.getModel()).modelHash;await repo.reviewModule({moduleId:'top',modelHash:hash,reviewer:'temporary fixture'});await repo.review({modelHash:hash,reviewer:'temporary fixture'});}
try{
 const free=stateModel(),d=driver(free);d.update.branches=[{id:'disabled',condition:constant(1,'0'),value:constant(8,'100')},{id:'tick',condition:constant(1,'1'),value:{kind:'operator',operator:'+',operands:[ep('out_data',true),constant(8,'1')]}}];d.inputs=stateUpdateReads(d.update);
 const freeRTL=replaceState("if (!rst_n) out_data <= '0; else out_data <= out_data + 1;");
 const freeDir=await fixture('free-running',free,freeRTL,tb('repeat(6) @(negedge clk);'));
 await check('free-running register passes; constant-false branch and hold are explicitly unreachable',async()=>{
  const run=await runVerification(freeDir,profile);assert.equal(run.status,'passed',json(run));const r=(await report(freeDir)).behavior[0];assert.equal(r.coverage!.goals.find(g=>g.key==='hold')!.status,'UNREACHABLE');assert.equal(r.coverage!.goals.find(g=>g.key==='branch0')!.status,'UNREACHABLE');assert(r.coverage!.observedTransitions!>0);assert.equal(r.basis.kind,'as_built');assert.deepEqual(r.nextSteps,[]);
 });
 await check('wrong increment still fails on an unconditional-update register',async()=>{
  await writeFile(join(freeDir,'rtl/add_const.sv'),freeRTL.replace('out_data + 1','out_data + 2'));assert.equal((await runVerification(freeDir,profile)).status,'command_failed');assert.equal((await report(freeDir)).behavior[0].status,'FAILED');
 });
 await check('unproved hold cannot be waived; insufficient stimulus is not RTL failure',async()=>{
  const m=stateModel(),d=driver(m);d.update.branches=[{id:'tick',condition:ep('s_valid'),value:{kind:'operator',operator:'+',operands:[ep('out_data',true),constant(8,'1')]}}];d.inputs=stateUpdateReads(d.update);
  const dir=await fixture('missing-hold',m,freeRTL,tb('s_valid=1; repeat(6) @(negedge clk);'));
  assert.equal((await runVerification(dir,profile)).status,'coverage_incomplete');const r=(await report(dir)).behavior[0];assert.equal(r.status,'COVERAGE_INCOMPLETE');assert.equal(r.coverage!.goals.find(g=>g.key==='hold')!.status,'UNTESTED');assert.equal(r.nextSteps.length,1);assert.equal(r.nextSteps[0].key,'hold');
 });
 await check('another failed check cannot be downgraded to a coverage gap in either manifest order',async()=>{
  const dir=join(root,'missing-hold'),missing={kind:'contains',file:'step-1.stdout.log',text:'RTLARCH_EXPECTED_BUT_ABSENT'};
  for(const checks of [[missing,...profile.checks],[...profile.checks,missing]]){
   const run=await runVerification(dir,{...profile,checks});assert.equal(run.status,'check_failed');
   assert.equal(run.checks.filter(c=>!c.passed).length,2);const r=(await report(dir)).behavior[0];assert.equal(r.status,'FAILED');assert.deepEqual(r.nextSteps,[]);
  }
 });
 const priority=stateModel(),pd=driver(priority);pd.update.branches=[{id:'clear',condition:ep('s_valid'),value:constant(8,'0')},{id:'load',condition:ep('m_ready'),value:ep('s_data')}];pd.inputs=stateUpdateReads(pd.update);
 const po=priority.modules[0].contract.obligations![0];if(po.kind!=='state_transition')throw Error();po.priorityPairs=[{higher:'clear',lower:'load'}];
 await check('priority pair order, identity and uniqueness are validated',()=>{
  for(const pairs of [[{higher:'load',lower:'clear'}],[{higher:'clear',lower:'absent'}],[...po.priorityPairs!,...po.priorityPairs!]]){const m=structuredClone(priority),o=m.modules[0].contract.obligations![0];if(o.kind==='state_transition')o.priorityPairs=pairs;assert(validateModel(m).some(i=>i.code==='OBLIGATION_PRIORITY'));assert.throws(()=>renderChecks(m,bindings));}
 });
 const priorityBody="if (!rst_n) out_data <= '0; else if (s_valid) out_data <= '0; else if (m_ready) out_data <= s_data;";
 const separate='s_valid=1; @(negedge clk); s_valid=0; m_ready=1; s_data=33; @(negedge clk); m_ready=0; @(negedge clk);';
 const priorityDir=await fixture('priority',priority,replaceState(priorityBody),tb(separate));
 await check('each branch exercised alone does not cover competition',async()=>{
  assert.equal((await runVerification(priorityDir,profile)).status,'coverage_incomplete');const goals=(await report(priorityDir)).behavior[0].coverage!.goals;assert(goals.filter(g=>g.key.startsWith('branch')).every(g=>g.status==='HIT'));assert.equal(goals.find(g=>g.key==='priority0')!.status,'UNTESTED');
 });
 await check('simultaneous conditions with identical writes do not cover distinguishable priority',async()=>{
  await writeFile(join(priorityDir,'tb.sv'),tb(separate+'s_valid=1; m_ready=1; s_data=0; @(negedge clk);'));
  assert.equal((await runVerification(priorityDir,profile)).status,'coverage_incomplete');
 });
 await check('simultaneous distinct writes cover priority; reversed RTL is detected',async()=>{
  await writeFile(join(priorityDir,'tb.sv'),tb(separate+'s_valid=1; m_ready=1; s_data=53; @(negedge clk);'));
  assert.equal((await runVerification(priorityDir,profile)).status,'passed');const r=(await report(priorityDir)).behavior[0];assert.equal(r.coverage!.goals.find(g=>g.key==='priority0')!.status,'HIT');
  const meta=renderChecks(priority,bindings).metadata.items[0];assert.equal(readStateCoverage('garbage',meta.coverage!.marker,meta.coverage!.goals).status,'UNKNOWN');
  await writeFile(join(priorityDir,'rtl/add_const.sv'),replaceState("if (!rst_n) out_data <= '0; else if (m_ready) out_data <= s_data; else if (s_valid) out_data <= '0;"));assert.equal((await runVerification(priorityDir,profile)).status,'command_failed');
 });
 const asbuilt=stateModel();asbuilt.specification={summary:'验证参照的区分',requirements:[{id:'add5',moduleIds:['top'],text:'被接受的数据加五',acceptance:'8 位模 256，阻塞保持，复位清零'},{id:'timing',moduleIds:['top'],text:'器件频率达标',acceptance:'独立 STA 报告'}],decisions:[],openQuestions:[]};asbuilt.modules[0].contract.obligations![0].requirementIds=['add5'];
 const asbuiltDir=await fixture('as-built',asbuilt);
 await check('x+3 observation can pass, but cannot certify x+5 requirement or unlinked timing',async()=>{
  assert.equal((await runVerification(asbuiltDir,profile)).status,'passed');const r=await report(asbuiltDir);assert.equal(r.behavior[0].basis.kind,'as_built');assert.equal(r.requirements[0].status,'NOT_VERIFIED');assert.equal(r.requirements[1].status,'NO_CHECK');
 });
 const intent=structuredClone(asbuilt);intent.provenance={origin:'design',fidelity:'exact',scope:'Temporary independently specified add-five design',sourceDigest:'0'.repeat(64),configuration:'DATA_W=8, CONST=5',coverage:{elaboratedInstances:1,representedInstances:1},evidence:[],findings:[],unsupportedStructures:[],verification:[]};intent.localSignals!.forEach(l=>l.evidenceIds=[]);intent.modules[0].parameters.CONST=5;
 const sum=intent.localSignals!.find(l=>l.id==='sum_value')!;if(sum.driver.kind!=='comb'||sum.driver.value.kind!=='operator')throw Error();sum.driver.value.operands[1]=constant(8,'5');sum.name='输入加五';sum.description='独立设计声明：8 位输入加五。';
 const intentDir=await fixture('approved-intent',intent);
 await approve(intentDir);
 await check('frozen approved x+5 intent rejects x+3 implementation without changing authority',async()=>{
  const hash=modelHash(intent),run=await runVerification(intentDir,profile);assert.equal(run.status,'command_failed');assert.equal(run.basis.kind,'approved_intent');assert.equal((await report(intentDir)).behavior[0].basis.kind,'approved_intent');assert.equal((await new Repository(intentDir).getModel()).modelHash,hash);
 });
 await check('correct x+5 passes with requirement, checker, approval and run trace',async()=>{
  await writeFile(join(intentDir,'rtl/add_const.sv'),rtl.replace("CONST = DATA_W'(3)","CONST = DATA_W'(5)"));
  const run=await runVerification(intentDir,profile);assert.equal(run.status,'passed',json(run));const r=await report(intentDir);assert.equal(r.requirements[0].status,'SCENARIO_SUPPORTED');assert.equal(r.behavior[0].requirements[0].id,'add5');assert(r.behavior[0].checkerFingerprint);assert.equal(run.obligationTargets[0].requirements[0].text,'被接受的数据加五');
 });
 const draftDir=await fixture('draft-intent',intent,rtl.replace("CONST = DATA_W'(3)","CONST = DATA_W'(5)"));
 await check('approval after a run cannot upgrade historical draft evidence',async()=>{
  assert.equal((await runVerification(draftDir,profile)).status,'passed');await approve(draftDir);const r=await report(draftDir);assert.equal(r.behavior[0].basis.kind,'unreviewed_design');assert.equal(r.requirements[0].status,'NOT_VERIFIED');
 });
 await check('requirement edits invalidate approval, checker and previous evidence',async()=>{
  const changed=structuredClone(intent);changed.specification!.requirements[0].acceptance+='; new boundary';await writeFile(join(intentDir,'architecture/model.json'),json(changed));assert.equal((await report(intentDir)).behavior[0].status,'STALE');assert.deepEqual((await report(intentDir)).behavior[0].nextSteps,[]);await assert.rejects(runVerification(intentDir,profile),/不匹配/);
 });
 console.log(json({groups,passed:true,scope:'Finite simulation, literal-only reachability, explicit priority competition, requirement/basis trace. Local approvals only; no natural-language or arbitrary RTL equivalence.'}));
}finally{if(process.env.RTLARCH_KEEP_RELIABILITY)console.log('kept '+root);else await rm(root,{recursive:true,force:true});}
