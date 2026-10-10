import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toolRoot, exists } from '../src/workspace/environment';
import type { ServiceInfo } from '../src/core/service';
const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'rtlarch-skill-check-'));
const projectA = join(root, 'project A'), projectB = join(root, 'project B'), bin = join(toolRoot, 'bin/rtlarch');
const env = { ...process.env }; delete env.RTLARCH_API_PORT; delete env.RTLARCH_WORKSPACE;
let checks = 0;
async function cli(args: string[], cwd = root, fail = false) {
  let stdout: string;
  try { stdout = (await exec(bin, [...args, '--json'], { cwd, env, maxBuffer: 4 * 1024 * 1024, timeout: 30000 })).stdout; assert.equal(fail, false, 'expected CLI to fail'); }
  catch (error) { if (!fail) throw error; stdout = (error as { stdout: string }).stdout; }
  const result = JSON.parse(stdout); assert.equal(result.ok, !fail); return result;
}
async function check(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${++checks}: ${name}`); }
const record = async (workspace: string): Promise<ServiceInfo> => JSON.parse(await readFile(join(workspace, '.rtlarch/runtime.json'), 'utf8'));
try {
  await mkdir(projectA); await mkdir(projectB);
  await check('doctor is read-only and reports an uninitialized workspace', async () => {
    const result = await cli(['doctor', '--workspace', projectA], root, true);
    assert.equal(result.error.code, 'ENVIRONMENT_NOT_READY'); assert.equal(await exists(join(projectA, '.rtlarch')), false);
    assert.equal(await exists(join(projectA, 'architecture')), false);
  });
  await check('init creates an explicit draft and refuses to overwrite it', async () => {
    const result = await cli(['init', '--workspace', projectA]); assert.equal(result.reviewStatus, 'DRAFT');
    const before = await readFile(join(projectA, 'architecture/model.json'), 'utf8');
    assert.equal((await cli(['init', '--workspace', projectA], root, true)).error.code, 'WORKSPACE_EXISTS');
    assert.equal(await readFile(join(projectA, 'architecture/model.json'), 'utf8'), before);
  });
  await check('concurrent CLI requests automatically start exactly one service for the workspace', async () => {
    const [a, b] = await Promise.all([cli(['context', '--workspace', projectA]), cli(['start', '--workspace', projectA])]);
    assert.equal(a.workspaceId, b.workspaceId); assert.equal(a.model.modules.length, 1);
    const info = await record(projectA); assert.equal(info.instanceId, b.service.instanceId);
    assert.equal((await cli(['doctor', '--workspace', projectA])).ready, true);
  });
  await check('nested directories and symlinks resolve to the same workspace; module context is scoped', async () => {
    const nested = join(projectA, 'rtl/subsystem'); await mkdir(nested, { recursive: true });
    const result = await cli(['context', '--module', 'top'], nested);
    assert.equal(result.workspaceRoot, projectA); assert.equal(result.module.id, 'top'); assert.equal(result.model, undefined);
    const alias = join(root, 'alias'); await symlink(projectA, alias);
    assert.equal((await cli(['status', '--workspace', alias])).workspaceId, result.workspaceId);
  });
  await check('two projects have isolated services; explicit wrong port and copied runtime record are rejected', async () => {
    await cli(['init', '--workspace', projectB]); await cli(['start', '--workspace', projectB]);
    const a = await record(projectA), b = await record(projectB); assert.notEqual(a.apiUrl, b.apiUrl); assert.notEqual(a.workspaceId, b.workspaceId);
    const wrong = await cli(['status', '--workspace', projectB, '--api-port', new URL(a.apiUrl).port], root, true);
    assert.equal(wrong.error.code, 'WORKSPACE_MISMATCH');
    const mismatch = await fetch(`${a.apiUrl}/api/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RTLArch-Workspace': b.workspaceId }, body: '{}' });
    assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).code, 'WORKSPACE_MISMATCH');
    const path = join(projectB, '.rtlarch/runtime.json');
    await writeFile(path, JSON.stringify(a));
    try { assert.equal((await cli(['status', '--workspace', projectB], root, true)).error.code, 'WORKSPACE_MISMATCH'); }
    finally { await writeFile(path, JSON.stringify(b)); }
  });
  await check('stop releases metadata and dead service locks are recovered on restart', async () => {
    const old = await record(projectA); assert.equal((await cli(['stop', '--workspace', projectA])).stopped, true);
    assert.equal(await exists(join(projectA, '.rtlarch/runtime.json')), false);
    await writeFile(join(projectA, '.rtlarch/service.lock'), JSON.stringify({ pid: 2147483647, instanceId: 'dead-process' }));
    await cli(['start', '--workspace', projectA]); assert.notEqual((await record(projectA)).instanceId, old.instanceId);
    assert.equal(await exists(join(projectA, '.rtlarch/recover.lock')), false);
  });
  await check('draft --open registers an immutable proposal and returns a workspace-bound review link without committing', async () => {
    const info = await record(projectA), before = await cli(['status', '--workspace', projectA]);
    const file = join(projectA, 'proposals/pipeline.json');
    const draft = await cli(['draft', join(toolRoot, 'examples/packet-pipeline/model.json'), file, '--workspace', projectA, '--open']);
    const url = new URL(draft.reviewUrl); assert.equal(url.searchParams.get('workspace'), info.workspaceId); assert.equal(url.searchParams.get('proposal'), draft.proposalId);
    const again = await cli(['propose', file, '--workspace', projectA, '--open']); assert.equal(again.proposalId, draft.proposalId);
    const listing = await cli(['proposals', '--workspace', projectA]); assert.equal(listing.proposals.length, 1); assert.equal(listing.proposals[0].state, 'READY');
    assert.equal((await cli(['status', '--workspace', projectA])).modelHash, before.modelHash);
    assert.equal(await exists(join(projectA, 'architecture/review.json')), false);
    const saved = await (await fetch(`${info.apiUrl}/api/proposals/${draft.proposalId}`)).json();
    assert.equal(saved.preview.candidate.modules.length, 7); assert.equal(saved.preview.candidateHash, draft.candidateHash);
    const committed = await fetch(`${info.apiUrl}/api/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RTLArch-Workspace': info.workspaceId }, body: JSON.stringify({ proposal: saved.proposal, candidateHash: saved.candidateHash }) });
    assert.equal(committed.status, 200); assert.equal((await (await fetch(`${info.apiUrl}/api/proposals/${draft.proposalId}`)).json()).state, 'APPLIED');
  });
  await check('module context excludes unrelated architecture and unapproved handoff returns a stable error code', async () => {
    const context = await cli(['context', '--workspace', projectA, '--module', 'buffer']);
    assert.equal(context.model, undefined); assert.equal(context.module.id, 'buffer'); assert.equal(context.parent.id, 'processing');
    assert.deepEqual(context.neighbors.map((n: { id: string }) => n.id).sort(), ['compute', 'scheduler']);
    assert.ok(context.requirements.some((r: { id: string }) => r.id === 'REQ_BUFFER'));
    assert.equal((await cli(['handoff', 'buffer', '--workspace', projectA], root, true)).error.code, 'REVIEW_REQUIRED');
  });
  await check('registered proposals become stale after another commit and retain their original baseHash', async () => {
    const info = await record(projectA), snapshot = await cli(['status', '--workspace', projectA]);
    const proposal = { baseHash: snapshot.modelHash, reason: 'buffer depth', commands: [{ op: 'set_parameter', moduleId: 'buffer', key: 'DEPTH', value: 32 }] };
    const file = join(projectA, 'proposals/depth.json'); await writeFile(file, JSON.stringify(proposal));
    const registered = await cli(['propose', file, '--workspace', projectA]);
    const other = { baseHash: snapshot.modelHash, reason: 'another client', commands: [{ op: 'rename_module', moduleId: 'egress', name: 'Output stage' }] };
    const post = async (path: string, body: unknown) => fetch(`${info.apiUrl}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const candidate = await (await post('preview', other)).json(); assert.equal((await post('commit', { proposal: other, candidateHash: candidate.candidateHash })).status, 200);
    const saved = await (await fetch(`${info.apiUrl}/api/proposals/${registered.id}`)).json(); assert.equal(saved.state, 'STALE'); assert.equal(saved.proposal.baseHash, snapshot.modelHash); assert.equal(saved.preview, undefined);
    assert.equal((await post('commit', { proposal, candidateHash: registered.candidateHash })).status, 409);
    const path = join(projectA, `proposals/registered/${registered.id}.json`), original = await readFile(path, 'utf8');
    const altered = JSON.parse(original); altered.proposal.reason = 'tampered'; await writeFile(path, JSON.stringify(altered));
    try { const rejected = await fetch(`${info.apiUrl}/api/proposals/${registered.id}`); assert.equal(rejected.status, 422); assert.equal((await rejected.json()).code, 'PROPOSAL_CORRUPT'); }
    finally { await writeFile(path, original); }
  });
  await check('an incompatible running tool version is rejected with VERSION_MISMATCH', async () => {
    const actual = await record(projectA);
    const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...actual, toolVersion: '0.0.0', apiUrl: `http://127.0.0.1:${(server.address() as {port:number}).port}` })); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const result = await cli(['status', '--workspace', projectA, '--api-port', String((server.address() as {port:number}).port)], root, true);
      assert.equal(result.error.code, 'VERSION_MISMATCH');
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  });
  await check('project skill installation is idempotent and its entry works from an unrelated cwd', async () => {
    await cli(['install', '--workspace', projectA]);
    assert.equal((await cli(['install', '--workspace', projectA])).links[0].installed, false);
    const entry = join(projectA, '.agents/skills/rtl-architect/scripts/rtlarch');
    const response = JSON.parse((await exec(entry, ['context', '--workspace', projectA, '--module', 'buffer', '--json'], { cwd: root, env })).stdout);
    assert.equal(response.ok, true); assert.equal(response.module.id, 'buffer');
    assert.equal(response.parent.interfaces[0].resolvedWidth, 128);
    assert.equal(await exists(join(projectA, 'AGENTS.md')), false);
    await mkdir(join(projectB, '.agents/skills/rtl-architect'), { recursive: true });
    assert.equal((await cli(['install', '--workspace', projectB], root, true)).error.code, 'INSTALL_CONFLICT');
  });
  console.log(`完成 ${checks} 组 skill 入口检查；所有项目及服务均为临时创建。`);
} finally {
  for (const workspace of [projectA, projectB]) await exec(bin, ['stop', '--workspace', workspace, '--json'], { env, timeout: 15000 }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
