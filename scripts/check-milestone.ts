import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Repository} from '../src/workspace/repository';
import {modelSchema,type Model} from '../src/core/schema';
import {reviewDependencies} from '../src/core/reviewImpact';
import {modelHash} from '../src/core/export';
import {evaluateStudy,type Study} from '../src/core/studies';
import {runVerification,verificationRuns} from '../src/workspace/verification';
import {importYosys,importImpact} from '../src/workspace/importYosys';
import {toolRoot} from '../src/workspace/environment';
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-milestone-'));let checks=0;
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();console.log(`PASS ${++checks}: ${name}`);};
const base=modelSchema.parse(JSON.parse(await readFile(join(toolRoot,'examples/packet-pipeline/model.json'),'utf8')));
const study=(hash:string):Study=>({id:'tradeoff',title:'比较并行计算资源',modelHash:hash,moduleIds:[base.design.top],configuration:'同一输入与运算量',assumptions:['运算独立，读写端口独立，开销不可重叠'],workItems:10,options:[{id:'one',label:'一个单元',compute:{lanes:1,operationsPerItem:3,cyclesPerOperation:1,overheadCycles:2},runIds:[]},{id:'two',label:'两个单元',compute:{lanes:2,operationsPerItem:3,cyclesPerOperation:1,overheadCycles:2},runIds:[]}]});
try{
 await mkdir(join(root,'architecture'));await writeFile(join(root,'architecture/model.json'),JSON.stringify(base));
 const repo=new Repository(root),initial=(await repo.getModel()).modelHash,modelBytes=await readFile(join(root,'architecture/model.json'));
 let threadId='';
 await check('durable questions and agent replies leave architecture untouched; concurrent writes cannot overwrite',async()=>{
  const first=await repo.getWorkbench();const asked=await repo.updateWorkbench({baseHash:first.workbenchHash,action:{kind:'ask',title:'能否复用运算单元？',text:'请比较周期与存储端口约束。',target:{modelHash:initial,moduleId:base.design.top,connectionIds:[]}}});
  threadId=asked.workbench.threads[0].id;
  await assert.rejects(repo.updateWorkbench({baseHash:first.workbenchHash,action:{kind:'resolve',threadId,modelHash:initial}}),e=>(e as any).code==='WORKBENCH_CONFLICT');
  const replied=await repo.updateWorkbench({baseHash:asked.workbenchHash,action:{kind:'reply',threadId,author:'agent',text:'先用相同工作量计算服务量下界，再验证。',modelHash:initial}});
  assert.equal(replied.workbench.threads[0].status,'addressed');assert.equal(replied.workbench.threads[0].messages.length,2);
  assert.deepEqual(await readFile(join(root,'architecture/model.json')),modelBytes);
  const context=await repo.getContext(base.design.top);assert.equal(context.collaboration.threads[0].id,threadId);
 });
 await check('checkpoint, candidate-linked replies and user resolution survive a new repository instance',async()=>{
  const proposal={baseHash:initial,reason:'明确顶层说明',commands:[{op:'rename_module',moduleId:base.design.top,name:'流处理设计'}]};
  const p=await repo.registerProposal(proposal);let work=await repo.getWorkbench();
  work=await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'reply',threadId,author:'agent',text:'候选修改已登记。',modelHash:initial,proposalId:p.id}});
  work=await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'checkpoint',intent:'比较结构',nextStep:'检查候选并核对吞吐假设',target:{modelHash:p.candidateHash,moduleId:base.design.top,connectionIds:[],proposalId:p.id}}});
  const resumed=await new Repository(root).getResume();assert.equal(resumed.workbench.checkpoint?.target.proposalId,p.id);assert.ok(resumed.proposals.some(x=>x.id===p.id&&x.state==='READY'));
  const resolved=await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'resolve',threadId,modelHash:initial}});assert.equal(resolved.workbench.threads[0].status,'resolved');
  assert.equal((await repo.getModel()).reviewStatus,'DRAFT');
 });
 await check('budget exposes fractional service bounds, absent ports, buffer insufficiency and overflow',async()=>{
  const s=study(initial),r=evaluateStudy(s);assert.equal(r.options[0].cyclesLowerBound,32);assert.equal(r.options[1].cyclesLowerBound,17);assert.equal(r.options[1].intervalLowerBound,1.5);
  s.options[0].memory={words:8,width:16,copies:2,readsPerItem:1,writesPerItem:0,readPorts:0,writePorts:0};
  s.options[1].flow={producedPerCycle:2,maxStallCycles:3,inFlight:4,capacity:9};
  const bad=evaluateStudy(s);assert.equal(bad.options[0].cyclesLowerBound,null);assert.equal(bad.options[0].storageBits,256);assert.equal(bad.options[1].requiredCapacity,10);assert.equal(bad.options[1].feasible,false);
  const huge=study(initial);huge.workItems=1e9;huge.options[0].compute.operationsPerItem=1e9;assert.throws(()=>evaluateStudy(huge));
 });
 await check('review retains a disconnected module but invalidates changed modules and parents; legacy remains conservative',async()=>{
  const m=structuredClone(base),leaf=m.modules.find(n=>n.parent&&n.kind!=='subsystem')!;
  m.modules.push({...structuredClone(leaf),id:'independent',name:'独立模块',parent:m.design.top,interfaces:[]});
  const dir=join(root,'review');await mkdir(join(dir,'architecture'),{recursive:true});await writeFile(join(dir,'architecture/model.json'),JSON.stringify(m));const r=new Repository(dir),old=await r.getModel();
  for(const module of m.modules)await r.reviewModule({modelHash:old.modelHash,moduleId:module.id,reviewer:'fixture'});
  await r.review({modelHash:old.modelHash,reviewer:'fixture'});
  const proposal={baseHash:old.modelHash,reason:'局部名称变更',commands:[{op:'rename_module',moduleId:leaf.id,name:'更新的职责名'}]},preview=await r.preview(proposal);
  const updated=await r.commit({proposal,candidateHash:preview.candidateHash});
  assert.equal(updated.moduleReviews.find(x=>x.moduleId==='independent')?.status,'APPROVED');assert.equal(updated.moduleReviews.find(x=>x.moduleId==='independent')?.retained,true);
  assert.equal(updated.moduleReviews.find(x=>x.moduleId===leaf.id)?.status,'STALE');assert.equal(updated.moduleReviews.find(x=>x.moduleId===m.design.top)?.status,'STALE');assert.equal(updated.reviewStatus,'STALE');
  const recordFile=join(dir,'architecture/module-reviews.json'),records=JSON.parse(await readFile(recordFile,'utf8'));delete records.modules.independent.scopeHash;delete records.modules.independent.scopeParts;await writeFile(recordFile,JSON.stringify(records));assert.equal((await r.getModel()).moduleReviews.find(x=>x.moduleId==='independent')?.status,'STALE');
 });
 await check('verification records input-bound isolated runs, checks JUnit and rejects stale results',async()=>{
  await writeFile(join(root,'probe.js'),"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite><testcase name=\"selfcheck\"/></testsuite>')");
  const p={schemaVersion:1,name:'运行记录自检',stage:'simulation',moduleIds:[base.design.top],inputs:['probe.js'],timeoutMs:5000,commands:[{program:process.execPath,args:['probe.js','{runDir}'],versionArgs:['--version']}],checks:[{kind:'junit',file:'result.xml'}]};
  const run=await runVerification(root,p);assert.equal(run.status,'passed');assert.equal((await verificationRuns(root,initial))[0].fresh,true);
  const s=study(initial);s.options[0].runIds=[run.id];let work=await repo.getWorkbench();await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'study',study:s}});
  await writeFile(join(root,'probe.js'),'// source changed');assert.equal((await verificationRuns(root,initial))[0].fresh,false);
  work=await repo.getWorkbench();await assert.rejects(repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'study',study:s}}));
 });
 await check('zero/skipped test reports, timeout, report traversal and live input mutation never pass',async()=>{
  for(const [name,code,check] of [
   ['zero',"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite/>')",{kind:'junit',file:'result.xml'}],
   ['suite_error',"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite errors=\"1\"><testcase/></testsuite>')",{kind:'junit',file:'result.xml'}],
   ['skip',"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite><testcase><skipped/></testcase></testsuite>')",{kind:'junit',file:'result.xml'}],
   ['timeout','setInterval(()=>{},1000)',{kind:'exit_code'}],
   ['change',"require('fs').appendFileSync('probe.js','// changed')",{kind:'exit_code'}],
   ['traversal','', {kind:'contains',file:'../../../../etc/passwd',text:'root'}],
  ] as const){await writeFile(join(root,'probe.js'),code);const run=await runVerification(root,{schemaVersion:1,name,stage:'simulation',moduleIds:[base.design.top],inputs:['probe.js'],timeoutMs:name==='timeout'?150:5000,commands:[{program:process.execPath,args:['probe.js','{runDir}']}],checks:[check]});assert.notEqual(run.status,'passed',name);}
 });
 await check('real Yosys elaboration imports RTL topology and preserves unknown behavior with incremental source mapping',async()=>{
  const dir=join(root,'intake');await mkdir(dir);await cp(join(toolRoot,'examples/rtl-intake/rtl'),join(dir,'rtl'),{recursive:true});
  await exec('yosys',['-Q','-T','-p','read_verilog -sv rtl/stage.sv rtl/stream_top.sv; hierarchy -top stream_top; proc; write_json netlist.json'],{cwd:dir,timeout:30000,maxBuffer:4*1024*1024});
  const manifest={schemaVersion:1,top:'stream_top',netlist:'netlist.json',files:['rtl/stage.sv','rtl/stream_top.sv'],configuration:'BIAS=1 then BIAS=2; no flatten'},result=await importYosys(dir,manifest,join(dir,'candidate'));
  const model=modelSchema.parse(JSON.parse(await readFile(result.modelFile,'utf8')));assert.equal(model.modules.length,3);assert.equal(model.provenance?.origin,'as_built');assert.equal(model.provenance?.fidelity,'partial');assert.ok(model.connections.length>=8);assert.ok(model.modules.every(m=>m.timing==='unknown'));
  const report=JSON.parse(await readFile(result.reportFile,'utf8')),fresh=await importImpact(dir,report);assert.equal(fresh.changedFiles.length,0);
  await writeFile(join(dir,'rtl/stage.sv'),(await readFile(join(dir,'rtl/stage.sv'),'utf8')).replace('data_i + BIAS','data_i - BIAS'));
  const impact=await importImpact(dir,report);assert.equal(impact.changedFiles.length,1);assert.equal(impact.affectedModuleIds.length,2);assert.equal(impact.requiresReelaboration,true);
  await assert.rejects(importYosys(dir,manifest,join(dir,'architecture/out')));await assert.rejects(importYosys(dir,manifest,join(dir,'candidate')));
 });
 await check('dependency fingerprints cover neighbor contracts, global clocks and ancestor parameters without unrelated churn',async()=>{
  const id='buffer',hash=(m:Model)=>reviewDependencies(m,id).scopeHash;
  const unchanged=structuredClone(base);unchanged.modules.find(m=>m.id==='egress')!.name='Presentation only';assert.equal(hash(unchanged),hash(base));
  for(const change of [(m:Model)=>{m.modules.find(m=>m.id==='compute')!.contract.backpressure+=' Changed';},(m:Model)=>{m.clocks[0].edge=m.clocks[0].edge==='rising'?'falling':'rising';},(m:Model)=>{m.modules.find(m=>m.id==='processing')!.parameters.EXTRA=1;}]){const changed=structuredClone(base);change(changed);assert.notEqual(hash(changed),hash(base));}
 });
 await check('Yosys constants and normalized slices preserve bits while ambiguous and bidirectional drivers stay gaps',async()=>{
  const dir=join(root,'bit-import');await mkdir(dir);await writeFile(join(dir,'ports.sv'),'// explicit synthetic netlist fixture');
  const net={modules:{top:{attributes:{src:'ports.sv:1.1-1.2'},ports:{a:{direction:'input',bits:[2,3],offset:8,upto:1,signed:1},b:{direction:'output',bits:[3,2]},k:{direction:'output',bits:['1','0']},tri:{direction:'inout',bits:[4]}},cells:{}}}};
  await writeFile(join(dir,'net.json'),JSON.stringify(net));const manifest={schemaVersion:1,top:'top',netlist:'net.json',files:['ports.sv'],configuration:'synthetic bit mapping fixture'};
  const first=await importYosys(dir,manifest,join(dir,'one')),m=modelSchema.parse(JSON.parse(await readFile(first.modelFile,'utf8')));assert.equal(m.connections.length,4);assert.ok(m.localSignals?.some(l=>l.driver.kind==='comb'&&l.driver.value.kind==='constant'));assert.ok(m.provenance?.unsupportedStructures.some(s=>s.kind==='port'));
  const report=JSON.parse(await readFile(first.reportFile,'utf8'));assert.equal(report.mapping[0].ports[0].offset,8);assert.equal(report.mapping[0].ports[0].signed,true);
  net.modules.top.ports.tri.bits=[2];await writeFile(join(dir,'net.json'),JSON.stringify(net));const tri=await importYosys(dir,manifest,join(dir,'tri')),triModel=modelSchema.parse(JSON.parse(await readFile(tri.modelFile,'utf8')));assert.equal(triModel.connections.filter(c=>c.to.interfaceId==='b').length,1);
  Object.assign(net.modules.top.ports,{duplicate:{direction:'input',bits:[2]}});await writeFile(join(dir,'net.json'),JSON.stringify(net));const second=await importYosys(dir,manifest,join(dir,'two')),ambiguous=modelSchema.parse(JSON.parse(await readFile(second.modelFile,'utf8')));assert.ok(ambiguous.provenance?.unsupportedStructures.some(s=>s.kind==='multiple_driver'));assert.equal(ambiguous.connections.filter(c=>c.to.interfaceId==='b').length,1);
 });
}finally{await rm(root,{recursive:true,force:true});}
console.log(`完成 ${checks} 组 1.0 共同设计与执行检查。`);
