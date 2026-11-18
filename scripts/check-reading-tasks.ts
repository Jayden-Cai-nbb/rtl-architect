import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {modelSchema,layoutSchema} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {prepareDiagram} from '../src/web/graph/prepareDiagram';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {diagramQuality} from '../src/web/graph/quality';
import {diagramSvg} from '../src/web/graph/exportSvg';
import {highlightDiagram} from '../src/web/graph/selection';
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
 const members=[...graph.edges.flatMap(e=>e.data?.relationMembers as {id:string}[]??[]),...Object.values(graph.projection!.internal).flat(),...graph.projection!.auxiliary];
 assert.deepEqual(members.map(m=>m.id).sort(),full.edges.map(e=>e.id).sort(),'every relation exactly once');
 assert.deepEqual(graph.nodes.filter(n=>!n.data.boundary).flatMap(n=>n.data.memberIds as string[]).sort(),full.nodes.filter(n=>!n.data.boundary).map(n=>n.id).sort());
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
console.log('PASS reading tasks: exact membership, relation ledger, stable selection, expansion, hashes and geometry');
