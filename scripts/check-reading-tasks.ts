import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {modelSchema,layoutSchema,type Model,type ScopeLayout} from '../src/core/schema';
import {hashValue,modelHash} from '../src/core/export';
import {prepareDiagram} from '../src/web/graph/prepareDiagram';
import {scopeDiagram,type ScopeDiagram} from '../src/web/graph/scopeDiagram';
import {readingConstraints} from '../src/web/graph/readingConstraints';
import type {RelationMember} from '../src/web/graph/readingProjection';
import {Repository} from '../src/workspace/repository';
import {validateModel} from '../src/core/engine';
import {diagramQuality} from '../src/web/graph/quality';
import {diagramSvg} from '../src/web/graph/exportSvg';
import {highlightDiagram} from '../src/web/graph/selection';
import {architecturePattern} from './architecture-patterns';
import type {ReadingTask} from '../src/core/readingProjection';

function assertLedger(model:Model,scope:string,graph:ScopeDiagram){
 const full=scopeDiagram(model,scope,{mode:graph.mode,showLocals:true,showState:true,showAuxiliary:true,measureOnly:true});
 const original=new Map(full.edges.map(e=>[e.id,e]));
 const members=[...graph.edges.flatMap(e=>e.data?.relationMembers as RelationMember[]??[]),...Object.values(graph.projection!.internal).flat(),...graph.projection!.auxiliary];
 assert.deepEqual(members.map(m=>m.id).sort(),[...original.keys()].sort(),'every original relation exactly once');
 for(const m of members){
  const e=original.get(m.id)!;
  assert.deepEqual([m.source,m.target,m.sourceHandle,m.targetHandle,m.label,m.category,m.semanticKind],
   [e.source,e.target,e.sourceHandle,e.targetHandle,e.label??'',e.data?.category??'other',e.data?.semanticKind]);
  assert.deepEqual(m.connectionIds,(e.data?.connectionIds as string[]|undefined)??[]);
  assert.deepEqual(m.connections,m.connectionIds.map(id=>model.connections.find(l=>l.id===id)));
  assert.deepEqual(m.dependencyEndpoints,e.data?.dependencyEndpoints??[]);
 }
 for(const e of graph.edges){
  const visible=e.data?.relationMembers as RelationMember[];
  assert(visible.every(m=>m.label===visible[0].label));
  assert.equal(e.label,visible[0].label+(visible.length>1?` · ${visible.length} 关系`:''));
 }
 const originalNodes=full.nodes.filter(n=>!n.data.boundary);
 assert.deepEqual(graph.nodes.filter(n=>!n.data.boundary).flatMap(n=>n.data.memberIds as string[]).sort(),originalNodes.map(n=>n.id).sort());
 for(const n of originalNodes.filter(n=>graph.projection!.nodeFor[n.id]===n.id)){
  const visible=graph.nodes.find(m=>m.id===n.id)!;
  assert.deepEqual([visible.data.label,visible.data.kind],[n.data.label,n.data.kind],'single visible member keeps its identity');
 }
 return members;
}

