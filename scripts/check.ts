// Core checks using Node assertions; all writes target a temporary workspace.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelSchema, type Model, type Proposal } from '../src/core/schema';
import { applyCommands, validateModel, resolveEndpoint } from '../src/core/engine';
import { semanticDiff } from '../src/core/diff';
import { specMarkdown } from '../src/core/spec';
import { modelHash } from '../src/core/export';
import { Repository, atomicWrite } from '../src/workspace/repository';
import { createApp } from '../src/server/app';
import { scopeDiagram } from '../src/web/graph/scopeDiagram';
import { elkLayout } from '../src/web/graph/elkLayout';
const initial = modelSchema.parse(JSON.parse(await readFile('examples/tiny-stream/model.json', 'utf8')));
const generic = modelSchema.parse(JSON.parse(await readFile('examples/packet-pipeline/model.json', 'utf8')));
let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${checks}: ${name}`); }
const workspace = await mkdtemp(join(tmpdir(), 'rtlarch-v2-check-'));
let server: ReturnType<typeof createServer> | undefined;
try {
  await atomicWrite(join(workspace, 'architecture/model.json'), JSON.stringify(initial));
  const repo = new Repository(workspace);
  await check('v1 fixture remains unchanged and generic v2 hierarchy validates', () => {
    assert.equal(modelHash(initial), '67d8474cbde520a73e057ef9f1260bdb3f92ab2c9450c3c9c0376aa0165929cd');
    assert.deepEqual(validateModel(initial), []); assert.deepEqual(validateModel(generic), []);
    assert.equal(resolveEndpoint(generic, 'processing', { moduleId: 'processing', interfaceId: 'request' })?.direction, 'source');
    assert.equal(resolveEndpoint(generic, 'packet_top', { moduleId: 'processing', interfaceId: 'request' })?.direction, 'target');
  });
  await check('invalid reference/protocol/width and malformed duplicate hierarchy are rejected without mutation', () => {
    const before = JSON.stringify(generic);
    assert.throws(() => applyCommands(generic, [{ op: 'set_parameter', moduleId: 'buffer', key: 'DATA_W', value: 64 }]));
    assert.throws(() => applyCommands(generic, [{ op: 'update_interfaces', moduleId: 'buffer', interfaces: [{ ...generic.modules.find(m => m.id === 'buffer')!.interfaces[0], protocol: 'axi' }] }]));
    assert.throws(() => applyCommands(generic, [{ op: 'update_specification', specification: { ...generic.specification!, requirements: [{ id: 'R', text: 'test', moduleIds: ['missing'], acceptance: 'check' }] } }]));
    const bad = structuredClone(generic); bad.modules.push({ ...bad.modules[0], kind: 'module' });
    assert.ok(validateModel(bad).some(i => i.blocks.includes('commit'))); assert.equal(JSON.stringify(generic), before);
  });
  await check('preview carries a canonical candidate, does not write files, and stale commits conflict', async () => {
    const current = await repo.getModel();
    const proposal: Proposal = { baseHash: current.modelHash, reason: 'generic architecture', commands: [{ op: 'replace_architecture', model: generic }] };
    const preview = await repo.preview(proposal);
    assert.equal(preview.candidateHash, modelHash(preview.candidate)); assert.equal(preview.candidate.modules.length, 7);
    assert.equal((await repo.getModel()).modelHash, current.modelHash);
    assert.ok(preview.diff.some(d => d.target === 'specification'));
    await repo.commit({ proposal, candidateHash: preview.candidateHash });
    await assert.rejects(repo.commit({ proposal, candidateHash: preview.candidateHash }), { status: 409 });
    assert.equal((await new Repository(workspace).getModel()).modelHash, preview.candidateHash);
  });
  await check('generic scalar parameters, interface edits and stable-ID diff', () => {
    const changed = applyCommands(generic, [{ op: 'set_parameter', moduleId: 'compute', key: 'ENABLE_CHECK', value: false }, { op: 'rename_module', moduleId: 'compute', name: 'Execution' }]);
    assert.equal(changed.model.modules.find(m => m.id === 'compute')?.parameters.ENABLE_CHECK, false);
    assert.ok(semanticDiff(generic, changed.model).some(d => d.kind === 'rename'));
    const extended = applyCommands(generic, [{ op: 'update_interfaces', moduleId: 'compute', interfaces: [...generic.modules.find(m => m.id === 'compute')!.interfaces, { id: 'flag', role: 'producer', protocol: 'signal', width: 1, required: false }] }]);
    assert.deepEqual(extended.issues, []);
  });
  await check('spec is deterministic, links requirements and renders resolved interfaces', async () => {
    const snapshot = await repo.getModel(), spec = await repo.getSpec('buffer');
    assert.equal(spec.markdown, specMarkdown(snapshot.model, snapshot.modelHash, snapshot.reviewStatus, snapshot.issues, 'buffer'));
    assert.match(spec.markdown, /REQ_BUFFER/); assert.match(spec.markdown, /128/); assert.match(spec.markdown, /16/);
    assert.equal((await repo.getSpec()).markdown, (await repo.getSpec()).markdown);
  });
  await check('projection and ELK use generic multiple ports and scope-aware edges', async () => {
    const graph = scopeDiagram(generic, 'packet_top');
    assert.equal(graph.nodes.filter(n=>!n.data.boundary).length, 3); assert.equal(graph.edges.length, 4);
    assert.ok(graph.nodes.some(n=>n.id==='rack:packet_top:consumer'));assert.equal(generic.modules.find(m=>m.id==='ingress')!.interfaces.length,3);
    const positions = await elkLayout(graph.nodes, graph.edges);
    assert.ok(positions.ingress.x < positions.processing.x);
  });
  await check('draft cannot globally approve or hand off; per-module confirmations are independent', async () => {
    const current = await repo.getModel();
    await assert.rejects(repo.review({ modelHash: current.modelHash, reviewer: 'temporary' }), { status: 422 });
    await assert.rejects(repo.handoff('compute'), { status: 422 });
    await repo.reviewModule({ modelHash: current.modelHash, moduleId: 'packet_top', reviewer: 'temporary' });
    const next = await repo.getModel(); assert.equal(next.reviewStatus, 'DRAFT');
    assert.equal(next.moduleReviews.filter(r => r.status === 'APPROVED').length, 1);
    await assert.rejects(repo.reviewModule({ modelHash: '0'.repeat(64), moduleId: 'buffer', reviewer: 'temporary' }), { status: 409 });
  });
  await check('all module confirmations, approval, export and exact-contract handoff', async () => {
    const current = await repo.getModel();
    for (const module of current.model.modules) await repo.reviewModule({ modelHash: current.modelHash, moduleId: module.id, reviewer: 'temporary' });
    await repo.review({ modelHash: current.modelHash, reviewer: 'temporary' });
    await assert.rejects(repo.handoff('buffer'), { status: 409 });
    await repo.export({ modelHash: current.modelHash, kind: 'contract' });
    const handoff = await repo.handoff('buffer'); assert.equal(handoff.modelHash, current.modelHash); assert.ok(handoff.requirements.some(r => r.id === 'REQ_BUFFER'));
    await writeFile(join(workspace, 'generated/contract.json'), '{}');
    await assert.rejects(repo.handoff('buffer'), { status: 409 });
    await repo.export({ modelHash: current.modelHash, kind: 'contract' });
  });
  await check('layout saves leave confirmation valid and stale layout writes fail', async () => {
    const current = await repo.getModel(), old = await repo.getLayout();
    await repo.putLayout({ baseLayoutHash: old.layoutHash, layout: { schemaVersion: 1, scopes: { packet_top: { positions: { ingress: { x: 50, y: 40 } }, viewport: { x: 0, y: 0, zoom: 1 } } } } });
    await assert.rejects(repo.putLayout({ baseLayoutHash: old.layoutHash, layout: old.layout }), { status: 409 });
    assert.equal((await repo.getModel()).modelHash, current.modelHash); assert.equal((await repo.getModel()).reviewStatus, 'APPROVED');
  });
  await check('semantic edits invalidate all module reviews and block old handoff', async () => {
    const current = await repo.getModel(), proposal = { baseHash: current.modelHash, reason: 'edit spec', commands: [{ op: 'set_parameter', moduleId: 'buffer', key: 'DEPTH', value: 32 }] };
    const preview = await repo.preview(proposal); await repo.commit({ proposal, candidateHash: preview.candidateHash });
    const next = await repo.getModel(); assert.equal(next.reviewStatus, 'STALE'); assert.ok(next.moduleReviews.every(r => r.status === 'STALE'));
    await assert.rejects(repo.handoff('buffer'), { status: 422 });
  });
  await check('incomplete requirements and unconnected ports block review but permit drafts', async () => {
    const current = await repo.getModel();
    const spec = { ...current.model.specification!, requirements: [{ id: 'UNFINISHED', text: 'missing acceptance', moduleIds: ['compute', 'buffer'], acceptance: '' }] };
    const result = applyCommands(current.model, [{ op: 'update_specification', specification: spec }, { op: 'disconnect', connectionId: 'buffer_compute' }]);
    assert.deepEqual(result.issues.filter(i => i.code === 'ACCEPTANCE_MISSING').map(i => i.target).sort(), ['buffer', 'compute']); assert.ok(result.issues.some(i => i.code === 'REQUIRED_UNCONNECTED'));
    const proposal = { baseHash: current.modelHash, reason: 'draft', commands: [{ op: 'replace_architecture', model: result.model }] };
    const preview = await repo.preview(proposal); await repo.commit({ proposal, candidateHash: preview.candidateHash });
    await assert.rejects(repo.reviewModule({ modelHash: preview.candidateHash, moduleId: 'compute', reviewer: 'temporary' }), { status: 422 });
  });
  await check('atomic write failure preserves model and module-review files', async () => {
    const before = await repo.getModel();
    const failed = new Repository(workspace, (path, content) => atomicWrite(path, content, async () => { throw new Error('injected failure'); }));
    await assert.rejects(failed.reviewModule({ modelHash: before.modelHash, moduleId: 'ingress', reviewer: 'temporary' }), /injected failure/);
    assert.deepEqual(await repo.getModel(), before);
  });
  await check('real HTTP and CLI draft produce a proposal without committing or approving', async () => {
    server = createServer();
    await new Promise<void>((done, fail) => { server!.once('error', fail); server!.listen(0, '127.0.0.1', done); });
    const port = (server.address() as { port: number }).port;
    server.on('request', createApp(repo, port));
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${url}/api/spec`)).status, 200);
    assert.equal((await fetch(`${url}/api/handoff/compute`)).status, 422);
    const before = await repo.getModel(), output = join(workspace, 'proposals/generic.json');
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'draft', 'examples/packet-pipeline/model.json', output], { env: { ...process.env, RTLARCH_API_PORT: String(port), RTLARCH_WORKSPACE: workspace } });
    const proposal = JSON.parse(await readFile(output, 'utf8')) as Proposal;
    assert.equal(proposal.baseHash, before.modelHash); assert.equal(proposal.commands[0].op, 'replace_architecture');
    assert.equal((await repo.getModel()).modelHash, before.modelHash);
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'draft', 'examples/packet-pipeline/model.json', output], { env: { ...process.env, RTLARCH_API_PORT: String(port) } }));
  });
  console.log(`完成 ${checks} 项检查；所有文件写入和确认均在临时目录。`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
  await rm(workspace, { recursive: true, force: true });
}
