import {stateConeDiagram} from '../src/web/graph/stateConeDiagram';
import {geometryQuality} from '../src/web/graph/quality';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runVerification} from '../src/workspace/verification';
import {evaluateStateObservation} from '../src/workspace/stateObservation';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,cp,rm,writeFile} from 'node:fs/promises';
import {modelSchema,type Model} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {modelStateCone,observedStateCone,type StateCone} from '../src/core/nextStateCone';
import {stateDescription} from '../src/core/stateUpdates';
import {stateUpdateReads,signalChildren} from '../src/core/signals';
import {renderChecks} from '../src/workspace/contractChecks';
import {observeState,type Definition} from '../src/core/stateObservation';
const load=async(name:string)=>modelSchema.parse(JSON.parse(await readFile(`examples/${name}/architecture/model.json`,'utf8')));
const typed=await load('typed-expressions'),state=await load('state-updates');
function evaluate(c:StateCone,id:string,env:Record<string,bigint>):bigint{
 const n=c.nodes.find(n=>n.id===id)!,edges=c.edges.filter(e=>e.target===id),get=(role:string)=>evaluate(c,edges.find(e=>e.role===role)!.source,env);
 const args=edges.map(e=>evaluate(c,e.source,env));let v:bigint;
 if(n.kind==='Q')v=env[n.origin];
 else if(n.kind==='constant')v=BigInt(n.label);
 else if(n.kind==='endpoint')v=args[0]??env[n.label];
 else if(n.kind==='D'||n.kind==='hold')v=args[0];
 else if(n.kind==='mux'||n.kind==='reset')v=get(n.kind==='reset'?'reset / select':'condition / select')?get('data:1'):get('data:0');
 else if(n.kind==='cast'){
  const input=c.nodes.find(n=>n.id===edges[0].source)!;
  v=n.label.startsWith('sign_extend')?BigInt.asIntN(input.width!,args[0]):args[0];
 }else if(n.kind==='operator'){
  const input=c.nodes.find(n=>n.id===edges[0].source)!;
  if(n.label==='>>>')v=(input.signed?BigInt.asIntN(input.width!,args[0]):args[0])>>args[1];
  else if(n.label==='>>')v=args[0]>>args[1];
  else if(n.label==='+')v=args[0]+args[1];
  else if(n.label==='&&')v=BigInt(!!args[0]&&!!args[1]);
  else if(n.label==='||')v=BigInt(!!args[0]||!!args[1]);
  else if(n.label.startsWith('!'))v=BigInt(!args[0]);
  else throw Error(n.label);
 }else throw Error(n.kind);
 assert.notEqual(v,undefined,`${n.label} has no input`);return BigInt.asUintN(n.width!,v);
}
for(const id of ['scaled_q','packed_value_q']){
 const hash=modelHash(typed),cone=modelStateCone(typed,'top',id,hash),d=cone.nodes.find(n=>n.kind==='D')!;
 const drawing=stateConeDiagram(cone);assert(drawing.edges.every(e=>!e.data?.routingFallback));
 for(const e of drawing.edges){const pts=e.data?.routePoints as {x:number;y:number}[];for(let i=1;i<pts.length;i++)for(const n of drawing.nodes){if([e.source,e.target].includes(n.id))continue;const a=pts[i-1],b=pts[i],x=n.position.x,y=n.position.y,w=n.data.geometry.width,h=n.data.geometry.height;const hit=a.x===b.x?a.x>x&&a.x<x+w&&Math.max(a.y,b.y)>y&&Math.min(a.y,b.y)<y+h:a.y>y&&a.y<y+h&&Math.max(a.x,b.x)>x&&Math.min(a.x,b.x)<x+w;assert(!hit,`${e.id} crosses ${n.id}`);}}
 assert.equal(cone.boundaries.length,0);assert.deepEqual(cone.rules,stateDescription(typed.localSignals!.find(s=>s.id===id)!)!.rows);
 assert(cone.nodes.every(n=>n.width!==null&&n.signed!==null));
 for(let sample=0;sample<256;sample++)for(let shift=0;shift<16;shift++){
  const expected=BigInt(sample<128?sample:sample-256)>>BigInt(shift);
  const env={'top.sample':BigInt(sample),'top.shift':BigInt(shift),'top.enable':1n,'top.rst_n':1n,[`local:top:${id}`]:13n};
  assert.equal(evaluate(cone,d.id,env),BigInt.asUintN(id==='scaled_q'?12:8,expected));
  assert.equal(evaluate(cone,d.id,{...env,'top.enable':0n}),13n);assert.equal(evaluate(cone,d.id,{...env,'top.rst_n':0n}),0n);
 }
 assert.equal(modelHash(typed),hash);
 console.log(`PASS ${id}: exhaustive sign-extension → arithmetic shift${id==='packed_value_q'?' → truncate':''}, reset and hold`);
}
const hash=modelHash(state),cone=modelStateCone(state,'top','out_data',hash);
assert(cone.nodes.some(n=>n.expandState==='out_valid'));assert(!cone.nodes.some(n=>n.kind==='D'&&n.label.startsWith('out_valid')));
const expanded=modelStateCone(state,'top','out_data',hash,['out_valid']);assert(expanded.nodes.some(n=>n.kind==='D'&&n.label.startsWith('out_valid')));
assert.equal(modelHash(state),hash);
assert.equal(expanded.nodes.filter(n=>n.label==='top.local:accept').length,1);
const accept=expanded.nodes.find(n=>n.label==='top.local:accept')!;
assert.deepEqual(accept.references!.map(r=>r.consumer).sort(),['out_data','out_valid']);
assert(accept.references!.every(r=>r.role==='state_condition'));
assert.equal(expanded.edges.filter(e=>e.source===accept.id).length,2,'each consumer retains its own relationship');
const reset=expanded.nodes.find(n=>n.label==='top.rst_n')!;
assert(reset.references!.some(r=>r.consumer==='accept'&&r.role==='operand'));
assert(reset.references!.some(r=>r.consumer==='out_data'&&r.role==='state_reset'));
assert(reset.references!.some(r=>r.consumer==='out_valid'&&r.role==='state_reset'));
assert(expanded.nodes.length<35,'shared declared endpoints reduce the former 35-node expanded cone');
const sliced:Model=structuredClone(state),sliceState=sliced.localSignals!.find(s=>s.id==='out_data')!;
assert(sliceState.driver.kind==='register');
sliceState.driver.update!.branches[0].value={kind:'concat',parts:[{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'s_data',slice:{msb:7,lsb:4}}},{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'s_data',slice:{msb:3,lsb:0}}}]};
sliceState.driver.inputs=stateUpdateReads(sliceState.driver.update!);
const sliceCone=modelStateCone(sliced,'top','out_data','slice fixture');
assert.equal(sliceCone.boundaries.length,0);assert.equal(sliceCone.nodes.filter(n=>n.kind==='endpoint'&&n.label.includes('s_data')).length,2,'disjoint bit ranges are never merged');
const distinct:Model=structuredClone(state),alias=structuredClone(distinct.localSignals!.find(n=>n.id==='accept')!);alias.id='accept_alias';distinct.localSignals!.push(alias);
const valid=distinct.localSignals!.find(n=>n.id==='out_valid')!;assert(valid.driver.kind==='register');
const redirect=(value:import('../src/core/schema').SignalValue)=>{if(value.kind==='endpoint'&&value.endpoint.local&&value.endpoint.interfaceId==='accept')value.endpoint.interfaceId='accept_alias';signalChildren(value).forEach(redirect)};
valid.driver.update!.branches.forEach(b=>{redirect(b.condition);redirect(b.value)});valid.driver.inputs=stateUpdateReads(valid.driver.update!);
const distinctCone=modelStateCone(distinct,'top','out_data','separate declarations',['out_valid']);assert.equal(distinctCone.boundaries.length,0);
assert.equal(distinctCone.nodes.filter(n=>n.label==='top.local:accept'||n.label==='top.local:accept_alias').length,2,'equal ASTs in distinct declarations are not one hardware signal');

