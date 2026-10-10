import { integerExpression } from '../src/core/expressions';
import { parameterValue, physicalInstanceCount } from '../src/core/parameters';
import { validateModel, applyCommands } from '../src/core/engine';
import { moduleDocument } from '../src/core/spec';
import { contractData } from '../src/core/export';
import { Repository, atomicWrite } from '../src/workspace/repository';
import { sourceInventory } from '../src/workspace/inventory';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { modelSchema, type Model, type Proposal } from '../src/core/schema';
import { modelHash } from '../src/core/export';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import { elkLayout } from '../src/web/graph/elkLayout';
import { readEvidence } from '../src/workspace/evidence';
const fixture=modelSchema.parse(JSON.parse(await readFile('examples/packet-pipeline/model.json','utf8')));
const top=structuredClone(fixture.modules[0]);
top.id='top';top.name='top';top.parent=null;top.parameters={WIDTH:8};top.interfaces=[{id:'data',role:'consumer',protocol:'signal',width:4,required:true}];top.contract.openQuestions=[];
const leaf={...structuredClone(top),id:'lane',name:'lane',rtlModule:'lane',parent:'top',kind:'module' as const,parameters:{DATA_W:8,OFFSET:0},parameterBindings:{DATA_W:{scope:'parent' as const,expression:'WIDTH'},OFFSET:{scope:'self' as const,expression:'z * 4'}},instances:{indexVariable:'z',from:0,to:255,sourcePath:'top.g[{z}].lane'},interfaces:[{id:'data',role:'consumer' as const,protocol:'signal' as const,width:{param:'DATA_W'},required:true}]};
const arrayModel:Model={schemaVersion:3,design:{id:'array_demo',name:'Array controls',top:'top'},clocks:structuredClone(fixture.clocks),resets:structuredClone(fixture.resets),modules:[top,leaf],localSignals:[{id:'control',scope:'top',name:'control',width:8,description:'真实局部 assign，不是 RTL 子模块',evidenceIds:[],driver:{kind:'comb',value:{kind:'concat',parts:[{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'data'}},{kind:'constant',width:4,value:'0xa'}]}}}],connections:[{id:'broadcast',scope:'top',from:{moduleId:'top',interfaceId:'control',local:true},to:{moduleId:'lane',interfaceId:'data',index:'all'}}]};
let checks=0;
async function check(name:string,fn:()=>unknown|Promise<unknown>){await fn();console.log(`PASS ${++checks}: ${name}`)}
const dir=await mkdtemp(join(tmpdir(),'rtlarch-explore-check-'));
try {
 await check('compact projection merges boundaries and preserves every real connection in bundles without changing IR',async()=>{
  const model=structuredClone(fixture),scope=model.design.top,top=model.modules.find(m=>m.id===scope)!;
  for(let i=0;i<40;i++)top.interfaces.push({id:`extra_${i}`,role:'consumer',protocol:'signal',width:1,required:false});
  const before=modelHash(model),compact=scopeDiagram(model,scope);
  assert.equal(compact.nodes.filter(n=>n.data.kind==='rack').length,2);assert.equal(compact.nodes.filter(n=>!n.data.boundary).length,model.modules.filter(m=>m.parent===scope).length);
  assert.deepEqual(compact.edges.flatMap(e=>e.data!.connectionIds as string[]).sort(),model.connections.filter(c=>c.scope===scope).map(c=>c.id).sort());
  assert.ok(compact.nodes.filter(n=>!n.data.boundary).every(n=>n.height!<300));assert.equal(modelHash(model),before);
  const positions=await elkLayout(compact.nodes,compact.edges);assert.equal(Object.keys(positions).length,compact.nodes.length);
 });
 await check('evidence preview reads only declared workspace source, detects changed content and rejects escaping symlinks',async()=>{
  await mkdir(join(dir,'rtl'));await writeFile(join(dir,'rtl/source.sv'),'line1\nline2\nline3\n');
  const model=structuredClone(fixture);model.provenance={origin:'as_built',fidelity:'partial',scope:'test',configuration:'test',sourceDigest:'a'.repeat(64),coverage:{elaboratedInstances:7,representedInstances:7},findings:[],unsupportedStructures:[],verification:[],evidence:[{id:'source',file:'rtl/source.sv',fileHash:createHash('sha256').update('line1\nline2\nline3\n').digest('hex'),line:2,sourceKind:'code'}]};
  const first=await readEvidence(dir,model,'source');assert.equal(first.matches,true);assert.match(first.text,/line2/);
  await writeFile(join(dir,'rtl/source.sv'),'changed\n');const next=await readEvidence(dir,model,'source');assert.equal(next.matches,false);assert.equal(next.lineExists,true);
  await symlink('/etc/hosts',join(dir,'outside'));model.provenance.evidence[0].file='outside';await assert.rejects(readEvidence(dir,model,'source'),{code:'EVIDENCE_OUTSIDE_WORKSPACE'});
  await assert.rejects(readEvidence(dir,model,'missing'),{code:'EVIDENCE_NOT_FOUND'});
 });

 await check('restricted integer evaluator handles precedence/clog2/literals and rejects execution, overflow, unknown names and cycles',()=>{
  assert.equal(integerExpression('($clog2(N) + 2) * 4 + 8\'h0f',n=>{assert.equal(n,'N');return 256}),55);
  assert.equal(integerExpression('1 + 2 << 3 | 1',()=>0),25);
  for(const expression of ['process.exit()','globalThis[1]','1 / 0','1 << 128',"4'hff",'2 ** 4','foo;bar','1.5','9007199254740992'])assert.throws(()=>integerExpression(expression,()=>{throw Error('unknown')}));
  const bad=structuredClone(arrayModel);bad.modules[1].parameterBindings!.OFFSET={scope:'self',expression:'OFFSET + 1'};assert.ok(validateModel(bad).some(i=>i.code==='PARAMETER_BINDING'));
 });
 await check('native 256-element array has exact counts, indexed context, shared contract and per-index width/parameter validation',()=>{
  assert.deepEqual(validateModel(arrayModel),[]);assert.equal(physicalInstanceCount(arrayModel),257);
  const doc=moduleDocument(arrayModel,'lane',123);assert.equal(doc.instance?.sourcePath,'top.g[123].lane');assert.equal(doc.instance?.parameters.OFFSET,492);assert.equal(doc.connections.length,1);assert.equal(doc.connections[0].to.index,123);
  const exported=contractData(arrayModel);assert.equal(exported.modules[1]?.id==='lane'?exported.modules[1].instances?.to:exported.modules[0].instances?.to,255);
  const graph=scopeDiagram(arrayModel,'top',{showLocals:true});assert.ok(graph.nodes.find(n=>n.id==='lane')?.data.instanceCount===256);assert.ok(graph.nodes.some(n=>n.data.localId==='control'));assert.equal(graph.edges.filter(e=>e.data?.localSignalId).length,1);
  const bad=structuredClone(arrayModel);bad.modules[1].parameterBindings!.OFFSET={scope:'self',expression:'1 / (z - 123)'};assert.ok(validateModel(bad).some(i=>i.code==='PARAMETER_BINDING'));
  assert.throws(()=>moduleDocument(arrayModel,'lane',256));
  assert.throws(()=>applyCommands(arrayModel,[{op:'set_instance_parameter',moduleId:'lane',index:123,key:'DATA_W',value:16}]));
  assert.throws(()=>applyCommands(arrayModel,[{op:'set_parameter',moduleId:'lane',key:'DATA_W',value:16}]));
 });
 await check('local constants/concat/slices and disjoint bit drivers validate; overlaps, gaps, truncation, fake boundaries and comb dependency loops are detected',()=>{
  const m=structuredClone(arrayModel);m.modules[1].instances={...m.modules[1].instances!,to:0};m.connections=[{id:'lo',scope:'top',from:{moduleId:'top',interfaceId:'control',local:true,slice:{msb:3,lsb:0}},to:{moduleId:'lane',interfaceId:'data',index:0,slice:{msb:3,lsb:0}}},{id:'hi',scope:'top',from:{moduleId:'top',interfaceId:'control',local:true,slice:{msb:7,lsb:4}},to:{moduleId:'lane',interfaceId:'data',index:0,slice:{msb:7,lsb:4}}}];
  assert.deepEqual(validateModel(m),[]);
  const overlap=structuredClone(m);overlap.connections[1].to.slice={msb:5,lsb:2};assert.ok(validateModel(overlap).some(i=>i.code==='MULTI_DRIVER'));
  const gap=structuredClone(m);gap.connections.pop();assert.ok(validateModel(gap).some(i=>i.code==='REQUIRED_UNCONNECTED'&&i.target.includes('lane')));
  const overflow=structuredClone(m);overflow.localSignals![0].driver={kind:'comb',value:{kind:'constant',width:8,value:'256'}};assert.ok(validateModel(overflow).some(i=>i.code==='LOCAL_DRIVER'));
  const loop=structuredClone(m);loop.localSignals![0].driver={kind:'comb',value:{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'control',local:true}}};assert.ok(validateModel(loop).some(i=>i.code==='LOCAL_DRIVER'));
  loop.localSignals![0].driver={kind:'register',inputs:[{moduleId:'top',interfaceId:'control',local:true}],sourceText:'q <= q;'};assert.ok(!validateModel(loop).some(i=>i.blocks.includes('commit')));
  const op=structuredClone(m);op.localSignals![0].driver={kind:'comb',value:{kind:'operator',operator:'mux',operands:[{kind:'constant',width:1,value:'1'},{kind:'constant',width:8,value:'0xaa'},{kind:'constant',width:8,value:'0x55'}]}};assert.ok(!validateModel(op).some(i=>i.blocks.includes('commit')));
  assert.equal(op.localSignals![0].driver.value.kind,'operator');if(op.localSignals![0].driver.value.kind!=='operator')throw Error('test fixture');op.localSignals![0].driver.value.operands[2]={kind:'constant',width:4,value:'0'};assert.ok(validateModel(op).some(i=>i.code==='LOCAL_DRIVER'));
  const fake=structuredClone(m);delete fake.connections[0].from.local;assert.ok(validateModel(fake).some(i=>i.code==='SCOPE_REFERENCE'));
  const reduce=structuredClone(arrayModel);reduce.modules[0].interfaces.push({id:'out',role:'producer',protocol:'signal',width:8,required:false});reduce.modules[1].interfaces.push({id:'out',role:'producer',protocol:'signal',width:8,required:false});reduce.connections.push({id:'bad_reduce',scope:'top',from:{moduleId:'lane',interfaceId:'out',index:'all'},to:{moduleId:'top',interfaceId:'out'}});assert.ok(validateModel(reduce).some(i=>i.code==='MULTI_DRIVER'));
 });
 await check('index-specific preview is read-only, commit persists only the chosen override, invalidates confirmations and rejects stale replay',async()=>{
  const workspace=join(dir,'project');await atomicWrite(join(workspace,'architecture/model.json'),JSON.stringify(arrayModel));const repo=new Repository(workspace),before=await repo.getModel();
  for(const m of arrayModel.modules)await repo.reviewModule({modelHash:before.modelHash,moduleId:m.id,reviewer:'temporary'});
  const proposal:Proposal={baseHash:before.modelHash,reason:'override index 123',commands:[{op:'set_instance_parameter',moduleId:'lane',index:123,key:'OFFSET',value:999}]};
  const preview=await repo.preview(proposal);assert.equal((await repo.getModel()).modelHash,before.modelHash);await repo.commit({proposal,candidateHash:preview.candidateHash});
  const after=await new Repository(workspace).getModel(),lane=after.model.modules[1];assert.equal(parameterValue(after.model,lane,'OFFSET',123),999);assert.equal(parameterValue(after.model,lane,'OFFSET',122),488);assert.deepEqual(Object.keys(lane.instances!.overrides!),['123']);assert.ok(after.moduleReviews.every(r=>r.status==='STALE'));
  await assert.rejects(repo.commit({proposal,candidateHash:preview.candidateHash}),{status:409});
  const propagated=applyCommands(arrayModel,[{op:'set_parameter',moduleId:'top',key:'WIDTH',value:16},{op:'update_local_signals',localSignals:[{...arrayModel.localSignals![0],width:16,driver:{kind:'comb',value:{kind:'concat',parts:[{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'data'}},{kind:'constant',width:12,value:'0'}]}}}]}]).model;assert.equal(parameterValue(propagated,propagated.modules[1],'DATA_W',255),16);
 });
 await check('source targets resolve to real items and root causes annotate rather than hide unresolved port warnings',()=>{
  const m=structuredClone(arrayModel);m.connections=[];m.provenance={origin:'as_built',fidelity:'partial',scope:'array review',configuration:'defaults',sourceDigest:'a'.repeat(64),coverage:{elaboratedInstances:257,representedInstances:257},evidence:[{id:'e',file:'rtl/source.sv',fileHash:'b'.repeat(64),sourceKind:'code',targets:[{kind:'interface',moduleId:'lane',itemId:'data'}]}],findings:[],verification:[],unsupportedStructures:[{id:'driver_gap',kind:'local',causes:[{issueCodes:['REQUIRED_UNCONNECTED'],moduleId:'lane',interfaceId:'data'}],moduleIds:['lane'],description:'source driver pending',evidenceIds:['e'],targets:[{kind:'interface',moduleId:'lane',itemId:'data'}]}]};
  const issues=validateModel(m);assert.equal(issues.filter(i=>i.code==='REQUIRED_UNCONNECTED'&&i.causeIds?.includes('driver_gap')&&i.evidenceIds?.includes('e')).length,256);assert.ok(issues.some(i=>i.code==='PARTIAL_MODEL'));assert.ok(!issues.some(i=>i.code==='INCOMPLETE_COVERAGE'));assert.equal(moduleDocument(m,'lane').provenance?.evidence.length,1);
  m.provenance.evidence[0].targets![0].itemId='missing';assert.ok(validateModel(m).some(i=>i.code==='EVIDENCE_REFERENCE'&&i.blocks.includes('commit')));
 });
 await check('evidence reads are bound to current or candidate hashes and stale candidate evidence never silently rebases',async()=>{
  const workspace=join(dir,'evidence-project');await atomicWrite(join(workspace,'rtl/a.sv'),'// evidence\n');const m=structuredClone(arrayModel);m.provenance={origin:'as_built',fidelity:'partial',scope:'test',configuration:'test',sourceDigest:'a'.repeat(64),coverage:{elaboratedInstances:257,representedInstances:257},evidence:[{id:'e',file:'rtl/a.sv',fileHash:createHash('sha256').update('// evidence\n').digest('hex'),sourceKind:'code'}],findings:[],verification:[],unsupportedStructures:[]};await atomicWrite(join(workspace,'architecture/model.json'),JSON.stringify(m));
  const repo=new Repository(workspace),before=await repo.getModel();assert.equal((await repo.getEvidence({id:'e',modelHash:before.modelHash})).matches,true);
  const proposal:Proposal={baseHash:before.modelHash,reason:'candidate evidence',commands:[{op:'rename_module',moduleId:'lane',name:'new name'}]},preview=await repo.preview(proposal);assert.equal((await repo.getEvidence({id:'e',modelHash:preview.candidateHash,proposal})).matches,true);
  await assert.rejects(repo.getEvidence({id:'e',modelHash:before.modelHash,proposal}),{status:409});await repo.commit({proposal,candidateHash:preview.candidateHash});await assert.rejects(repo.getEvidence({id:'e',modelHash:preview.candidateHash,proposal}),{status:409});
 });
 await check('stage-specific inventory distinguishes compile inputs from missing simulation assets without claiming execution',async()=>{
  const result=await sourceInventory(dir,{top:'top',configuration:'default',parameters:{},defines:[],includeDirs:[],files:['rtl/source.sv'],assets:[{path:'missing.mem',stages:['simulation']}]});
  assert.equal(result.inputsAvailable,false);assert.equal(result.compileInputsAvailable,true);assert.equal(result.simulationInputsAvailable,false);
 });
 await check('candidate comparison and indexed offline context never start a service or change the commit base',async()=>{
  const beforeFile=join(dir,'a.json'),afterFile=join(dir,'b.json');await writeFile(beforeFile,JSON.stringify(arrayModel));const after=structuredClone(arrayModel);after.modules[1].name='renamed';await writeFile(afterFile,JSON.stringify(after));
  const result=JSON.parse((await promisify(execFile)(resolve('bin/rtlarch'),['compare',beforeFile,afterFile,'--json'])).stdout);assert.equal(result.readOnly,true);assert.ok(result.diff.some((d:{target:string})=>d.target==='lane.name'));
  const context=JSON.parse((await promisify(execFile)(resolve('bin/rtlarch'),['context','lane','--index','123','--offline','--workspace',join(dir,'project'),'--json'])).stdout);assert.equal(context.instance.parameters.OFFSET,999);
  await assert.rejects(readFile(join(dir,'project','.rtlarch/service.json')),{code:'ENOENT'});
 });
 console.log(`完成 ${checks} 项探索体验检查。`);
}finally{await rm(dir,{recursive:true,force:true})}
