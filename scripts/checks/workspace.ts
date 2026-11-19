import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { coverageReport } from '../../src/core/coverage';
import { type DecisionInput } from '../../src/core/decisions';
import { diagnosticGroups } from '../../src/core/diagnostics';
import { hardwareChangeSummary, semanticDiff } from '../../src/core/diff';
import { applyCommands, resolveEndpoint, validateModel } from '../../src/core/engine';
import { contractData, hashValue, modelHash } from '../../src/core/export';
import { integerExpression } from '../../src/core/expressions';
import { inspectScope } from '../../src/core/inspection';
import { parameterReport, parameterValue, physicalInstanceCount } from '../../src/core/parameters';
import { reviewDependencies } from '../../src/core/reviewImpact';
import { type Model, modelSchema, type Module, type Proposal } from '../../src/core/schema';
import { makeSelection } from '../../src/core/selection';
import { driverReads, expandLink } from '../../src/core/signals';
import { moduleDocument, specMarkdown } from '../../src/core/spec';
import { evaluateStudy, type Study, studyMatchesCandidates, type StudyOption, studySchema } from '../../src/core/studies';
import { memoryConstraint, portKindSchema } from '../../src/core/studyConstraints';
import { requestLimitBytes, RequestSizeError, serializeRequest } from '../../src/core/transport';
import { emptyWorkbench, makeWorkObject, makeWorkTarget, sameWorkObject, workbenchSchema, workSelection, type WorkTarget } from '../../src/core/workbench';
import { createApp } from '../../src/server/app';
import { startService } from '../../src/server/service';
import { elkLayout } from '../../src/web/graph/elkLayout';
import { scopeDiagram } from '../../src/web/graph/scopeDiagram';
import { architectureContext } from '../../src/workspace/context';
import { toolRoot } from '../../src/workspace/environment';
import { readEvidence } from '../../src/workspace/evidence';
import { importImpact, importYosys } from '../../src/workspace/importYosys';
import { sourceInventory } from '../../src/workspace/inventory';
import { atomicWrite, Repository } from '../../src/workspace/repository';
import { runVerification, verificationRuns } from '../../src/workspace/verification';
import { mappedFixture, reviewFixture } from './fixtures';

