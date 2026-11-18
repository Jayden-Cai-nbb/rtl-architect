import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {modelSchema,layoutSchema,type Proposal} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {Repository} from '../src/workspace/repository';
import {prepareDiagram} from '../src/web/graph/prepareDiagram';
import {diagramQuality,geometryQuality} from '../src/web/graph/quality';
import {highlightDiagram} from '../src/web/graph/selection';
import {routeEdges} from '../src/web/graph/orthogonal';
import {autoReadingFixture} from './auto-reading-fixture';

const root=await mkdtemp(join(tmpdir(),'rtlarch-candidate-quality-check-'));
let count=0;
const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++count}: ${name}`);};
const cli=(workspace:string,args:string[],success=true)=>{
 const result=spawnSync(process.execPath,['--import','tsx',resolve('scripts/cli.ts'),'diagram-quality','--workspace',workspace,'--json',...args],{encoding:'utf8',maxBuffer:16*1024*1024});
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