const reports=[];
for(const example of ['typed-expressions','external-axis']){
 const file=`examples/${example}/architecture/model.json`,bytes=await readFile(file,'utf8'),model=modelSchema.parse(JSON.parse(bytes)),hash=modelHash(model);
 let layout;try{layout=layoutSchema.parse(JSON.parse(await readFile(`examples/${example}/architecture/layout.json`,'utf8')))}catch{}
 for(const scope of model.modules.filter(m=>m.id===model.design.top||m.kind==='subsystem').map(m=>m.id)){
 const states=model.localSignals?.filter(s=>s.scope===scope&&s.driver.kind==='register')??[];
 for(const task of [{kind:'overview' as const},...states.slice(0,1).map(s=>({kind:'state' as const,stateId:s.id}))]){
 const start=performance.now(),{graph,positions}=await prepareDiagram(model,scope,hash,layout?.scopes[scope],{task}),elapsedMs=performance.now()-start,q=diagramQuality(graph);
 assert.equal(q.structuralFidelity.status,'passed',JSON.stringify(q.structuralFidelity));assert.equal(q.status,'passed',JSON.stringify(q));
 const full=scopeDiagram(model,scope,{showLocals:true,showState:true,showAuxiliary:true,measureOnly:true});
 const members=assertLedger(model,scope,graph);
 assert(graph.semantics.issues.some(i=>i.code==='PARTIAL_MODEL'));
 for(const n of graph.nodes){const selected=highlightDiagram(graph,n.id);assert.deepEqual(selected.nodes.map(n=>[n.id,n.position,n.data.geometry]),graph.nodes.map(n=>[n.id,n.position,n.data.geometry]));assert.deepEqual(selected.edges.map(e=>e.data?.routePoints),graph.edges.map(e=>e.data?.routePoints));}
 assert.equal(modelHash(model),hash);assert.equal(await readFile(file,'utf8'),bytes);
 const svg=diagramSvg(model,scope,{task,positions},hash,graph);assert(svg.includes('reading-projection'));
 const report={example,scope,task,hash,nodes:graph.nodes.filter(n=>!n.data.boundary).length,edges:graph.edges.length,retainedRelations:members.length,elapsedMs,quality:q};reports.push(report);
 console.log(JSON.stringify({example,scope,task,nodes:report.nodes,edges:report.edges,crossings:q.crossings,hidden:q.hiddenLabels.length,elapsedMs}));
 if(process.env.RTLARCH_READING_EVIDENCE)await writeFile(`${process.env.RTLARCH_READING_EVIDENCE}/${example}-${scope}-${task.kind}.svg`,svg);
 const expanded={...task,expanded:graph.projection!.groups.map(g=>g.id)};
 const expandedGraph=scopeDiagram(model,scope,{task:expanded,reading:layout?.scopes[scope]?.reading,measureOnly:true});assert.equal(expandedGraph.nodes.filter(n=>!n.data.boundary).length,full.nodes.filter(n=>!n.data.boundary).length);
 }
 }
}
if(process.env.RTLARCH_READING_EVIDENCE)await writeFile(`${process.env.RTLARCH_READING_EVIDENCE}/after.json`,JSON.stringify(reports,null,2)+'\n');
console.log('PASS reading tasks: exact membership, original labels and endpoints, stable selection, expansion, hashes and geometry');

