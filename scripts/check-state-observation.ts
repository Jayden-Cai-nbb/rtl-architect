import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BitFunctions} from '../src/core/bitFunctions';
import {compareState,observeState,stateInventory,type Definition} from '../src/core/stateObservation';
import {modelSchema,type Model,type SignalValue,type StateUpdate} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {stateUpdateReads,localSignalAnalysis} from '../src/core/signals';
import {resolveEndpoint} from '../src/core/endpoints';
import {renderChecks} from '../src/workspace/contractChecks';
import {Repository} from '../src/workspace/repository';
import {runVerification} from '../src/workspace/verification';
import {runStateObservation,evaluateStateObservation,latestStateObservation} from '../src/workspace/stateObservation';
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
 await check('approval after comparison cannot upgrade a saved draft basis; a new comparison can bind it',async()=>{
  const intent=structuredClone(base);intent.provenance={origin:'design',fidelity:'exact',scope:'Independent temporary state-update intent',configuration:'DATA_W=8 CONST=3',sourceDigest:'0'.repeat(64),coverage:{elaboratedInstances:1,representedInstances:1},evidence:[],findings:[],unsupportedStructures:[],verification:[]};intent.localSignals!.forEach(l=>l.evidenceIds=[]);
  await writeFile(join(workspace,'architecture/model.json'),json(intent));const r=await runVerification(workspace,profile),manifest={...mapping,runId:r.id};const draft=await runStateObservation(workspace,manifest);assert.equal(draft.basis.kind,'unreviewed_design');
  const repo=new Repository(workspace),hash=modelHash(intent);await repo.reviewModule({moduleId:'top',modelHash:hash,reviewer:'isolated maintenance fixture'});await repo.review({modelHash:hash,reviewer:'isolated maintenance fixture'});
  assert.equal((await latestStateObservation(workspace,hash)).basis!.kind,'unknown');assert.equal((await runStateObservation(workspace,manifest)).basis.kind,'approved_intent');
 });
 console.log(json({groups,passed:true,scope:'Actual Yosys proc; bounded Boolean single-step functions, explicit witnesses and UNKNOWN boundaries; no sequential reachability or full RTL equivalence.'}));
}finally{if(process.env.RTLARCH_KEEP_STATE_OBSERVATION)console.log('kept '+root);else await rm(root,{recursive:true,force:true});}