for(const graph of [stateConeDiagram(cone),stateConeDiagram(expanded)]){
 assert(graph.edges.every(e=>!e.data?.routingFallback));
 for(const a of graph.nodes)for(const b of graph.nodes)if(a.id!==b.id)assert(!(a.position.x<b.position.x+b.width!&&a.position.x+a.width!>b.position.x&&a.position.y<b.position.y+b.height!&&a.position.y+a.height!>b.position.y),'compact nodes must not overlap');
}
console.log('PASS shared endpoint identities preserve every consumer, role and bit range; compact expanded geometry');
// Check every visited AST occurrence against provenance, independently of display sharing.
function assertOrigins(model:Model,graph:StateCone,states:string[]){
 const actual=new Set(graph.nodes.flatMap(n=>[n.origin,...(n.references??[]).map(r=>r.path)])),seen=new Set<string>();
 const visit=(v:import('../src/core/schema').SignalValue,path:string)=>{assert(actual.has(path),`lost AST occurrence ${path}`);signalChildren(v).forEach((c,i)=>visit(c,`${path}/${i}`));if(v.kind==='endpoint'&&v.endpoint.local){const local=model.localSignals!.find(n=>n.id===v.endpoint.interfaceId)!;if(local.driver.kind==='comb'&&!seen.has(local.id)){seen.add(local.id);visit(local.driver.value,`local:top:${local.id}/value`);}}};
 for(const id of states){const local=model.localSignals!.find(n=>n.id===id)!;assert(local.driver.kind==='register');const u=local.driver.update!;u.branches.forEach((b,i)=>{visit(b.condition,`local:top:${id}/update/branches/${i}/condition`);visit(b.value,`local:top:${id}/update/branches/${i}/value`)});if(u.reset){visit({kind:'endpoint',endpoint:u.reset.signal},`local:top:${id}/update/reset/signal`);visit(u.reset.value,`local:top:${id}/update/reset/value`);}}
}
assertOrigins(state,expanded,['out_data','out_valid']);assertOrigins(typed,modelStateCone(typed,'top','packed_value_q',modelHash(typed)),['packed_value_q']);
console.log('PASS every declared AST occurrence remains traceable after sharing');


