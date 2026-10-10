import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelSchema, layoutSchema, type Model } from '../src/core/schema';
import { modelHash } from '../src/core/export';
import { evidenceFreshness } from '../src/workspace/freshness';
import { exportBundle } from '../src/workspace/bundle';
import { Repository } from '../src/workspace/repository';
import { toolRoot } from '../src/workspace/environment';
import { arrangeScope } from '../src/web/graph/readingLayout';
import { scopeDiagram } from '../src/web/graph/scopeDiagram';
import { diagramQuality } from '../src/web/graph/quality';

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
