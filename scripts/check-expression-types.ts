import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {modelSchema,signalValueSchema,type SignalValue,type Model} from '../src/core/schema';
import {localSignalAnalysis,stateUpdateReads,signalReads,signalText} from '../src/core/signals';
import {resolveEndpoint} from '../src/core/endpoints';
import {modelHash} from '../src/core/export';
import {validateModel} from '../src/core/engine';
import {BitFunctions} from '../src/core/bitFunctions';
import {compareState,type Definition,type StateMapping} from '../src/core/stateObservation';
import {dependencyRoles} from '../src/core/hardwareView';
import {generateChecks,renderChecks,type CheckBindings} from '../src/workspace/contractChecks';
import {runVerification} from '../src/workspace/verification';
import {runStateObservation,latestStateObservation} from '../src/workspace/stateObservation';
import {prepareDiagram} from '../src/web/graph/prepareDiagram';
import {diagramQuality} from '../src/web/graph/quality';
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
