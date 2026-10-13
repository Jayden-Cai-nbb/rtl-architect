import assert from 'node:assert/strict';
import {autoReadingFixture} from './auto-reading-fixture';
import {dependencyRelations} from '../src/web/graph/dependencies';
import {endpointLabel} from '../src/core/signals';
import {feedbackFixture,feedbackReading} from './feedback-fixture';
import {modelHash} from '../src/core/export';
import {layoutSchema} from '../src/core/schema';
import {inspectScope} from '../src/core/inspection';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {highlightDiagram} from '../src/web/graph/selection';
import {arrangeScope} from '../src/web/graph/readingLayout';
import {diagramSvg} from '../src/web/graph/exportSvg';
import {diagramQuality} from '../src/web/graph/quality';
import {routeEdges} from '../src/web/graph/orthogonal';
const model=feedbackFixture(),hash=modelHash(model);let count=0;
async function check(name:string,fn:()=>unknown){await fn();console.log(`PASS ${++count}: ${name}`)}
await check('default overview retains register boundaries; opt-out and internal detail are explicit',()=>{
 const graph=scopeDiagram(model,'top');assert.equal(graph.nodes.filter(n=>n.data.kind==='state').length,4);assert.equal(graph.nodes.filter(n=>n.data.kind==='local').length,1);assert.equal(scopeDiagram(model,'top',{showState:false,showLocals:false}).nodes.filter(n=>n.data.localId).length,0);assert.equal(graph.localCount,5);assert.equal(model.modules.length,6);
});
await check('selection changes styles only and preserves exact route/port objects and model identity',()=>{
 const graph=scopeDiagram(model,'top'),before=JSON.stringify(graph);
 for(let i=0;i<30;i++)for(const id of model.modules.map(m=>m.id)){
  const selected=highlightDiagram(graph,id);assert.equal(selected.nodes.length,graph.nodes.length);assert.equal(selected.edges.length,graph.edges.length);assert.equal(selected.nodes.find(n=>n.id===id)?.selected??false,id!=='top');
  selected.edges.forEach((e,j)=>assert.equal(e.data?.routePoints,graph.edges[j].data?.routePoints));selected.nodes.forEach((n,j)=>assert.equal(n.data.geometry,graph.nodes[j].data.geometry));
 }assert.equal(JSON.stringify(graph),before);assert.equal(modelHash(model),hash);
});
await check('default dependency trace stops at state, explicit crossing is bounded and deduplicated',()=>{
 const trace=inspectScope(model,'top',{kind:'module',id:'unit0'});assert.deepEqual(trace.stateBoundaries,['state3']);assert.equal(trace.dependencies.length,1);assert.ok(!trace.localIds.includes('state2'));
 const cross=inspectScope(model,'top',{kind:'module',id:'unit0',depth:8,crossState:true});assert.ok(cross.localIds.includes('state0'));assert.ok(cross.localIds.length<=48&&cross.dependencies.length<=160);
 const one=inspectScope(model,'top',{kind:'local',id:'state3',depth:1,crossState:true});assert.ok(one.limited.includes('state2'));assert.ok(!one.localIds.includes('state1'));
 const graph=scopeDiagram(model,'top',{showLocals:true});assert.equal(graph.edges.filter(e=>e.data?.localSignalId==='feedback').length,1);assert.ok(graph.edges.filter(e=>e.data?.localSignalId).every(e=>e.label!=='驱动'));
});
await check('local positions and stage regions are presentation only; online and SVG share geometry',async()=>{
 const reading=feedbackReading(model),positions=await arrangeScope(model,'top',hash,reading);
 const parsed=layoutSchema.parse({schemaVersion:1,scopes:{top:{positions,reading,viewport:{x:0,y:0,zoom:1}}}});
 const graph=scopeDiagram(model,'top',{positions,reading:parsed.scopes.top.reading});
 assert.equal(graph.nodes.filter(n=>n.data.kind==='region').length,3);assert.deepEqual(graph.nodes.find(n=>n.id==='local:top:state0')!.position,positions['local:top:state0']);
 const quality=diagramQuality(graph);assert.deepEqual(quality.overlaps,[]);assert.deepEqual(quality.nodeHits,[]);
 const spread=scopeDiagram(model,'top',{positions:{...positions,'local:top:state0':{x:-1200,y:-400},'local:top:state3':{x:6000,y:350}},reading,measureOnly:true});
 for(const node of spread.nodes.filter(n=>!n.data.boundary)){assert.ok(node.position.x>=spread.frame.position.x);assert.ok(node.position.x+node.data.geometry.width<=spread.frame.position.x+spread.frame.width);assert.ok(node.position.y>=spread.frame.position.y);assert.ok(node.position.y+node.data.geometry.height<=spread.frame.position.y+spread.frame.height);}

 const svg=diagramSvg(model,'top',{positions,reading},hash,graph);assert.ok(svg.includes('data-reading-stage='));for(const e of graph.edges)if(e.data?.route)assert.ok(svg.includes((e.data.route as {path:string}).path));
 assert.throws(()=>scopeDiagram(model,'top',{positions,reading:{...reading,stages:[{id:'wrong',label:'错误',nodes:['missing']}]}}));
 assert.equal(modelHash(model),hash);await assert.rejects(arrangeScope(model,'top',hash,{...reading,modelHash:'0'.repeat(64)}));await assert.rejects(arrangeScope(model,'top',hash,{...reading,stages:[{id:'bad',label:'错误范围',nodes:['local:other:state0']}]}));
});
await check('dense small graphs have bounded search without obstacle penetration',()=>{
 const graph=scopeDiagram(model,'top',{showLocals:true,measureOnly:true}),edges=Array.from({length:60},(_,i)=>({...structuredClone(graph.edges[i%graph.edges.length]),id:`dense${i}`,data:{...graph.edges[i%graph.edges.length].data,netKey:`unique${i}`}}));
 const routed:import('@xyflow/react').Edge[]=edges;
 const start=performance.now();routeEdges(graph.nodes,routed);const elapsed=performance.now()-start;
 assert.ok(routed.every(e=>Number(e.data?.routingWork)<=52002));assert.ok(routed.every(e=>!e.data?.routingFallback));
 const quality=diagramQuality({...graph,edges});assert.deepEqual(quality.nodeHits,[]);console.log(`  dense routing ${elapsed.toFixed(1)} ms, ${edges.length} edges`);
});
await check('dependency bundles preserve categories, unknown ports and distinct bit ranges without claiming a physical bus',()=>{
 const m=structuredClone(model),unit=m.modules.find(n=>n.id==='unit0')!,state=m.localSignals![0];
 unit.interfaceGroups=[{id:'operands',category:'data',label:'操作数',description:'显式数据用途'}];
 unit.interfaces[1].group='operands';unit.interfaces.push({id:'flags',role:'producer',protocol:'signal',width:4,required:false,group:'operands'},{id:'unknown',role:'producer',protocol:'signal',width:1,required:false});
 assert.equal(state.driver.kind,'register');if(state.driver.kind!=='register')return;
 state.driver.inputs=[{moduleId:unit.id,interfaceId:'dout',slice:{msb:15,lsb:0}},{moduleId:unit.id,interfaceId:'dout',slice:{msb:31,lsb:16}},{moduleId:unit.id,interfaceId:'flags'},{moduleId:unit.id,interfaceId:'unknown'}];state.driver.inputs.push(state.driver.inputs[0]);
 const before=modelHash(m),relations=dependencyRelations(m,'top').filter(d=>d.localId===state.id),bundle=relations.find(d=>d.group.category==='data')!;
 assert.equal(relations.length,2);assert.equal(bundle.endpoints.length,3);assert.equal(new Set(bundle.endpoints.map(endpointLabel)).size,3);
 const graph=scopeDiagram(m,'top',{measureOnly:true}),edge=graph.edges.find(e=>e.id===bundle.id)!;
 assert.deepEqual(edge.data?.dependencyEndpoints,bundle.endpoints);assert.equal(edge.data?.netKey,undefined);assert.equal(edge.style?.strokeDasharray,undefined);
 const detailed=scopeDiagram(m,'top',{detail:'signals',measureOnly:true});assert.equal(detailed.edges.filter(e=>e.data?.localSignalId===state.id).length,4);assert.equal(modelHash(m),before);
});
await check('parallel state and compute nodes with different widths remain separate in one topology layer',async()=>{
 const m=autoReadingFixture('fork');m.modules=m.modules.filter(n=>n.id!=='branch');
 m.localSignals=[{id:'branch',scope:'top',name:'分支状态',width:1,description:'独立真实状态的合成夹具',evidenceIds:[],driver:{kind:'register',inputs:[{moduleId:'input',interfaceId:'right'}],sourceText:'fixture state'}}];
 m.connections=m.connections.filter(l=>l.id!=='right');m.connections.find(l=>l.id==='right_result')!.from={moduleId:'top',interfaceId:'branch',local:true};
 const hash=modelHash(m),positions=await arrangeScope(m,'top',hash),graph=scopeDiagram(m,'top',{positions}),q=diagramQuality(graph);
 assert.notEqual(graph.nodes.find(n=>n.id==='work')!.data.geometry.width,graph.nodes.find(n=>n.id==='local:top:branch')!.data.geometry.width);
 assert.equal(positions.work.x,positions['local:top:branch'].x);assert.deepEqual(q.overlaps,[]);assert.deepEqual(q.nodeHits,[]);assert.deepEqual(q.unrouted,[]);assert.equal(modelHash(m),hash);
});
await check('stage constraints preserve ordered regions, every RTL instance and exact dependency members',async()=>{
 const reading=feedbackReading(model),positions=await arrangeScope(model,'top',hash,reading),graph=scopeDiagram(model,'top',{positions,reading});
 const boxes=reading.stages.map(stage=>{const members=graph.nodes.filter(n=>stage.nodes.includes(n.id));return {left:Math.min(...members.map(n=>n.position.x)),right:Math.max(...members.map(n=>n.position.x+n.data.geometry.width))};});
 boxes.slice(1).forEach((box,i)=>assert.ok(box.left>boxes[i].right));
 assert.deepEqual(graph.nodes.filter(n=>!n.data.boundary&&!n.data.localId).map(n=>n.id).sort(),model.modules.filter(n=>n.parent==='top').map(n=>n.id).sort());
 const rendered=graph.edges.flatMap(e=>(e.data?.dependencyEndpoints as import('../src/core/schema').Endpoint[]??[]).map(endpointLabel));
 const expected=dependencyRelations(model,'top').flatMap(d=>d.endpoints.map(endpointLabel));assert.deepEqual(rendered.sort(),expected.sort());
 assert.ok(graph.nodes.some(n=>n.id==='local:top:feedback'),'output-driving combinational logic remains visible');assert.equal(modelHash(model),hash);
});
console.log(`完成 ${count} 组真实反馈对应检查。`);
