import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateModel } from '../../src/core/engine';
import { hashValue, modelHash } from '../../src/core/export';
import { modelStateCone, observedStateCone, type StateCone } from '../../src/core/nextStateCone';
import { type ReadingTask } from '../../src/core/readingProjection';
import { layoutSchema, type Model, modelSchema, type Proposal, type ScopeLayout, type SignalValue } from '../../src/core/schema';
import { signalChildren, stateUpdateReads } from '../../src/core/signals';
import { type Definition, observeState } from '../../src/core/stateObservation';
import { stateDescription } from '../../src/core/stateUpdates';
import { diagramSvg } from '../../src/web/graph/exportSvg';
import { routeEdges } from '../../src/web/graph/orthogonal';
import { prepareDiagram } from '../../src/web/graph/prepareDiagram';
import { diagramQuality, geometryQuality } from '../../src/web/graph/quality';
import { readingConstraints } from '../../src/web/graph/readingConstraints';
import { type RelationMember } from '../../src/web/graph/readingProjection';
import { scopeDiagram, type ScopeDiagram } from '../../src/web/graph/scopeDiagram';
import { highlightDiagram } from '../../src/web/graph/selection';
import { stateConeDiagram } from '../../src/web/graph/stateConeDiagram';
import { renderChecks } from '../../src/workspace/contractChecks';
import { Repository } from '../../src/workspace/repository';
import { evaluateStateObservation } from '../../src/workspace/stateObservation';
import { runVerification } from '../../src/workspace/verification';
import { architecturePattern, autoReadingFixture } from './fixtures';

export async function checkReadingTasks() {
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
}

