import assert from 'node:assert/strict';
import {mappedFixture} from './review-fixture';
import {modelHash} from '../src/core/export';
import {inspectScope} from '../src/core/inspection';
import {specMarkdown} from '../src/core/spec';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {routeEdges} from '../src/web/graph/orthogonal';
import type {RtlNode} from '../src/web/graph/types';
import type {Edge} from '@xyflow/react';
import {diagramSvg} from '../src/web/graph/exportSvg';
import {excerpt} from '../src/web/reading';
import type {Model} from '../src/core/schema';
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