export async function checkRepository() {
  // Core checks using Node assertions; all writes target a temporary workspace.
















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
    await check('semantic edits invalidate dependent module reviews, retain unrelated reviews and block old handoff', async () => {
      const current = await repo.getModel(), proposal = { baseHash: current.modelHash, reason: 'edit spec', commands: [{ op: 'set_parameter', moduleId: 'buffer', key: 'DEPTH', value: 32 }] };
      const preview = await repo.preview(proposal); await repo.commit({ proposal, candidateHash: preview.candidateHash });
      const next = await repo.getModel(); assert.equal(next.reviewStatus, 'STALE'); assert.deepEqual(next.moduleReviews.filter(r=>r.status==='STALE').map(r=>r.moduleId).sort(),['buffer','compute','packet_top','processing','scheduler']); assert.deepEqual(next.moduleReviews.filter(r=>r.status==='APPROVED').map(r=>r.moduleId).sort(),['egress','ingress']); assert.ok(next.moduleReviews.filter(r=>r.status==='APPROVED').every(r=>r.retained));
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
      await promisify(execFile)(resolve('bin/rtlarch'), ['draft', 'examples/packet-pipeline/model.json', output], { env: { ...process.env, RTLARCH_API_PORT: String(port), RTLARCH_WORKSPACE: workspace } });
      const proposal = JSON.parse(await readFile(output, 'utf8')) as Proposal;
      assert.equal(proposal.baseHash, before.modelHash); assert.equal(proposal.commands[0].op, 'replace_architecture');
      assert.equal((await repo.getModel()).modelHash, before.modelHash);
      await assert.rejects(promisify(execFile)(resolve('bin/rtlarch'), ['draft', 'examples/packet-pipeline/model.json', output], { env: { ...process.env, RTLARCH_API_PORT: String(port) } }));
    });
    console.log(`完成 ${checks} 项检查；所有文件写入和确认均在临时目录。`);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function checkSemanticImport() {
  // Regressions drawn from real RTL import feedback. All writes use temporary projects.


















  const initial = modelSchema.parse(JSON.parse(await readFile('examples/tiny-stream/model.json', 'utf8')));
  const base = structuredClone(initial.modules[0]);
  const module = (id: string, parent: string | null, kind: Module['kind']): Module => ({ ...structuredClone(base), id, name: id, rtlModule: id, parent, kind, parameters: {}, interfaces: [], timing: 'sequential', contract: { ...base.contract, resetBehavior: '控制寄存器异步复位；数据 RAM 无复位；按模块声明。' } });
  const fixture: Model = {
    schemaVersion: 3, design: { id: 'import_demo', name: 'RTL feedback regression', top: 'top' },
    clocks: [{ id: 'clk', edge: 'rising' }], resets: [{ id: 'rst_n', clock: 'clk', activeLevel: 'low', synchronous: false, deassertion: 'asynchronous' }],
    modules: [module('top', null, 'subsystem'), module('mem', 'top', 'memory'), module('pro', 'top', 'compute'), { ...module('comb', 'top', 'module'), timing: 'combinational', clock: null, reset: null }],
    connections: [],
  };
  fixture.modules[1].reset = null;
  fixture.modules[1].interfaces = [{ id: 'data', role: 'producer', protocol: 'signal', width: 8, required: true }, { id: 'write', role: 'consumer', protocol: 'signal', width: 8, required: true }];
  fixture.modules[2].interfaces = [{ id: 'data', role: 'consumer', protocol: 'signal', width: 8, required: true }, { id: 'write', role: 'producer', protocol: 'signal', width: 8, required: true }];
  fixture.modules[3].interfaces = [{ id: 'data', role: 'consumer', protocol: 'signal', width: 8, required: true }];
  fixture.connections = [
    { id: 'return_data', scope: 'top', from: { moduleId: 'mem', interfaceId: 'data' }, to: { moduleId: 'pro', interfaceId: 'data' } },
    { id: 'writeback', scope: 'top', from: { moduleId: 'pro', interfaceId: 'write' }, to: { moduleId: 'mem', interfaceId: 'write' } },
    { id: 'broadcast', scope: 'top', from: { moduleId: 'mem', interfaceId: 'data' }, to: { moduleId: 'comb', interfaceId: 'data' } },
  ];
  const partial: Model = { ...structuredClone(fixture), provenance: {
    origin: 'as_built', fidelity: 'partial', scope: 'one representative instance per repeated group', configuration: 'source defaults, no defines', sourceDigest: 'a'.repeat(64),
    coverage: { elaboratedInstances: 1827, representedInstances: 4 },
    evidence: [{ id: 'rtl', file: 'rtl/top.sv', fileHash: 'b'.repeat(64), line: 10, endLine: 15, sourceKind: 'code' }],
    findings: [{ id: 'width_conflict', classification: 'conflict', moduleIds: ['pro'], text: 'TB expects 10 bits, RTL declares 8', evidenceIds: ['rtl'] }],
    unsupportedStructures: [{ id: 'array', kind: 'generate', moduleIds: ['pro'], description: 'z=0 only; other instances not represented', evidenceIds: ['rtl'] }],
    verification: [{ stage: 'simulation', status: 'blocked', command: '', detail: 'missing ROM and golden data', evidenceIds: [] }]
  } };
  let checks = 0;
  async function check(name: string, fn: () => void | Promise<void>) { await fn(); console.log(`PASS ${++checks}: ${name}`); }
  const workspace = await mkdtemp(join(tmpdir(), 'rtlarch-import-check-'));
  try {
    await check('legacy hash is preserved; async reset, resetless RAM and combinational modules validate', () => {
      assert.equal(modelHash(initial), '67d8474cbde520a73e057ef9f1260bdb3f92ab2c9450c3c9c0376aa0165929cd');
      assert.deepEqual(validateModel(initial), []); assert.deepEqual(validateModel(fixture), []);
      const parsed = modelSchema.parse(fixture); assert.equal(parsed.modules[1].reset, null); assert.equal(parsed.resets[0].synchronous, false);
      const markdown = specMarkdown(fixture, modelHash(fixture), 'DRAFT', []);
      assert.match(markdown, /异步，低有效，释放异步/); assert.match(markdown, /纯组合 · 时钟：无 · 复位：无/);
      const bad = structuredClone(fixture); bad.modules[3].clock = 'clk'; assert.ok(validateModel(bad).some(i => i.code === 'DOMAIN'));
      bad.modules[3].clock = null; bad.resets[0].deassertion = 'unknown'; assert.ok(validateModel(bad).some(i => i.code === 'RESET_RELEASE_UNKNOWN' && i.blocks.includes('review') && !i.blocks.includes('commit')));
      const high = structuredClone(fixture); high.clocks[0].edge = 'falling'; high.resets[0].activeLevel = 'high'; assert.deepEqual(validateModel(high), []);
      high.schemaVersion = 2; assert.ok(validateModel(high).some(i => i.code === 'SCHEMA_VERSION'));
    });
    await check('physical feedback and broadcast preserve edges; multidriver, width, CDC, scope and rv restrictions remain', async () => {
      const graph = scopeDiagram(fixture, 'top'); assert.equal(graph.edges.length, 3);
      const layout = await elkLayout(graph.nodes, graph.edges); assert.ok(Object.values(layout).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
      const clone = () => structuredClone(fixture);
      let bad = clone(); bad.connections.push({ ...bad.connections[0], id: 'second_driver', from: bad.connections[1].from }); assert.ok(validateModel(bad).some(i => i.code === 'MULTI_DRIVER'));
      bad = clone(); bad.modules[3].interfaces[0].width = 9; assert.ok(validateModel(bad).some(i => i.code === 'WIDTH_MISMATCH'));
      bad = clone(); bad.clocks.push({ id: 'other', edge: 'rising' }); bad.modules[1].clock = 'other'; assert.ok(validateModel(bad).some(i => i.code === 'DOMAIN_MISMATCH'));
      bad = clone(); bad.connections[0].scope = 'mem'; assert.ok(validateModel(bad).some(i => i.code === 'SCOPE_REFERENCE'));
      bad = clone(); bad.modules.forEach(m => { m.interfaces.forEach(i => { i.protocol = 'rv'; }); }); const codes = validateModel(bad).map(i => i.code); assert.ok(codes.includes('FANOUT')); assert.ok(codes.includes('MODULE_CYCLE'));
    });
    await check('incomplete provenance survives clearing openQuestions, commit/reload, and blocks every approval/export/handoff path', async () => {
      await atomicWrite(join(workspace, 'architecture/model.json'), JSON.stringify(fixture));
      const repo = new Repository(workspace), before = await repo.getModel();
      const proposal: Proposal = { baseHash: before.modelHash, reason: 'as-built partial view', commands: [{ op: 'replace_architecture', model: partial }] };
      const preview = await repo.preview(proposal); assert.ok(preview.diff.some(d => d.target === 'provenance'));
      await repo.commit({ proposal, candidateHash: preview.candidateHash });
      const snapshot = await new Repository(workspace).getModel();
      assert.equal(snapshot.modelHash, preview.candidateHash); assert.ok(snapshot.model.modules.every(m => !m.contract.openQuestions.length));
      assert.ok(snapshot.issues.some(i => i.code === 'PARTIAL_MODEL'));
      for (const m of partial.modules) await assert.rejects(repo.reviewModule({ modelHash: snapshot.modelHash, moduleId: m.id, reviewer: 'temporary' }), { status: 422 });
      await assert.rejects(repo.review({ modelHash: snapshot.modelHash, reviewer: 'temporary' }), { status: 422 });
      await assert.rejects(repo.export({ modelHash: snapshot.modelHash, kind: 'contract' }), { status: 422 });
      await assert.rejects(repo.handoff('pro'), { status: 422 });
      await repo.export({ modelHash: snapshot.modelHash, kind: 'spec' });
      assert.match(await readFile(join(workspace, 'generated/spec.md'), 'utf8'), /missing ROM and golden data/);
      const context = architectureContext(snapshot, 'pro'); assert.ok('provenance' in context && context.provenance?.findings.some(f => f.id === 'width_conflict'));
    });
    await check('partial/unsupported/coverage markers independently block a design; invalid evidence is rejected; additions appear in diff', () => {
      const edited = structuredClone(partial); edited.provenance!.origin = 'design'; edited.provenance!.findings = [];
      assert.ok(validateModel(edited).some(i => i.code === 'PARTIAL_MODEL'));
      edited.provenance!.fidelity = 'exact'; assert.ok(validateModel(edited).some(i => i.code === 'UNSUPPORTED_STRUCTURE'));
      edited.provenance!.unsupportedStructures = []; assert.ok(validateModel(edited).some(i => i.code === 'INCOMPLETE_COVERAGE'));
      edited.provenance!.coverage.elaboratedInstances = 4; assert.deepEqual(validateModel(edited), []);
      const bad = structuredClone(edited); bad.provenance!.findings = [{ id: 'bad', classification: 'fact', text: 'bad ref', moduleIds: ['missing'], evidenceIds: ['missing'] }]; assert.throws(() => applyCommands(fixture, [{ op: 'replace_architecture', model: bad }]));
      const changed = applyCommands(fixture, [{ op: 'update_provenance', provenance: edited.provenance! }]).model;
      assert.notEqual(modelHash(changed), modelHash(fixture)); assert.ok(semanticDiff(fixture, changed).some(d => d.target === 'provenance'));
      const old = structuredClone(fixture); delete old.modules[0].timing; assert.ok(semanticDiff(old, fixture).some(d => d.target === 'top.timing'));
      const specified = applyCommands(changed, [{ op: 'update_specification', specification: { summary: 'test', requirements: [], decisions: [], openQuestions: [] } }]); assert.equal(specified.model.schemaVersion, 3);
      const observed = structuredClone(edited); observed.provenance!.origin = 'as_built'; assert.ok(validateModel(observed).some(i => i.code === 'AS_BUILT_READ_ONLY'));
      const combinational = { ...structuredClone(fixture.modules[3]), parent: initial.design.top, interfaces: [] };
      assert.equal(applyCommands(initial, [{ op: 'define_module', module: combinational }]).model.schemaVersion, 3);
    });
    await check('approved v3 design exports truthful timing and source metadata; provenance edits invalidate reviews', async () => {
      const repo = new Repository(workspace), snapshot = await repo.getModel();
      const p = structuredClone(partial.provenance!); p.origin = 'design'; p.fidelity = 'exact'; p.coverage.elaboratedInstances = 4; p.findings = []; p.unsupportedStructures = [];
      const proposal: Proposal = { baseHash: snapshot.modelHash, reason: 'explicit design transition in temporary fixture', commands: [{ op: 'update_provenance', provenance: p }] };
      const preview = await repo.preview(proposal); await repo.commit({ proposal, candidateHash: preview.candidateHash });
      for (const m of fixture.modules) await repo.reviewModule({ modelHash: preview.candidateHash, moduleId: m.id, reviewer: 'temporary' });
      await repo.review({ modelHash: preview.candidateHash, reviewer: 'temporary' }); await repo.export({ modelHash: preview.candidateHash, kind: 'contract' });
      const handoff = await repo.handoff('mem'); assert.equal(handoff.module.reset, null); assert.equal(handoff.resets[0].synchronous, false); assert.equal(handoff.provenance?.sourceDigest, p.sourceDigest);
      const contract = JSON.parse(await readFile(join(workspace, 'generated/contract.json'), 'utf8')); assert.deepEqual(contract, contractData(preview.candidate));
      p.sourceDigest = 'c'.repeat(64); const next: Proposal = { baseHash: preview.candidateHash, reason: 'updated evidence', commands: [{ op: 'update_provenance', provenance: p }] };
      const nextPreview = await repo.preview(next); const result = await repo.commit({ proposal: next, candidateHash: nextPreview.candidateHash }); assert.equal(result.reviewStatus, 'STALE'); await assert.rejects(repo.handoff('mem'), { status: 422 });
    });
    await check('source inventory is read-only, deterministic, and reports missing assets separately from verification', async () => {
      const directory = join(workspace, 'raw sources'); await mkdir(directory);
      await writeFile(join(directory, 'top.sv'), 'module top; endmodule\n');
      const manifest = { top: 'top', configuration: 'default', parameters: { BIG: "8192'hf" }, defines: [], includeDirs: ['.'], files: ['top.sv'], assets: ['missing.hex'] };
      const first = await sourceInventory(directory, manifest), second = await sourceInventory(directory, manifest);
      assert.equal(first.sourceDigest, second.sourceDigest); assert.equal(first.files[0].status, 'present'); assert.equal(first.assets[0].status, 'missing'); assert.equal(first.inputsAvailable, false);
      await assert.rejects(access(join(directory, 'architecture'))); await assert.rejects(access(join(directory, '.rtlarch')));
      await writeFile(join(directory, 'top.sv'), 'module top; wire changed; endmodule\n');
      assert.notEqual((await sourceInventory(directory, manifest)).sourceDigest, first.sourceDigest);
      const changedConfiguration = { ...manifest, defines: ['FEATURE=1'] }; assert.notEqual((await sourceInventory(directory, changedConfiguration)).sourceDigest, (await sourceInventory(directory, manifest)).sourceDigest);
      await assert.rejects(sourceInventory(directory, { ...manifest, parameters: { BAD: Number.MAX_SAFE_INTEGER + 1 } }));
      await writeFile(join(directory, 'inputs.json'), JSON.stringify(manifest));
      const env = { ...process.env }; delete env.RTLARCH_API_PORT; delete env.RTLARCH_WORKSPACE;
      await assert.rejects(promisify(execFile)(join(toolRoot, 'bin/rtlarch'), ['inventory', join(directory, 'inputs.json'), '--workspace', directory, '--json'], { cwd: '/tmp', env }), (error: unknown) => {
        const result = JSON.parse((error as { stdout: string }).stdout); return result.error.code === 'INPUTS_UNAVAILABLE' && result.assets[0].status === 'missing';
      });
    });
    await check('offline context ignores service metadata, stays scoped and writes nothing; doctor makes no startup claim', async () => {
      const env = { ...process.env }; delete env.RTLARCH_API_PORT; delete env.RTLARCH_WORKSPACE;
      const exec = promisify(execFile), bin = join(toolRoot, 'bin/rtlarch');
      const before = await readFile(join(workspace, 'architecture/model.json'), 'utf8');
      const doctor = JSON.parse((await exec(bin, ['doctor', '--workspace', workspace, '--json'], { env })).stdout);
      assert.equal(doctor.readyForRead, true); assert.equal(doctor.serviceReadiness, 'not_checked'); await assert.rejects(access(join(workspace, '.rtlarch')));
      await mkdir(join(workspace, '.rtlarch')); await writeFile(join(workspace, '.rtlarch/runtime.json'), 'invalid metadata');
      const result = JSON.parse((await exec(bin, ['context', '--module', 'mem', '--offline', '--workspace', workspace, '--json'], { cwd: '/tmp', env })).stdout);
      assert.equal(result.readMode, 'disk'); assert.equal(result.module.id, 'mem'); assert.equal(result.model, undefined); assert.equal(result.provenance.origin, 'design');
      assert.equal(await readFile(join(workspace, '.rtlarch/runtime.json'), 'utf8'), 'invalid metadata'); await assert.rejects(access(join(workspace, '.rtlarch/service.lock')));
      assert.equal(await readFile(join(workspace, 'architecture/model.json'), 'utf8'), before);
    });
    console.log(`完成 ${checks} 项真实项目反馈回归检查；未改写真实工作区。`);
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function checkParametersAndContext() {
  const fixture=modelSchema.parse(JSON.parse(await readFile('examples/packet-pipeline/model.json','utf8')));
  const top=structuredClone(fixture.modules[0]);
  top.id='top';top.name='top';top.parent=null;top.parameters={WIDTH:8};top.interfaces=[{id:'data',role:'consumer',protocol:'signal',width:4,required:true}];top.contract.openQuestions=[];
  const leaf={...structuredClone(top),id:'lane',name:'lane',rtlModule:'lane',parent:'top',kind:'module' as const,parameters:{DATA_W:8,OFFSET:0},parameterBindings:{DATA_W:{scope:'parent' as const,expression:'WIDTH'},OFFSET:{scope:'self' as const,expression:'z * 4'}},instances:{indexVariable:'z',from:0,to:255,sourcePath:'top.g[{z}].lane'},interfaces:[{id:'data',role:'consumer' as const,protocol:'signal' as const,width:{param:'DATA_W'},required:true}]};
  const arrayModel:Model={schemaVersion:3,design:{id:'array_demo',name:'Array controls',top:'top'},clocks:structuredClone(fixture.clocks),resets:structuredClone(fixture.resets),modules:[top,leaf],localSignals:[{id:'control',scope:'top',name:'control',width:8,description:'真实局部 assign，不是 RTL 子模块',evidenceIds:[],driver:{kind:'comb',value:{kind:'concat',parts:[{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'data'}},{kind:'constant',width:4,value:'0xa'}]}}}],connections:[{id:'broadcast',scope:'top',from:{moduleId:'top',interfaceId:'control',local:true},to:{moduleId:'lane',interfaceId:'data',index:'all'}}]};
  let checks=0;
  async function check(name:string,fn:()=>unknown|Promise<unknown>){await fn();console.log(`PASS ${++checks}: ${name}`)}
  const dir=await mkdtemp(join(tmpdir(),'rtlarch-explore-check-'));
  try {
   await check('compact projection merges boundaries and preserves every real connection in bundles without changing IR',async()=>{
    const model=structuredClone(fixture),scope=model.design.top,top=model.modules.find(m=>m.id===scope)!;
    for(let i=0;i<40;i++)top.interfaces.push({id:`extra_${i}`,role:'consumer',protocol:'signal',width:1,required:false});
    const before=modelHash(model),compact=scopeDiagram(model,scope);
    assert.equal(compact.nodes.filter(n=>n.data.kind==='rack').length,2);assert.equal(compact.nodes.filter(n=>!n.data.boundary).length,model.modules.filter(m=>m.parent===scope).length);
    assert.deepEqual(compact.edges.flatMap(e=>e.data!.connectionIds as string[]).sort(),model.connections.filter(c=>c.scope===scope).map(c=>c.id).sort());
    assert.ok(compact.nodes.filter(n=>!n.data.boundary).every(n=>n.height!<300));assert.equal(modelHash(model),before);
    const positions=await elkLayout(compact.nodes,compact.edges);assert.equal(Object.keys(positions).length,compact.nodes.length);
   });
   await check('evidence preview reads only declared workspace source, detects changed content and rejects escaping symlinks',async()=>{
    await mkdir(join(dir,'rtl'));await writeFile(join(dir,'rtl/source.sv'),'line1\nline2\nline3\n');
    const model=structuredClone(fixture);model.provenance={origin:'as_built',fidelity:'partial',scope:'test',configuration:'test',sourceDigest:'a'.repeat(64),coverage:{elaboratedInstances:7,representedInstances:7},findings:[],unsupportedStructures:[],verification:[],evidence:[{id:'source',file:'rtl/source.sv',fileHash:createHash('sha256').update('line1\nline2\nline3\n').digest('hex'),line:2,sourceKind:'code'}]};
    const first=await readEvidence(dir,model,'source');assert.equal(first.matches,true);assert.match(first.text,/line2/);
    await writeFile(join(dir,'rtl/source.sv'),'changed\n');const next=await readEvidence(dir,model,'source');assert.equal(next.matches,false);assert.equal(next.lineExists,true);
    await symlink('/etc/hosts',join(dir,'outside'));model.provenance.evidence[0].file='outside';await assert.rejects(readEvidence(dir,model,'source'),{code:'EVIDENCE_OUTSIDE_WORKSPACE'});
    await assert.rejects(readEvidence(dir,model,'missing'),{code:'EVIDENCE_NOT_FOUND'});
   });

   await check('restricted integer evaluator handles precedence/clog2/literals and rejects execution, overflow, unknown names and cycles',()=>{
    assert.equal(integerExpression('($clog2(N) + 2) * 4 + 8\'h0f',n=>{assert.equal(n,'N');return 256}),55);
    assert.equal(integerExpression('1 + 2 << 3 | 1',()=>0),25);
    for(const expression of ['process.exit()','globalThis[1]','1 / 0','1 << 128',"4'hff",'2 ** 4','foo;bar','1.5','9007199254740992'])assert.throws(()=>integerExpression(expression,()=>{throw Error('unknown')}));
    const bad=structuredClone(arrayModel);bad.modules[1].parameterBindings!.OFFSET={scope:'self',expression:'OFFSET + 1'};assert.ok(validateModel(bad).some(i=>i.code==='PARAMETER_BINDING'));
   });
   await check('native 256-element array has exact counts, indexed context, shared contract and per-index width/parameter validation',()=>{
    assert.deepEqual(validateModel(arrayModel),[]);assert.equal(physicalInstanceCount(arrayModel),257);
    const doc=moduleDocument(arrayModel,'lane',123);assert.equal(doc.instance?.sourcePath,'top.g[123].lane');assert.equal(doc.instance?.parameters.OFFSET,492);assert.equal(doc.connections.length,1);assert.equal(doc.connections[0].to.index,123);
    const exported=contractData(arrayModel);assert.equal(exported.modules[1]?.id==='lane'?exported.modules[1].instances?.to:exported.modules[0].instances?.to,255);
    const graph=scopeDiagram(arrayModel,'top',{showLocals:true});assert.ok(graph.nodes.find(n=>n.id==='lane')?.data.instanceCount===256);assert.ok(graph.nodes.some(n=>n.data.localId==='control'));assert.equal(graph.edges.filter(e=>e.data?.localSignalId).length,1);
    const bad=structuredClone(arrayModel);bad.modules[1].parameterBindings!.OFFSET={scope:'self',expression:'1 / (z - 123)'};assert.ok(validateModel(bad).some(i=>i.code==='PARAMETER_BINDING'));
    assert.throws(()=>moduleDocument(arrayModel,'lane',256));
    assert.throws(()=>applyCommands(arrayModel,[{op:'set_instance_parameter',moduleId:'lane',index:123,key:'DATA_W',value:16}]));
    assert.throws(()=>applyCommands(arrayModel,[{op:'set_parameter',moduleId:'lane',key:'DATA_W',value:16}]));
   });
   await check('local constants/concat/slices and disjoint bit drivers validate; overlaps, gaps, truncation, fake boundaries and comb dependency loops are detected',()=>{
    const m=structuredClone(arrayModel);m.modules[1].instances={...m.modules[1].instances!,to:0};m.connections=[{id:'lo',scope:'top',from:{moduleId:'top',interfaceId:'control',local:true,slice:{msb:3,lsb:0}},to:{moduleId:'lane',interfaceId:'data',index:0,slice:{msb:3,lsb:0}}},{id:'hi',scope:'top',from:{moduleId:'top',interfaceId:'control',local:true,slice:{msb:7,lsb:4}},to:{moduleId:'lane',interfaceId:'data',index:0,slice:{msb:7,lsb:4}}}];
    assert.deepEqual(validateModel(m),[]);
    const overlap=structuredClone(m);overlap.connections[1].to.slice={msb:5,lsb:2};assert.ok(validateModel(overlap).some(i=>i.code==='MULTI_DRIVER'));
    const gap=structuredClone(m);gap.connections.pop();assert.ok(validateModel(gap).some(i=>i.code==='REQUIRED_UNCONNECTED'&&i.target.includes('lane')));
    const overflow=structuredClone(m);overflow.localSignals![0].driver={kind:'comb',value:{kind:'constant',width:8,value:'256'}};assert.ok(validateModel(overflow).some(i=>i.code==='LOCAL_DRIVER'));
    const loop=structuredClone(m);loop.localSignals![0].driver={kind:'comb',value:{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'control',local:true}}};assert.ok(validateModel(loop).some(i=>i.code==='LOCAL_DRIVER'));
    loop.localSignals![0].driver={kind:'register',inputs:[{moduleId:'top',interfaceId:'control',local:true}],sourceText:'q <= q;'};assert.ok(!validateModel(loop).some(i=>i.blocks.includes('commit')));
    const op=structuredClone(m);op.localSignals![0].driver={kind:'comb',value:{kind:'operator',operator:'mux',operands:[{kind:'constant',width:1,value:'1'},{kind:'constant',width:8,value:'0xaa'},{kind:'constant',width:8,value:'0x55'}]}};assert.ok(!validateModel(op).some(i=>i.blocks.includes('commit')));
    assert.equal(op.localSignals![0].driver.value.kind,'operator');if(op.localSignals![0].driver.value.kind!=='operator')throw Error('test fixture');op.localSignals![0].driver.value.operands[2]={kind:'constant',width:4,value:'0'};assert.ok(validateModel(op).some(i=>i.code==='LOCAL_DRIVER'));
    const fake=structuredClone(m);delete fake.connections[0].from.local;assert.ok(validateModel(fake).some(i=>i.code==='SCOPE_REFERENCE'));
    const reduce=structuredClone(arrayModel);reduce.modules[0].interfaces.push({id:'out',role:'producer',protocol:'signal',width:8,required:false});reduce.modules[1].interfaces.push({id:'out',role:'producer',protocol:'signal',width:8,required:false});reduce.connections.push({id:'bad_reduce',scope:'top',from:{moduleId:'lane',interfaceId:'out',index:'all'},to:{moduleId:'top',interfaceId:'out'}});assert.ok(validateModel(reduce).some(i=>i.code==='MULTI_DRIVER'));
   });
   await check('index-specific preview is read-only, commit persists only the chosen override, invalidates confirmations and rejects stale replay',async()=>{
    const workspace=join(dir,'project');await atomicWrite(join(workspace,'architecture/model.json'),JSON.stringify(arrayModel));const repo=new Repository(workspace),before=await repo.getModel();
    for(const m of arrayModel.modules)await repo.reviewModule({modelHash:before.modelHash,moduleId:m.id,reviewer:'temporary'});
    const proposal:Proposal={baseHash:before.modelHash,reason:'override index 123',commands:[{op:'set_instance_parameter',moduleId:'lane',index:123,key:'OFFSET',value:999}]};
    const preview=await repo.preview(proposal);assert.equal((await repo.getModel()).modelHash,before.modelHash);await repo.commit({proposal,candidateHash:preview.candidateHash});
    const after=await new Repository(workspace).getModel(),lane=after.model.modules[1];assert.equal(parameterValue(after.model,lane,'OFFSET',123),999);assert.equal(parameterValue(after.model,lane,'OFFSET',122),488);assert.deepEqual(Object.keys(lane.instances!.overrides!),['123']);assert.ok(after.moduleReviews.every(r=>r.status==='STALE'));
    await assert.rejects(repo.commit({proposal,candidateHash:preview.candidateHash}),{status:409});
    const propagated=applyCommands(arrayModel,[{op:'set_parameter',moduleId:'top',key:'WIDTH',value:16},{op:'update_local_signals',localSignals:[{...arrayModel.localSignals![0],width:16,driver:{kind:'comb',value:{kind:'concat',parts:[{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'data'}},{kind:'constant',width:12,value:'0'}]}}}]}]).model;assert.equal(parameterValue(propagated,propagated.modules[1],'DATA_W',255),16);
   });
   await check('source targets resolve to real items and root causes annotate rather than hide unresolved port warnings',()=>{
    const m=structuredClone(arrayModel);m.connections=[];m.provenance={origin:'as_built',fidelity:'partial',scope:'array review',configuration:'defaults',sourceDigest:'a'.repeat(64),coverage:{elaboratedInstances:257,representedInstances:257},evidence:[{id:'e',file:'rtl/source.sv',fileHash:'b'.repeat(64),sourceKind:'code',targets:[{kind:'interface',moduleId:'lane',itemId:'data'}]}],findings:[],verification:[],unsupportedStructures:[{id:'driver_gap',kind:'local',causes:[{issueCodes:['REQUIRED_UNCONNECTED'],moduleId:'lane',interfaceId:'data'}],moduleIds:['lane'],description:'source driver pending',evidenceIds:['e'],targets:[{kind:'interface',moduleId:'lane',itemId:'data'}]}]};
    const issues=validateModel(m);assert.equal(issues.filter(i=>i.code==='REQUIRED_UNCONNECTED'&&i.causeIds?.includes('driver_gap')&&i.evidenceIds?.includes('e')).length,256);assert.ok(issues.some(i=>i.code==='PARTIAL_MODEL'));assert.ok(!issues.some(i=>i.code==='INCOMPLETE_COVERAGE'));assert.equal(moduleDocument(m,'lane').provenance?.evidence.length,1);
    m.provenance.evidence[0].targets![0].itemId='missing';assert.ok(validateModel(m).some(i=>i.code==='EVIDENCE_REFERENCE'&&i.blocks.includes('commit')));
   });
   await check('evidence reads are bound to current or candidate hashes and stale candidate evidence never silently rebases',async()=>{
    const workspace=join(dir,'evidence-project');await atomicWrite(join(workspace,'rtl/a.sv'),'// evidence\n');const m=structuredClone(arrayModel);m.provenance={origin:'as_built',fidelity:'partial',scope:'test',configuration:'test',sourceDigest:'a'.repeat(64),coverage:{elaboratedInstances:257,representedInstances:257},evidence:[{id:'e',file:'rtl/a.sv',fileHash:createHash('sha256').update('// evidence\n').digest('hex'),sourceKind:'code'}],findings:[],verification:[],unsupportedStructures:[]};await atomicWrite(join(workspace,'architecture/model.json'),JSON.stringify(m));
    const repo=new Repository(workspace),before=await repo.getModel();assert.equal((await repo.getEvidence({id:'e',modelHash:before.modelHash})).matches,true);
    const proposal:Proposal={baseHash:before.modelHash,reason:'candidate evidence',commands:[{op:'rename_module',moduleId:'lane',name:'new name'}]},preview=await repo.preview(proposal);assert.equal((await repo.getEvidence({id:'e',modelHash:preview.candidateHash,proposal})).matches,true);
    await assert.rejects(repo.getEvidence({id:'e',modelHash:before.modelHash,proposal}),{status:409});await repo.commit({proposal,candidateHash:preview.candidateHash});await assert.rejects(repo.getEvidence({id:'e',modelHash:preview.candidateHash,proposal}),{status:409});
   });
   await check('stage-specific inventory distinguishes compile inputs from missing simulation assets without claiming execution',async()=>{
    const result=await sourceInventory(dir,{top:'top',configuration:'default',parameters:{},defines:[],includeDirs:[],files:['rtl/source.sv'],assets:[{path:'missing.mem',stages:['simulation']}]});
    assert.equal(result.inputsAvailable,false);assert.equal(result.compileInputsAvailable,true);assert.equal(result.simulationInputsAvailable,false);
   });
   await check('candidate comparison and indexed offline context never start a service or change the commit base',async()=>{
    const beforeFile=join(dir,'a.json'),afterFile=join(dir,'b.json');await writeFile(beforeFile,JSON.stringify(arrayModel));const after=structuredClone(arrayModel);after.modules[1].name='renamed';await writeFile(afterFile,JSON.stringify(after));
    const result=JSON.parse((await promisify(execFile)(resolve('bin/rtlarch'),['compare',beforeFile,afterFile,'--json'])).stdout);assert.equal(result.readOnly,true);assert.ok(result.diff.some((d:{target:string})=>d.target==='lane.name'));
    const context=JSON.parse((await promisify(execFile)(resolve('bin/rtlarch'),['context','lane','--index','123','--offline','--workspace',join(dir,'project'),'--json'])).stdout);assert.equal(context.instance.parameters.OFFSET,999);
    await assert.rejects(readFile(join(dir,'project','.rtlarch/service.json')),{code:'ENOENT'});
   });
   console.log(`完成 ${checks} 项探索体验检查。`);
  }finally{await rm(dir,{recursive:true,force:true})}
}

export async function checkReview() {
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
}

export async function checkDraftsAndSourceImpact() {
  const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-milestone-'));let checks=0;
  const check=async(name:string,fn:()=>Promise<void>)=>{await fn();console.log(`PASS ${++checks}: ${name}`);};
  const base=modelSchema.parse(JSON.parse(await readFile(join(toolRoot,'examples/packet-pipeline/model.json'),'utf8')));
  const study=(hash:string):Study=>({id:'tradeoff',title:'比较并行计算资源',modelHash:hash,moduleIds:[base.design.top],configuration:'同一输入与运算量',assumptions:['运算独立，读写端口独立，开销不可重叠'],workItems:10,options:[{id:'one',label:'一个单元',compute:{lanes:1,operationsPerItem:3,cyclesPerOperation:1,overheadCycles:2},runIds:[]},{id:'two',label:'两个单元',compute:{lanes:2,operationsPerItem:3,cyclesPerOperation:1,overheadCycles:2},runIds:[]}]});
  try{
   await mkdir(join(root,'architecture'));await writeFile(join(root,'architecture/model.json'),JSON.stringify(base));
   const repo=new Repository(root),initial=(await repo.getModel()).modelHash,modelBytes=await readFile(join(root,'architecture/model.json'));
   let threadId='';
   await check('durable questions and agent replies leave architecture untouched; concurrent writes cannot overwrite',async()=>{
    const first=await repo.getWorkbench();const asked=await repo.updateWorkbench({baseHash:first.workbenchHash,action:{kind:'ask',title:'能否复用运算单元？',text:'请比较周期与存储端口约束。',target:{modelHash:initial,moduleId:base.design.top,connectionIds:[]}}});
    threadId=asked.workbench.threads[0].id;
    await assert.rejects(repo.updateWorkbench({baseHash:first.workbenchHash,action:{kind:'resolve',threadId,modelHash:initial}}),e=>(e as any).code==='WORKBENCH_CONFLICT');
    const replied=await repo.updateWorkbench({baseHash:asked.workbenchHash,action:{kind:'reply',threadId,author:'agent',text:'先用相同工作量计算服务量下界，再验证。',modelHash:initial}});
    assert.equal(replied.workbench.threads[0].status,'addressed');assert.equal(replied.workbench.threads[0].messages.length,2);
    assert.deepEqual(await readFile(join(root,'architecture/model.json')),modelBytes);
    const context=await repo.getContext(base.design.top);assert.equal(context.collaboration.threads[0].id,threadId);
   });
   await check('checkpoint, candidate-linked replies and user resolution survive a new repository instance',async()=>{
    const proposal={baseHash:initial,reason:'明确顶层说明',commands:[{op:'rename_module',moduleId:base.design.top,name:'流处理设计'}]};
    const p=await repo.registerProposal(proposal);let work=await repo.getWorkbench();
    work=await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'reply',threadId,author:'agent',text:'候选修改已登记。',modelHash:initial,proposalId:p.id}});
    work=await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'checkpoint',intent:'比较结构',nextStep:'检查候选并核对吞吐假设',target:{modelHash:p.candidateHash,moduleId:base.design.top,connectionIds:[],proposalId:p.id}}});
    const resumed=await new Repository(root).getResume();assert.equal(resumed.workbench.checkpoint?.target.proposalId,p.id);assert.ok(resumed.proposals.some(x=>x.id===p.id&&x.state==='READY'));
    const resolved=await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'resolve',threadId,modelHash:initial}});assert.equal(resolved.workbench.threads[0].status,'resolved');
    assert.equal((await repo.getModel()).reviewStatus,'DRAFT');
   });
   await check('budget exposes fractional service bounds, absent ports, buffer insufficiency and overflow',async()=>{
    const s=study(initial),r=evaluateStudy(s);assert.equal(r.options[0].cyclesLowerBound,32);assert.equal(r.options[1].cyclesLowerBound,17);assert.equal(r.options[1].intervalLowerBound,1.5);
    s.options[0].memory={words:8,width:16,copies:2,readsPerItem:1,writesPerItem:0,readPorts:0,writePorts:0};
    s.options[1].flow={producedPerCycle:2,maxStallCycles:3,inFlight:4,capacity:9};
    const bad=evaluateStudy(s);assert.equal(bad.options[0].cyclesLowerBound,null);assert.equal(bad.options[0].storageBits,256);assert.equal(bad.options[1].requiredCapacity,10);assert.equal(bad.options[1].capacitySufficient,false);
    const huge=study(initial);huge.workItems=1e9;huge.options[0].compute.operationsPerItem=1e9;assert.throws(()=>evaluateStudy(huge));
   });
   await check('review retains a disconnected module but invalidates changed modules and parents; legacy remains conservative',async()=>{
    const m=structuredClone(base),leaf=m.modules.find(n=>n.parent&&n.kind!=='subsystem')!;
    m.modules.push({...structuredClone(leaf),id:'independent',name:'独立模块',parent:m.design.top,interfaces:[]});
    const dir=join(root,'review');await mkdir(join(dir,'architecture'),{recursive:true});await writeFile(join(dir,'architecture/model.json'),JSON.stringify(m));const r=new Repository(dir),old=await r.getModel();
    for(const module of m.modules)await r.reviewModule({modelHash:old.modelHash,moduleId:module.id,reviewer:'fixture'});
    await r.review({modelHash:old.modelHash,reviewer:'fixture'});
    const proposal={baseHash:old.modelHash,reason:'局部名称变更',commands:[{op:'rename_module',moduleId:leaf.id,name:'更新的职责名'}]},preview=await r.preview(proposal);
    const updated=await r.commit({proposal,candidateHash:preview.candidateHash});
    assert.equal(updated.moduleReviews.find(x=>x.moduleId==='independent')?.status,'APPROVED');assert.equal(updated.moduleReviews.find(x=>x.moduleId==='independent')?.retained,true);
    assert.equal(updated.moduleReviews.find(x=>x.moduleId===leaf.id)?.status,'STALE');assert.equal(updated.moduleReviews.find(x=>x.moduleId===m.design.top)?.status,'STALE');assert.equal(updated.reviewStatus,'STALE');
    const recordFile=join(dir,'architecture/module-reviews.json'),records=JSON.parse(await readFile(recordFile,'utf8'));delete records.modules.independent.scopeHash;delete records.modules.independent.scopeParts;await writeFile(recordFile,JSON.stringify(records));assert.equal((await r.getModel()).moduleReviews.find(x=>x.moduleId==='independent')?.status,'STALE');
   });
   await check('verification records input-bound isolated runs, checks JUnit and rejects stale results',async()=>{
    await writeFile(join(root,'probe.js'),"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite><testcase name=\"selfcheck\"/></testsuite>')");
    const p={schemaVersion:1,name:'运行记录自检',stage:'simulation',moduleIds:[base.design.top],inputs:['probe.js'],timeoutMs:5000,commands:[{program:process.execPath,args:['probe.js','{runDir}'],versionArgs:['--version']}],checks:[{kind:'junit',file:'result.xml'}]};
    const run=await runVerification(root,p);assert.equal(run.status,'passed');assert.equal((await verificationRuns(root,initial))[0].fresh,true);
    const s=study(initial);s.options[0].runIds=[run.id];let work=await repo.getWorkbench();await repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'study',study:s}});
    await writeFile(join(root,'probe.js'),'// source changed');assert.equal((await verificationRuns(root,initial))[0].fresh,false);
    work=await repo.getWorkbench();await assert.rejects(repo.updateWorkbench({baseHash:work.workbenchHash,action:{kind:'study',study:s}}));
   });
   await check('zero/skipped test reports, timeout, report traversal and live input mutation never pass',async()=>{
    for(const [name,code,check] of [
     ['zero',"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite/>')",{kind:'junit',file:'result.xml'}],
     ['suite_error',"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite errors=\"1\"><testcase/></testsuite>')",{kind:'junit',file:'result.xml'}],
     ['skip',"require('fs').writeFileSync(process.argv[2]+'/result.xml','<testsuite><testcase><skipped/></testcase></testsuite>')",{kind:'junit',file:'result.xml'}],
     ['timeout','setInterval(()=>{},1000)',{kind:'exit_code'}],
     ['change',"require('fs').appendFileSync('probe.js','// changed')",{kind:'exit_code'}],
     ['traversal','', {kind:'contains',file:'../../../../etc/passwd',text:'root'}],
    ] as const){await writeFile(join(root,'probe.js'),code);const run=await runVerification(root,{schemaVersion:1,name,stage:'simulation',moduleIds:[base.design.top],inputs:['probe.js'],timeoutMs:name==='timeout'?150:5000,commands:[{program:process.execPath,args:['probe.js','{runDir}']}],checks:[check]});assert.notEqual(run.status,'passed',name);}
   });
   await check('real Yosys elaboration imports RTL topology and preserves unknown behavior with incremental source mapping',async()=>{
    const dir=join(root,'intake');await mkdir(dir);await cp(join(toolRoot,'examples/rtl-intake/rtl'),join(dir,'rtl'),{recursive:true});
    await exec('yosys',['-Q','-T','-p','read_verilog -sv rtl/stage.sv rtl/stream_top.sv; hierarchy -top stream_top; proc; write_json netlist.json'],{cwd:dir,timeout:30000,maxBuffer:4*1024*1024});
    const manifest={schemaVersion:1,top:'stream_top',netlist:'netlist.json',files:['rtl/stage.sv','rtl/stream_top.sv'],configuration:'BIAS=1 then BIAS=2; no flatten'},result=await importYosys(dir,manifest,join(dir,'candidate'));
    const model=modelSchema.parse(JSON.parse(await readFile(result.modelFile,'utf8')));assert.equal(model.modules.length,3);assert.equal(model.provenance?.origin,'as_built');assert.equal(model.provenance?.fidelity,'partial');assert.ok(model.connections.length>=8);assert.ok(model.modules.every(m=>m.timing==='unknown'));
    const report=JSON.parse(await readFile(result.reportFile,'utf8')),fresh=await importImpact(dir,report);assert.equal(fresh.changedFiles.length,0);
    await writeFile(join(dir,'rtl/stage.sv'),(await readFile(join(dir,'rtl/stage.sv'),'utf8')).replace('data_i + BIAS','data_i - BIAS'));
    const impact=await importImpact(dir,report);assert.equal(impact.changedFiles.length,1);assert.equal(impact.affectedModuleIds.length,2);assert.equal(impact.requiresReelaboration,true);
    await assert.rejects(importYosys(dir,manifest,join(dir,'architecture/out')));await assert.rejects(importYosys(dir,manifest,join(dir,'candidate')));
   });
   await check('dependency fingerprints cover neighbor contracts, global clocks and ancestor parameters without unrelated churn',async()=>{
    const id='buffer',hash=(m:Model)=>reviewDependencies(m,id).scopeHash;
    const unchanged=structuredClone(base);unchanged.modules.find(m=>m.id==='egress')!.name='Presentation only';assert.equal(hash(unchanged),hash(base));
    for(const change of [(m:Model)=>{m.modules.find(m=>m.id==='compute')!.contract.backpressure+=' Changed';},(m:Model)=>{m.clocks[0].edge=m.clocks[0].edge==='rising'?'falling':'rising';},(m:Model)=>{m.modules.find(m=>m.id==='processing')!.parameters.EXTRA=1;}]){const changed=structuredClone(base);change(changed);assert.notEqual(hash(changed),hash(base));}
   });
   await check('Yosys constants and normalized slices preserve bits while ambiguous and bidirectional drivers stay gaps',async()=>{
    const dir=join(root,'bit-import');await mkdir(dir);await writeFile(join(dir,'ports.sv'),'// explicit synthetic netlist fixture');
    const net={modules:{top:{attributes:{src:'ports.sv:1.1-1.2'},ports:{a:{direction:'input',bits:[2,3],offset:8,upto:1,signed:1},b:{direction:'output',bits:[3,2]},k:{direction:'output',bits:['1','0']},tri:{direction:'inout',bits:[4]}},cells:{}}}};
    await writeFile(join(dir,'net.json'),JSON.stringify(net));const manifest={schemaVersion:1,top:'top',netlist:'net.json',files:['ports.sv'],configuration:'synthetic bit mapping fixture'};
    const first=await importYosys(dir,manifest,join(dir,'one')),m=modelSchema.parse(JSON.parse(await readFile(first.modelFile,'utf8')));assert.equal(m.connections.length,4);assert.ok(m.localSignals?.some(l=>l.driver.kind==='comb'&&l.driver.value.kind==='constant'));assert.ok(m.provenance?.unsupportedStructures.some(s=>s.kind==='port'));
    const report=JSON.parse(await readFile(first.reportFile,'utf8'));assert.equal(report.mapping[0].ports[0].offset,8);assert.equal(report.mapping[0].ports[0].signed,true);
    net.modules.top.ports.tri.bits=[2];await writeFile(join(dir,'net.json'),JSON.stringify(net));const tri=await importYosys(dir,manifest,join(dir,'tri')),triModel=modelSchema.parse(JSON.parse(await readFile(tri.modelFile,'utf8')));assert.equal(triModel.connections.filter(c=>c.to.interfaceId==='b').length,1);
    Object.assign(net.modules.top.ports,{duplicate:{direction:'input',bits:[2]}});await writeFile(join(dir,'net.json'),JSON.stringify(net));const second=await importYosys(dir,manifest,join(dir,'two')),ambiguous=modelSchema.parse(JSON.parse(await readFile(second.modelFile,'utf8')));assert.ok(ambiguous.provenance?.unsupportedStructures.some(s=>s.kind==='multiple_driver'));assert.equal(ambiguous.connections.filter(c=>c.to.interfaceId==='b').length,1);
   });
  }finally{await rm(root,{recursive:true,force:true});}
  console.log(`完成 ${checks} 组 1.0 共同设计与执行检查。`);
}

