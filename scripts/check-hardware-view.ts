import {refineSpacing} from '../src/web/graph/layoutFeedback';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {modelSchema} from '../src/core/schema';
import {modelHash} from '../src/core/export';
import {hardwareView,dependencyRoles,type ViewMode} from '../src/core/hardwareView';
import {linkGroup} from '../src/core/inspection';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {diagramQuality} from '../src/web/graph/quality';
import {diagramSvg} from '../src/web/graph/exportSvg';
import {arrangeScope} from '../src/web/graph/readingLayout';
import {autoReadingFixture} from './auto-reading-fixture';
import {feedbackFixture} from './feedback-fixture';
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