type Reading=NonNullable<ScopeLayout['reading']>;
const saved=(reading:Reading):ScopeLayout=>({reading,positions:{},viewport:{x:0,y:0,zoom:1}});
const measurements=[];
const overviewLimits={
 accumulator:{nodes:2,edges:5,folded:1,crossings:2,hidden:0,longest:1287},
 fifo:{nodes:2,edges:10,folded:4,crossings:12,hidden:1,longest:1500.5},
 shared_ram:{nodes:2,edges:11,folded:1,crossings:0,hidden:0,longest:1466},
};
const measure=async(model:Model,reading:Reading,task?:ReadingTask)=>{
 const hash=modelHash(model),start=performance.now();
 const prepared=await prepareDiagram(model,'top',hash,saved(reading),{task});
 const generatedMs=performance.now()-start,{graph}=prepared,q=diagramQuality(graph);
 const body=graph.nodes.filter(n=>!n.data.boundary);
 const metrics={nodes:body.length,edges:graph.edges.length,crossings:q.crossings,hidden:q.hiddenLabels.length,
  longest:q.maxRouteLength,wireLength:q.wireLength,generatedMs,dispositions:q.readingConstraints.constraints};
 assert(Number.isFinite(generatedMs)&&generatedMs>=0);
 assert.equal(prepared.readingSource,'explicit');
 assert.equal(q.structuralFidelity.status,'passed');
 assert.equal(q.status,'passed',JSON.stringify({overlaps:q.overlaps,nodeHits:q.nodeHits,unrouted:q.unrouted}));
 assert.equal(modelHash(model),hash);
 if(task)assertLedger(model,'top',graph);
 assert.deepEqual(q.readingConstraints.constraints.map(r=>[r.kind,r.index,r.original]),
  readingConstraints(reading).map(r=>[r.kind,r.index,r.original]),'every original constraint gets a disposition');
 return {...prepared,q,body,metrics};
};
const local=(id:string)=>`local:top:${id}`;
for(const id of ['accumulator','fifo','shared_ram','fork_join','arbiter','pipeline'] as const){
 const {model,reading,question}=await architecturePattern(id);
 const modelBytes=JSON.stringify(model),readingDigest=hashValue(reading);
 const full=await measure(model,reading),overview=await measure(model,reading,{kind:'overview'});
 const {graph,q}=overview;
 const dispositions=q.readingConstraints.constraints;
 const constraint=(kind:typeof dispositions[number]['kind'])=>dispositions.find(c=>c.kind===kind)!;
 assert.equal(full.q.readingConstraints.status,'satisfied',JSON.stringify(full.q.readingConstraints.issues));
 assert.equal(q.readingConstraints.status,'satisfied',JSON.stringify(q.readingConstraints.issues));
 assert.equal(constraint('mainPath').status,'applied');
 if(id==='accumulator'||id==='fifo'||id==='shared_ram'){
  const limit=overviewLimits[id],metrics=overview.metrics,projection=graph.projection!;
  const folded=projection.auxiliary.length+Object.values(projection.internal).flat().length;
  assert.deepEqual([metrics.nodes,metrics.edges,folded],[limit.nodes,limit.edges,limit.folded],'preserve the measured overview topology and fold count');
  assert(metrics.crossings<=limit.crossings&&metrics.hidden<=limit.hidden&&metrics.longest<=limit.longest,JSON.stringify(metrics));
 }
 const readingSvg=diagramSvg(model,'top',{task:{kind:'overview'},reading},modelHash(model),graph);
 assert(readingSvg.includes('id="reading-constraints"'));
 if(id==='accumulator'){
  assert.deepEqual(graph.reading?.mainPath,[local('sum'),local('q')]);
  assert.equal(graph.nodes.find(n=>n.id===local('q'))?.data.label,'累加寄存器');
  const returned=graph.edges.filter(e=>constraint('feedback').edges?.includes(e.id));
  assert.equal(returned.length,1);
  assert.deepEqual([returned[0].source,returned[0].target,returned[0].data?.readingFeedback],[local('q'),local('sum'),'bottom']);
  assert(!q.hiddenLabels.includes(returned[0].id));
  const adjacent={...reading, mainPath:[local('sum')],adjacent:[{node:local('q'),anchor:local('sum')}]};
  const view=await measure(model,adjacent,{kind:'overview'});
  assert.equal(view.q.readingConstraints.constraints.find(c=>c.kind==='adjacent')?.status,'applied');
  assert.equal(view.q.readingConstraints.status,'satisfied');
  const folded=await measure(model,{...reading,stages:[{id:'accumulate',label:'本次累加',nodes:[local('sum'),local('q')]}]},{kind:'overview'});
  assert.equal(folded.q.readingConstraints.constraints.find(c=>c.kind==='feedback')?.status,'internal_to_group');
  assert(Object.values(folded.graph.projection!.internal).flat().some(m=>m.source===local('q')&&m.target===local('sum')));
 }
 if(id==='fifo'){
  assert.equal(constraint('parallel').status,'internal_to_group');
  assert.equal(constraint('feedback').status,'applied');
  const feedback=graph.edges.find(e=>constraint('feedback').edges?.includes(e.id))!;
  assert((feedback.data!.relationMembers as RelationMember[]).every(m=>m.source===local('full')&&m.target===local('accept')));
  assert(!graph.edges.some(e=>(e.data?.relationMembers as RelationMember[]).some(m=>m.semanticKind==='ready_valid')),'signal names cannot imply a protocol');
  assert(!readingSvg.includes('RV 的 data/valid 正向'),'the export only lists protocols declared in the model');
  const task={kind:'state',stateId:'data_q'} as const;
  assert.equal(model.localSignals!.filter(n=>n.driver.kind==='register')[1].id,task.stateId);
  const state=await measure(model,reading,task);
  assert(state.graph.projection!.focus.includes(local(task.stateId)));
  assert.equal(state.graph.nodes.find(n=>n.id===local(task.stateId))?.data.label,'槽数据寄存器');
  assert.deepEqual([state.metrics.nodes,state.metrics.edges],[4,11]);
  assert.equal(state.q.readingConstraints.constraints.find(c=>c.kind==='parallel')?.status,'applied');
  assert.equal(state.q.readingConstraints.status,'satisfied');
  measurements.push({id,view:task,metrics:state.metrics});
  const outside=await measure(model,{...reading,control:[local('visible')]},task);
  assert.equal(outside.q.readingConstraints.constraints.find(c=>c.kind==='control')?.status,'not_applicable');
  const cyclic=await measure(model,{...reading,mainPath:[local('accept'),local('data_q'),local('visible')]},{kind:'overview'});
  assert.equal(cyclic.q.readingConstraints.constraints.find(c=>c.kind==='mainPath')?.status,'unsupported');
  assert.equal(cyclic.q.readingConstraints.status,'needs_attention');
 }
 if(id==='shared_ram'){
  assert.equal(constraint('shared').status,'applied');
  assert.equal(constraint('parallel').status,'internal_to_group');
  const reader=graph.projection!.nodeFor.reader_a;
  assert.equal(reader,graph.projection!.nodeFor.reader_b);
  assert.deepEqual(graph.reading?.shared,[{node:'store',clients:[reader]}]);
  assert.equal(graph.nodes.filter(n=>n.data.kind==='memory').length,1);
  const reads=graph.edges.filter(e=>e.source===reader&&e.target==='store'||e.source==='store'&&e.target===reader);
  assert.equal(reads.length,4);
  assert(reads.every(e=>!q.hiddenLabels.includes(e.id)),'both original requests and responses should have visible names');
 }
 if(id==='fork_join'){
  assert.equal(constraint('parallel').status,'internal_to_group');
  const expanded=await measure(model,reading,{kind:'overview',expanded:graph.projection!.groups.map(g=>g.id)});
  assert.equal(expanded.q.readingConstraints.constraints.find(c=>c.kind==='parallel')?.status,'applied');
  assert.equal(expanded.q.readingConstraints.status,'satisfied');
  assert.equal(expanded.positions.left.x,expanded.positions.right.x);
  assert(expanded.positions.left.y<expanded.positions.right.y);
 }
 if(id==='arbiter'){
  assert.equal(constraint('control').status,'applied');
  const target=graph.projection!.nodeFor.client_b;
  const grants=graph.edges.filter(e=>e.source==='choose'&&e.target===target);
  assert.equal(grants.length,2);
  assert.equal(grants.filter(e=>e.data?.readingFeedback==='top').length,1);
  assert.equal((grants.find(e=>e.data?.readingFeedback)?.data?.relationMembers as RelationMember[])[0].target,'client_b');
 }
 if(id==='pipeline'){
  assert.equal(graph.nodes.find(n=>n.id==='first')?.data.label,'输入寄存级');
  assert.equal(graph.nodes.find(n=>n.id==='first')?.data.kind,'module');
  assert.equal(graph.nodes.filter(n=>n.data.kind==='region').length,2);
 }
 assert.equal(JSON.stringify(model),modelBytes);
 assert.equal(hashValue(reading),readingDigest);
 measurements.push({id,question,hash:modelHash(model),readingDigest,full:full.metrics,overview:overview.metrics});
 console.log(JSON.stringify({id,full:full.metrics,overview:overview.metrics}));
}

