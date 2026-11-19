import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validateModel } from '../../src/core/engine';
import { modelHash } from '../../src/core/export';
import { dependencyRoles, hardwareView, type ViewMode } from '../../src/core/hardwareView';
import { inspectScope, interfaceGroup, linkGroup } from '../../src/core/inspection';
import { type Endpoint, layoutSchema, type Model, modelSchema } from '../../src/core/schema';
import { endpointLabel } from '../../src/core/signals';
import { specMarkdown } from '../../src/core/spec';
import { dependencyRelations } from '../../src/web/graph/dependencies';
import { diagramSvg } from '../../src/web/graph/exportSvg';
import { refineSpacing } from '../../src/web/graph/layoutFeedback';
import { routeEdges } from '../../src/web/graph/orthogonal';
import { prepareDiagram } from '../../src/web/graph/prepareDiagram';
import { diagramQuality } from '../../src/web/graph/quality';
import { arrangeScope } from '../../src/web/graph/readingLayout';
import { validateReadingRefs } from '../../src/web/graph/readingRefs';
import { scopeDiagram } from '../../src/web/graph/scopeDiagram';
import { highlightDiagram } from '../../src/web/graph/selection';
import { type RtlNode } from '../../src/web/graph/types';
import { excerpt } from '../../src/web/reading';
import { exportBundle } from '../../src/workspace/bundle';
import { toolRoot } from '../../src/workspace/environment';
import { evidenceFreshness } from '../../src/workspace/freshness';
import { Repository } from '../../src/workspace/repository';
import { architecturePattern, autoReadingFixture, feedbackFixture, feedbackReading, mappedFixture, patternIds } from './fixtures';
import { type Edge } from '@xyflow/react';

