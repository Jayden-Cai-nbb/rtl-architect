// Regressions drawn from real RTL import feedback. All writes use temporary projects.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelSchema, type Model, type Module, type Proposal } from '../src/core/schema';
import { applyCommands, validateModel } from '../src/core/engine';
import { semanticDiff } from '../src/core/diff';
import { contractData, modelHash } from '../src/core/export';
import { specMarkdown } from '../src/core/spec';
import { Repository, atomicWrite } from '../src/workspace/repository';
import { architectureContext } from '../src/workspace/context';
import { scopeDiagram } from '../src/web/graph/scopeDiagram';
import { elkLayout } from '../src/web/graph/elkLayout';
import { sourceInventory } from '../src/workspace/inventory';
import { toolRoot } from '../src/workspace/environment';

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