// Exercise the offline CLI with a saved plan, including the read-only approval view.
const workspace=await mkdtemp(join(tmpdir(),'rtlarch-reading-tasks-'));
try{
 const {model,reading}=await architecturePattern('shared_ram');
 const modelFile=join(workspace,'architecture/model.json'),layoutFile=join(workspace,'architecture/layout.json');
 await mkdir(join(workspace,'architecture'));
 const modelBytes=JSON.stringify(model),layoutBytes=JSON.stringify({schemaVersion:1,scopes:{top:saved(reading)}});
 await writeFile(modelFile,modelBytes);
 await writeFile(layoutFile,layoutBytes);
 const repo=new Repository(workspace),before=await repo.getModel();
 const report=JSON.parse(execFileSync(resolve('bin/rtlarch'),['diagram-quality','--task','overview','--workspace',workspace,'--json'],{encoding:'utf8'}));
 assert.equal(report.modelHash,before.modelHash);
 assert.equal(report.quality.readingConstraints.status,'satisfied');
 assert.equal(report.quality.readingConstraints.constraints.find((c:{kind:string})=>c.kind==='shared').status,'applied');
 const after=await repo.getModel();
 assert.equal(after.modelHash,before.modelHash);
 assert.equal(after.reviewStatus,before.reviewStatus);
 assert.deepEqual(after.moduleReviews,before.moduleReviews);
 assert.equal(await readFile(modelFile,'utf8'),modelBytes);
 assert.equal(await readFile(layoutFile,'utf8'),layoutBytes);

 const pathModel=structuredClone(model),provenance=pathModel.provenance!;
 const source=provenance.evidence[0].id,wire=pathModel.connections[0];
 provenance.readingTasks=[{id:'access',label:'核对存储访问',moduleId:'top',steps:[
  {id:'request',label:'定位入口地址与连接',target:{kind:'boundary',id:wire.from.interfaceId},evidenceIds:[source],connectionIds:[wire.id]},
 ]}];
 const checked=scopeDiagram(pathModel,'top',{task:{kind:'overview'}});
 assert.equal(checked.taskEvidence.status,'ready');
 const topology=checked.edges.map(edge=>[edge.id,edge.data?.routePoints]);
 const gap={id:'storage',kind:'memory',moduleIds:['top'],description:'地址化存储待表达',evidenceIds:[source]};
 provenance.unsupportedStructures.push(gap);
 provenance.readingTasks[0].steps.push({id:'read',label:'查看 RAM 证据',gapId:gap.id,evidenceIds:[source]});
 const blocked=scopeDiagram(pathModel,'top',{task:{kind:'overview'}});
 assert.equal(blocked.taskEvidence.status,'blocked');
 assert.equal(blocked.taskEvidence.tasks[0].steps[1].status,'gap');
 assert.deepEqual(blocked.edges.map(edge=>[edge.id,edge.data?.routePoints]),topology);
 assert(diagramSvg(pathModel,'top',{},modelHash(pathModel),blocked).includes('id="reading-task-evidence"'));
 provenance.readingTasks[0].steps[1].gapId='absent';
 assert(validateModel(pathModel).some(i=>i.code==='READING_TASK_REFERENCE'&&i.blocks.includes('commit')));

 const approvedRoot=join(workspace,'approved-fixture'),approvedDir=join(approvedRoot,'architecture');
 await mkdir(approvedDir,{recursive:true});
 await writeFile(join(approvedDir,'model.json'),await readFile('examples/packet-pipeline/model.json'));
 const approvedRepo=new Repository(approvedRoot),draft=await approvedRepo.getModel();
 const reviewer='temporary reading task fixture';
 for(const {id:moduleId} of draft.model.modules)await approvedRepo.reviewModule({modelHash:draft.modelHash,moduleId,reviewer});
 const approved=await approvedRepo.review({modelHash:draft.modelHash,reviewer});
 assert.equal(approved.reviewStatus,'APPROVED');
 const approvedReading={modelHash:approved.modelHash,reason:'临时批准状态回归',mainPath:['ingress','processing','egress'],control:[],adjacent:[]};
 await writeFile(join(approvedDir,'layout.json'),JSON.stringify({schemaVersion:1,scopes:{[draft.model.design.top]:saved(approvedReading)}}));
 const names=['model.json','layout.json','review.json','module-reviews.json'];
 const readAuthority=()=>Promise.all(names.map(name=>readFile(join(approvedDir,name),'utf8')));
 const authority=await readAuthority();
 const projected=JSON.parse(execFileSync(resolve('bin/rtlarch'),['diagram-quality','--task','overview','--workspace',approvedRoot,'--json'],{encoding:'utf8'}));
 assert.equal(projected.modelHash,approved.modelHash);
 assert.equal(projected.quality.readingConstraints.status,'satisfied');
 assert.equal((await approvedRepo.getModel()).reviewStatus,'APPROVED');
 assert.deepEqual(await readAuthority(),authority);
}finally{await rm(workspace,{recursive:true,force:true});}
if(process.env.RTLARCH_READING_EVIDENCE)await writeFile(`${process.env.RTLARCH_READING_EVIDENCE}/projection-constraints.json`,JSON.stringify(measurements,null,2)+'\n');
console.log('PASS projected reading constraints: feedback, shared resource, parallel and staged layouts, second state, and offline audit without writes');