export async function checkReadingGeometry() {
  let checks=0;function check(name:string,fn:()=>void){fn();console.log(`PASS ${++checks}: ${name}`)}
  const fixture=():Model=>{const m=mappedFixture();m.modules=m.modules.filter(n=>['top','mem','pro','config'].includes(n.id));m.connections=[];const top=m.modules[0];top.interfaces.push({id:'control',role:'consumer',protocol:'signal',width:1,required:false,group:'ctrl'});top.interfaceGroups!.push({id:'ctrl',label:'启动',category:'control',description:'启动处理'});const pro=m.modules.find(n=>n.id==='pro')!;pro.interfaces=[{id:'cfg',role:'consumer',protocol:'signal',width:8,required:false},{id:'start',role:'consumer',protocol:'signal',width:1,required:false},{id:'out',role:'producer',protocol:'signal',width:1,required:false}];m.connections=[{id:'cfg',scope:'top',from:{moduleId:'top',interfaceId:'llr_0'},to:{moduleId:'pro',interfaceId:'cfg'}},{id:'start',scope:'top',from:{moduleId:'top',interfaceId:'control'},to:{moduleId:'pro',interfaceId:'start'}}];return m;};
  check('boundary group selection excludes other inputs while retaining exact connection IDs',()=>{
   const m=fixture(),selected=inspectScope(m,'top',{kind:'boundary',role:'consumer',groupId:'llr'});assert.deepEqual(selected.links.map(l=>l.id),['cfg']);assert.equal(inspectScope(m,'top',{kind:'boundary',role:'consumer'}).links.length,2);
  });
  check('each boundary group has a distinct stable handle; folding never changes model or module geometry',()=>{
   const m=fixture(),hash=modelHash(m),a=scopeDiagram(m,'top'),b=scopeDiagram(m,'top',{showAuxiliary:true});const rack=a.nodes.find(n=>n.id==='rack:top:consumer')!;
   assert.notEqual(rack.data.geometry.ports.find(p=>p.id==='out:llr')!.y,rack.data.geometry.ports.find(p=>p.id==='out:ctrl')!.y);
   assert.deepEqual(a.nodes.map(n=>n.data.geometry),b.nodes.map(n=>n.data.geometry));assert.equal(modelHash(m),hash);assert.ok(b.edges.some(e=>e.sourceHandle==='out:llr'));assert.equal(a.auxiliaryCount,1);
  });
  check('three local drivers in a narrow subsystem all fit inside the frame and outside boundary racks',()=>{
   const m=fixture();m.localSignals=Array.from({length:3},(_,i)=>({id:`local${i}`,scope:'mem',name:`常量${i}`,description:'常量驱动',width:1,evidenceIds:[],driver:{kind:'comb',value:{kind:'constant',width:1,value:'0'}}}));const g=scopeDiagram(m,'mem',{showLocals:true}),f=g.frame;
   assert.equal(g.nodes.filter(n=>n.data.localId).length,3);for(const n of g.nodes.filter(n=>n.data.localId)){assert.ok(n.position.x>=f.position.x+174);assert.ok(n.position.x+n.data.geometry.width<=f.position.x+f.width-174);assert.ok(n.position.y+n.data.geometry.height<=f.position.y+f.height);}
  });
  check('forward and feedback connections avoid an intervening block and preserve arrow direction',()=>{
   const m=fixture(),pro=m.modules.find(n=>n.id==='pro')!,mem=m.modules.find(n=>n.id==='mem')!;mem.interfaces=[{id:'in',role:'consumer',protocol:'signal',width:1,required:false},{id:'out',role:'producer',protocol:'signal',width:1,required:false}];m.connections=[{id:'fwd',scope:'top',from:{moduleId:'pro',interfaceId:'out'},to:{moduleId:'mem',interfaceId:'in'}},{id:'back',scope:'top',from:{moduleId:'mem',interfaceId:'out'},to:{moduleId:'pro',interfaceId:'start'}}];
   const positions={pro:{x:0,y:120},config:{x:380,y:120},mem:{x:760,y:120}},g=scopeDiagram(m,'top',{positions});
   for(const e of g.edges){assert.ok(!e.data?.routingFallback);const p=e.data?.routePoints as {x:number;y:number}[];assert.ok(p.length>3);const source=g.nodes.find(n=>n.id===e.source)!,target=g.nodes.find(n=>n.id===e.target)!;const sp=source.data.geometry.ports.find(p=>p.id===e.sourceHandle)!,tp=target.data.geometry.ports.find(p=>p.id===e.targetHandle)!;assert.deepEqual(p[0],{x:source.position.x+sp.x,y:source.position.y+sp.y});assert.deepEqual(p.at(-1),{x:target.position.x+tp.x,y:target.position.y+tp.y});
    for(let i=1;i<p.length;i++){const a=p[i-1],b=p[i];assert.ok(a.x===b.x||a.y===b.y);const block=g.nodes.find(n=>n.id==='config')!,right=380+block.data.geometry.width,bottom=120+block.data.geometry.height;const hits=a.x===b.x?a.x>380&&a.x<right&&Math.max(a.y,b.y)>120&&Math.min(a.y,b.y)<bottom:a.y>120&&a.y<bottom&&Math.max(a.x,b.x)>380&&Math.min(a.x,b.x)<right;assert.equal(hits,false);}
   }
   assert.equal(pro.id,'pro');
  });
  check('SVG uses routed geometry, escapes user strings, discloses partial/folded state and leaves model untouched',()=>{
   const m=fixture();m.modules[0].name='<script>&"';const hash=modelHash(m),svg=diagramSvg(m,'top',{},hash);assert.ok(svg.includes('&lt;script&gt;&amp;&quot;'));assert.ok(!svg.includes('<script>'));assert.match(svg,/尚未完整/);assert.match(svg,/时钟 \/ 配置折叠 1 条/);assert.match(svg,/marker-end/);assert.match(svg,new RegExp(hash.slice(0,12)));assert.equal(modelHash(m),hash);
  });
  check('short previews retain inference qualifiers and full exported evidence follows the behavior',()=>{
   assert.equal(excerpt('[推断] 可能由上游保持输入。'),'推断：可能由上游保持输入。');const m=fixture(),md=specMarkdown(m,modelHash(m),'DRAFT',[]);assert.ok(md.indexOf('### 行为合同')<md.indexOf('## 来源与覆盖'));assert.match(md,/fixture.txt/);
  });


  check('north/south handles remain stable across selection, and every route terminates at its declared handle',()=>{
   const m=fixture(),pro=m.modules.find(n=>n.id==='pro')!,mem=m.modules.find(n=>n.id==='mem')!;
   mem.interfaces=[{id:'in',role:'consumer',protocol:'signal',width:1,required:false}];
   m.connections=[{id:'vertical',scope:'top',from:{moduleId:'pro',interfaceId:'out'},to:{moduleId:'mem',interfaceId:'in'}}];
   const positions={pro:{x:200,y:0},mem:{x:200,y:320},config:{x:600,y:320}},a=scopeDiagram(m,'top',{positions}),b=scopeDiagram(m,'top',{positions,inspection:{kind:'connection',ids:['vertical']}});
   const edge=a.edges[0],source=a.nodes.find(n=>n.id===edge.source)!,target=a.nodes.find(n=>n.id===edge.target)!;
   const sp=source.data.geometry.ports.find(p=>p.id===edge.sourceHandle)!,tp=target.data.geometry.ports.find(p=>p.id===edge.targetHandle)!;
   assert.equal(sp.side,'SOUTH');assert.equal(tp.side,'NORTH');assert.equal(edge.data?.labelHidden,false);
   assert.deepEqual(a.nodes.map(n=>n.data.geometry),b.nodes.map(n=>n.data.geometry));
   const points=edge.data!.routePoints as {x:number;y:number}[];
   assert.deepEqual(points[0],{x:source.position.x+sp.x,y:source.position.y+sp.y});assert.deepEqual(points.at(-1),{x:target.position.x+tp.x,y:target.position.y+tp.y});
   const svg=diagramSvg(m,'top',{positions});assert.ok(svg.includes((edge.data!.route as {path:string}).path));assert.ok(svg.includes('data-edge-id='));
  });

  check('a grouped port never implies a shared physical source; exact sources remain distinguishable',()=>{
   const m=fixture(),pro=m.modules.find(n=>n.id==='pro')!,mem=m.modules.find(n=>n.id==='mem')!,cfg=m.modules.find(n=>n.id==='config')!;
   pro.interfaceGroups=[{id:'dispatch',label:'任务',category:'control',description:'分发'}];
   pro.interfaces=[{id:'a',role:'producer',protocol:'signal',width:1,required:false,group:'dispatch'},{id:'b',role:'producer',protocol:'signal',width:1,required:false,group:'dispatch'}];
   for(const n of [mem,cfg])n.interfaces=[{id:'in',role:'consumer',protocol:'signal',width:1,required:false}];
   m.connections=[{id:'a',scope:'top',from:{moduleId:'pro',interfaceId:'a'},to:{moduleId:'mem',interfaceId:'in'}},{id:'b',scope:'top',from:{moduleId:'pro',interfaceId:'b'},to:{moduleId:'config',interfaceId:'in'}}];
   const options={positions:{pro:{x:200,y:0},mem:{x:0,y:300},config:{x:450,y:300}}},g=scopeDiagram(m,'top',options);
   assert.notEqual(g.edges[0].data?.netKey,g.edges[1].data?.netKey);
   m.connections[1].from.interfaceId='a';const fanout=scopeDiagram(m,'top',options);assert.equal(fanout.edges[0].data?.netKey,fanout.edges[1].data?.netKey);
   assert.deepEqual(fanout.edges.flatMap(e=>e.data?.connectionIds).sort(),['a','b']);
  });



  check('status returns approach the facing controller side from left and right, independently of record order',()=>{
   const m=fixture(),controller=m.modules.find(n=>n.id==='pro')!,left=m.modules.find(n=>n.id==='mem')!,right=m.modules.find(n=>n.id==='config')!;
   controller.kind='controller';controller.interfaces=[{id:'left_done',role:'consumer',protocol:'signal',width:1,required:false},{id:'right_done',role:'consumer',protocol:'signal',width:1,required:false}];
   for(const [n,group] of [[left,'left_status'],[right,'right_status']] as const){n.interfaceGroups=[{id:group,label:'完成',category:'response',description:'任务完成'}];n.interfaces=[{id:'done',role:'producer',protocol:'signal',width:1,required:false,group}];}
   m.connections=[{id:'left_done',scope:'top',from:{moduleId:'mem',interfaceId:'done'},to:{moduleId:'pro',interfaceId:'left_done'}},{id:'right_done',scope:'top',from:{moduleId:'config',interfaceId:'done'},to:{moduleId:'pro',interfaceId:'right_done'}}];
   const positions={pro:{x:500,y:0},mem:{x:0,y:400},config:{x:1000,y:400}},g=scopeDiagram(m,'top',{positions});
   const ports=g.nodes.find(n=>n.id==='pro')!.data.geometry.ports;
   assert.equal(ports.find(p=>p.interfaceIds?.includes('left_done'))!.side,'WEST');assert.equal(ports.find(p=>p.interfaceIds?.includes('right_done'))!.side,'EAST');
   m.connections.reverse();assert.deepEqual(scopeDiagram(m,'top',{positions}).nodes.map(n=>n.data.geometry),g.nodes.map(n=>n.data.geometry));
  });

  check('port names are exact model interfaces inside their blocks; detail export never moves nodes or routes',()=>{
   const m=fixture(),positions={pro:{x:0,y:200},mem:{x:500,y:200},config:{x:0,y:500}},hash=modelHash(m);
   const a=scopeDiagram(m,'top',{positions}),b=scopeDiagram(m,'top',{positions,showPortNames:true});
   assert.deepEqual(a.nodes,b.nodes);assert.deepEqual(a.edges,b.edges);
   for(const n of a.nodes.filter(n=>!n.data.boundary))for(const p of n.data.geometry.ports.filter(p=>p.label)){
    assert.ok(p.interfaceIds?.every(id=>m.modules.find(m=>m.id===n.id)?.interfaces.some(i=>i.id===id)));
    assert.ok(p.labelX!>0&&p.labelX!<n.data.geometry.width&&p.labelY!>0&&p.labelY!<n.data.geometry.height);
   }
   const compact=diagramSvg(m,'top',{positions}),detail=diagramSvg(m,'top',{positions,showPortNames:true});
   assert.match(detail,/class="show-port-names"/);assert.ok(!compact.includes('class="show-port-names"'));assert.equal(modelHash(m),hash);
  });



  check('long unrelated wires separate into readable lanes even when their endpoint pins are close',()=>{
   const make=(id:string,x:number,direction:'source'|'target'):RtlNode=>({id,type:'rtlModule',position:{x,y:0},data:{label:id,moduleId:id,kind:'module',summary:'',boundary:false,ports:[],geometry:{width:160,height:160,ports:[40,44].map((y,i)=>({id:String(i),direction,side:direction==='source'?'EAST':'WEST',x:direction==='source'?160:0,y}))}}});
   const nodes=[make('a',0,'source'),make('b',720,'target')],edges:Edge[]=[0,1].map(i=>({id:String(i),source:'a',target:'b',sourceHandle:String(i),targetHandle:String(i),label:'data'+i,data:{netKey:String(i),category:'data'}}));
   routeEdges(nodes,edges);assert.ok(edges.every(e=>!e.data?.routingFallback));
   const segments=edges.map(e=>{const ps=e.data!.routePoints as {x:number;y:number}[];return ps.slice(1).map((b,i)=>({a:ps[i],b})).filter(s=>s.a.y===s.b.y);});
   for(const a of segments[0])for(const b of segments[1]){const overlap=Math.min(Math.max(a.a.x,a.b.x),Math.max(b.a.x,b.b.x))-Math.max(Math.min(a.a.x,a.b.x),Math.min(b.a.x,b.b.x));if(overlap>120)assert.ok(Math.abs(a.a.y-b.a.y)>=32);}
  });
  console.log(`完成 ${checks} 组架构阅读与框图检查。`);
}

