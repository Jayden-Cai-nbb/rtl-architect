import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {architecturePattern,patternIds} from './architecture-patterns';
import {modelHash} from '../src/core/export';
import {layoutSchema,type Endpoint} from '../src/core/schema';
import {validateModel} from '../src/core/engine';
import {highlightDiagram} from '../src/web/graph/selection';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {prepareDiagram} from '../src/web/graph/prepareDiagram';
import {arrangeScope} from '../src/web/graph/readingLayout';
import {diagramQuality} from '../src/web/graph/quality';
import {diagramSvg} from '../src/web/graph/exportSvg';
import {validateReadingRefs} from '../src/web/graph/readingRefs';
import {exportBundle} from '../src/workspace/bundle';
import {Repository} from '../src/workspace/repository';
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
  const workspace=join(root,'accumulator'),cli=resolve('scripts/cli.ts'),f=await architecturePattern('accumulator');
  const before=await readFile(join(workspace,'architecture/model.json'),'utf8');
  const run=(args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx',cli,'diagram-quality','--workspace',workspace,'--json',...args],{encoding:'utf8'}));
  const good=run([]);assert.equal(good.ok,true);assert.equal(good.readOnly,true);assert.equal(Object.keys(good.positions).length,2);assert.equal(good.quality.readingConstraints.status,'satisfied');
  const broken={...f.model,connections:[{...f.model.connections[0],to:{moduleId:'missing',interfaceId:'q'}}]};
  await writeFile(join(root,'broken-model.json'),JSON.stringify(broken));assert.throws(()=>run(['--model',join(root,'broken-model.json')]));
  assert.throws(()=>run(['--module','missing']));
  await writeFile(join(root,'stale-layout.json'),JSON.stringify({schemaVersion:1,scopes:{top:{reading:{...f.reading,modelHash:'a'.repeat(64)},positions:{},viewport:{x:0,y:0,zoom:1}}}}));
  assert.throws(()=>run(['--layout',join(root,'stale-layout.json')]));
  const fork=await architecturePattern('fork_join'),positions=await arrangeScope(fork.model,'top',fork.reading.modelHash,fork.reading);positions.right.x+=130;
  const moved=join(root,'moved-layout.json');await writeFile(moved,JSON.stringify({schemaVersion:1,scopes:{top:{positions,reading:fork.reading,viewport:{x:0,y:0,zoom:1}}}}));
  try{execFileSync(process.execPath,['--import','tsx',cli,'bundle',join(root,'diagnostic-bundle'),'--workspace',join(root,'fork_join'),'--layout',moved,'--json'],{encoding:'utf8'});assert.fail('unmet reading constraints must fail delivery');}catch(e){const result=JSON.parse(String((e as {stdout:string}).stdout));assert.equal(result.error.code,'DIAGRAM_QUALITY_FAILED');assert.match(result.error.message,/阅读约束/);}
  const diagnostic=JSON.parse(await readFile(join(root,'diagnostic-bundle/top.quality.json'),'utf8'));assert.equal(diagnostic.status,'passed');assert.equal(diagnostic.readingConstraints.status,'needs_attention');
  assert.equal(await readFile(join(workspace,'architecture/model.json'),'utf8'),before);
 });
 if(evidence){
  await writeFile(join(evidence,'benchmark.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks:count,patterns:reports,humanReadingReview:'not_run',note:'图形、声明约束及真实展开端点分别核对；没有功能仿真或人工正确率结论。'},null,2)+'\n');
  await writeFile(join(evidence,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>1.8 架构阅读样例</title><style>body{font:16px/1.7 system-ui;max-width:920px;margin:40px auto;padding:20px;color:#234}li{margin:20px 0}a{color:#17658b}</style><h1>六类真实 RTL 的阅读样例</h1><p>保留全部真实连接与 partial；并排、共享及外侧返回是展示约束，位置不代表时钟周期。</p><ul>${(reports as {id:string;question:string}[]).map(r=>`<li><a href="${r.id}/index.html">${r.id}</a> — ${r.question}<br><a href="${r.id}/rtl/${r.id}.sv">RTL 源码</a> · <a href="${r.id}/top.quality.json">图形检查</a></li>`).join('')}</ul><p><a href="benchmark.json">本次工具检查记录</a>；使用者阅读验收尚未执行，不能由几何通过替代。</p></html>`);
 }
 console.log(`完成 ${count} 组布局约束检查。`);
}finally{await rm(root,{recursive:true,force:true});}
