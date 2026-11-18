import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,cp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {evaluateStudy,studySchema,type Study,type StudyOption} from '../src/core/studies';
import {memoryConstraint,portKindSchema} from '../src/core/studyConstraints';
import {hashValue} from '../src/core/export';
import {workbenchSchema} from '../src/core/workbench';
import {Repository} from '../src/workspace/repository';
const root=await mkdtemp(join(tmpdir(),'rtlarch-storage-budget-'));let checks=0;
const check=async(name:string,fn:()=>unknown)=>{await fn();console.log(`PASS ${++checks}: ${name}`);};
const fixture=async(name:string):Promise<Study>=>studySchema.parse(JSON.parse(await readFile(`examples/storage-budget/${name}.json`,'utf8')));
const result=(s:Study)=>evaluateStudy(s).options[0];
try{
 await check('legacy inputs and workbench hash stay unchanged, old lower-bound numbers remain exact',()=>{
  const old:Study={id:'old',title:'old',modelHash:'0'.repeat(64),moduleIds:['top'],configuration:'legacy',assumptions:['independent'],workItems:10,options:['a','b'].map((id,i)=>({id,label:id,compute:{lanes:i+1,operationsPerItem:3,cyclesPerOperation:1,overheadCycles:2},memory:{words:8,width:16,copies:2,readsPerItem:1,writesPerItem:1,readPorts:1,writePorts:1},flow:{producedPerCycle:2,maxStallCycles:3,inFlight:4,capacity:9},runIds:[]}))};
  const w={schemaVersion:1,threads:[],checkpoint:null,studies:[old]},serialized=JSON.stringify(w),r=evaluateStudy(old);
  assert.deepEqual(workbenchSchema.parse(w),w);assert.equal(hashValue(workbenchSchema.parse(w)),hashValue(w));assert.equal(JSON.stringify(w),serialized);
  assert.deepEqual(r.options.map(o=>[o.computeII,o.memoryII,o.intervalLowerBound,o.cyclesLowerBound,o.storageBits,o.requiredCapacity,o.capacitySufficient]),[[3,1,3,32,256,10,false],[1.5,1,1.5,17,256,10,false]]);
  assert(r.options.every(o=>!('feasible' in o)&&o.scheduleStatus==='not_proven'));assert(!('timing' in old.options[0].compute));
 });
 await check('three-cycle pipelined latency differs from three-cycle exclusive occupancy; II is separate',async()=>{
  const s=await fixture('operation-timing'),r=evaluateStudy(s).options;
  assert.deepEqual(r.map(o=>o.computeII),[1,3]);assert.deepEqual(r.map(o=>o.constraints.resource.resultWindowLowerBound),[10,24]);
  assert.equal(r[0].constraints.resource.traceStatus,'no_conflict_in_declared_trace');assert.equal(r[1].constraints.resource.issues[0].code,'RESOURCE_OCCUPIED');
  s.options[0].compute.timing!.initiationInterval=3;const separated=result(s);assert.equal(separated.computeII,3);assert.equal(separated.constraints.resource.occupancyCycles,1);assert.equal(separated.constraints.resource.issues[0].code,'INITIATION_INTERVAL');
  s.options[0].compute.timing!.latencyCycles=99;assert.equal(result(s).computeII,3);
  s.options[0].compute.timing!.initiationInterval=null;assert.equal(result(s).constraints.resource.traceStatus,'unknown');
 });
 await check('shared R/W, independent 1R1W and 2RW obey an independent exhaustive port allocator',async()=>{
  // Exhaustively assign small request sets to explicit capable ports, unrelated to bound formula.
  const allocate=(requests:string[],ports:string[]):boolean=>!requests.length||ports.some((p,i)=>p.includes(requests[0])&&allocate(requests.slice(1),ports.filter((_,j)=>j!==i)));
  for(const kind of portKindSchema.options)for(let reads=0;reads<=4;reads++)for(let writes=0;writes<=4;writes++){
   const requests=[...Array(reads).fill('R'),...Array(writes).fill('W')],ports=kind==='shared_rw'?['RW']:kind==='independent_1r1w'?['R','W']:['RW','RW'];
   const report=memoryConstraint({kind,bankIds:['b'],readLatencyCycles:1,sameAddressReadWrite:'old_data',mapping:requests.map((_,i)=>({address:i,bank:'b',word:i}))},requests.map((r,i)=>({id:`a${i}`,cycle:0,kind:r==='R'?'read':'write',address:i})));
   assert.equal(report.issues.some(i=>i.code==='BANK_PORT_CONFLICT'),!allocate(requests,ports),`${kind} R${reads} W${writes}`);
  }
  const s=await fixture('shared-ram'),r=evaluateStudy(s).options;assert.deepEqual(r.map(o=>o.memoryII),[2,1]);assert.deepEqual(r.map(o=>o.cyclesLowerBound),[16,8]);assert.equal(r[0].constraints.memory.trace!.status,'conflict');assert.equal(r[1].constraints.memory.trace!.status,'no_conflict_in_declared_trace');
 });
 await check('identical aggregate ports cannot hide same-bank conflicts; every access ID is retained',async()=>{
  const s=await fixture('bank-conflict'),r=evaluateStudy(s).options;
  assert.deepEqual(r.map(o=>o.memoryII),[1,1]);assert.equal(r[0].constraints.memory.trace!.issues[0].code,'BANK_PORT_CONFLICT');assert.equal(r[1].constraints.memory.trace!.status,'no_conflict_in_declared_trace');
  for(const [i,o] of r.entries()){const m=s.options[i].memory!;assert('organization' in m);assert.deepEqual(o.constraints.memory.trace!.rows.map(a=>a.id).sort(),m.accesses!.map(a=>a.id).sort());}
 });
 await check('physical word aliases, read latency, read-during-write and unknown boundaries stay explicit',async()=>{
  const s=await fixture('shared-ram');s.options[0]=structuredClone(s.options[1]);s.options[0].id='a';const m=s.options[0].memory!;assert('organization' in m);
  m.accesses=m.accesses!.slice(0,2);m.organization.mapping[1].word=0; // Different logical addresses, same physical word.
  for(const mode of ['old_data','new_data','no_change','unknown','forbidden'] as const){m.organization.sameAddressReadWrite=mode;const trace=result(s).constraints.memory.trace!;
   assert.equal(trace.rows.find(a=>a.kind==='read')!.readValue,mode==='forbidden'?'unresolved_conflict':mode);
   assert.equal(trace.status,mode==='unknown'?'unknown':mode==='forbidden'?'conflict':'no_conflict_in_declared_trace');
   assert.equal(trace.rows.find(a=>a.kind==='read')!.readVisibleCycle,mode==='no_change'||mode==='forbidden'?null:1);
  }
  m.organization.sameAddressReadWrite='old_data';m.organization.readLatencyCycles=null;assert(result(s).constraints.memory.trace!.unknowns.some(i=>i.code==='READ_LATENCY_UNKNOWN'));
  m.organization.readLatencyCycles=2;m.accesses![0].address=999;assert.equal(result(s).constraints.memory.trace!.status,'unknown');assert.equal(result(s).constraints.memory.trace!.rows[0].bank,null);
  m.accesses![1].kind='read';const uncertain=result(s).constraints.memory.trace!;assert.equal(uncertain.rows[1].portStatus,'unknown');assert.equal(uncertain.rows[1].readVisibleCycle,null,'unmapped peer may conflict; known address must not imply an accepted read');
  m.accesses![0].address=0;m.accesses![0].kind='write';m.accesses![1].kind='write';m.organization.kind='true_dual_2rw';assert(result(s).constraints.memory.trace!.issues.some(i=>i.code==='SAME_WORD_WRITES'));
 });
 await check('feedback distance creates a separate recurrence bound, unknown never becomes zero latency',async()=>{
  const s=await fixture('feedback-flow'),o=result(s);assert.equal(o.constraints.recurrence.intervalLowerBound,1.5);assert.equal(o.integerIILowerBound,2);
  s.options[0].feedback![0].distance=1;assert.equal(result(s).intervalLowerBound,3);s.options[0].feedback![0].latencyCycles=null;assert.equal(result(s).constraints.recurrence.status,'unknown');assert.equal(result(s).constraints.recurrence.intervalLowerBound,null);
  s.options[0].feedback![0].distance=0;assert.throws(()=>evaluateStudy(s));
 });
 await check('8 GB/s arrival versus 6 GB/s drain rejects every finite FIFO despite a passing stall budget',async()=>{
  const s=await fixture('feedback-flow');for(const capacity of [0,16,1000000,1e9]){s.options[0].flow!.capacity=capacity;const o=result(s);assert.equal(o.constraints.capacity.sustained.status,'unbounded_growth');assert.equal(o.constraints.capacity.sustained.finiteCapacitySupportsLongTerm,false);assert.equal(o.constraints.capacity.sustained.timeToFill,capacity*4/2e9);if(capacity>=16)assert.equal(o.capacitySufficient,true);}
  const f=s.options[0].flow!.sustained!;f.consumption=8e9;assert.equal(result(s).constraints.capacity.sustained.status,'balanced_rates');assert.equal(result(s).constraints.capacity.sustained.finiteCapacitySupportsLongTerm,null);
  f.consumption=9e9;assert.equal(result(s).constraints.capacity.sustained.status,'rate_headroom');f.consumption=null;assert.equal(result(s).constraints.capacity.sustained.status,'unknown');
  s.options[0].flow!.sustained={unit:'items_per_cycle',arrival:0.5,consumption:0.25};assert.equal(result(s).constraints.capacity.sustained.netGrowth,0.25);
 });
 await check('invalid maps, resource identity, duplicate IDs, unsupported types and numeric overflow fail',async()=>{
  const s=await fixture('shared-ram');const fail=(change:(s:Study)=>void)=>{const c=structuredClone(s);change(c);assert.throws(()=>evaluateStudy(c));};
  fail(c=>{c.options[0].compute.launches![0].lane=1;});fail(c=>{c.options[0].compute.launches![1].id='op0';});fail(c=>{c.options[0].compute.launches![0].cycle=4096;});
  fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.bankIds.push('ram0');});
  fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.mapping[0].bank='missing';});
  fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.mapping[0].word=16;});
  fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.mapping.push({...m.organization.mapping[0]});});
  fail(c=>{const m=c.options[0].memory!;assert('organization' in m);(m.organization as any).kind='arbitrary_multiport';});
  fail(c=>{c.workItems=1e9;c.options[0].compute.operationsPerItem=1e9;});
  fail(c=>{c.options[0].memory!.copies=2;});
  fail(c=>{c.options[0].memory!.words=1e9;c.options[0].memory!.width=1e9;});
 });
 await check('maximum finite request sets terminate with grouped diagnostics and complete membership',async()=>{
  const s=await fixture('shared-ram'),m=s.options[0].memory!;assert('organization' in m);
  m.accesses=Array.from({length:512},(_,i)=>({id:`write${i}`,cycle:0,kind:'write',address:0}));s.options[0].compute.launches=Array.from({length:256},(_,i)=>({id:`op${i}`,cycle:0,lane:0}));
  const r=result(s);assert.equal(r.constraints.memory.trace!.rows.length,512);assert.equal(r.constraints.memory.trace!.issues.length,2);assert.equal(r.constraints.memory.trace!.issues[1].members.length,512);assert.equal(r.constraints.resource.rows.length,256);assert.equal(r.constraints.resource.issues.length,255);assert(JSON.stringify(r).length<500000);
  m.accesses.push({...m.accesses[0],id:'overflow'});assert.throws(()=>evaluateStudy(s));
 });
 await check('CLI and core return identical calculation and explanation without workspace writes',async()=>{
  const before=await readdir(root);
  for(const name of ['shared-ram','operation-timing','bank-conflict','feedback-flow']){
   const parsed=JSON.parse(execFileSync(resolve('bin/rtlarch'),['study',resolve(`examples/storage-budget/${name}.json`),'--json'],{cwd:root,encoding:'utf8'}));assert(parsed.ok);delete parsed.ok;delete parsed.toolVersion;
   assert.deepEqual(parsed,evaluateStudy(await fixture(name)));
  }
  assert.deepEqual(await readdir(root),before);
 });
 await check('saved budgets round-trip without defaults and preserve approved temporary hardware bytes',async()=>{
  const dir=join(root,'workspace');await mkdir(join(dir,'architecture'),{recursive:true});await cp('examples/packet-pipeline/model.json',join(dir,'architecture/model.json'));
  const repo=new Repository(dir),base=await repo.getModel();for(const m of base.model.modules)await repo.reviewModule({modelHash:base.modelHash,moduleId:m.id,reviewer:'temporary budget fixture'});await repo.review({modelHash:base.modelHash,reviewer:'temporary budget fixture'});
  const names=['model.json','review.json','module-reviews.json'],bytes=await Promise.all(names.map(n=>readFile(join(dir,'architecture',n))));const s=await fixture('shared-ram');s.modelHash=base.modelHash;s.moduleIds=[base.model.design.top];
  const old=await repo.getWorkbench();await repo.updateWorkbench({baseHash:old.workbenchHash,action:{kind:'study',study:s}});assert.deepEqual((await new Repository(dir).getWorkbench()).workbench.studies[0],s);
  for(const [i,n] of names.entries())assert.deepEqual(await readFile(join(dir,'architecture',n)),bytes[i]);assert.equal((await repo.getModel()).reviewStatus,'APPROVED');
  await assert.rejects(repo.updateWorkbench({baseHash:(await repo.getWorkbench()).workbenchHash,action:{kind:'study',study:s}}));
 });
 console.log(`完成 ${checks} 组有限资源与存储预算检查；非 RTL 调度、仿真或性能证明。`);
}finally{await rm(root,{recursive:true,force:true});}
