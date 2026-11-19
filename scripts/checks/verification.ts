import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BitFunctions } from '../../src/core/bitFunctions';
import { semanticDiff } from '../../src/core/diff';
import { resolveEndpoint } from '../../src/core/endpoints';
import { validateModel } from '../../src/core/engine';
import { hashValue, modelHash } from '../../src/core/export';
import { dependencyRoles, hardwareView } from '../../src/core/hardwareView';
import { inspectScope } from '../../src/core/inspection';
import { type Model, modelSchema, type SignalValue, signalValueSchema, type StateUpdate } from '../../src/core/schema';
import { endpointLabel, localSignalAnalysis, signalReads, signalText, stateUpdateReads } from '../../src/core/signals';
import { readStateCoverage } from '../../src/core/stateCoverage';
import { compareState, type Definition, observeState, stateInventory, type StateMapping } from '../../src/core/stateObservation';
import { stateDescription } from '../../src/core/stateUpdates';
import { REPLAY_CHECKER_VERSION, type ReplaySamples, replaySamplesSchema, replayTransactions } from '../../src/core/transactionReplay';
import { verificationImpact } from '../../src/core/verificationImpact';
import { prepareDiagram } from '../../src/web/graph/prepareDiagram';
import { diagramQuality } from '../../src/web/graph/quality';
import { scopeDiagram } from '../../src/web/graph/scopeDiagram';
import { assurance } from '../../src/workspace/assurance';
import { runConformance } from '../../src/workspace/conformance';
import { contextView } from '../../src/workspace/contextView';
import { type CheckBindings, generateChecks, loadChecks, renderChecks } from '../../src/workspace/contractChecks';
import { importYosys } from '../../src/workspace/importYosys';
import { Repository } from '../../src/workspace/repository';
import { evaluateStateObservation, latestStateObservation, runStateObservation, stateObservationSchema } from '../../src/workspace/stateObservation';
import { importReplay, replayRecords } from '../../src/workspace/transactionReplay';
import { runVerification, verificationRuns } from '../../src/workspace/verification';

