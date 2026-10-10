import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {autoReadingFixture} from './auto-reading-fixture';
import {modelHash} from '../src/core/export';
import {modelSchema} from '../src/core/schema';
import {validateModel} from '../src/core/engine';
import {interfaceGroup} from '../src/core/inspection';
import {arrangeScope} from '../src/web/graph/readingLayout';
import {scopeDiagram} from '../src/web/graph/scopeDiagram';
import {diagramQuality} from '../src/web/graph/quality';
import {exportBundle} from '../src/workspace/bundle';
let checks=0;
const output=process.argv[2];if(output)await mkdir(resolve(output),{recursive:true});
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
  if(output)await exportBundle(process.cwd(),join(resolve(output),shape),model);
  console.log(`PASS ${++checks}: ${shape}: geometry, labels, exact connections, deterministic layout and stable selection (${q.crossings} crossings)`);
}
console.log(`完成 ${checks} 组默认阅读布局检查。`);