const priority:Model=structuredClone(state),local=priority.localSignals!.find(s=>s.id==='out_data')!;
assert(local.driver.kind==='register');const u=local.driver.update!;
u.branches=[{id:'first',condition:{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'s_valid'}},value:{kind:'constant',width:8,value:'3'}},{id:'second',condition:{kind:'constant',width:1,value:'1'},value:{kind:'constant',width:8,value:'7'}}];local.driver.inputs=stateUpdateReads(u);
const p=modelStateCone(priority,'top','out_data',modelHash(priority)),d=p.nodes.find(n=>n.kind==='D')!;
assert.equal(evaluate(p,d.id,{'top.s_valid':1n,'top.rst_n':1n,'local:top:out_data':9n}),3n);assert.equal(evaluate(p,d.id,{'top.s_valid':0n,'top.rst_n':1n,'local:top:out_data':9n}),7n);
assert.deepEqual(p.rules.map(r=>r.id),['reset','first','second','otherwise']);
const bindings=JSON.parse(await readFile('examples/state-updates/bindings.json','utf8'));assert.doesNotThrow(()=>renderChecks(priority,bindings));
console.log('PASS state-updates: explicit upstream expansion, priority and rule/checker validation');
const def:Definition={attributes:{},ports:{clk:{direction:'input',bits:[2]},a:{direction:'input',bits:[3]}},netnames:{q:{bits:[4],attributes:{}}},cells:{q:{type:'$dff',parameters:{WIDTH:1,CLK_POLARITY:1},attributes:{},port_directions:{D:'input',CLK:'input',Q:'output'},connections:{D:[5],CLK:[2],Q:[4]}},unsupported:{type:'$mul',parameters:{A_WIDTH:1,B_WIDTH:1,Y_WIDTH:1,A_SIGNED:0,B_SIGNED:0},attributes:{},port_directions:{A:'input',B:'input',Y:'output'},connections:{A:[3],B:[3],Y:[5]}}}};
const result=observeState(def,'q');assert.equal(result.status,'UNKNOWN');const negative=observedStateCone(result.observed,result.status,result.reason,'fixture observation');assert(negative.nodes.some(n=>n.kind==='boundary'&&n.detail?.includes('$mul')));assert(!negative.nodes.some(n=>n.kind==='operator'));
for(const status of ['NOT_RUN','UNKNOWN','STALE'])assert(observedStateCone(undefined,status,'缺失映射或过期','fixture').boundaries.length);
const good=structuredClone(def);good.cells.unsupported.type='$not';delete good.cells.unsupported.connections.B;delete good.cells.unsupported.port_directions!.B;
const observed=observeState(good,'q');assert.equal(observed.status,'EXTRACTED');assert(observedStateCone(observed.observed,observed.status,observed.reason,'fixture').nodes.some(n=>n.label==='$not'));
const mismatch=observedStateCone(observed.observed,'MISMATCH','单步反例仍有效','fixture');assert(mismatch.note.includes('MISMATCH'));assert(mismatch.note.includes('单步反例仍有效'));assert(mismatch.nodes.some(n=>n.label==='$not'));
console.log('PASS independent RTL observation source, unsupported unit / missing mapping / stale boundaries');
const feedback=structuredClone(good);feedback.cells.unsupported.connections.A=[4];
const feedbackObserved=observeState(feedback,'q');assert.equal(feedbackObserved.status,'EXTRACTED');
const feedbackCone=observedStateCone(feedbackObserved.observed,feedbackObserved.status,feedbackObserved.reason,'feedback fixture');
assert(feedbackCone.edges.some(e=>e.role==='old Q / data A'));assert(!feedbackCone.edges.some(e=>e.role.includes('hold Q')),'Q used by an operator is not a hold branch');
const shiftFixture=structuredClone(def);shiftFixture.cells.unsupported.type='$shr';
const shiftObserved=observeState(shiftFixture,'q');assert.equal(shiftObserved.status,'EXTRACTED');
assert(observedStateCone(shiftObserved.observed,shiftObserved.status,shiftObserved.reason,'shift fixture').edges.some(e=>e.role==='shift amount B'));
assert(observedStateCone(observed.observed,observed.status,observed.reason,'leaf fixture').boundaries.some(b=>b.includes('输入 / 上游状态')));
console.log('PASS observed old Q is not hold, shift amounts have explicit roles, leaf boundaries remain counted');