export async function checkAutomaticReading() {
  let checks=0;
  for(const shape of ['pipeline','fork','controlled','ring','mixed','unknown','shared','inline','nested'] as const){
    const model=modelSchema.parse(autoReadingFixture(shape)),hash=modelHash(model),bytes=JSON.stringify(model);
    assert.deepEqual(validateModel(model).filter(i=>i.blocks.includes('commit')),[]);
    const positions=await arrangeScope(model,'top',hash),g=scopeDiagram(model,'top',{positions}),q=diagramQuality(g);
    assert.deepEqual(Object.keys(positions).sort(),model.modules.filter(m=>m.parent==='top').map(m=>m.id).sort());
    assert.equal(q.status,'passed',`${shape}: ${JSON.stringify(q)}`);
    assert.equal(q.hiddenLabels.length,0,`${shape}: hidden labels ${q.hiddenLabels}`);
    assert.deepEqual(g.edges.flatMap(e=>e.data?.connectionIds).sort(),model.connections.map(l=>l.id).sort());
    assert.equal(JSON.stringify(model),bytes);assert.equal(modelHash(model),hash);
    const reversed=structuredClone(model);reversed.modules.reverse();reversed.connections.reverse();
    assert.deepEqual(await arrangeScope(reversed,'top',modelHash(reversed)),positions,`${shape}: stable positions`);
    const focused=scopeDiagram(model,'top',{positions,inspection:{kind:'module',id:'work'}});
    assert.deepEqual(focused.nodes.map(n=>n.data.geometry),g.nodes.map(n=>n.data.geometry));
    if(shape==='pipeline')assert.ok(positions.input.x<positions.work.x&&positions.work.x<positions.output.x);
    if(shape==='fork'){assert.ok(positions.input.x<positions.work.x&&positions.input.x<positions.branch.x);assert.ok(positions.output.x>positions.work.x&&positions.output.x>positions.branch.x);assert.equal(positions.work.x,positions.branch.x);}
    if(shape==='controlled'){assert.ok(positions.scheduler.y<positions.work.y);assert.equal(positions.store.x,positions.work.x);assert.ok(positions.store.y>positions.work.y);}
    if(shape==='shared'){assert.notEqual(positions.store.x,positions.work.x,'shared memory must not be attached to a single user');}
    if(shape==='inline')assert.ok(positions.input.x<positions.work.x&&positions.work.x<positions.output.x,'in-line memory remains in the data path');
    if(shape==='nested'){const outer=await arrangeScope(model,'root',hash);assert.deepEqual(Object.keys(outer),['top']);assert.equal(diagramQuality(scopeDiagram(model,'root',{positions:outer})).status,'passed');}
    if(shape==='mixed')assert.ok(positions.scheduler.y>=100,'data-carrying controller stays in topology');
    if(shape==='unknown'){
      assert.notEqual(interfaceGroup(model,{moduleId:'input',interfaceId:'samples'}).id,interfaceGroup(model,{moduleId:'work',interfaceId:'samples'}).id,'same spelling in distinct modules does not define a bus');
      assert.equal(g.auxiliaryCount,0);assert.ok(positions.work.x>positions.input.x);
      for(const id of ['clk','rst_n','config']){const group=interfaceGroup(model,{moduleId:'input',interfaceId:id});assert.equal(group.label,id);assert.equal(group.category,'other');assert.equal(group.auxiliary,false);assert.ok(g.edges.some(e=>e.label===id));}
    }
    console.log(`PASS ${++checks}: ${shape}: geometry, labels, exact connections, deterministic layout and stable selection (${q.crossings} crossings)`);
  }
  console.log(`完成 ${checks} 组默认阅读布局检查。`);
}