export async function checkAssurance() {
  const root=await mkdtemp(join(tmpdir(),'rtlarch-assurance-'));let groups=0;
  const json=(x:unknown)=>JSON.stringify(x,null,2)+'\n';
  try{
   await mkdir(join(root,'architecture'));await mkdir(join(root,'rtl'));
   const original=modelSchema.parse(JSON.parse(await readFile('examples/tiny-stream/model.json','utf8'))),model=structuredClone(original);model.schemaVersion=3;
   const fifo=model.modules.find(m=>m.id==='fifo')!;fifo.id='top';fifo.parent=null;fifo.kind='subsystem';fifo.rtlModule='rv_fifo';fifo.contract.obligations=[{id:'stable',kind:'ready_valid_stability',interfaceId:'out',description:'背压期间保持有效输出'},{id:'flush',kind:'reset_flush',interfaceId:'out',description:'复位后首沿输出为空'},{id:'order',kind:'fifo_ordering',inputInterfaceId:'in',outputInterfaceId:'out',capacity:{param:'DEPTH'},completion:'drained_test_end',description:'接受的输入按序输出，无丢失重复'}];
   model.modules=[fifo];model.connections=[];model.design={id:'checked_fifo',name:'合同检查 FIFO',top:'top'};
   assert.deepEqual(validateModel(model).filter(i=>i.blocks.includes('commit')),[]);
   const save=()=>writeFile(join(root,'architecture/model.json'),json(model));await save();await cp('examples/tiny-stream/rtl/rv_fifo.sv',join(root,'rtl/rv_fifo.sv'));
   const bindings={schemaVersion:1,testbench:'tb',bindings:fifo.contract.obligations.map(o=>({moduleId:'top',obligationId:o.id,instancePath:'tb.dut',clock:'clk',reset:'rst_n',interfaces:{in:{data:'s_data',valid:'s_valid',ready:'s_ready'},out:{data:'m_data',valid:'m_valid',ready:'m_ready'}}}))};
   await generateChecks(root,bindings,join(root,'checks'));
   const tb=`\`timescale 1ns/1ps
module tb;
 logic clk=0,rst_n=0; always #5 clk=~clk;
 logic [7:0] s_data=0,m_data; logic s_valid=0,s_ready,m_valid,m_ready=0;
 rv_fifo dut(.*); rtlarch_contract_checks checks();
 initial begin
  repeat(2) @(negedge clk); rst_n=1;
  @(negedge clk); s_valid=1;s_data=8'h11;
  @(negedge clk); s_data=8'h22;
  @(negedge clk); s_valid=0;
  repeat(3) @(negedge clk);m_ready=1;
  repeat(5) @(negedge clk);$finish;
 end
endmodule\n`;
   await writeFile(join(root,'tb.sv'),tb);
   const profile={schemaVersion:1,name:'FIFO 合同仿真',stage:'simulation',moduleIds:['top'],inputs:['rtl/rv_fifo.sv','tb.sv','checks/checks.sv','checks/checks.json'],inputClosure:{status:'declared_complete',note:'Standalone FIFO RTL, harness and generated monitors; no external includes.'},timeoutMs:120000,commands:[{program:'verilator',args:['--binary','--timing','--assert','-Wno-fatal','--top-module','tb','--Mdir','{runDir}/obj','rtl/rv_fifo.sv','tb.sv','checks/checks.sv'],versionArgs:['--version']},{program:'{runDir}/obj/Vtb',args:[]}],checks:[{kind:'obligations',file:'step-1.stdout.log',metadata:'checks/checks.json'}]};
   const passed=await runVerification(root,profile);assert.equal(passed.status,'passed',json(passed));groups++;
   const state=()=>new Repository(root).getModel();let report=await assurance(root,await state());assert(report.behavior.every(b=>b.status==='PASSED'));groups++;
   const recordFile=join(passed.directory,'run.json'),recordText=await readFile(recordFile,'utf8');await writeFile(recordFile,'broken');assert((await assurance(root,await state())).behavior.every(b=>b.status==='INCONCLUSIVE'));await writeFile(recordFile,recordText);groups++;
   const checkerText=await readFile(join(root,'checks/checks.sv'),'utf8');await writeFile(join(root,'checks/checks.sv'),checkerText+'// changed');assert((await assurance(root,await state())).behavior.every(b=>b.status==='STALE'));await writeFile(join(root,'checks/checks.sv'),checkerText);groups++;
   const rtl=await readFile(join(root,'rtl/rv_fifo.sv'),'utf8');await writeFile(join(root,'rtl/rv_fifo.sv'),rtl.replace('assign m_data = storage[read_ptr];','assign m_data = storage[read_ptr] ^ {7\'b0, clk};'));
   assert.equal((await verificationRuns(root,modelHash(model)))[0].fresh,false);groups++;
   const bad=await runVerification(root,profile);assert.notEqual(bad.status,'passed');report=await assurance(root,await state());assert(report.behavior.every(b=>b.status==='FAILED'));groups++;
   await writeFile(join(root,'rtl/rv_fifo.sv'),rtl.replace('if (pop) read_ptr', 'if (pop || (m_valid && !m_ready)) read_ptr'));
   const unstable=await runVerification(root,profile);assert.notEqual(unstable.status,'passed');groups++;
   await writeFile(join(root,'rtl/rv_fifo.sv'),rtl.replace('(count != 0)','((count != 0) || (s_data == 0))'));const resetBad=await runVerification(root,profile);assert.notEqual(resetBad.status,'passed');groups++;
   await writeFile(join(root,'rtl/rv_fifo.sv'),rtl);await writeFile(join(root,'tb.sv'),tb.replace('m_ready=1;','m_ready=0;'));
   const dropped=await runVerification(root,profile);assert.notEqual(dropped.status,'passed');groups++;
   await writeFile(join(root,'tb.sv'),tb.replace('s_valid=1;','s_valid=0;'));
   const vacuous=await runVerification(root,profile);assert.notEqual(vacuous.status,'passed');groups++;
   await writeFile(join(root,'tb.sv'),tb);
   const elab={schemaVersion:1,name:'FIFO 展开',stage:'elaboration',moduleIds:['top'],inputs:['rtl/rv_fifo.sv'],inputClosure:{status:'declared_complete',note:'Standalone RTL; all configuration in argv.'},timeoutMs:30000,commands:[{program:'yosys',versionArgs:['-V'],args:['-Q','-T','-p','read_verilog -sv rtl/rv_fifo.sv; hierarchy -top rv_fifo; proc; write_json {runDir}/netlist.json']}],checks:[{kind:'artifact',file:'netlist.json'}]};
   const mapping=(runId:string)=>({schemaVersion:1,runId,netlist:'netlist.json',top:'rv_fifo',mappings:[{moduleId:'top',instancePath:[],rtlType:'rv_fifo',parameters:{DATA_W:'DATA_W',DEPTH:'DEPTH'},ports:{in:{data:'s_data',valid:'s_valid',ready:'s_ready'},out:{data:'m_data',valid:'m_valid',ready:'m_ready'}},clock:'clk',reset:'rst_n'}]});
   let run=await runVerification(root,elab);assert.equal(run.status,'passed');let conform=await runConformance(root,mapping(run.id));assert.equal(conform.status,'MATCH',json(conform));groups++;
   await writeFile(join(root,'rtl/rv_fifo.sv'),rtl+'\n// changed input');assert.equal((await assurance(root,await state())).structural.status,'STALE');await writeFile(join(root,'rtl/rv_fifo.sv'),rtl);groups++;
   const wrongType=structuredClone(mapping(run.id));wrongType.mappings[0].rtlType='other';assert.equal((await runConformance(root,wrongType)).status,'MISMATCH');groups++;
   const wrong=structuredClone(mapping(run.id));wrong.mappings[0].ports.out.data='s_data';assert.equal((await runConformance(root,wrong)).status,'MISMATCH');groups++;
   const absent=structuredClone(mapping(run.id));Reflect.deleteProperty(absent.mappings[0].parameters,'DEPTH');assert.equal((await runConformance(root,absent)).status,'UNKNOWN');groups++;
   const before=structuredClone(model);fifo.parameters.DEPTH=8;await save();assert.equal((await runConformance(root,mapping(run.id))).status,'UNKNOWN');assert.equal((await assurance(root,await state())).behavior[0].status,'STALE');groups++;
   run=await runVerification(root,elab);conform=await runConformance(root,mapping(run.id));assert.equal(conform.status,'MISMATCH');assert(conform.items.some(i=>i.target==='top.parameters.DEPTH'&&i.status==='MISMATCH'));groups++;
   await writeFile(join(root,'rtl/rv_fifo.sv'),rtl.replace('DEPTH = 4','DEPTH = 8'));run=await runVerification(root,elab);assert.equal((await runConformance(root,mapping(run.id))).status,'MATCH');groups++;
   const noClosure=structuredClone(elab);noClosure.inputClosure.status='partial';run=await runVerification(root,noClosure);assert.equal((await runConformance(root,mapping(run.id))).status,'UNKNOWN');groups++;
   const changed=structuredClone(model);changed.modules[0].contract.backpressure+=' changed';const diff=semanticDiff(model,changed);assert.equal(diff.length,1);assert.equal(diff[0].path,'/contract/backpressure');assert.equal(verificationImpact(before,model).modules[0].obligations.length,3);groups++;
   const snap=await state(),ctx=contextView(snap,{purpose:'implementation',moduleId:'top'});assert.equal(ctx.modelHash,snap.modelHash);assert(Buffer.byteLength(json(ctx))<=12000);assert.equal(contextView(snap,{purpose:'index',limit:1}).total,1);assert.throws(()=>contextView(snap,{purpose:'debug',moduleId:'top',maxBytes:2048}),/预算/);groups++;
   const asyncModel=structuredClone(model);asyncModel.resets[0].synchronous=false;assert.throws(()=>renderChecks(asyncModel,bindings),/同步复位/);groups++;
   await cp('examples/tiny-stream/rtl',join(root,'rtl'),{recursive:true});await writeFile(join(root,'architecture/model.json'),json(original));
   const fullElab={...elab,inputs:['rtl/rv_fifo.sv','rtl/add_const.sv','rtl/stream_path.sv','rtl/tiny_stream.sv'],commands:[{program:'yosys',versionArgs:['-V'],args:['-Q','-T','-p','read_verilog -sv rtl/*.sv; hierarchy -top tiny_stream; proc; write_json {runDir}/netlist.json']}]};
   run=await runVerification(root,fullElab);assert.equal(run.status,'passed');
   const paths:Record<string,string[]>={top:[],path:['path'],fifo:['path','fifo'],add:['path','add']};
   const fullMap={schemaVersion:1,runId:run.id,netlist:'netlist.json',top:'tiny_stream',mappings:original.modules.map(m=>({moduleId:m.id,instancePath:paths[m.id],rtlType:m.rtlModule,parameters:Object.fromEntries(Object.keys(m.parameters).map(k=>[k,k])),ports:mapping(run.id).mappings[0].ports,clock:'clk',reset:'rst_n'}))};
   const full=await runConformance(root,fullMap);assert.equal(full.status,'MATCH',json(full));assert(full.items.some(i=>i.target.startsWith('connection.')&&i.status==='MATCH'));groups++;
   const wiring=await readFile(join(root,'rtl/stream_path.sv'),'utf8');await writeFile(join(root,'rtl/stream_path.sv'),wiring.replace('.s_data(mid_data)',".s_data(8'b0)"));run=await runVerification(root,fullElab);const miswired=await runConformance(root,{...fullMap,runId:run.id});assert.equal(miswired.status,'MISMATCH');assert(miswired.items.some(i=>i.target.startsWith('connection.')&&i.status==='MISMATCH'));groups++;
   assert.equal(modelHash(original),'67d8474cbde520a73e057ef9f1260bdb3f92ab2c9450c3c9c0376aa0165929cd');groups++;
   console.log(json({groups,passed:true,scenario:'real Verilator monitors + fault injection + current Yosys structure + DEPTH 4→8 + freshness + compact context',workspace:root}));
  }finally{if(!process.env.RTLARCH_KEEP_ASSURANCE)await rm(root,{recursive:true,force:true});else console.log('kept '+root);}
}