function assertRouting(c:StateCone){
 const before=JSON.stringify(c),graph=stateConeDiagram(c),q=geometryQuality(graph),base=graph.optimization.baseline;
 assert.equal(JSON.stringify(c),before,'layout must not mutate its projection');
 assert.deepEqual(graph.nodes.map(n=>n.id),c.nodes.map(n=>n.id));assert.equal(graph.edges.length,c.edges.length);
 assert.equal(q.overlaps.length+q.nodeHits.length+q.unrouted.length,0);
 for(const k of ['crossings','wireLength','maxRouteLength','unrelatedSharedLength'] as const)assert(q[k]<=base[k],`${k} must not regress`);
 graph.edges.forEach((edge,i)=>{
  const e=c.edges[i];assert.equal(edge.source,e.source);assert.equal(edge.target,e.target);assert.equal(edge.data!.role,e.role);assert.equal(edge.data!.netKey,undefined);
  const from=graph.nodes.find(n=>n.id===edge.source)!,to=graph.nodes.find(n=>n.id===edge.target)!,a=from.data.geometry.ports.find(p=>p.id===edge.sourceHandle)!,b=to.data.geometry.ports.find(p=>p.id===edge.targetHandle)!;
  assert.equal(b.label,e.role,'port sorting retains the original operand/select role');
  const pts=edge.data!.routePoints as {x:number;y:number}[];assert.deepEqual(pts[0],{x:from.position.x+a.x,y:from.position.y+a.y});assert.deepEqual(pts.at(-1),{x:to.position.x+b.x,y:to.position.y+b.y});
  pts.slice(1).forEach((p,j)=>assert(p.x===pts[j].x||p.y===pts[j].y,'each segment stays orthogonal'));
 });
 return graph;
}
for(const c of [modelStateCone(typed,'top','scaled_q',modelHash(typed)),modelStateCone(typed,'top','packed_value_q',modelHash(typed)),cone,expanded,negative])assertRouting(c);
const external=await load('external-axis');assertRouting(modelStateCone(external,'stage0','stage0_data_q',modelHash(external)));
assert.deepEqual(stateConeDiagram(expanded),stateConeDiagram(expanded),'bounded optimization is deterministic');
let seed=173;
for(let sample=0;sample<5;sample++){
 const c:StateCone={source:'model_ast',identity:'geometry-only fixture',nodes:[],edges:[],rules:[],boundaries:[],note:'no RTL meaning'};
 for(let i=0;i<12;i++){c.nodes.push({id:`g${i}`,kind:i===11?'D':'operator',label:`geometry ${i}`,width:8,signed:false,origin:`fixture/${i}`});if(i)for(let j=Math.max(0,i-3);j<i;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;if(j===i-1||seed%3===0)c.edges.push({source:`g${j}`,target:`g${i}`,role:`data:${j}`})}}
 assertRouting(c);
}
const wide:StateCone={...negative,nodes:Array.from({length:65},(_,i)=>({id:`b${i}`,kind:'boundary',label:'UNKNOWN',width:null,signed:null,origin:`budget/${i}`})),edges:[]};
assert.equal(stateConeDiagram(wide).optimization.candidates.length,1,'large cones do not multiply routing attempts');
const cyclic:StateCone={...wide,nodes:wide.nodes.slice(0,2),edges:[{source:'b0',target:'b1',role:'data'},{source:'b1',target:'b0',role:'data'}]};assert.throws(()=>stateConeDiagram(cyclic),/投影出现环/);
console.log('PASS bounded cone layout: same IDs/roles/endpoints, safe deterministic routes, no crossing/length/overlap regression, budget and cycle boundaries');