export async function checkFeedback() {
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
   const rendered=graph.edges.flatMap(e=>(e.data?.dependencyEndpoints as Endpoint[]??[]).map(endpointLabel));
   const expected=dependencyRelations(model,'top').flatMap(d=>d.endpoints.map(endpointLabel));assert.deepEqual(rendered.sort(),expected.sort());
   assert.ok(graph.nodes.some(n=>n.id==='local:top:feedback'),'output-driving combinational logic remains visible');assert.equal(modelHash(model),hash);
  });
  console.log(`完成 ${count} 组真实反馈对应检查。`);
}

export async function checkHardwareView() {
  const tiny=modelSchema.parse(JSON.parse(await readFile('examples/tiny-stream/model.json','utf8')));let n=0;
  const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++n}: ${name}`)};
  await check('native RV preserves forward data/valid and backward ready without claiming verified RTL',()=>{
   const view=hardwareView(tiny,'path');assert(view.relationships.every(r=>r.kind==='ready_valid'&&r.classification==='declared'));assert(view.relationships.every(r=>r.members.find(m=>m.part==='ready')?.direction==='backward'));assert(view.relationships.every(r=>!r.evidenceIds.length));
   const graph=scopeDiagram(tiny,'path');assert.equal(graph.edges.length,tiny.connections.filter(l=>l.scope==='path').length);assert(graph.edges.every(e=>String(e.label).includes('←ready')&&!e.data?.netKey));
  });
  await check('conflicting categories remain visible and never silently choose clock/config folding',()=>{
   const m=autoReadingFixture('controlled'),link=m.connections[0],a=m.modules.find(m=>m.id===link.from.moduleId)!;a.interfaceGroups!.find(g=>g.id===a.interfaces.find(p=>p.id===link.from.interfaceId)!.group)!.category='clock_reset';
   assert.equal(linkGroup(m,link).auxiliary,false);assert(hardwareView(m,'top').issues.some(i=>i.code==='GROUP_CONFLICT'&&i.target===link.id));assert(scopeDiagram(m,'top').edges.some(e=>(e.data?.connectionIds as string[])?.includes(link.id)));
  });
  await check('register input sets stay uncertain; explicit mux selector differs from operands',()=>{
   const m=feedbackFixture(),state=m.localSignals!.find(l=>l.driver.kind==='register')!;assert([...dependencyRoles(state).values()].every(r=>r==='state_unknown'));assert(hardwareView(m,'top').issues.some(i=>i.code==='STATE_ROLE_UNKNOWN'));
   const e=(id:string)=>({kind:'endpoint' as const,endpoint:{moduleId:'top',interfaceId:id}}),comb={...state,driver:{kind:'comb' as const,value:{kind:'operator' as const,operator:'mux' as const,operands:[e('sel'),e('data_a'),e('data_b')]}}};
   const roles=dependencyRoles(comb);assert.deepEqual([...roles.values()],['select','operand','operand']);
   const graph=scopeDiagram(m,'top');assert(graph.edges.filter(e=>e.data?.semanticKind==='dependency').every(e=>!e.data?.netKey&&String(e.label).includes('依赖')));assert(diagramSvg(m,'top',{},modelHash(m),graph).includes('arrow-dependency'));
  });
  for(const shape of ['fork','shared','inline','unknown'] as const)for(const mode of ['architecture','microarchitecture','signals'] as ViewMode[])await check(`${shape}/${mode}: all connections traceable, stable model and exact raw anchors`,async()=>{
   const m=autoReadingFixture(shape),hash=modelHash(m),positions=await arrangeScope(m,'top',hash,undefined,{mode}),g=scopeDiagram(m,'top',{mode,positions}),q=diagramQuality(g);
   assert.equal(q.structuralFidelity.status,'passed',JSON.stringify(q.structuralFidelity));assert.equal(q.status,'passed',JSON.stringify(q));assert.equal(modelHash(m),hash);assert.equal(g.mode,mode);
   if(mode==='signals'){assert.equal(g.omissions.length,0);assert.equal(g.edges.filter(e=>e.data?.connectionIds).length,m.connections.length);for(const e of g.edges)assert(g.nodes.find(n=>n.id===e.source)?.data.geometry.ports.some(p=>p.id===e.sourceHandle));}
   const svg=diagramSvg(m,'top',{mode,positions},hash,g);assert(svg.includes(`data-view-mode="${mode}"`));
   if(process.env.RTLARCH_VIEW_EVIDENCE){await mkdir(process.env.RTLARCH_VIEW_EVIDENCE,{recursive:true});await writeFile(`${process.env.RTLARCH_VIEW_EVIDENCE}/${shape}-${mode}.svg`,svg);}
  });
  await check('semantic and connection audits do not borrow geometric PASS',()=>{
   const m=autoReadingFixture('unknown'),g=scopeDiagram(m,'top');assert.equal(diagramQuality(g).semanticClarity.status,'needs_review');g.edges.pop();assert.equal(diagramQuality(g).structuralFidelity.status,'failed');
   const h=scopeDiagram(m,'top');h.edges[0].target='wrong';assert.equal(diagramQuality(h).structuralFidelity.status,'failed');
  });
  await check('unknown-role controller remains in main topology',async()=>{
   const m=autoReadingFixture('unknown');m.modules.find(m=>m.id==='work')!.kind='controller';const p=await arrangeScope(m,'top',modelHash(m));assert(p.work.x>p.input.x&&p.work.y>=100);
  });
  await check('spacing feedback is bounded, preserves relative order and skips explicit reading plans',async()=>{
   const m=autoReadingFixture('shared'),hash=modelHash(m),p=await arrangeScope(m,'top',hash),r=refineSpacing(m,'top',p);
   assert(r.attempts<=2);assert.equal(modelHash(m),hash);assert.deepEqual(Object.keys(r.positions),Object.keys(p));
   for(const a of Object.keys(p))for(const b of Object.keys(p))assert.equal(Math.sign(p[a].x-p[b].x),Math.sign(r.positions[a].x-r.positions[b].x));
   assert.equal(refineSpacing(m,'top',p,{reading:{modelHash:hash,reason:'明确阅读',mainPath:[],control:[],adjacent:[]}}).attempts,0);
  });
  console.log(`完成 ${n} 组硬件语义视图检查。`);
}

export async function checkLayoutConstraints() {
  const root=await mkdtemp(join(tmpdir(),'rtlarch-layout-')),evidence=process.env.RTLARCH_LAYOUT_EVIDENCE;
  const yosys=process.env.YOSYS??'yosys';let count=0;
  const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++count}: ${name}`);};
  const reports:unknown[]=[];
  try{
   const version=execFileSync(yosys,['-V'],{encoding:'utf8'}).trim();
   for(const id of patternIds)await check(`${id}: real RTL elaboration, net correspondence, three views and explicit reading constraints`,async()=>{
    const f=await architecturePattern(id),hash=modelHash(f.model),workspace=join(root,id);
    await mkdir(join(workspace,'architecture'),{recursive:true});await mkdir(join(workspace,'rtl'));
    await writeFile(join(workspace,'rtl',`${id}.sv`),f.source);await writeFile(join(workspace,'architecture/model.json'),JSON.stringify(f.model));
    const layout=layoutSchema.parse({schemaVersion:1,scopes:{top:{positions:{},reading:f.reading,viewport:{x:0,y:0,zoom:1}}}});
    await writeFile(join(workspace,'architecture/layout.json'),JSON.stringify(layout));
    assert.deepEqual(validateModel(f.model).filter(i=>i.blocks.includes('commit')),[]);
    execFileSync(yosys,['-Q','-T','-p',`read_verilog -sv rtl/${id}.sv; hierarchy -check -top ${id}; proc; check -assert; write_json netlist.json`],{cwd:workspace,encoding:'utf8',stdio:'pipe'});
    const netlist=JSON.parse(await readFile(join(workspace,'netlist.json'),'utf8')),top=netlist.modules[id];
    for(const module of f.model.modules.filter(m=>m.parent==='top'))assert.equal(top.cells[module.id].type,module.rtlModule);
    const bits=(e:Endpoint)=>e.local?top.netnames[f.localNetBindings[e.interfaceId]??e.interfaceId].bits:e.moduleId==='top'?top.ports[e.interfaceId].bits:top.cells[e.moduleId].connections[e.interfaceId];
    for(const c of f.model.connections)assert.deepEqual(bits(c.from),bits(c.to),`${id}/${c.id}: physical endpoint mismatch`);
    const modes=[];
    for(const mode of ['architecture','microarchitecture','signals'] as const){
     const {graph,positions}=await prepareDiagram(f.model,'top',hash,layout.scopes.top,{mode}),q=diagramQuality(graph);
     assert.equal(q.status,'passed',JSON.stringify(q));assert.equal(q.structuralFidelity.status,'passed');assert.equal(q.readingConstraints.status,'satisfied',JSON.stringify(q.readingConstraints));
     if(mode!=='signals')assert.equal(q.hiddenLabels.length,0,`${id}: missing relation names`);
     assert.equal(modelHash(f.model),hash);assert.equal(q.visualReview,'not_run');
     if(id==='fork_join'){
      const operands=graph.edges.filter(e=>e.target==='merge');assert.equal(new Set(operands.map(e=>e.targetHandle)).size,2,'different destination operands must not inherit a shared peer group ID');
      const ports=graph.nodes.find(n=>n.id==='merge')!.data.geometry.ports;assert(ports.some(p=>p.interfaceIds?.length===1&&p.interfaceIds[0]==='a'));assert(ports.some(p=>p.interfaceIds?.length===1&&p.interfaceIds[0]==='b'));
     }
     if(id==='shared_ram')for(const e of graph.edges.filter(e=>e.source==='store'&&e.data?.category==='response')){
      assert.equal(graph.nodes.find(n=>n.id===e.source)!.data.geometry.ports.find(p=>p.id===e.sourceHandle)!.side,'WEST');
      assert.equal(graph.nodes.find(n=>n.id===e.target)!.data.geometry.ports.find(p=>p.id===e.targetHandle)!.side,'EAST');
     }
     const focused={...graph,...highlightDiagram(graph,graph.nodes.find(n=>!n.data.boundary)!.id)};
     const geometry=(g:typeof graph)=>({nodes:g.nodes.map(n=>[n.id,n.position,n.data.geometry]),edges:g.edges.map(e=>[e.id,e.data?.routePoints])});
     assert.deepEqual(geometry(focused),geometry(graph),'ordinary selection must not re-layout');
     const svg=diagramSvg(f.model,'top',{reading:f.reading,positions,mode},hash,graph);assert(svg.includes(`data-model-hash="${hash}"`));assert(svg.includes(`data-view-mode="${mode}"`));
     modes.push({mode,quality:q});
    }
    const automatic=diagramQuality(scopeDiagram(f.model,'top',{positions:await arrangeScope(f.model,'top',hash)}));
    if(evidence){
     await mkdir(evidence,{recursive:true});const output=join(evidence,id);await exportBundle(workspace,output,f.model,undefined,layout);
     await cp(join(workspace,'rtl'),join(output,'rtl'),{recursive:true});
     const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
     manifest.files.push({file:`rtl/${id}.sv`,sha256:f.model.provenance!.sourceDigest,bytes:Buffer.byteLength(f.source)});
     await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    }
    reports.push({id,question:f.question,modelHash:hash,sourceHash:f.model.provenance!.sourceDigest,rtlTool:version,physicalConnectionsChecked:f.model.connections.length,automatic,constrained:modes});
   });
   await check('conflicting / fabricated reading constraints are rejected, including saved positions',async()=>{
    const f=await architecturePattern('fork_join');
    const staged={...f.reading,stages:[{id:'branches',label:'分支',nodes:['left','right']},{id:'join',label:'汇合',nodes:['merge']}]};
    const sp=await arrangeScope(f.model,'top',f.reading.modelHash,staged),sg=scopeDiagram(f.model,'top',{reading:staged,positions:sp});
    assert.equal(diagramQuality(sg).readingConstraints.status,'satisfied');assert.equal(diagramQuality(sg).status,'passed');
    sp.merge.x=-500;assert(diagramQuality(scopeDiagram(f.model,'top',{reading:staged,positions:sp})).readingConstraints.issues.some(i=>i.code==='STAGE_ORDER'));
    const invalid=[{...f.reading,mainPath:['left','right','merge']},{...f.reading,parallel:[{id:'p',label:'未知',nodes:['left','missing']}]},{...f.reading,control:['right']},{...f.reading,feedback:[{from:'merge',to:'left',side:'top' as const}]},{...f.reading,stages:[{id:'a',label:'一',nodes:['merge']},{id:'b',label:'二',nodes:['left','right']}]}];
    for(const reading of invalid){assert.throws(()=>validateReadingRefs(f.model,'top',reading));assert.throws(()=>scopeDiagram(f.model,'top',{reading,positions:{left:{x:0,y:0},right:{x:0,y:400},merge:{x:500,y:0}}}));}
    const ram=await architecturePattern('shared_ram');assert.throws(()=>validateReadingRefs(ram.model,'top',{...ram.reading,shared:[{node:'store',clients:['reader_a','reader_a']}]}));
    const repository=new Repository(join(root,'fork_join')),previous=await repository.getLayout();
    await assert.rejects(repository.putLayout({baseLayoutHash:previous.layoutHash,layout:{...previous.layout,scopes:{top:{...previous.layout.scopes.top,reading:invalid[0]}}}}));
    assert.deepEqual(await repository.getLayout(),previous);
   });
   await check('manual displacement reports unmet constraints without moving nodes or changing semantics',async()=>{
    const f=await architecturePattern('fork_join'),positions=await arrangeScope(f.model,'top',f.reading.modelHash,f.reading);positions.right.x+=130;
    const before=JSON.stringify(positions),{graph,positions:retained}=await prepareDiagram(f.model,'top',f.reading.modelHash,{reading:f.reading,positions,viewport:{x:0,y:0,zoom:1}});
    assert.equal(JSON.stringify(retained),before);assert(diagramQuality(graph).readingConstraints.issues.some(i=>i.code==='PARALLEL_COLUMN'));assert.equal(modelHash(f.model),f.reading.modelHash);
    const fifo=await architecturePattern('fifo'),fp=await arrangeScope(fifo.model,'top',fifo.reading.modelHash,fifo.reading),fg=scopeDiagram(fifo.model,'top',{positions:fp,reading:fifo.reading});
    for(const e of fg.edges)if(e.data?.readingFeedback)e.data.routePoints=[{x:0,y:200},{x:20,y:200}];
    assert(diagramQuality(fg).readingConstraints.issues.some(i=>i.code==='FEEDBACK_CHANNEL'));
   });
   await check('offline quality command: local-only scope arranged, stale layout / invalid scope rejected, no source writes',async()=>{
    const workspace=join(root,'accumulator'),cli=resolve('bin/rtlarch'),f=await architecturePattern('accumulator');
    const before=await readFile(join(workspace,'architecture/model.json'),'utf8');
    const run=(args:string[])=>JSON.parse(execFileSync(cli,['diagram-quality','--workspace',workspace,'--json',...args],{encoding:'utf8'}));
    const good=run([]);assert.equal(good.ok,true);assert.equal(good.readOnly,true);assert.equal(Object.keys(good.positions).length,2);assert.equal(good.quality.readingConstraints.status,'satisfied');
    const broken={...f.model,connections:[{...f.model.connections[0],to:{moduleId:'missing',interfaceId:'q'}}]};
    await writeFile(join(root,'broken-model.json'),JSON.stringify(broken));assert.throws(()=>run(['--model',join(root,'broken-model.json')]));
    assert.throws(()=>run(['--module','missing']));
    await writeFile(join(root,'stale-layout.json'),JSON.stringify({schemaVersion:1,scopes:{top:{reading:{...f.reading,modelHash:'a'.repeat(64)},positions:{},viewport:{x:0,y:0,zoom:1}}}}));
    assert.throws(()=>run(['--layout',join(root,'stale-layout.json')]));
    const fork=await architecturePattern('fork_join'),positions=await arrangeScope(fork.model,'top',fork.reading.modelHash,fork.reading);positions.right.x+=130;
    const moved=join(root,'moved-layout.json');await writeFile(moved,JSON.stringify({schemaVersion:1,scopes:{top:{positions,reading:fork.reading,viewport:{x:0,y:0,zoom:1}}}}));
    try{execFileSync(cli,['bundle',join(root,'diagnostic-bundle'),'--workspace',join(root,'fork_join'),'--layout',moved,'--json'],{encoding:'utf8'});assert.fail('unmet reading constraints must fail delivery');}catch(e){const result=JSON.parse(String((e as {stdout:string}).stdout));assert.equal(result.error.code,'DIAGRAM_QUALITY_FAILED');assert.match(result.error.message,/阅读约束/);}
    const diagnostic=JSON.parse(await readFile(join(root,'diagnostic-bundle/top.quality.json'),'utf8'));assert.equal(diagnostic.status,'passed');assert.equal(diagnostic.readingConstraints.status,'needs_attention');
    assert.equal(await readFile(join(workspace,'architecture/model.json'),'utf8'),before);
   });
   if(evidence){
    await writeFile(join(evidence,'benchmark.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks:count,patterns:reports,humanReadingReview:'not_run',note:'图形、声明约束及真实展开端点分别核对；没有功能仿真或人工正确率结论。'},null,2)+'\n');
    await writeFile(join(evidence,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>1.8 架构阅读样例</title><style>body{font:16px/1.7 system-ui;max-width:920px;margin:40px auto;padding:20px;color:#234}li{margin:20px 0}a{color:#17658b}</style><h1>六类真实 RTL 的阅读样例</h1><p>保留全部真实连接与 partial；并排、共享及外侧返回是展示约束，位置不代表时钟周期。</p><ul>${(reports as {id:string;question:string}[]).map(r=>`<li><a href="${r.id}/index.html">${r.id}</a> — ${r.question}<br><a href="${r.id}/rtl/${r.id}.sv">RTL 源码</a> · <a href="${r.id}/top.quality.json">图形检查</a></li>`).join('')}</ul><p><a href="benchmark.json">本次工具检查记录</a>；使用者阅读验收尚未执行，不能由几何通过替代。</p></html>`);
   }
   console.log(`完成 ${count} 组布局约束检查。`);
  }finally{await rm(root,{recursive:true,force:true});}
}

export async function checkOfflineDelivery() {
  const root = await mkdtemp(join(tmpdir(),'rtlarch-delivery-')), exec = promisify(execFile);
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  let checks = 0;
  async function check(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${++checks}: ${name}`); }
  const model: Model = modelSchema.parse(JSON.parse(await readFile(join(toolRoot,'examples/packet-pipeline/model.json'),'utf8')));
  const env = { ...process.env }; delete env.RTLARCH_API_PORT; delete env.RTLARCH_WORKSPACE;
  async function cli(args: string[], expected = true) {
    let stdout: string;
    try { stdout = (await exec(join(toolRoot,'bin/rtlarch'), [...args,'--workspace',root,'--json'], {env,cwd:root,timeout:60000,maxBuffer:4*1024*1024})).stdout; assert.ok(expected); }
    catch (e) { if(expected) throw e; stdout = (e as {stdout:string}).stdout; }
    const result=JSON.parse(stdout); assert.equal(result.ok,expected); return result;
  }
  try {
    await mkdir(join(root,'architecture')); await writeFile(join(root,'source.txt'),'source v1');
    model.schemaVersion = 3;
    model.provenance = { origin:'design',fidelity:'exact',scope:'fixture',sourceDigest:sha('source v1'),configuration:'fixture',coverage:{elaboratedInstances:model.modules.length,representedInstances:model.modules.length},evidence:[{id:'source',file:'source.txt',fileHash:sha('source v1'),sourceKind:'code'}],findings:[],unsupportedStructures:[],verification:[] };
    await writeFile(join(root,'architecture/model.json'),JSON.stringify(model));
    const sourceBytes=await readFile(join(root,'architecture/model.json'));
    await check('freshness reports matching, changed, missing, external symlink, no evidence without mutating the model', async()=>{
      assert.equal((await evidenceFreshness(root,model)).status,'fresh');
      await writeFile(join(root,'source.txt'),'source v2'); assert.equal((await evidenceFreshness(root,model)).files[0].state,'changed');
      await writeFile(join(root,'source.txt'),'source v1');
      const variant=structuredClone(model); variant.provenance!.evidence[0].file='missing'; assert.equal((await evidenceFreshness(root,variant)).files[0].state,'missing');
      await symlink('/etc/passwd',join(root,'outside')); variant.provenance!.evidence[0].file='outside'; assert.equal((await evidenceFreshness(root,variant)).files[0].state,'outside_workspace');
      variant.provenance!.evidence=[]; assert.equal((await evidenceFreshness(root,variant)).status,'unknown');
      assert.deepEqual(await readFile(join(root,'architecture/model.json')),sourceBytes);
    });
    await check('CLI remains offline, fails on stale/unknown evidence and refuses unrelated flags', async()=>{
      assert.equal((await cli(['evidence'])).status,'fresh');
      await writeFile(join(root,'source.txt'),'new'); assert.equal((await cli(['evidence'],false)).error.code,'EVIDENCE_ATTENTION');
      await writeFile(join(root,'source.txt'),'source v1');
      const variant=structuredClone(model); delete variant.provenance; await writeFile(join(root,'no-evidence.json'),JSON.stringify(variant));
      assert.equal((await cli(['evidence','--model','no-evidence.json'],false)).error.code,'EVIDENCE_UNKNOWN');
      assert.equal((await cli(['context','--model','no-evidence.json'],false)).error.code,'USAGE');
      await assert.rejects(access(join(root,'.rtlarch')));
    });
    await check('reading constraints preserve semantic hash, order the main path, and reject stale or duplicate assignments', async()=>{
      const children=model.modules.filter(m=>m.parent===model.design.top).map(m=>m.id),hash=modelHash(model);
      const reading={modelHash:hash,reason:'fixture main path',mainPath:children,control:[],adjacent:[]};
      const positions=await arrangeScope(model,model.design.top,hash,reading);
      children.slice(1).forEach((id,i)=>assert.ok(positions[id].x>positions[children[i]].x));
      assert.equal(modelHash(model),hash);
      await assert.rejects(arrangeScope(model,model.design.top,hash,{...reading,modelHash:'0'.repeat(64)}));
      await assert.rejects(arrangeScope(model,model.design.top,hash,{...reading,control:[children[0]]}));
    });
    await check('bundle is self-contained, artifact hashes match, approval is independent of verification, sources remain untouched',async()=>{
      const repo=new Repository(root),snapshot=await repo.getModel();
      const result=await exportBundle(root,join(root,'delivery'),model,snapshot);
      const manifest=JSON.parse(await readFile(join(result.directory,'manifest.json'),'utf8'));
      for(const entry of manifest.files) assert.equal(sha(await readFile(join(result.directory,entry.file))),entry.sha256,entry.file);
      assert.equal(manifest.states.implementation.status,'not_checked'); assert.equal(manifest.states.physical.status,'not_checked');
      const contract=JSON.parse(await readFile(join(result.directory,'contract.json'),'utf8')); assert.equal(contract.modelHash,modelHash(model));
      const connections=JSON.parse(await readFile(join(result.directory,'connections.json'),'utf8')); assert.deepEqual(connections.connections,model.connections);
      assert.deepEqual(await readFile(join(root,'architecture/model.json')),sourceBytes);
      await assert.rejects(access(join(root,'architecture/review.json'))); await assert.rejects(access(join(root,'generated')));
      const candidate=await cli(['bundle','candidate','--model','architecture/model.json']); assert.equal(candidate.reviewStatus,'CANDIDATE');
    });
    await check('bundle refuses protected directories, symlink aliases and existing output; escaped HTML cannot inject markup',async()=>{
      await assert.rejects(exportBundle(root,join(root,'architecture','out'),model),e=>(e as {code:string}).code==='OUTPUT_PROTECTED');
      await symlink(join(root,'architecture'),join(root,'alias'));
      await assert.rejects(exportBundle(root,join(root,'alias','out'),model),e=>(e as {code:string}).code==='OUTPUT_PROTECTED');
      await assert.rejects(exportBundle(root,join(root,'delivery'),model),e=>(e as {code:string}).code==='EEXIST');
      const hostile=structuredClone(model);hostile.design.name='<script>alert(1)</script>';
      await exportBundle(root,join(root,'escaped'),hostile);
      const page=await readFile(join(root,'escaped/index.html'),'utf8');assert.ok(!page.includes(hostile.design.name));assert.ok(page.includes('&lt;script&gt;'));assert.equal([...page.matchAll(/<script\b/g)].length,2);assert.ok(page.includes('diagram-metadata'));
    });
    await check('geometry failures retain a diagnostic package and exit nonzero; every connection keeps exact endpoint mapping',async()=>{
      const scopes=Object.fromEntries(model.modules.filter(m=>m.kind==='subsystem').map(m=>[m.id,{positions:Object.fromEntries(model.modules.filter(n=>n.parent===m.id).map(n=>[n.id,{x:0,y:0}])),viewport:{x:0,y:0,zoom:1}}]));
      await writeFile(join(root,'overlap.json'),JSON.stringify(layoutSchema.parse({schemaVersion:1,scopes})));
      const result=await cli(['bundle','overlap','--layout','overlap.json'],false);assert.equal(result.error.code,'DIAGRAM_QUALITY_FAILED');
      const report=JSON.parse(await readFile(join(root,'overlap',`${model.design.top}.quality.json`),'utf8'));assert.ok(report.overlaps.length);
      assert.deepEqual(report.connections.map((l:any)=>({id:l.id,from:l.from,to:l.to})),model.connections.filter(l=>l.scope===model.design.top).map(l=>({id:l.id,from:l.from,to:l.to})));
    });
    await check('routing is stable under connection record reordering; no diagram operation mutates the model',async()=>{
      const positions=await arrangeScope(model,model.design.top,modelHash(model));
      const before=modelHash(model),a=scopeDiagram(model,model.design.top,{positions});
      const variant=structuredClone(model);variant.connections.reverse();const b=scopeDiagram(variant,model.design.top,{positions});
      const paths=(g:typeof a)=>Object.fromEntries(g.edges.map(e=>[e.id,e.data?.routePoints]));assert.deepEqual(paths(a),paths(b));
      assert.equal(modelHash(model),before);assert.equal(diagramQuality(a).connections.length,model.connections.filter(l=>l.scope===model.design.top).length);
    });
  } finally { await rm(root,{recursive:true,force:true}); }
  console.log(`完成 ${checks} 组证据、交付与布局检查。`);
}