export async function checkStateUpdates() {
  const root=await mkdtemp(join(tmpdir(),'rtlarch-state-'));let groups=0;
  const check=async(name:string,fn:()=>unknown)=>{await fn();console.log(`PASS ${++groups}: ${name}`)};
  const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
  try{
   await cp('examples/state-updates',root,{recursive:true});
   const model=modelSchema.parse(JSON.parse(await readFile(join(root,'architecture/model.json'),'utf8'))),hash=modelHash(model),bindings=JSON.parse(await readFile(join(root,'bindings.json'),'utf8')),profile=JSON.parse(await readFile(join(root,'verification.json'),'utf8'));
   const state=(m:Model)=>m.localSignals!.find(l=>l.id==='out_data')!;
   const driver=state(model).driver;if(driver.kind!=='register'||!driver.update)throw Error('missing fixture update');
   await check('optional state rules preserve old fixture hash and keep source model partial',async()=>{
    const old=modelSchema.parse(JSON.parse(await readFile('examples/tiny-stream/model.json','utf8')));assert.equal(modelHash(old),'67d8474cbde520a73e057ef9f1260bdb3f92ab2c9450c3c9c0376aa0165929cd');assert.equal(model.provenance!.fidelity,'partial');assert.deepEqual(validateModel(model).filter(i=>i.blocks.includes('commit')),[]);
   });
   await check('invalid condition/value widths, stale input sets, branch IDs and async reset fail',()=>{
    for(const mutate of [(m:Model)=>{const d=state(m).driver;if(d.kind==='register')d.update!.branches[0].condition={kind:'constant',width:8,value:'1'}},(m:Model)=>{const d=state(m).driver;if(d.kind==='register')d.update!.branches[0].value={kind:'constant',width:1,value:'0'}},(m:Model)=>{const d=state(m).driver;if(d.kind==='register')d.inputs.pop()},(m:Model)=>{const d=state(m).driver;if(d.kind==='register')d.update!.branches.push(d.update!.branches[0])},(m:Model)=>{m.resets[0].synchronous=false}]){const bad=structuredClone(model);mutate(bad);assert(validateModel(bad).some(i=>i.blocks.includes('commit')));assert.throws(()=>renderChecks(bad,bindings));}
   });
   await check('data/control questions select distinct dependencies and stop at upstream state',()=>{
    const roles=dependencyRoles(state(model));assert.equal(roles.get('top.local:sum_value'),'state_data');assert.equal(roles.get('top.rst_n'),'state_reset');assert.equal(roles.get('top.local:accept'),'state_condition');
    const data=inspectScope(model,'top',{kind:'local',id:'out_data',purpose:'data',depth:2}),control=inspectScope(model,'top',{kind:'local',id:'out_data',purpose:'control',depth:3});
    assert(data.dependencies.some(d=>d.endpoint.interfaceId==='s_data'));assert(!data.dependencies.some(d=>d.endpoint.interfaceId==='rst_n'));assert(control.dependencies.some(d=>d.endpoint.interfaceId==='m_ready'));assert(control.stateBoundaries.includes('out_valid'));assert(!control.dependencies.some(d=>d.localId==='out_valid'));
    assert(!hardwareView(model,'top').issues.some(i=>i.code==='STATE_ROLE_UNKNOWN'));const legacy=structuredClone(model);const d=state(legacy).driver;if(d.kind==='register')delete d.update;assert(hardwareView(legacy,'top').issues.some(i=>i.code==='STATE_ROLE_UNKNOWN'));
    const graph=scopeDiagram(model,'top',{mode:'microarchitecture'});assert(graph.edges.some(e=>e.data?.dependencyRole==='state_data'));assert.equal(stateDescription(state(model))!.rows.at(-1)!.action,'保持原值');assert.equal(modelHash(model),hash);const cg=scopeDiagram(model,'top',{mode:'microarchitecture',inspection:{kind:'local',id:'out_data',purpose:'control',depth:2}});assert(cg.edges.some(e=>e.data?.dependencyRole==='state_reset'&&e.style?.opacity===1));
   });
   await check('missing, duplicate and shadowed mappings fail instead of guessing pins',()=>{
    const missing=structuredClone(bindings);missing.bindings[0].signals=[];assert.throws(()=>renderChecks(model,missing),/缺少/);
    const duplicate=structuredClone(bindings);duplicate.bindings[0].signals.push(duplicate.bindings[0].signals[0]);assert.throws(()=>renderChecks(model,duplicate),/唯一/);
    const shadow=structuredClone(bindings);shadow.bindings[0].signals.push({endpoint:{moduleId:'top',interfaceId:'accept',local:true},pin:'s_ready'});assert.throws(()=>renderChecks(model,shadow),/内联/);
   });
   await generateChecks(root,bindings,join(root,'checks'));
   await check('actual RTL exercises reset, update, hold, overflow and current assurance',async()=>{
    const run=await runVerification(root,profile);assert.equal(run.status,'passed',json(run));const report=await assurance(root,await new Repository(root).getModel());assert(report.behavior.every(b=>b.status==='PASSED'));console.log('GOOD_RUN '+run.id);
   });
   const rtl=await readFile(join(root,'rtl/add_const.sv'),'utf8'),tb=await readFile(join(root,'tb.sv'),'utf8');
   for(const [name,changed] of [['wrong_data',rtl.replace('s_data + CONST','s_data + CONST + 1')],['wrong_hold',rtl.replace('else if (s_ready) begin','else begin')],['wrong_reset',rtl.replace("out_data <= '0;","out_data <= '1;")]])await check(`${name}: mutated RTL is rejected and cannot inherit earlier PASS`,async()=>{
    await writeFile(join(root,'rtl/add_const.sv'),changed);const run=await runVerification(root,profile);assert.notEqual(run.status,'passed');const log=await readFile(join(run.directory,'step-1.stdout.log'),'utf8');assert(log.includes('state transition mismatch'),log);assert((await assurance(root,await new Repository(root).getModel())).behavior.every(b=>b.status==='FAILED'));
   });
   await writeFile(join(root,'rtl/add_const.sv'),rtl);
   await check('unexercised update/hold cannot count as PASS',async()=>{
    await writeFile(join(root,'tb.sv'),tb.replaceAll('s_valid=1','s_valid=0'));const run=await runVerification(root,profile);assert.notEqual(run.status,'passed');assert((await readFile(join(run.directory,'step-1.stdout.log'),'utf8')).includes('not exercised'));
   });await writeFile(join(root,'tb.sv'),tb);
   await check('edited checker and changed state semantics invalidate generated artifacts',async()=>{
    const file=join(root,'checks/checks.sv'),text=await readFile(file,'utf8');await writeFile(file,text+'// changed');await assert.rejects(loadChecks(root,'checks/checks.json',profile.inputs));await writeFile(file,text);
    const changed=structuredClone(model),d=state(changed).driver;if(d.kind==='register')d.update!.reset!.value={kind:'constant',width:8,value:'1'};await writeFile(join(root,'architecture/model.json'),json(changed));await assert.rejects(loadChecks(root,'checks/checks.json',profile.inputs));await writeFile(join(root,'architecture/model.json'),json(model));
   });
   await check('two real competing conditions honor first-match priority; reversed RTL fails',async()=>{
    const priority=structuredClone(model),d=state(priority).driver;if(d.kind!=='register')throw Error();
    const ep=(id:string)=>({kind:'endpoint' as const,endpoint:{moduleId:'top',interfaceId:id}});
    d.update!.branches=[{id:'clear',condition:ep('s_valid'),value:{kind:'constant',width:8,value:'0'}},{id:'load',condition:ep('m_ready'),value:ep('s_data')}];d.inputs=['rst_n','s_valid','m_ready','s_data'].map(id=>ep(id).endpoint);priority.modules[0].contract.obligations=priority.modules[0].contract.obligations!.slice(0,1);
    await writeFile(join(root,'architecture/model.json'),json(priority));const pb={...bindings,bindings:bindings.bindings.slice(0,1)};await generateChecks(root,pb,join(root,'priority-checks'));
    const body="if (!rst_n) out_data <= '0; else if (s_valid) out_data <= '0; else if (m_ready) out_data <= s_data;";
    const prtl=rtl.replace("      out_data <= '0;",'').replace('      if (s_valid) out_data <= s_data + CONST;','').replace('endmodule',`always_ff @(posedge clk) begin ${body} end\nendmodule`);
    const ptb=tb.replace('s_data=5','s_data=53');await writeFile(join(root,'tb.sv'),ptb);
    const pp=JSON.parse(JSON.stringify(profile).replaceAll('checks/checks.','priority-checks/checks.'));await writeFile(join(root,'rtl/add_const.sv'),prtl);assert.equal((await runVerification(root,pp)).status,'passed');
    await writeFile(join(root,'rtl/add_const.sv'),prtl.replace(body,"if (!rst_n) out_data <= '0; else if (m_ready) out_data <= s_data; else if (s_valid) out_data <= '0;"));const bad=await runVerification(root,pp);assert.notEqual(bad.status,'passed');assert((await readFile(join(bad.directory,'step-1.stdout.log'),'utf8')).includes('state transition mismatch'));
   });
   console.log(json({groups,passed:true,scope:'Declared synchronous whole-vector updates, explicit mapping, real Verilator and mutations; no arbitrary RTL extraction or formal proof.'}));
  }finally{if(process.env.RTLARCH_KEEP_STATE)console.log('kept '+root);else await rm(root,{recursive:true,force:true});}
}

