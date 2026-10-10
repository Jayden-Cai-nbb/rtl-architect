import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {reviewFixture,mappedFixture} from './review-fixture';
import {validateModel,applyCommands} from '../src/core/engine';
import {expandLink} from '../src/core/signals';
import {modelHash} from '../src/core/export';
import {moduleDocument} from '../src/core/spec';
import {parameterValue,parameterReport} from '../src/core/parameters';
import {coverageReport} from '../src/core/coverage';
import {diagnosticGroups} from '../src/core/diagnostics';
import {inspectScope} from '../src/core/inspection';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {serializeRequest,requestLimitBytes,RequestSizeError} from '../src/core/transport';
import {Repository,atomicWrite} from '../src/workspace/repository';
import {startService} from '../src/server/service';
let checks=0;const dir=await mkdtemp(join(tmpdir(),'rtlarch-review-check-'));let service:Awaited<ReturnType<typeof startService>>|undefined;
async function check(name:string,fn:()=>unknown|Promise<unknown>){await fn();console.log(`PASS ${++checks}: ${name}`)}
try{
 const mapped=mappedFixture(),large=reviewFixture();
 await check('45 affine rules represent 11,520 CNU-like connections and resolve indices 0/123/255 exactly',()=>{
  assert.equal(mapped.connections.length,45);assert.equal(mapped.connections.flatMap(c=>expandLink(mapped,c)).length,11520);
  assert.ok(!validateModel(mapped).some(i=>i.blocks.includes('commit')));
  for(const index of [0,123,255]){const link=expandLink(mapped,mapped.connections[0],{moduleId:'lane_0',index})[0];assert.deepEqual(link.from.slice,{lsb:index*30,msb:index*30+29});assert.equal(link.to.index,index);assert.equal(link.id,'map_0_0');}
  const proposal={baseHash:modelHash(large),reason:'affine map',commands:[{op:'replace_architecture',model:mapped}]};assert.ok(serializeRequest(proposal).bytes<200000);
  const invalid=structuredClone(mapped);invalid.connections[0].from.sliceMapping!.offset=1;assert.ok(validateModel(invalid).some(i=>i.code==='SCOPE_REFERENCE'));
  const overlap=structuredClone(mapped);overlap.connections[0].to.sliceMapping={arrayModuleId:'lane_0',offset:0,stride:0,width:30};overlap.connections.push({...overlap.connections[0],id:'duplicate_rule'});assert.ok(validateModel(overlap).some(i=>i.code==='MULTI_DRIVER'));
  invalid.connections[0].from.sliceMapping!.arrayModuleId='lane_1';assert.ok(validateModel(invalid).some(i=>i.code==='ARRAY_CONNECTION'));
 });
 await check('typed string references preserve ROM paths, trace multi-level dependency, and reject type/cycle errors',()=>{
  const lane=mapped.modules.find(m=>m.id==='lane_0')!;assert.equal(parameterValue(mapped,lane,'ROM_FILE',123),'data/rom.hex');
  const report=parameterReport(mapped,mapped.modules[0]);assert.ok(report.find(p=>p.key==='ROM_FILE')!.paths.some(p=>p.join(' > ')==='top.ROM_FILE > pro.INIT_FILE > lane_0.ROM_FILE'));assert.deepEqual(report.find(p=>p.key==='UNUSED')!.paths,[]);
  const changed=applyCommands(mapped,[{op:'set_parameter',moduleId:'top',key:'ROM_FILE',value:'other.hex'}]).model;assert.equal(parameterValue(changed,changed.modules.find(m=>m.id==='lane_0')!,'ROM_FILE',255),'other.hex');
  assert.throws(()=>applyCommands(mapped,[{op:'set_parameter',moduleId:'top',key:'ROM_FILE',value:8}]));
  assert.throws(()=>applyCommands(mapped,[{op:'set_parameter_binding',moduleId:'top',key:'ROM_FILE',binding:{scope:'self',reference:'ROM_FILE',type:'string'}}]));
  const literal=structuredClone(mapped);literal.modules[0].parameters.hff=1;literal.modules[1].parameters.VALUE=255;literal.modules[1].parameterBindings={VALUE:{scope:'parent',expression:"8'hff"}};assert.deepEqual(parameterReport(literal,literal.modules[0]).find(p=>p.key==='hff')!.paths,[]);
 });
 await check('causal ranges group only matching diagnostics; related module evidence does not absorb source/reset/contract unknowns',()=>{
  const model=structuredClone(large);model.modules.find(m=>m.id==='lane_0')!.contract.openQuestions=['是否取消在途数据？'];model.resets[0].synchronous=false;model.resets[0].deassertion='unknown';
  const issues=validateModel(model);assert.equal(issues.filter(i=>i.causeIds?.includes('import_gap')&&i.code==='REQUIRED_UNCONNECTED').length,256);
  for(const code of ['SOURCE_UNRESOLVED','OPEN_QUESTIONS','RESET_RELEASE_UNKNOWN'])assert.ok(issues.some(i=>i.code===code&&!i.causeIds?.length));
  model.provenance!.unsupportedStructures[0].causes=undefined;assert.equal(validateModel(model).filter(i=>i.code==='REQUIRED_UNCONNECTED'&&i.causeIds?.length).length,0);
 });
 await check('more than 15,000 diagnostics retain exact totals while grouping by port and index range',()=>{
  const issues=validateModel(large),groups=diagnosticGroups(large,issues);assert.ok(issues.length>15000);assert.equal(groups.reduce((n,g)=>n+g.count,0),issues.length);assert.ok(groups.length<15);assert.ok(groups.flatMap(g=>g.items).some(i=>i.indexLabel==='0–255'&&i.issues.length===256));
 });
 await check('coverage separates instance paths from bits, drivers, bindings, behavior and actual verification',()=>{
  const before=coverageReport(mapped),changed=structuredClone(mapped);changed.connections.pop();const after=coverageReport(changed);
  assert.equal(before.instances.represented,1827);assert.equal(before.instances.status,'complete');assert.equal(before.portBits.status,'partial');assert.equal(before.portBits.expected,null);assert.equal(before.behavior.status,'partial');assert.ok(after.portBits.covered<before.portBits.covered);assert.equal(before.verification.length,0);
 });
 await check('main graph excludes boundary modules from layout, preserves all IDs and positions across inspection/auxiliary/local toggles',()=>{
  const model=structuredClone(mapped);const positions={mem:{x:0,y:0},pro:{x:400,y:0},config:{x:0,y:230}},before=modelHash(model);
  model.connections.push({id:'aux',scope:'top',from:{moduleId:'top',interfaceId:'llr_0'},to:{moduleId:'config',interfaceId:'in'}});model.modules.find(m=>m.id==='config')!.interfaces=[{id:'in',protocol:'signal',role:'consumer',width:8,required:false}];
  const current=modelHash(model),base=scopeDiagram(model,'top',{positions}),selected=scopeDiagram(model,'top',{positions,inspection:{kind:'connection',ids:['aux']}});
  assert.equal(base.nodes.filter(n=>!n.data.boundary&&!n.data.localId).length,3);assert.equal(base.auxiliaryCount,1);assert.equal(selected.edges.flatMap(e=>e.data?.connectionIds??[]).length,1);
  assert.equal((base.nodes.find(n=>n.id==='rack:top:consumer')!.data.groups as {count:number}[])[0].count,32);
  for(const id of ['mem','pro','config'])assert.deepEqual(base.nodes.find(n=>n.id===id)!.position,selected.nodes.find(n=>n.id===id)!.position);
  assert.equal(modelHash(model),current);assert.notEqual(before,current);
  const pro=model.modules.find(m=>m.id==='pro')!,mem=model.modules.find(m=>m.id==='mem')!;
  pro.interfaceGroups=[{id:'request',label:'存储请求',category:'request',description:'请求读取地址'},{id:'writeback',label:'结果写回',category:'writeback',description:'写回处理结果'}];mem.interfaceGroups=[{id:'response',label:'返回数据',category:'response',description:'返回读取结果'}];
  for(const group of ['request','writeback']){pro.interfaces.push({id:group,role:'producer',protocol:'signal',width:1,required:false,group});mem.interfaces.push({id:group,role:'consumer',protocol:'signal',width:1,required:false});model.connections.push({id:group,scope:'top',from:{moduleId:'pro',interfaceId:group},to:{moduleId:'mem',interfaceId:group}})}
  mem.interfaces.push({id:'response',role:'producer',protocol:'signal',width:1,required:false,group:'response'});pro.interfaces.push({id:'response',role:'consumer',protocol:'signal',width:1,required:false});model.connections.push({id:'response',scope:'top',from:{moduleId:'mem',interfaceId:'response'},to:{moduleId:'pro',interfaceId:'response'}});
  const routed=scopeDiagram(model,'top',{positions:{pro:{x:0,y:0},mem:{x:420,y:0},config:{x:0,y:230}}});
  const request=routed.edges.find(e=>e.data?.category==='request')!,writeback=routed.edges.find(e=>e.data?.category==='writeback')!,response=routed.edges.find(e=>e.data?.category==='response')!;
  assert.notEqual(request.data?.laneOffset,writeback.data?.laneOffset);assert.equal(response.data?.feedback,true);assert.deepEqual(request.data?.connectionIds,['request']);
 });
 await check('array inspection resolves only the selected slice and marks unimported element 124 explicitly',()=>{
  for(const index of [0,123,255]){const detail=inspectScope(mapped,'pro',{kind:'array',id:'lane_0',index});assert.equal(detail.links.length,9);assert.equal(detail.links[0].from.slice?.lsb,index*30);assert.equal(detail.missing.length,0);assert.equal(moduleDocument(mapped,'lane_0',index).connections.length,9);}
  const partial=structuredClone(mapped);partial.connections=partial.connections.flatMap(l=>[0,123,255].flatMap(index=>expandLink(mapped,l,{moduleId:l.to.moduleId,index})).map((l,i)=>({...l,id:`${l.id}_${i}`})));
  const missing=inspectScope(partial,'pro',{kind:'array',id:'lane_0',index:124});assert.equal(missing.links.length,0);assert.equal(missing.missing.length,9);
 });
 await check('request budget uses UTF-8 bytes and reports exact size and controlled limit',()=>{
  const value={text:'界'.repeat(requestLimitBytes/3+1)};assert.throws(()=>serializeRequest(value),e=>e instanceof RequestSizeError&&e.actualBytes===Buffer.byteLength(JSON.stringify(value))&&e.limitBytes===requestLimitBytes);
 });
 await atomicWrite(join(dir,'architecture/model.json'),JSON.stringify(large));service=await startService(dir,{port:0});
 const post=async(path:string,body:unknown)=>fetch(service!.info.apiUrl+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 await check('real preview accepts compressed full-index mapping; oversized HTTP request gets 413 with byte counts',async()=>{
  const proposal={baseHash:modelHash(large),reason:'temporary affine preview',commands:[{op:'replace_architecture',model:mapped}]};const response=await post('preview',proposal);assert.equal(response.status,200);const result=await response.json();assert.ok(result.candidateHash);assert.equal(JSON.parse(await readFile(join(dir,'architecture/model.json'),'utf8')).connections.length,0);
  const body={text:'x'.repeat(requestLimitBytes)};const oversized=await post('preview',body);assert.equal(oversized.status,413);const error=await oversized.json();assert.equal(error.code,'REQUEST_TOO_LARGE');assert.equal(error.details.actualBytes,Buffer.byteLength(JSON.stringify(body)));assert.equal(error.details.limitBytes,requestLimitBytes);
 });
 await check('proposal creation version is immutable; legacy metadata stays unknown and model hash stays unchanged',async()=>{
  const repo=new Repository(dir),proposal={baseHash:modelHash(large),reason:'metadata',commands:[{op:'rename_module',moduleId:'top',name:'Review'}]};const record=await repo.registerProposal(proposal);assert.ok(record.createdWith);assert.equal((await repo.getProposal(record.id)).createdWith,record.createdWith);assert.equal((await repo.getModel()).modelHash,modelHash(large));
  // Simulate a pre-version-recording registration, only in the isolated test project.
  const file=join(dir,'proposals/registered',record.id+'.json'),legacy=JSON.parse(await readFile(file,'utf8'));delete legacy.createdWith;await writeFile(file,JSON.stringify(legacy));assert.equal((await repo.getProposal(record.id)).createdWith,undefined);
 });
 console.log(`完成 ${checks} 组主图与大规模审阅检查。`);
}finally{await service?.close();await rm(dir,{recursive:true,force:true})}