export async function checkWorkObjects() {
  const root=await mkdtemp(join(tmpdir(),'rtlarch-work-objects-'));let count=0;
  const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++count}: ${name}`)};
  try{
   await cp('examples/external-axis',root,{recursive:true});const repo=new Repository(root),base=await repo.getModel();
   const model=structuredClone(base.model);model.specification={summary:'对象协作检查',requirements:[{id:'payload',text:'保持数据',acceptance:'阻塞期间不变',moduleIds:['stage0','stage1']}],decisions:[],openQuestions:[]};
   model.modules.find(m=>m.id==='stage0')!.contract.obligations=[{kind:'state_transition',id:'state_rule',description:'核对更新',localSignalId:'stage0_data_q'}];
   const proposal={baseHash:base.modelHash,reason:'临时对象检查',commands:[{op:'replace_architecture',model}]},p=await repo.preview(proposal),saved=await repo.commit({proposal,candidateHash:p.candidateHash});
   const target=(scope:string,kind:'local_state'|'update_branch'|'requirement'|'obligation',id:string,stateId?:string):WorkTarget=>({modelHash:saved.modelHash,moduleId:scope,connectionIds:[],object:makeWorkObject(saved.model,{scope,kind,id,...(stateId?{stateId}:{})})});
   const a=target('stage0','local_state','stage0_data_q'),b=target('stage1','local_state','stage1_data_q');
   const branch=target('stage0','update_branch','load','stage0_data_q');
   const ask=async(t:WorkTarget,title='关于同名状态')=>repo.updateWorkbench({baseHash:(await repo.getWorkbench()).workbenchHash,action:{kind:'ask',target:t,title,text:'核对这个具体对象'}});
   await check('same RTL definition and state display name remain distinct instances',async()=>{
    assert.equal(model.modules[1].rtlModule,model.modules[2].rtlModule);
    assert.equal(model.localSignals!.find(s=>s.id==='stage0_data_q')!.name,model.localSignals!.find(s=>s.id==='stage1_data_q')!.name);
    await ask(a);const w=await ask(b);assert.equal(w.workbench.threads.filter(t=>sameWorkObject(t.target,a)).length,1);assert.equal(w.workbench.threads.filter(t=>sameWorkObject(t.target,b)).length,1);
    const wrong=structuredClone(a);wrong.object!.instancePath[1].moduleId='stage1';await assert.rejects(ask(wrong));
    const cross=target('stage1','local_state','stage0_data_q');await assert.rejects(ask(cross));
   });
   await check('branch, requirement, obligation and checkpoint restore exact identities',async()=>{
    await ask(branch);await ask(target('top','requirement','payload'));await ask(target('stage0','obligation','state_rule'));
    const w=await repo.getWorkbench();await repo.updateWorkbench({baseHash:w.workbenchHash,action:{kind:'checkpoint',target:branch,intent:'检查装载',nextStep:'核对优先级'}});
    const restored=await new Repository(root).getResume();assert.deepEqual(restored.workbench.checkpoint!.target,branch);assert(restored.checkpointState?.canLocate);assert(restored.threadStates.every(t=>t.canLocate));
   });
   await check('shared selection stores every original relation member and rejects unrelated aliases',async()=>{
    const members=[{kind:'connection' as const,id:'middle_tvalid'},{kind:'connection' as const,id:'middle_tdata'}];
    const ref=makeSelection(model,saved.modelHash,'top',{kind:'relationship',members});
    const target=makeWorkTarget(model,ref);
    assert.deepEqual(target.connectionIds,['middle_tdata','middle_tvalid']);
    assert.deepEqual(workSelection(model,target),ref);
    const record=await ask(target,'聚合关系成员');
    assert.deepEqual(record.workbench.threads.at(-1)!.target.selection,ref);
    await assert.rejects(ask({...target,connectionIds:['middle_tready']}));
    await assert.rejects(ask(makeWorkTarget(model,makeSelection(model,saved.modelHash,'stage0',{kind:'relationship',members}))));
    const local=model.localSignals!.find(n=>n.id==='stage0_data_q')!;
    const [endpoint]=driverReads(local);
    const dependency=makeSelection(model,saved.modelHash,'stage0',{kind:'relationship',members:[{kind:'dependency',localId:local.id,endpoint}]});
    assert.deepEqual((await ask(makeWorkTarget(model,dependency))).workbench.threads.at(-1)!.target.selection,dependency);
    assert.deepEqual(workSelection(model,branch),makeSelection(model,saved.modelHash,'stage0',{kind:'local',id:'stage0_data_q',branch:'load'}));
   });
   await check('changed/deleted branch and same display name never rebind old questions',async()=>{
    const locals=structuredClone(model.localSignals!);const local=locals.find(l=>l.id==='stage0_data_q')!;assert(local.driver.kind==='register');local.driver.update!.branches[0].id='replacement';
    const change={baseHash:saved.modelHash,reason:'临时分支替换',commands:[{op:'update_local_signals',localSignals:locals}]},preview=await repo.preview(change);await repo.commit({proposal:change,candidateHash:preview.candidateHash});
    const w=await repo.getWorkbench();assert(w.threadStates.every(t=>!t.canLocate&&t.versionChanged));assert(w.checkpointState!.missingTargets.some(x=>x.includes('load')));assert.deepEqual(w.workbench.checkpoint!.target,branch);await assert.rejects(ask(a));
   });
   await check('legacy workbench hash is unchanged and discussions preserve model and approval bytes',async()=>{
    const old=emptyWorkbench();assert.equal(hashValue(workbenchSchema.parse(old)),hashValue(old));
    const dir=join(root,'approved');await mkdir(join(dir,'architecture'),{recursive:true});await cp('examples/packet-pipeline/model.json',join(dir,'architecture/model.json'));
    const r=new Repository(dir),s=await r.getModel();for(const m of s.model.modules)await r.reviewModule({modelHash:s.modelHash,moduleId:m.id,reviewer:'temporary fixture'});await r.review({modelHash:s.modelHash,reviewer:'temporary fixture'});
    const files=['model.json','review.json','module-reviews.json'],before=await Promise.all(files.map(f=>readFile(join(dir,'architecture',f))));
    await r.updateWorkbench({baseHash:(await r.getWorkbench()).workbenchHash,action:{kind:'ask',target:{modelHash:s.modelHash,moduleId:s.model.design.top,connectionIds:[]},title:'普通讨论',text:'不改变批准'}});
    for(const [i,f] of files.entries())assert.deepEqual(await readFile(join(dir,'architecture',f)),before[i]);assert.equal((await r.getModel()).reviewStatus,'APPROVED');
    const work=await r.getWorkbench();
    assert.deepEqual(await r.getWorkDock(),{height:null});
    await r.putWorkDock({height:286});
    assert.deepEqual(await new Repository(dir).getWorkDock(),{height:286});
    await assert.rejects(r.putWorkDock({height:1000}));
    assert.equal((await r.getWorkbench()).workbenchHash,work.workbenchHash);
    for(const [i,f] of files.entries())assert.deepEqual(await readFile(join(dir,'architecture',f)),before[i]);
   });
   console.log(`完成第一步 ${count} 组对象协作检查；所有提交与批准仅在临时 fixture。`);
  }finally{await rm(root,{recursive:true,force:true});}
}

export async function checkDecisions() {
  const root=await mkdtemp(join(tmpdir(),'rtlarch-decisions-'));let checks=0;
  const check=async(name:string,f:()=>unknown)=>{await f();console.log(`PASS ${++checks}: ${name}`)};
  try{
   await mkdir(join(root,'architecture'));await cp('examples/packet-pipeline/model.json',join(root,'architecture/model.json'));const repo=new Repository(root),base=await repo.getModel();
   const a=structuredClone(base.model),b=structuredClone(base.model);a.modules[0].name='候选 A';b.modules[0].name='候选 B';
   const commit=async(model:Model)=>{const current=await repo.getModel(),proposal={baseHash:current.modelHash,reason:'临时版本记录检查',commands:[{op:'replace_architecture',model}]},p=await repo.preview(proposal);return repo.commit({proposal,candidateHash:p.candidateHash});};
   await writeFile(join(root,'probe.cjs'),"console.log('version-binding fixture, not RTL verification');process.exit(process.argv.includes('--fail')?1:0)");
   const profile=(fail=false)=>({schemaVersion:1,name:'候选证据绑定检查（非 RTL）',stage:'lint',moduleIds:base.model.modules.map(m=>m.id),inputs:['probe.cjs'],inputClosure:{status:'declared_complete',note:'仅检查本地记录隔离'},timeoutMs:5000,commands:[{program:process.execPath,args:['probe.cjs',...(fail?['--fail']:[])],versionArgs:['--version']}],checks:[{kind:'exit_code'}]});
   await commit(a);const runA=await runVerification(root,profile());await commit(b);const runB=await runVerification(root,profile(true));await commit(base.model);
   for(const m of base.model.modules)await repo.reviewModule({modelHash:base.modelHash,moduleId:m.id,reviewer:'temporary fixture'});await repo.review({modelHash:base.modelHash,reviewer:'temporary fixture'});
   const files=['model.json','review.json','module-reviews.json'],bytes=await Promise.all(files.map(f=>readFile(join(root,'architecture',f))));
   const register=async(model:Model,reason:string)=>{const p=await repo.registerProposal({baseHash:base.modelHash,reason,commands:[{op:'replace_architecture',model}]});return {proposalId:p.id,modelHash:p.candidateHash};};
   const ca=await register(a,'方案 A'),cb=await register(b,'方案 B');
   const save=async(action:unknown)=>repo.updateWorkbench({baseHash:(await repo.getWorkbench()).workbenchHash,action});
   await save({kind:'ask',target:{modelHash:base.modelHash,moduleId:base.model.design.top,connectionIds:[]},title:'选择哪一个候选？',text:'按本次假设比较'});
   const threadId=(await repo.getWorkbench()).workbench.threads[0].id;
   const study:Study={id:'bound_budget',title:'条件化预算',modelHash:base.modelHash,moduleIds:[base.model.design.top],configuration:'相同工作量',assumptions:['工作项独立'],workItems:16,options:[{id:'a',label:'A',candidate:ca,compute:{lanes:1,operationsPerItem:1,cyclesPerOperation:1,overheadCycles:0},runIds:[runA.id]},{id:'b',label:'B',candidate:cb,compute:{lanes:2,operationsPerItem:1,cyclesPerOperation:1,overheadCycles:0},runIds:[runB.id]}]};
   const decision:DecisionInput={id:'decision',title:'记录 A/B 取舍',threadIds:[threadId],options:[ca,cb].map((candidate,i)=>({id:i?'b':'a',label:i?'B':'A',candidate,budget:{studyId:study.id,optionId:i?'b':'a'},assumptions:['只核对显式版本'],risks:['非 RTL 实验不能证明硬件性能'],experiments:[{runId:i?runB.id:runA.id,modelHash:candidate.modelHash}]}))};
   await check('read-only candidate evaluation isolates A/B hashes and preserves failed evidence',async()=>{
    assert.equal(runA.status,'passed');assert.notEqual(runB.status,'passed');
    const report=await repo.compareCandidates({before:a,after:b});assert(report.readOnly);assert.deepEqual(report.before.runs.map(r=>r.id),[runA.id]);assert.deepEqual(report.after.runs.map(r=>r.id),[runB.id]);
    assert.equal(report.after.runs[0].status,runB.status);assert.deepEqual(report.diff,semanticDiff(a,b));
    await save({kind:'study',study});await save({kind:'decision',decision});
   });
   await check('A evidence or budget cannot be attached to B and mismatched candidate hashes fail',async()=>{
    const wrong=structuredClone(decision);wrong.id='wrong_run';wrong.options[1].experiments=[{runId:runA.id,modelHash:cb.modelHash}];await assert.rejects(save({kind:'decision',decision:wrong}));
    wrong.id='wrong_budget';wrong.options[1].experiments=[];wrong.options[1].budget!.optionId='a';await assert.rejects(save({kind:'decision',decision:wrong}));
    const s=structuredClone(study);s.id='wrong_hash';s.options[0].candidate!.modelHash=cb.modelHash;await assert.rejects(save({kind:'study',study:s}));
   });
   await check('explicit user choice is append-only and does not resolve, commit or approve',async()=>{
    await save({kind:'choose_decision',decisionId:decision.id,optionId:'a',reason:'保留当前资源预算，后续独立验证'});
    const w=await new Repository(root).getWorkbench();assert.equal(w.workbench.decisions![0].choices.length,1);assert.equal(w.workbench.threads[0].status,'open');assert.equal(w.decisionStates[0].options[1].experiments[0].status,runB.status);
    for(const [i,file] of files.entries())assert.deepEqual(await readFile(join(root,'architecture',file)),bytes[i]);assert.equal((await repo.getModel()).reviewStatus,'APPROVED');
   });
   await check('candidate revision invalidates old comparison budgets; stale inputs retain historical failures',async()=>{
    const changed=structuredClone(b);changed.modules[0].name='候选 B 修订';const cb2=await register(changed,'修订 B');assert(!studyMatchesCandidates(study,[ca,cb2]));assert(studyMatchesCandidates(study,[ca,cb]));
    const d=structuredClone(decision);d.id='new_candidate_old_budget';d.options[1].candidate=cb2;d.options[1].experiments=[];await assert.rejects(save({kind:'decision',decision:d}));
    await writeFile(join(root,'probe.cjs'),'// changed source');let w=await repo.getWorkbench();assert(w.studyStates[0].stale);assert(w.decisionStates[0].options.every(o=>o.stale));assert.equal(w.decisionStates[0].options[1].experiments[0].status,runB.status);
    await assert.rejects(save({kind:'choose_decision',decisionId:decision.id,optionId:'a',reason:'不可静默复用旧来源'}));await commit(changed);w=await repo.getWorkbench();assert(w.studyStates.every(s=>s.stale));assert.equal(w.workbench.decisions![0].choices.length,1);
   });
   await check('deterministic summary covers rule order, state, width, truncation and full connections',async()=>{
    const before:Model=JSON.parse(await readFile('examples/typed-expressions/architecture/model.json','utf8')),after=structuredClone(before);
    const local=after.localSignals!.find(l=>l.driver.kind==='register')!;assert(local.driver.kind==='register');const first=local.driver.update!.branches[0];local.driver.update!.branches.unshift({...structuredClone(first),id:'earlier'});
    local.width=typeof local.width==='number'?local.width+1:16;
    let found=false;const walk=(v:any)=>{if(!v||typeof v!=='object')return;if(v.kind==='cast'&&v.mode==='truncate'&&!found){v.width++;found=true;}for(const child of Object.values(v))walk(child);};walk(after.localSignals);assert(found);
    after.connections[0].to={...after.connections[0].to,slice:{msb:0,lsb:0}};
    const raw=semanticDiff(before,after),summary=hardwareChangeSummary(before,after);for(const kind of ['state','priority','width','truncation','connection'])assert(summary.items.some(i=>i.category===kind));
    assert.deepEqual(semanticDiff(before,after),raw);const shuffled=structuredClone(after);shuffled.modules.reverse();shuffled.connections.reverse();shuffled.localSignals!.reverse();assert.deepEqual(hardwareChangeSummary(before,shuffled),summary);
    assert(summary.items.find(i=>i.category==='priority')!.text.includes('真实规则'));assert(summary.note.includes('没有推断端到端'));
   });
   console.log(`完成第二步 ${checks} 组决策检查；实验为本地记录隔离 fixture，不声称 RTL 验证。`);
  }finally{await rm(root,{recursive:true,force:true});}
}

export async function checkStorageBudget() {
  const root=await mkdtemp(join(tmpdir(),'rtlarch-storage-budget-'));let checks=0;
  const check=async(name:string,fn:()=>unknown)=>{await fn();console.log(`PASS ${++checks}: ${name}`);};
  const fixture=async(name:string):Promise<Study>=>studySchema.parse(JSON.parse(await readFile(`examples/storage-budget/${name}.json`,'utf8')));
  const result=(s:Study)=>evaluateStudy(s).options[0];
  try{
   await check('legacy inputs and workbench hash stay unchanged, old lower-bound numbers remain exact',()=>{
    const old:Study={id:'old',title:'old',modelHash:'0'.repeat(64),moduleIds:['top'],configuration:'legacy',assumptions:['independent'],workItems:10,options:['a','b'].map((id,i)=>({id,label:id,compute:{lanes:i+1,operationsPerItem:3,cyclesPerOperation:1,overheadCycles:2},memory:{words:8,width:16,copies:2,readsPerItem:1,writesPerItem:1,readPorts:1,writePorts:1},flow:{producedPerCycle:2,maxStallCycles:3,inFlight:4,capacity:9},runIds:[]}))};
    const w={schemaVersion:1,threads:[],checkpoint:null,studies:[old]},serialized=JSON.stringify(w),r=evaluateStudy(old);
    assert.deepEqual(workbenchSchema.parse(w),w);assert.equal(hashValue(workbenchSchema.parse(w)),hashValue(w));assert.equal(JSON.stringify(w),serialized);
    assert.deepEqual(r.options.map(o=>[o.computeII,o.memoryII,o.intervalLowerBound,o.cyclesLowerBound,o.storageBits,o.requiredCapacity,o.capacitySufficient]),[[3,1,3,32,256,10,false],[1.5,1,1.5,17,256,10,false]]);
    assert(r.options.every(o=>!('feasible' in o)&&o.scheduleStatus==='not_proven'));assert(!('timing' in old.options[0].compute));
   });
   await check('three-cycle pipelined latency differs from three-cycle exclusive occupancy; II is separate',async()=>{
    const s=await fixture('operation-timing'),r=evaluateStudy(s).options;
    assert.deepEqual(r.map(o=>o.computeII),[1,3]);assert.deepEqual(r.map(o=>o.constraints.resource.resultWindowLowerBound),[10,24]);
    assert.equal(r[0].constraints.resource.traceStatus,'no_conflict_in_declared_trace');assert.equal(r[1].constraints.resource.issues[0].code,'RESOURCE_OCCUPIED');
    s.options[0].compute.timing!.initiationInterval=3;const separated=result(s);assert.equal(separated.computeII,3);assert.equal(separated.constraints.resource.occupancyCycles,1);assert.equal(separated.constraints.resource.issues[0].code,'INITIATION_INTERVAL');
    s.options[0].compute.timing!.latencyCycles=99;assert.equal(result(s).computeII,3);
    s.options[0].compute.timing!.initiationInterval=null;assert.equal(result(s).constraints.resource.traceStatus,'unknown');
   });
   await check('shared R/W, independent 1R1W and 2RW obey an independent exhaustive port allocator',async()=>{
    // Exhaustively assign small request sets to explicit capable ports, unrelated to bound formula.
    const allocate=(requests:string[],ports:string[]):boolean=>!requests.length||ports.some((p,i)=>p.includes(requests[0])&&allocate(requests.slice(1),ports.filter((_,j)=>j!==i)));
    for(const kind of portKindSchema.options)for(let reads=0;reads<=4;reads++)for(let writes=0;writes<=4;writes++){
     const requests=[...Array(reads).fill('R'),...Array(writes).fill('W')],ports=kind==='shared_rw'?['RW']:kind==='independent_1r1w'?['R','W']:['RW','RW'];
     const report=memoryConstraint({kind,bankIds:['b'],readLatencyCycles:1,sameAddressReadWrite:'old_data',mapping:requests.map((_,i)=>({address:i,bank:'b',word:i}))},requests.map((r,i)=>({id:`a${i}`,cycle:0,kind:r==='R'?'read':'write',address:i})));
     assert.equal(report.issues.some(i=>i.code==='BANK_PORT_CONFLICT'),!allocate(requests,ports),`${kind} R${reads} W${writes}`);
    }
    const s=await fixture('shared-ram'),r=evaluateStudy(s).options;assert.deepEqual(r.map(o=>o.memoryII),[2,1]);assert.deepEqual(r.map(o=>o.cyclesLowerBound),[16,8]);assert.equal(r[0].constraints.memory.trace!.status,'conflict');assert.equal(r[1].constraints.memory.trace!.status,'no_conflict_in_declared_trace');
   });
   await check('identical aggregate ports cannot hide same-bank conflicts; every access ID is retained',async()=>{
    const s=await fixture('bank-conflict'),r=evaluateStudy(s).options;
    assert.deepEqual(r.map(o=>o.memoryII),[1,1]);assert.equal(r[0].constraints.memory.trace!.issues[0].code,'BANK_PORT_CONFLICT');assert.equal(r[1].constraints.memory.trace!.status,'no_conflict_in_declared_trace');
    for(const [i,o] of r.entries()){const m=s.options[i].memory!;assert('organization' in m);assert.deepEqual(o.constraints.memory.trace!.rows.map(a=>a.id).sort(),m.accesses!.map(a=>a.id).sort());}
   });
   await check('physical word aliases, read latency, read-during-write and unknown boundaries stay explicit',async()=>{
    const s=await fixture('shared-ram');s.options[0]=structuredClone(s.options[1]);s.options[0].id='a';const m=s.options[0].memory!;assert('organization' in m);
    m.accesses=m.accesses!.slice(0,2);m.organization.mapping[1].word=0; // Different logical addresses, same physical word.
    for(const mode of ['old_data','new_data','no_change','unknown','forbidden'] as const){m.organization.sameAddressReadWrite=mode;const trace=result(s).constraints.memory.trace!;
     assert.equal(trace.rows.find(a=>a.kind==='read')!.readValue,mode==='forbidden'?'unresolved_conflict':mode);
     assert.equal(trace.status,mode==='unknown'?'unknown':mode==='forbidden'?'conflict':'no_conflict_in_declared_trace');
     assert.equal(trace.rows.find(a=>a.kind==='read')!.readVisibleCycle,mode==='no_change'||mode==='forbidden'?null:1);
    }
    m.organization.sameAddressReadWrite='old_data';m.organization.readLatencyCycles=null;assert(result(s).constraints.memory.trace!.unknowns.some(i=>i.code==='READ_LATENCY_UNKNOWN'));
    m.organization.readLatencyCycles=2;m.accesses![0].address=999;assert.equal(result(s).constraints.memory.trace!.status,'unknown');assert.equal(result(s).constraints.memory.trace!.rows[0].bank,null);
    m.accesses![1].kind='read';const uncertain=result(s).constraints.memory.trace!;assert.equal(uncertain.rows[1].portStatus,'unknown');assert.equal(uncertain.rows[1].readVisibleCycle,null,'unmapped peer may conflict; known address must not imply an accepted read');
    m.accesses![0].address=0;m.accesses![0].kind='write';m.accesses![1].kind='write';m.organization.kind='true_dual_2rw';assert(result(s).constraints.memory.trace!.issues.some(i=>i.code==='SAME_WORD_WRITES'));
   });
   await check('feedback distance creates a separate recurrence bound, unknown never becomes zero latency',async()=>{
    const s=await fixture('feedback-flow'),o=result(s);assert.equal(o.constraints.recurrence.intervalLowerBound,1.5);assert.equal(o.integerIILowerBound,2);
    s.options[0].feedback![0].distance=1;assert.equal(result(s).intervalLowerBound,3);s.options[0].feedback![0].latencyCycles=null;assert.equal(result(s).constraints.recurrence.status,'unknown');assert.equal(result(s).constraints.recurrence.intervalLowerBound,null);
    s.options[0].feedback![0].distance=0;assert.throws(()=>evaluateStudy(s));
   });
   await check('8 GB/s arrival versus 6 GB/s drain rejects every finite FIFO despite a passing stall budget',async()=>{
    const s=await fixture('feedback-flow');for(const capacity of [0,16,1000000,1e9]){s.options[0].flow!.capacity=capacity;const o=result(s);assert.equal(o.constraints.capacity.sustained.status,'unbounded_growth');assert.equal(o.constraints.capacity.sustained.finiteCapacitySupportsLongTerm,false);assert.equal(o.constraints.capacity.sustained.timeToFill,capacity*4/2e9);if(capacity>=16)assert.equal(o.capacitySufficient,true);}
    const f=s.options[0].flow!.sustained!;f.consumption=8e9;assert.equal(result(s).constraints.capacity.sustained.status,'balanced_rates');assert.equal(result(s).constraints.capacity.sustained.finiteCapacitySupportsLongTerm,null);
    f.consumption=9e9;assert.equal(result(s).constraints.capacity.sustained.status,'rate_headroom');f.consumption=null;assert.equal(result(s).constraints.capacity.sustained.status,'unknown');
    s.options[0].flow!.sustained={unit:'items_per_cycle',arrival:0.5,consumption:0.25};assert.equal(result(s).constraints.capacity.sustained.netGrowth,0.25);
   });
   await check('invalid maps, resource identity, duplicate IDs, unsupported types and numeric overflow fail',async()=>{
    const s=await fixture('shared-ram');const fail=(change:(s:Study)=>void)=>{const c=structuredClone(s);change(c);assert.throws(()=>evaluateStudy(c));};
    fail(c=>{c.options[0].compute.launches![0].lane=1;});fail(c=>{c.options[0].compute.launches![1].id='op0';});fail(c=>{c.options[0].compute.launches![0].cycle=4096;});
    fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.bankIds.push('ram0');});
    fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.mapping[0].bank='missing';});
    fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.mapping[0].word=16;});
    fail(c=>{const m=c.options[0].memory!;assert('organization' in m);m.organization.mapping.push({...m.organization.mapping[0]});});
    fail(c=>{const m=c.options[0].memory!;assert('organization' in m);(m.organization as any).kind='arbitrary_multiport';});
    fail(c=>{c.workItems=1e9;c.options[0].compute.operationsPerItem=1e9;});
    fail(c=>{c.options[0].memory!.copies=2;});
    fail(c=>{c.options[0].memory!.words=1e9;c.options[0].memory!.width=1e9;});
   });
   await check('maximum finite request sets terminate with grouped diagnostics and complete membership',async()=>{
    const s=await fixture('shared-ram'),m=s.options[0].memory!;assert('organization' in m);
    m.accesses=Array.from({length:512},(_,i)=>({id:`write${i}`,cycle:0,kind:'write',address:0}));s.options[0].compute.launches=Array.from({length:256},(_,i)=>({id:`op${i}`,cycle:0,lane:0}));
    const r=result(s);assert.equal(r.constraints.memory.trace!.rows.length,512);assert.equal(r.constraints.memory.trace!.issues.length,2);assert.equal(r.constraints.memory.trace!.issues[1].members.length,512);assert.equal(r.constraints.resource.rows.length,256);assert.equal(r.constraints.resource.issues.length,255);assert(JSON.stringify(r).length<500000);
    m.accesses.push({...m.accesses[0],id:'overflow'});assert.throws(()=>evaluateStudy(s));
   });
   await check('CLI and core return identical calculation and explanation without workspace writes',async()=>{
    const before=await readdir(root);
    for(const name of ['shared-ram','operation-timing','bank-conflict','feedback-flow']){
     const parsed=JSON.parse(execFileSync(resolve('bin/rtlarch'),['study',resolve(`examples/storage-budget/${name}.json`),'--json'],{cwd:root,encoding:'utf8'}));assert(parsed.ok);delete parsed.ok;delete parsed.toolVersion;
     assert.deepEqual(parsed,evaluateStudy(await fixture(name)));
    }
    assert.deepEqual(await readdir(root),before);
   });
   await check('saved budgets round-trip without defaults and preserve approved temporary hardware bytes',async()=>{
    const dir=join(root,'workspace');await mkdir(join(dir,'architecture'),{recursive:true});await cp('examples/packet-pipeline/model.json',join(dir,'architecture/model.json'));
    const repo=new Repository(dir),base=await repo.getModel();for(const m of base.model.modules)await repo.reviewModule({modelHash:base.modelHash,moduleId:m.id,reviewer:'temporary budget fixture'});await repo.review({modelHash:base.modelHash,reviewer:'temporary budget fixture'});
    const names=['model.json','review.json','module-reviews.json'],bytes=await Promise.all(names.map(n=>readFile(join(dir,'architecture',n))));const s=await fixture('shared-ram');s.modelHash=base.modelHash;s.moduleIds=[base.model.design.top];
    const old=await repo.getWorkbench();await repo.updateWorkbench({baseHash:old.workbenchHash,action:{kind:'study',study:s}});assert.deepEqual((await new Repository(dir).getWorkbench()).workbench.studies[0],s);
    for(const [i,n] of names.entries())assert.deepEqual(await readFile(join(dir,'architecture',n)),bytes[i]);assert.equal((await repo.getModel()).reviewStatus,'APPROVED');
    await assert.rejects(repo.updateWorkbench({baseHash:(await repo.getWorkbench()).workbenchHash,action:{kind:'study',study:s}}));
   });
   console.log(`完成 ${checks} 组有限资源与存储预算检查；非 RTL 调度、仿真或性能证明。`);
  }finally{await rm(root,{recursive:true,force:true});}
}