const temporary=await mkdtemp(join(tmpdir(),'rtlarch-cone-'));
try{
 for(const example of ['typed-expressions','state-updates']){
  const workspace=join(temporary,example);await cp(`examples/${example}`,workspace,{recursive:true});
  const profile=JSON.parse(await readFile(join(workspace,'elaboration.json'),'utf8')),run=await runVerification(workspace,profile);assert.equal(run.status,'passed');
  const mapping=JSON.parse(await readFile(join(workspace,'state-mapping.json'),'utf8'));mapping.runId=run.id;
  const observed=await evaluateStateObservation(workspace,mapping);
  assert(observed.results.length);for(const r of observed.results){assert.equal(r.status,'MATCH');const graph=observedStateCone(r.observed,r.status,r.reason,`${observed.modelHash}/${r.observedHash}`);assert.equal(graph.source,'rtl_observation');assert(graph.nodes.some(n=>n.kind==='D'));assert(graph.nodes.some(n=>n.kind==='Q'));}
  if(process.env.RTLARCH_CONE_EVIDENCE)await writeFile(join(process.env.RTLARCH_CONE_EVIDENCE,example+'-observed.json'),JSON.stringify(observed,null,2)+'\n');
  console.log(`PASS ${example}: fresh verify/Yosys artifact, explicit mapping, independent observed cone`);
 }
}finally{await rm(temporary,{recursive:true,force:true})}