export async function checkEvidenceCoverage() {
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
}

export async function checkStateObservation() {
  const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-state-observation-'));
  const json=(x:unknown)=>JSON.stringify(x,null,2)+'\n';
  const base=modelSchema.parse(JSON.parse(await readFile('examples/state-updates/architecture/model.json','utf8')));
  const mapping=JSON.parse(await readFile('examples/state-updates/state-mapping.json','utf8'));
  const profile=JSON.parse(await readFile('examples/state-updates/elaboration.json','utf8'));
  const bindings=JSON.parse(await readFile('examples/state-updates/bindings.json','utf8'));
  let groups=0;const check=async(name:string,fn:()=>unknown)=>{await fn();console.log(`PASS ${++groups}: ${name}`);};
  const ep=(id:string,local=false):SignalValue=>({kind:'endpoint',endpoint:{moduleId:'top',interfaceId:id,...(local?{local:true}: {})}});
  const constant=(width:number,n:number):SignalValue=>({kind:'constant',width,value:String(n)});
  const op=(operator:Extract<SignalValue,{kind:'operator'}>['operator'],...operands:SignalValue[]):SignalValue=>({kind:'operator',operator,operands});
  function withUpdate(branches:StateUpdate['branches']){const m=structuredClone(base),d=m.localSignals!.find(l=>l.id==='out_data')!.driver;if(d.kind!=='register'||!d.update)throw Error();d.update.branches=branches;d.inputs=stateUpdateReads(d.update);return m;}
  const rtl=(body:string,edge='posedge clk')=>`module add_const(input clk,rst_n,s_valid,m_ready,input [7:0] s_data,output reg [7:0] out_data,output reg out_valid); always @(${edge}) begin ${body} end always @(posedge clk) out_valid <= s_valid; endmodule`;
  async function elaborate(code:string):Promise<Definition>{await writeFile(join(root,'probe.sv'),code);await exec('yosys',['-Q','-T','-p','read_verilog -sv probe.sv; hierarchy -check -top add_const; proc; write_json probe.json'],{cwd:root,timeout:30000,maxBuffer:4*1024*1024});return JSON.parse(await readFile(join(root,'probe.json'),'utf8')).modules.add_const;}
  const compare=(m:Model,d:Definition)=>compareState(m,d,mapping.mappings[0]);
  try{
   await check('Boolean arithmetic independently exhausts four-bit unsigned/signed inputs and verifies witnesses',()=>{
    const f=new BitFunctions(),a=[0,1,2,3].map(i=>f.variable(i)),b=[4,5,6,7].map(i=>f.variable(i));
    const add=f.add(a,b),sub=f.add(a,b,true),lt=f.less(a,b),signed=f.less(a,b,true),eq=f.equal(a,b);
    for(let x=0;x<16;x++)for(let y=0;y<16;y++){const v=new Map(Array.from({length:8},(_,i)=>[i,(i<4?x>>i:y>>(i-4))&1]));assert.equal(BigInt(f.value(add,v)),BigInt((x+y)&15));assert.equal(BigInt(f.value(sub,v)),BigInt((x-y)&15));assert.equal(f.evaluate(lt,v),Number(x<y));assert.equal(f.evaluate(signed,v),Number((x<8?x:x-16)<(y<8?y:y-16)));assert.equal(f.evaluate(eq,v),Number(x===y));}
    const w=f.witness(f.not(eq))!;assert.notEqual(f.value(a,w),f.value(b,w));assert.throws(()=>new BitFunctions(2).variable(1),/预算/);
   });
   await cp('examples/state-updates',join(root,'workspace'),{recursive:true});const workspace=join(root,'workspace');
   const run=await runVerification(workspace,profile);assert.equal(run.status,'passed',json(run));mapping.runId=run.id;
   const hash=modelHash(base);let saved=await runStateObservation(workspace,mapping);
   await check('actual Yosys proc extracts both elastic-stage registers and matches existing rules',()=>{
    assert.equal(saved.status,'MATCH',json(saved.results));assert(saved.producerFresh);assert.equal(saved.scope.stateCount,2);assert(saved.observations.every(o=>o.status==='EXTRACTED'));assert(saved.results.every(r=>r.observed?.source?.includes('add_const.sv:')));assert.equal(saved.basis.kind,'as_built');
   });
   await check('observation without mappings discovers states without claiming design conformance',async()=>{
    const report=await evaluateStateObservation(workspace,{...mapping,mappings:[]});assert.equal(report.status,'UNKNOWN');assert.equal(report.observations.length,2);assert.equal(report.results.length,0);
    const aliases=await evaluateStateObservation(workspace,{...mapping,mappings:[mapping.mappings[0],{...mapping.mappings[1],state:'m_data'}]});assert.equal(aliases.status,'UNKNOWN');assert(aliases.results.every(r=>r.reason.includes('重复映射')));
   });
   await check('explicit source elaboration survives a draft revision, while configuration and comparator changes invalidate evidence',async()=>{
    const isolated=join(root,'reusable');await cp('examples/state-updates',isolated,{recursive:true});
    const inventory='inputs.json',filename=join(isolated,inventory);
    const inputs={top:'add_const',configuration:'locked standalone stage',parameters:{DATA_W:8,CONST:3},defines:[],includeDirs:[],files:['rtl/add_const.sv'],assets:[]};
    await writeFile(filename,json(inputs));
    const reusable={...profile,elaborationInputs:inventory,inputs:[...profile.inputs,inventory]};
    await assert.rejects(runVerification(isolated,{...reusable,inputs:[...reusable.inputs,'architecture/model.json']}),{code:'ELABORATION_INPUTS'});
    const produced=await runVerification(isolated,reusable);assert.equal(produced.status,'passed');
    const source={schemaVersion:2 as const,runId:produced.id,netlist:'state.json'};
    const imported=await importYosys(isolated,source,join(isolated,'imported'));
    assert(imported.review);const discovery=JSON.parse(await readFile(imported.review.stateDiscovery,'utf8'));
    const repo=new Repository(isolated),original=await repo.getModel(),updated=structuredClone(original.model);updated.design.name+=' revised';
    const proposal={baseHash:original.modelHash,reason:'Verify reuse against a new draft hash',commands:[{op:'replace_architecture' as const,model:updated}]};
    const preview=await repo.preview(proposal);await repo.commit({proposal,candidateHash:preview.candidateHash});
    const refs={...discovery,scopes:[{instancePath:[],mappings:mapping.mappings}]};
    assert.equal((await evaluateStateObservation(isolated,{...refs,reuseElaboration:false})).status,'UNKNOWN');
    const report=await runStateObservation(isolated,refs);assert.equal(report.status,'MATCH');assert(report.reusedElaboration);
    assert.equal(report.producerModelHash,original.modelHash);assert.equal(report.modelHash,preview.candidateHash);
    const stored=join(isolated,report.record);const bytes=await readFile(stored,'utf8');
    await writeFile(stored,json({...JSON.parse(bytes),engine:'yosys-proc-bdd-v2'}));
    assert.equal((await latestStateObservation(isolated,preview.candidateHash)).status,'STALE');
    await writeFile(stored,bytes);
    await writeFile(filename,json({...inputs,configuration:'edited'}));
    assert.equal((await latestStateObservation(isolated,preview.candidateHash)).status,'STALE');
    await assert.rejects(importYosys(isolated,source,join(isolated,'stale')), {code:'ELABORATION_NOT_REUSABLE'});
   });
   await check('wrong arithmetic creates an explicit old-state/input witness, leaving authority unchanged',async()=>{
    const file=join(workspace,'rtl/add_const.sv'),original=await readFile(file,'utf8');await writeFile(file,original.replace("CONST = DATA_W'(3)","CONST = DATA_W'(5)"));
    assert.equal((await latestStateObservation(workspace,hash)).status,'STALE');
    const changed=await runVerification(workspace,profile);saved=await runStateObservation(workspace,{...mapping,runId:changed.id});assert.equal(saved.status,'MISMATCH');assert.equal((await latestStateObservation(workspace,hash)).status,'MISMATCH');const r=saved.results[0];assert(r.witness);assert.notEqual(r.witness.expected,r.witness.actual);assert.equal(modelHash(modelSchema.parse(JSON.parse(await readFile(join(workspace,'architecture/model.json'),'utf8')))),hash);
    const values=new Map(r.witness.inputs.map(i=>[i.signal,i.value])),literal=(id:string)=>`8'h${BigInt(values.get(id)??'0').toString(16)}`;
    await writeFile(join(workspace,'witness.sv'),`module witness; logic clk=0,rst_n=0,s_valid=0,m_ready=0; logic [7:0] s_data=0,m_data; wire s_ready,m_valid; add_const dut(.*); initial begin rst_n=${literal('rst_n')}; s_valid=${literal('s_valid')}; m_ready=${literal('m_ready')}; s_data=${literal('s_data')}; dut.out_data=${literal('out_data')}; dut.out_valid=${literal('out_valid')}; #5; clk=1; #1; if(m_data !== 8'h${BigInt(r.witness.actual).toString(16)}) $fatal(1,"WITNESS_DIFFERENT"); $display("WITNESS_REPLAY_PASS"); $finish; end endmodule`);
    const replay=await runVerification(workspace,{...profile,name:'Independent Verilator counterexample replay',stage:'simulation',timeoutMs:120000,inputs:['rtl/add_const.sv','witness.sv'],commands:[{program:'verilator',versionArgs:['--version'],args:['--binary','--timing','--assert','-Wno-fatal','--top-module','witness','--Mdir','{runDir}/obj','rtl/add_const.sv','witness.sv']},{program:'{runDir}/obj/Vwitness',args:[]}],checks:[{kind:'contains',file:'step-1.stdout.log',text:'WITNESS_REPLAY_PASS'}]});assert.equal(replay.status,'passed',json(replay));
    await writeFile(file,original);
   });
   const priority=withUpdate([{id:'clear',condition:ep('s_valid'),value:constant(8,0)},{id:'load',condition:ep('m_ready'),value:ep('s_data')}]);
   const good="if (!rst_n) out_data <= 0; else if (s_valid) out_data <= 0; else if (m_ready) out_data <= s_data;";
   await check('partial reruns and discovery cannot hide failures or untested states',async()=>{
    const run=await runVerification(workspace,profile),partial={...mapping,runId:run.id,mappings:[mapping.mappings[0]]};
    const bad={...partial,mappings:[{...mapping.mappings[0],state:'out_valid'}]};
    await runStateObservation(workspace,bad);
    await runStateObservation(workspace,{...partial,mappings:[mapping.mappings[1]]});
    let summary=await latestStateObservation(workspace,hash);assert.equal(summary.results.length,2);assert.equal(summary.status,'MISMATCH');assert.equal(summary.coverage.mismatched,1);assert.equal(summary.coverage.matched,1);
    await runStateObservation(workspace,{...partial,mappings:[]});summary=await latestStateObservation(workspace,hash);assert.equal(summary.status,'MISMATCH');
    await runStateObservation(workspace,partial);assert.equal((await latestStateObservation(workspace,hash)).status,'MATCH');
    const isolated=join(root,'partial-only');await cp('examples/state-updates',isolated,{recursive:true});const r=await runVerification(isolated,profile);
    await runStateObservation(isolated,{...partial,runId:r.id});const incomplete=await latestStateObservation(isolated,hash);assert.equal(incomplete.status,'UNKNOWN');assert.equal(incomplete.coverage.notRun,1);
   });
   await check('priority, hold and reset mutations are detected without stimulus or source-text matching',async()=>{
    assert.equal(compare(priority,await elaborate(rtl(good))).status,'MATCH');
    for(const body of ["if (!rst_n) out_data <= 0; else if (m_ready) out_data <= s_data; else if (s_valid) out_data <= 0;",good.replace('!rst_n','rst_n'),good+' else out_data <= 0;']){const r=compare(priority,await elaborate(rtl(body)));assert.equal(r.status,'MISMATCH',json(r));assert(r.witness);}
   });
   await check('equivalent Boolean rewrites match even though AST shapes differ',async()=>{
    const m=withUpdate([{id:'load',condition:op('&&',ep('s_valid'),ep('m_ready')),value:ep('s_data')}]);
    assert.equal(compare(m,await elaborate(rtl('if (!rst_n) out_data <= 0; else if (!(!s_valid || !m_ready)) out_data <= s_data;'))).status,'MATCH');
   });
   await check('simple case decode with mutually exclusive PMUX choices matches ordered model branches',async()=>{
    const m=withUpdate([{id:'one',condition:op('==',ep('s_data'),constant(8,1)),value:constant(8,5)},{id:'two',condition:op('==',ep('s_data'),constant(8,2)),value:constant(8,9)}]);
    assert.equal(compare(m,await elaborate(rtl("if (!rst_n) out_data <= 0; else case(s_data) 8'd1:out_data<=8'd5; 8'd2:out_data<=8'd9; default:out_data<=out_data; endcase"))).status,'MATCH');
   });
   await check('all unsigned comparison operators preserve one-bit width in model, monitor and RTL comparison',async()=>{
    for(const operator of ['==','!=','<','<=','>','>='] as const){const condition=op(operator,ep('s_data'),constant(8,7)),m=withUpdate([{id:'compare',condition,value:ep('s_data')}]);assert.equal(localSignalAnalysis(m,(s,e)=>resolveEndpoint(m,s,e)).value('top',condition).width,1);assert(renderChecks(m,bindings).source.includes(operator));assert.equal(compare(m,await elaborate(rtl(`if (!rst_n) out_data <= 0; else if(s_data ${operator} 8'd7) out_data<=s_data;`))).status,'MATCH');}
   });
   await check('unsized literal extension, truncating arithmetic and signed RTL comparison stay explicit',async()=>{
    const increment=withUpdate([{id:'tick',condition:constant(1,1),value:op('+',ep('out_data',true),constant(8,1))}]);assert.equal(compare(increment,await elaborate(rtl('if (!rst_n) out_data <= 0; else out_data <= out_data + 1;'))).status,'MATCH');
    const m=withUpdate([{id:'load',condition:op('<',ep('s_data'),constant(8,7)),value:ep('s_data')}]);assert.equal(compare(m,await elaborate(rtl("if (!rst_n) out_data<=0; else if ($signed(s_data) < 8'sd7) out_data<=s_data;"))).status,'MISMATCH');
   });
   await check('asynchronous reset, multiplication, X data and different clock domains remain UNKNOWN',async()=>{
    const codes=[rtl(good,'posedge clk or negedge rst_n'),rtl(good.replace('out_data <= s_data','out_data <= s_data * s_data')),rtl(good.replace('out_data <= s_data',"out_data <= 8'bx"))];
    for(const code of codes){const d=await elaborate(code),r=compare(priority,d);assert.equal(r.status,'UNKNOWN',json(r));}
    const d=await elaborate(rtl(good));const cell=Object.values(d.cells).find(c=>c.type==='$dff'&&c.connections.Q.length===8)!;cell.connections.CLK=d.ports.m_ready.bits;const r=compare(priority,d);assert.equal(r.status,'UNKNOWN');
   });
   await check('wrong edge is a difference; alias mappings, width mistakes, overlapping PMUX and malformed ports cannot pass',async()=>{
    assert.equal(compare(priority,await elaborate(rtl(good,'negedge clk'))).status,'MISMATCH');
    const d=await elaborate(rtl(good)),bad=structuredClone(mapping.mappings[0]);bad.signals[0].pin='s_valid';assert.equal(compareState(priority,d,bad).status,'UNKNOWN');
    const missing=structuredClone(d);delete missing.netnames.out_data;delete missing.ports.out_data;assert.equal(compare(priority,missing).status,'UNKNOWN');
    const multiple=structuredClone(d),reg=stateInventory(multiple).find(s=>s.width===8)!;multiple.cells.duplicate=structuredClone(multiple.cells[reg.cell]);assert.equal(compare(priority,multiple).status,'UNKNOWN');
    const pmux=await elaborate(rtl("if (!rst_n) out_data<=0; else case(s_data) 1:out_data<=5; 2:out_data<=9; default:out_data<=out_data; endcase"));const p=Object.values(pmux.cells).find(c=>c.type==='$pmux')!;p.connections.S=p.connections.S.map(()=>pmux.ports.s_valid.bits[0]);assert.equal(compare(priority,pmux).status,'UNKNOWN');
    const malformed=structuredClone(d);const mux=Object.values(malformed.cells).find(c=>c.type==='$mux')!;mux.connections.A=[];assert.equal(compare(priority,malformed).status,'UNKNOWN');
   });
   await check('partial input closure and unknown tool version cannot establish a match',async()=>{
    for(const partial of [{...profile,inputClosure:{status:'partial',note:'deliberately missing include closure'}},{...profile,commands:profile.commands.map((c:Record<string,unknown>)=>({...c,versionArgs:undefined}))}]){const r=await runVerification(workspace,partial);const s=await evaluateStateObservation(workspace,{...mapping,runId:r.id});assert.equal(s.status,'UNKNOWN');assert(s.results.every(i=>i.status==='UNKNOWN'));}
   });
   await check('latest mismatch is not hidden; model and artifact edits invalidate saved comparisons',async()=>{
    const r=await runVerification(workspace,profile),s=await runStateObservation(workspace,{...mapping,runId:r.id});assert.equal(s.status,'MATCH');
    await writeFile(join(r.directory,'state.json'),'{}');assert.equal((await latestStateObservation(workspace,hash)).status,'STALE');
    const changed=structuredClone(base);changed.design.name+=' changed';assert.equal((await latestStateObservation(workspace,modelHash(changed))).status,'STALE');
   });
   await check('unknown state types stay visible in inventory; observing never auto-approves',async()=>{
    const d=await elaborate(rtl(good,'posedge clk or negedge rst_n')),state=stateInventory(d).find(s=>s.width===8)!;assert.equal(observeState(d,state.cell).status,'UNKNOWN');const count=stateInventory(d).length;d.cells.user_module={type:'custom_logic',parameters:{},attributes:{},connections:{Q:[999]},port_directions:{Q:'output'}};assert.equal(stateInventory(d).length,count);assert.equal(await readFile(join(workspace,'architecture/review.json'),'utf8').catch(()=>null),null);
   });
   await check('a reversed 64-bit equality still reports the fixed BDD budget as UNKNOWN',async()=>{
    const d=await elaborate(`module add_const(input clk, input [63:0] x,y, output reg q);
   wire [63:0] reversed; for (genvar i=0; i<64; i=i+1) assign reversed[i]=y[63-i];
   always @(posedge clk) q <= x == reversed; endmodule`);
    const observed=observeState(d,stateInventory(d).find(s=>s.aliases.includes('q'))!.cell);
    assert.equal(observed.status,'UNKNOWN');assert.match(observed.reason,/布尔函数.*预算/);
   });
   await check('approval after comparison cannot upgrade a saved draft basis; a new comparison can bind it',async()=>{
    const intent=structuredClone(base);intent.provenance={origin:'design',fidelity:'exact',scope:'Independent temporary state-update intent',configuration:'DATA_W=8 CONST=3',sourceDigest:'0'.repeat(64),coverage:{elaboratedInstances:1,representedInstances:1},evidence:[],findings:[],unsupportedStructures:[],verification:[]};intent.localSignals!.forEach(l=>l.evidenceIds=[]);
    await writeFile(join(workspace,'architecture/model.json'),json(intent));const r=await runVerification(workspace,profile),manifest={...mapping,runId:r.id};const draft=await runStateObservation(workspace,manifest);assert.equal(draft.basis.kind,'unreviewed_design');
    const repo=new Repository(workspace),hash=modelHash(intent);await repo.reviewModule({moduleId:'top',modelHash:hash,reviewer:'isolated maintenance fixture'});await repo.review({modelHash:hash,reviewer:'isolated maintenance fixture'});
    assert.equal((await latestStateObservation(workspace,hash)).basis!.kind,'unknown');assert.equal((await runStateObservation(workspace,manifest)).basis.kind,'approved_intent');
   });
   console.log(json({groups,passed:true,scope:'Actual Yosys proc; bounded Boolean single-step functions, explicit witnesses and UNKNOWN boundaries; no sequential reachability or full RTL equivalence.'}));
  }finally{if(process.env.RTLARCH_KEEP_STATE_OBSERVATION)console.log('kept '+root);else await rm(root,{recursive:true,force:true});}
}