export async function checkCandidateQuality() {
  const root=await mkdtemp(join(tmpdir(),'rtlarch-candidate-quality-check-'));
  let count=0;
  const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++count}: ${name}`);};
  const cli=(workspace:string,args:string[],success=true)=>{
   const result=spawnSync(resolve('bin/rtlarch'),['diagram-quality','--workspace',workspace,'--json',...args],{encoding:'utf8',maxBuffer:16*1024*1024});
   assert.equal(result.error,undefined);assert.equal(result.status,success?0:1,result.stderr+result.stdout);
   return JSON.parse(result.stdout);
  };
  try{
   await cp('examples/typed-expressions',join(root,'typed'),{recursive:true});
   const workspace=join(root,'typed'),file=join(workspace,'architecture/model.json'),bytes=await readFile(file,'utf8');
   const model=modelSchema.parse(JSON.parse(bytes)),hash=modelHash(model);
   const saved=layoutSchema.parse(JSON.parse(await readFile(join(workspace,'architecture/layout.json'),'utf8'))).scopes.top;
   await check('CLI identifies exact task/model/layout and agrees with shared preparation',async()=>{
    for(const task of [undefined,{kind:'overview' as const},{kind:'state' as const,stateId:'scaled_q'}]){
     const args=task?['--task',task.kind,...(task.kind==='state'?['--state',task.stateId]:[])]:[];
     const report=cli(workspace,args),prepared=await prepareDiagram(model,'top',hash,saved,{task});
     assert.equal(report.modelHash,hash);assert.equal(report.readOnly,true);
     assert.equal(report.view.modelSource,'saved_model');assert.equal(report.view.task.kind,task?.kind??'full');
     assert.equal(report.view.layoutSource,task?'automatic':'saved_positions');
     assert.deepEqual(report.positions,prepared.positions);assert.deepEqual(report.quality,JSON.parse(JSON.stringify(diagramQuality(prepared.graph))));
     assert(report.generatedMs>=0);assert.equal(report.quality.visualReview,'not_run');
     assert(report.quality.semanticClarity.issues.some((i:{code:string})=>i.code==='PARTIAL_MODEL'));
    }
    for(const args of [['--task','state'],['--state','scaled_q'],['--task','state','--state','missing'],['--task','overview','--mode','signals'],['--task','bogus'],['--mode','bogus']])assert.equal(cli(workspace,args,false).ok,false);
    const raw=cli(workspace,['--task','full','--mode','signals']);assert.equal(raw.view.mode,'signals');assert.equal(raw.quality.structuralFidelity.status,'passed');
    assert.equal(await readFile(file,'utf8'),bytes);
   });
   await check('candidate preview/register/quality preserve authority; stale layout and commit hashes reject',async()=>{
    const repository=new Repository(workspace),candidate=structuredClone(model);candidate.design.name+=' · 候选阅读检查';
    const proposal:Proposal={baseHash:hash,reason:'临时候选链路维护检查',commands:[{op:'replace_architecture',model:candidate}]};
    const preview=await repository.preview(proposal),registered=await repository.registerProposal(proposal);
    const candidateFile=join(root,'candidate.json');await writeFile(candidateFile,JSON.stringify(preview.candidate));
    const report=cli(workspace,['--model',candidateFile,'--task','overview']);
    assert.equal(report.modelHash,preview.candidateHash);assert.equal(report.view.modelSource,'candidate_file');
    assert.equal(report.view.readingSource,'none');assert.equal(registered.state,'READY');
    assert.equal((await repository.getProposal(registered.id)).preview!.candidateHash,report.modelHash);
    assert.equal(await readFile(file,'utf8'),bytes);
    assert.equal(cli(workspace,['--model',candidateFile,'--layout',join(workspace,'architecture/layout.json')],false).ok,false);
    await assert.rejects(repository.commit({proposal,candidateHash:hash}));
    const second=await repository.registerProposal({...proposal,reason:'保留的独立候选',commands:[{op:'replace_architecture',model:{...candidate,design:{...candidate.design,name:'另一候选'}}}]});
    const committed=await repository.commit({proposal,candidateHash:preview.candidateHash});
    assert.equal(committed.modelHash,preview.candidateHash);assert.notEqual(committed.reviewStatus,'APPROVED');
    assert.equal((await repository.getProposal(second.id)).state,'STALE');await assert.rejects(repository.preview(proposal));
   });
   await check('task projection cannot silently reuse saved full positions; explicit session positions remain stable',async()=>{
    const m=autoReadingFixture('pipeline'),h=modelHash(m),task={kind:'overview' as const};
    const full=await prepareDiagram(m,'top',h),saved={positions:full.positions,viewport:{x:0,y:0,zoom:1}};
    const projected=await prepareDiagram(m,'top',h,saved,{task});assert.equal(projected.layoutSource,'automatic');
    const session=await prepareDiagram(m,'top',h,saved,{task,positions:projected.positions});assert.equal(session.layoutSource,'session_positions');
    assert.deepEqual(session.graph,projected.graph);assert.equal(modelHash(m),h);
   });
   await check('route review retains every relation and selection changes only styles',async()=>{
    const {graph}=await prepareDiagram(model,'top',hash,saved,{task:{kind:'overview'}}),q=diagramQuality(graph);
    assert.equal(q.routeReview.routes.length,graph.edges.length);
    const geometry=(g:typeof graph)=>({nodes:g.nodes.map(n=>[n.id,n.position,n.data.geometry]),edges:g.edges.map(e=>[e.id,e.sourceHandle,e.targetHandle,e.data?.routePoints])});
    for(const r of q.routeReview.routes){
     const edge=graph.edges.find(e=>e.id===r.id)!;
     assert.deepEqual(r.relationMembers,edge.data?.relationMembers??[]);assert.deepEqual(r.connectionIds,edge.data?.connectionIds??[]);
     const p=edge.data!.routePoints as {x:number;y:number}[];
     assert.equal(r.length,p.slice(1).reduce((n,b,i)=>n+Math.abs(b.x-p[i].x)+Math.abs(b.y-p[i].y),0));
     const selected={...graph,...highlightDiagram(graph,r.id)};assert.deepEqual(geometry(selected),geometry(graph));
     assert.equal(selected.edges.find(e=>e.id===r.id)?.data?.selected,true);
    }
    const detoured=structuredClone(graph);detoured.edges[0].data!.routePoints=[{x:0,y:0},{x:0,y:400},{x:100,y:400},{x:100,y:0}];
    const detourReport=diagramQuality(detoured),route=detourReport.routeReview.routes.find(r=>r.id===detoured.edges[0].id)!;
    assert.equal(route.length,900);assert.equal(route.directLength,100);assert.equal(route.detour,800);assert.equal(route.ratio,9);
    assert(detourReport.routeReview.detours.includes(route.id));
    const broken=structuredClone(graph);delete broken.edges[0].data!.routePoints;broken.edges[0].data!.routingFallback=true;
    const invalid=diagramQuality(broken);assert.equal(invalid.status,'failed');assert.equal(invalid.routeReview.routes.find(r=>r.id===broken.edges[0].id)?.routed,false);
    assert(!invalid.routeReview.longest.includes(broken.edges[0].id));
   });
   await check('unnamed wires reserve no phantom label boxes and keep identical geometry',async()=>{
    const m=autoReadingFixture('fork'),{graph}=await prepareDiagram(m,'top',modelHash(m));
    const before=graph.edges.map(e=>[e.id,e.data?.routePoints]);
    const edges:typeof graph.edges=graph.edges.map(e=>({...e,label:'',data:{category:e.data?.category,netKey:e.data?.netKey}}));routeEdges(graph.nodes,edges);
    assert.deepEqual(edges.map(e=>[e.id,e.data?.routePoints]),before);
    assert(edges.every(e=>!e.data?.labelBox&&!e.data?.labelHidden));
    const q=geometryQuality({nodes:graph.nodes,edges});assert.equal(q.unrouted.length,0);assert.equal(q.nodeHits.length,0);
   });
   console.log(`完成 ${count} 组候选图形质量检查；提交只在临时副本，无批准。`);
  }finally{await rm(root,{recursive:true,force:true});}
}

export async function checkStateCone() {
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
  const redirect=(value:SignalValue)=>{if(value.kind==='endpoint'&&value.endpoint.local&&value.endpoint.interfaceId==='accept')value.endpoint.interfaceId='accept_alias';signalChildren(value).forEach(redirect)};
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
   const visit=(v:SignalValue,path:string)=>{assert(actual.has(path),`lost AST occurrence ${path}`);signalChildren(v).forEach((c,i)=>visit(c,`${path}/${i}`));if(v.kind==='endpoint'&&v.endpoint.local){const local=model.localSignals!.find(n=>n.id===v.endpoint.interfaceId)!;if(local.driver.kind==='comb'&&!seen.has(local.id)){seen.add(local.id);visit(local.driver.value,`local:top:${local.id}/value`);}}};
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
}
