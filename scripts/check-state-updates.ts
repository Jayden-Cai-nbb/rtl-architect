import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,cp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelSchema,type Model} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {validateModel} from '../src/core/engine';
import {dependencyRoles,hardwareView} from '../src/core/hardwareView';
import {inspectScope} from '../src/core/inspection';
import {endpointLabel} from '../src/core/signals';
import {stateDescription} from '../src/core/stateUpdates';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {generateChecks,renderChecks,loadChecks} from '../src/workspace/contractChecks';
import {runVerification} from '../src/workspace/verification';
import {assurance} from '../src/workspace/assurance';
import {Repository} from '../src/workspace/repository';
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