export async function checkTypedExpressions() {
  const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-expression-types-'));
  const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
  let groups=0;const check=async(name:string,fn:()=>unknown)=>{await fn();console.log(`PASS ${++groups}: ${name}`);};
  const ep=(id:string,slice?:{msb:number;lsb:number}):SignalValue=>({kind:'endpoint',endpoint:{moduleId:'top',interfaceId:id,...(slice?{slice}:{})}});
  const constant=(width:number,value:number):SignalValue=>({kind:'constant',width,value:String(value)});
  const op=(operator:Extract<SignalValue,{kind:'operator'}>['operator'],...operands:SignalValue[]):SignalValue=>({kind:'operator',operator,operands});
  const cast=(value:SignalValue,width:number,signed:boolean,mode:Extract<SignalValue,{kind:'cast'}>['mode']='reinterpret'):SignalValue=>({kind:'cast',mode,width,signed,value});
  try{
   await cp('examples/typed-expressions',root,{recursive:true});
   const base=modelSchema.parse(JSON.parse(await readFile(join(root,'architecture/model.json'),'utf8'))),hash=modelHash(base);
   const profile=JSON.parse(await readFile(join(root,'elaboration.json'),'utf8')),mapping=JSON.parse(await readFile(join(root,'state-mapping.json'),'utf8')),bindings=JSON.parse(await readFile(join(root,'bindings.json'),'utf8')),simulation=JSON.parse(await readFile(join(root,'verification.json'),'utf8'));
   const analysis=()=>localSignalAnalysis(base,(s,e)=>resolveEndpoint(base,s,e));
   await check('legacy model hashes are unchanged; explicit types preserve dependencies and reject ambiguous casts',async()=>{
    for(const [file,hash] of [['examples/tiny-stream/model.json','67d8474cbde520a73e057ef9f1260bdb3f92ab2c9450c3c9c0376aa0165929cd'],['examples/state-updates/architecture/model.json','94c6cafc1ef936ab89fc883f3c761edce3d287c99461daf70a4c4a4ddb749bb5']])assert.equal(modelHash(modelSchema.parse(JSON.parse(await readFile(file,'utf8')))),hash);
    assert.deepEqual(validateModel(base).filter(i=>i.blocks.includes('commit')),[]);
    const signed=cast(ep('sample'),8,true);assert.deepEqual(analysis().value('top',signed),{width:8,signed:true,reads:[{moduleId:'top',interfaceId:'sample'}]});
    for(const v of [cast(ep('sample'),9,true),cast(ep('sample'),7,true,'sign_extend'),cast(ep('sample'),8,false,'truncate'),op('+',signed,ep('sample')),op('mux',ep('enable'),signed,ep('sample')),op('>>',signed,cast(ep('shift'),4,true)),op('reduce_and',signed,signed)])assert.throws(()=>analysis().value('top',v));
    assert(!signalValueSchema.safeParse({...signed,fourState:true}).success);
    assert(!signalValueSchema.safeParse({kind:'constant',width:8,value:'-1'}).success);
    assert.deepEqual(signalReads(cast(ep('sample'),12,true,'sign_extend')),[{moduleId:'top',interfaceId:'sample'}]);
    const local={...base.localSignals![0],driver:{kind:'comb' as const,value:cast(op('mux',ep('enable'),ep('sample'),ep('sample')),12,true,'sign_extend')}};
    assert.equal(dependencyRoles(local).get('top.enable'),'select');assert.equal(dependencyRoles(local).get('top.sample'),'operand');assert(signalText(local.driver.value).includes('符号扩展→12 位有符号'));
   });
   await check('bounded shifter exhausts unsigned/signed four-bit inputs and wide shift amounts against integers',()=>{
    const f=new BitFunctions(),a=Array.from({length:4},(_,i)=>f.variable(i)),b=Array.from({length:8},(_,i)=>f.variable(i+4));
    const left=f.shift(a,b,'left'),right=f.shift(a,b,'right'),arithmetic=f.shift(a,b,'right',true);
    for(let x=0;x<16;x++)for(let y=0;y<256;y++){
     const v=new Map(Array.from({length:12},(_,i)=>[i,i<4?x>>i&1:y>>(i-4)&1])),n=BigInt(x<8?x:x-16),amount=BigInt(y);
     assert.equal(BigInt(f.value(left,v)),BigInt(x)<<amount&15n);assert.equal(BigInt(f.value(right,v)),BigInt(x)>>amount);assert.equal(BigInt(f.value(arithmetic,v)),n>>amount&15n);
    }
    assert.equal(f.value(f.shift(a,Array.from({length:256},(_,i)=>i===255?1:0),'right',true),new Map([[3,1]])),'0xf');
   });
   await check('native parallel reading layout keeps all five states and connections without geometric collisions',async()=>{
    const layout=JSON.parse(await readFile(join(root,'architecture/layout.json'),'utf8'));
    const {graph}=await prepareDiagram(base,'top',hash,layout.scopes.top),q=diagramQuality(graph);
    assert.equal(q.status,'passed');assert.equal(q.structuralFidelity.status,'passed');assert.equal(q.readingConstraints.status,'satisfied');assert.equal(graph.stateCount,5);
    assert(q.crossings<46,'fixed 1.9 bank baseline had 46 crossings');assert(q.unrelatedSharedLength<6090);assert(q.hiddenLabels.length<=5);
    const rack=graph.nodes.find(n=>n.id==='rack:top:producer')!;assert(rack.data.geometry.height>1000,'output boundary must follow distributed state rows');
    console.log(json({reading:{crossings:q.crossings,hiddenLabels:q.hiddenLabels.length,humanReview:q.visualReview}}));
   });
   const run=await runVerification(root,profile);assert.equal(run.status,'passed',json(run));mapping.runId=run.id;
   await check('real Yosys signed scaler matches all five explicit state rules without upgrading as-built evidence',async()=>{
    const report=await runStateObservation(root,mapping);assert.equal(report.status,'MATCH',json(report.results));assert.equal(report.results.length,5);assert.equal(report.basis.kind,'as_built');assert(report.results.some(r=>r.observed?.cells.some(c=>c.type==='$sshr')));
   });
   await generateChecks(root,bindings,join(root,'checks'));
   await check('actual Verilator exhausts 4096 signed-scaler input pairs plus reset/hold with generated monitors',async()=>{
    const r=await runVerification(root,simulation);assert.equal(r.status,'passed',json(r));assert((await readFile(join(r.directory,'step-1.stdout.log'),'utf8')).includes('TYPED_EXHAUSTIVE_PASS'));
   });
   const original=await readFile(join(root,'rtl/signed_scaler.sv'),'utf8');
   for(const [name,code] of [['logical_instead_of_arithmetic',original.replaceAll('extended_sample >>> shift','extended_sample >> shift')],['unsigned_comparison',original.replace("sample < 8'sd0","$unsigned(sample) < 8'd0")]])await check(`${name}: independent RTL mutations produce witnesses and fail the simulation monitor`,async()=>{
    await writeFile(join(root,'rtl/signed_scaler.sv'),code);assert.equal((await latestStateObservation(root,hash)).status,'STALE');
    const r=await runVerification(root,profile),report=await runStateObservation(root,{...mapping,runId:r.id});assert.equal(report.status,'MISMATCH');assert(report.results.some(x=>x.witness&&x.witness.expected!==x.witness.actual));
    const s=await runVerification(root,simulation);assert.equal(s.status,'command_failed');assert((await readFile(join(s.directory,'step-1.stdout.log'),'utf8')).includes('state transition mismatch'));
   });
   await writeFile(join(root,'rtl/signed_scaler.sv'),original);
   // Independent HDL expressions exercise self-sizing, signedness, reductions, comparisons and conversion order.
   const a=ep('sample',{msb:3,lsb:0}),b=ep('shift'),sa=cast(a,4,true),sb=cast(b,4,true);
   const cases:{name:string;value:SignalValue;rtl:string}[]=[
    {name:'zero',value:cast(sa,8,true,'zero_extend'),rtl:"$signed({4'b0,sample[3:0]})"},
    {name:'sign',value:cast(a,8,false,'sign_extend'),rtl:'{{4{sample[3]}},sample[3:0]}'},
    {name:'truncate',value:cast(ep('sample'),4,true,'truncate'),rtl:'$signed(sample[3:0])'},
    {name:'wrap_unsigned',value:cast(op('+',a,constant(4,1)),8,false,'zero_extend'),rtl:"{4'b0,4'(sample[3:0]+4'd1)}"},
    {name:'wrap_signed',value:cast(op('+',sa,cast(constant(4,1),4,true)),8,true,'sign_extend'),rtl:"8'($signed(4'($signed(sample[3:0])+4'sd1)))"},
    {name:'truncate_before',value:cast(cast(ep('sample'),4,true,'truncate'),8,true,'sign_extend'),rtl:"8'($signed(sample[3:0]))"},
    {name:'mux_signed',value:op('<',op('mux',ep('enable'),sa,sb),cast(constant(4,0),4,true)),rtl:"(enable ? $signed(sample[3:0]) : $signed(shift)) < 4'sd0"},
    {name:'concat_unsigned',value:op('<',{kind:'concat',parts:[sa]},constant(4,8)),rtl:"{$signed(sample[3:0])} < 4'd8"},
   ];
   for(const operator of ['==','!=','<','<=','>','>='] as const)cases.push({name:'cmp'+cases.length,value:op(operator,sa,sb),rtl:`$signed(sample[3:0]) ${operator} $signed(shift)`});
   for(const [operator,symbol] of [['reduce_and','&'],['reduce_or','|'],['reduce_xor','^']] as const)cases.push({name:operator,value:op(operator,a),rtl:`${symbol}(sample[3:0])`});
   for(const signed of [false,true])for(const operator of ['<<','>>','>>>'] as const)cases.push({name:'shift'+cases.length,value:op(operator,signed?sa:a,b),rtl:`4'(${signed?'$signed(sample[3:0])':'sample[3:0]'} ${operator} shift)`});
   // Yosys A_WIDTH may exceed Y_WIDTH for a shift: high source bits must survive until after shifting.
   cases.push({name:'narrow_shift',value:cast(op('>>',ep('sample'),b),4,false,'truncate'),rtl:'sample >> shift'});
   cases.push({name:'wide_shift',value:op('>>>',cast(sa,8,true,'sign_extend'),b),rtl:'$signed(sample[3:0]) >>> shift'});
   await check('25 HDL expression cases match BDD functions and generated monitors across width/sign boundaries',async()=>{
    const m:Model=structuredClone(base);m.connections=[];m.localSignals=[];m.modules[0].contract.obligations=[];m.modules[0].interfaces=m.modules[0].interfaces.filter(i=>i.role==='consumer');
    const ports:string[]=[],assignments:string[]=[],map:StateMapping[]=[],bind:CheckBindings['bindings']=[];
    for(const c of cases){
     const width=analysis().value('top',c.value).width,id=c.name+'_q';
     const update={reset:{signal:{moduleId:'top',interfaceId:'rst_n'},activeLevel:'low' as const,value:constant(width,0)},branches:[{id:'tick',condition:constant(1,1),value:c.value}],otherwise:'hold' as const};
     m.localSignals.push({id,scope:'top',name:c.name,width,description:c.rtl,driver:{kind:'register',inputs:stateUpdateReads(update),sourceText:c.rtl,update},evidenceIds:[]});
     m.modules[0].contract.obligations!.push({id,kind:'state_transition',localSignalId:id,description:c.name});
     ports.push(`output reg [${width-1}:0] ${c.name}`);assignments.push(`always @(posedge clk) if (!rst_n) ${c.name} <= 0; else ${c.name} <= ${c.rtl};`);
     map.push({...mapping.mappings[0],localSignalId:id,state:c.name});bind.push({...bindings.bindings[0],obligationId:id,state:c.name});
    }
    const code=`module probe(input clk,rst_n,enable,input [7:0] sample,input [3:0] shift,${ports.join(',')});\n${assignments.join('\n')}\nendmodule`;
    await writeFile(join(root,'probe.sv'),code);await exec('yosys',['-Q','-T','-p','read_verilog -sv probe.sv; hierarchy -check -top probe; proc; check -assert; write_json probe.json'],{cwd:root,timeout:30000});
    const def:Definition=JSON.parse(await readFile(join(root,'probe.json'),'utf8')).modules.probe;
    for(const c of map){const r=compareState(m,def,c);assert.equal(r.status,'MATCH',json({state:c.state,result:r}));}
    const checks=renderChecks(m,{...bindings,bindings:bind});await writeFile(join(root,'probe_checks.sv'),checks.source);
    await writeFile(join(root,'probe_tb.sv'),`module tb; logic clk=0,rst_n=0,enable=0; logic [7:0] sample=0; logic [3:0] shift=0; probe dut(.clk(clk),.rst_n(rst_n),.enable(enable),.sample(sample),.shift(shift)); rtlarch_contract_checks checks(); task tick; #5;clk=1;#5;clk=0;#1;endtask initial begin tick();rst_n=1;for(int a=0;a<256;a++)for(int b=0;b<16;b++)begin sample=8'(a);shift=4'(b);enable=1'(a);tick();end $display("PROBE_EXHAUSTIVE_PASS");$finish;end endmodule`);
    await exec('verilator',['--binary','--timing','--assert','-Wno-fatal','--top-module','tb','--Mdir',join(root,'probe_obj'),'probe.sv','probe_tb.sv','probe_checks.sv'],{cwd:root,timeout:120000,maxBuffer:8*1024*1024});
    const sim=await exec(join(root,'probe_obj/Vtb'),[],{cwd:root,timeout:30000});assert(sim.stdout.includes('PROBE_EXHAUSTIVE_PASS'));assert(!sim.stdout.includes('RTLARCH_OBL_FAIL'));assert.equal(sim.stdout.split('\n').filter(l=>l.startsWith('RTLARCH_OBL_PASS ')).length,cases.length);
    const malformed=structuredClone(def),cell=Object.values(malformed.cells).find(c=>c.type==='$sshr')!;cell.parameters.B_SIGNED=1;assert(map.some(c=>compareState(m,malformed,c).status==='UNKNOWN'));
    const wrong=structuredClone(m),d=wrong.localSignals!.find(l=>l.id==='wrap_unsigned_q')!.driver;if(d.kind!=='register')throw Error();d.update!.branches[0].value=op('+',cast(a,8,false,'zero_extend'),constant(8,1));d.inputs=stateUpdateReads(d.update!);assert.equal(compareState(wrong,def,map.find(c=>c.state==='wrap_unsigned')!).status,'MISMATCH');
    console.log(`EXPRESSION_CASES ${cases.length} × 4096 input pairs`);
   });
   assert.equal(modelHash(modelSchema.parse(JSON.parse(await readFile(join(root,'architecture/model.json'),'utf8')))),hash);
   console.log(json({groups,passed:true,domain:'finite two-state expressions; no X/Z, reachability or full SystemVerilog type inference'}));
  }finally{await rm(root,{recursive:true,force:true});}
}

export async function checkAxisPair() {
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
}

export async function checkTransactionReplay() {
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
}
