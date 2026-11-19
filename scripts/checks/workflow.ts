import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { modelHash } from '../../src/core/export';
import { modelSchema } from '../../src/core/schema';
import { type ServiceInfo } from '../../src/core/service';
import { sourceBuildId } from '../../src/workspace/build';
import { exists, toolRoot, toolVersion } from '../../src/workspace/environment';

export async function checkSkillEntrypoints() {
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
    await check('help discovers runnable schemas and supports command-specific queries without a workspace', async () => {
      const help = await cli(['help']);
      const replay = await cli(['replay', '--help']);
      assert.deepEqual(Object.keys(replay.commands), ['replay']);
      assert.deepEqual(replay.schemas, ['transactionPath', 'replay', 'replaySamples', 'verification']);
      assert(replay.capabilities.unsupported.some((item:{semantics:string})=>item.semantics==='addressed_frame_fifo'));
      const workbench = await cli(['help', 'workbench']);
      assert(workbench.schemas.includes('selection') && workbench.schemas.includes('decision'));
      assert.deepEqual((await cli(['help', 'schema'])).schemas, help.schemas);
      for (const name of help.schemas) {
        const result = await cli(['schema', name]);
        assert.match(result[name].$schema, /json-schema\.org/);
      }
      assert.deepEqual(Object.keys(await cli(['schema'])), ['ok', 'toolVersion', 'model', 'proposal']);
      assert.equal((await cli(['schema', 'constructor'], root, true)).error.code, 'USAGE');
      assert.equal((await cli(['help', 'no_such_command'], root, true)).error.code, 'USAGE');
      assert.equal(await exists(join(root, '.rtlarch')), false);
    });
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
      const supported=await cli(['replay','--workspace',projectA,'--semantics','registered_skid']);
      const unavailable=await cli(['replay','--workspace',projectA,'--semantics','addressed_frame_fifo']);
      assert.equal(supported.availability.status,'NOT_DECLARED');
      assert.equal(unavailable.availability.status,'UNSUPPORTED');
      assert.match(unavailable.independentVerification.command,/verify/);
      assert.equal(await exists(join(projectA,'.rtlarch')),false);
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
}

export async function checkManagedService() {
  const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-open-')),copy=join(root,'tool'),a=join(root,'a'),b=join(root,'b');
  const env={...process.env};delete env.RTLARCH_API_PORT;delete env.RTLARCH_WORKSPACE;
  async function cli(workspace:string,args:string[],fail=false){try{const r=await exec(join(copy,'bin/rtlarch'),[...args,'--workspace',workspace,'--json'],{cwd:workspace,env,timeout:210000,maxBuffer:4*1024*1024});assert.equal(fail,false,'expected rejection');return JSON.parse(r.stdout);}catch(e){if(!fail)throw e;return JSON.parse((e as {stdout:string}).stdout);}}
  try{
   await mkdir(copy);for(const name of ['src','scripts','bin','dist','examples/storage-budget','package.json','package-lock.json','vite.config.ts','tsconfig.json','index.html'])await cp(join(toolRoot,name),join(copy,name),{recursive:true});
   await symlink(join(toolRoot,'node_modules'),join(copy,'node_modules'));
   const exampleFile=join(copy,'examples/storage-budget/shared-ram.json'),exampleBytes=await readFile(exampleFile),beforeExamples=await sourceBuildId(copy);
   const changedExample=JSON.parse(exampleBytes.toString());changedExample.options[0].label+=' changed fixture';await writeFile(exampleFile,JSON.stringify(changedExample));assert.notEqual(await sourceBuildId(copy),beforeExamples);
   await writeFile(exampleFile,exampleBytes);assert.equal(await sourceBuildId(copy),beforeExamples);
   for(const dir of [a,b]){await mkdir(join(dir,'architecture'),{recursive:true});await cp(join(toolRoot,'examples/packet-pipeline/model.json'),join(dir,'architecture/model.json'));}
   const first=await cli(a,['open']),other=await cli(b,['open']);assert.equal(first.rebuilt,false);
   // Same package version, different production source. Existing services must not be silently reused.
   await appendFile(join(copy,'src/core/service.ts'),'\n// isolated source update fixture\n');
   const denied=await cli(a,['open'],true);assert.equal(denied.error.code,'RESTART_REQUIRED');assert.equal((await (await fetch(other.service.apiUrl+'/api/health')).json()).instanceId,other.service.instanceId);
   const resumed=await cli(a,['open','--restart']);assert.equal(resumed.rebuilt,true);assert.notEqual(resumed.service.buildId,first.service.buildId);assert.notEqual(resumed.service.instanceId,first.service.instanceId);
   assert.equal((await (await fetch(other.service.apiUrl+'/api/health')).json()).instanceId,other.service.instanceId);
   assert.equal((await cli(b,['context'],true)).error.code,'SERVICE_BUILD_MISMATCH');
   const html=await (await fetch(resumed.reviewUrl)).text();assert.ok(html.includes('/assets/'));
   await cli(a,['stop']);await rm(join(copy,'dist'),{recursive:true});
   const missing=await cli(a,['open']);assert.equal(missing.rebuilt,true);assert.equal(missing.browser.opened,false);
   console.log('PASS 1: same-version stale sources require explicit workspace restart; a second workspace is untouched');
   console.log('PASS 2: missing web build is rebuilt, identity is current and --json returns a usable URL without browser launch');
   // Invalid source never falls back to serving an old successful build.
   await cli(a,['stop']);await writeFile(join(copy,'src/web/broken.ts'),'this is invalid TypeScript !!!!\n');
   const bad=await cli(a,['open'],true);assert.equal(bad.error.code,'BUILD_FAILED');assert.ok((await readFile(join(a,'.rtlarch/build.log'),'utf8')).includes('error TS'));
   console.log('PASS 3: failed rebuild reports a saved build log, never a stale success link');
   console.log('PASS 4: bundled budget examples participate in build identity and survive isolated tool copies');
  }finally{for(const workspace of [a,b]){try{const info=JSON.parse(await readFile(join(workspace,'.rtlarch/runtime.json'),'utf8'));await fetch(info.apiUrl+'/api/runtime/stop',{method:'POST',headers:{'Content-Type':'application/json','X-RTLArch-Workspace':info.workspaceId},body:'{}'});for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));try{await fetch(info.apiUrl+'/api/health',{signal:AbortSignal.timeout(500)});}catch{break;}}}catch{}}await rm(root,{recursive:true,force:true});}
  console.log('完成 4 组统一打开与升级恢复检查。');
}

export async function checkRtlWorkflow(reportPath?: string) {
  const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-workflow-')),bin=join(toolRoot,'bin/rtlarch'),begin=performance.now();
  const env={...process.env};delete env.RTLARCH_API_PORT;delete env.RTLARCH_WORKSPACE;
  let cliCalls=0;const timings:Record<string,number>={};
  async function cli(args:string[]){cliCalls++;const r=await exec(bin,[...args,'--workspace',root,'--json'],{env,timeout:210000,maxBuffer:16*1024*1024});const data=JSON.parse(r.stdout);assert.equal(data.ok,true);return data;}
  let url='';
  async function post(path:string,body:unknown){const response=await fetch(`${url}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
  try{
   await cp(join(toolRoot,'examples/rtl-intake'),root,{recursive:true});
   const opened=await cli(['open','--init']);url=opened.service.apiUrl;assert.equal(opened.service.buildId,await sourceBuildId());
   const initial=await cli(['context']);assert.equal(initial.model.clocks.length,0);assert.equal(initial.model.modules[0].timing,'unknown');
   const yosys=await exec('yosys',['-Q','-T','-p','read_verilog -sv rtl/stage.sv rtl/stream_top.sv; hierarchy -top stream_top; proc; write_json netlist.json'],{cwd:root,env,timeout:30000,maxBuffer:4*1024*1024});
   await writeFile(join(root,'elaboration.log'),yosys.stdout+yosys.stderr);
   const imported=await cli(['import-yosys',join(root,'inputs.json'),join(root,'intake')]);
   const draft=await cli(['draft',imported.modelFile,join(root,'first-proposal.json'),'--open']);
   timings.firstCandidateMs=Math.round(performance.now()-begin);
   const registered=await (await fetch(`${url}/api/proposals/${draft.proposalId}`)).json();
   assert.equal(registered.preview.candidate.provenance.fidelity,'partial');
   const committed=await post('commit',{proposal:registered.proposal,candidateHash:registered.candidateHash}); // Simulated human save, isolated fixture only.
   let work=await cli(['workbench']);
   const model=modelSchema.parse(committed.model),module=model.modules.find(m=>m.parent===model.design.top)!;
   async function action(action:unknown){const f=join(root,'work-action.json');await writeFile(f,JSON.stringify({baseHash:work.workbenchHash,action}));work=await cli(['workbench',f]);return work;}
   await action({kind:'ask',title:'为什么分成两级？',text:'是否每一级都寄存，复位期间有效位如何清除？',target:{modelHash:committed.modelHash,moduleId:module.id,connectionIds:[]}});
   const threadId=work.workbench.threads[0].id,context=await cli(['context','--module',module.id]);
   assert.equal(context.collaboration.threads[0].id,threadId);
   const proposal={baseHash:committed.modelHash,reason:'依据源码说明第一级职责，保留时序缺口',commands:[{op:'rename_module',moduleId:module.id,name:'第一级：输入加一并寄存'}]};
   const file=join(root,'clarify.json');await writeFile(file,JSON.stringify(proposal));const candidate=await cli(['propose',file]);
   await action({kind:'reply',threadId,author:'agent',modelHash:committed.modelHash,text:'stage.sv 在上升沿寄存数据与 valid；低有效同步复位清零。两级的角色名称在候选中说明，完整周期合同仍待核对。',proposalId:candidate.id});
   await action({kind:'checkpoint',intent:'核对两级处理的时序与复位',nextStep:'阅读答复，检查候选，再核对原 RTL 仿真记录',target:{modelHash:candidate.candidateHash,moduleId:module.id,connectionIds:[],proposalId:candidate.id}});
   const restartStart=performance.now();await cli(['stop']);const reopened=await cli(['open']);url=reopened.service.apiUrl;
   assert.equal(new URL(reopened.reviewUrl).searchParams.get('proposal'),candidate.id);assert.equal(new URL(reopened.reviewUrl).searchParams.get('module'),module.id);assert.equal(reopened.resume.workbench.threads[0].messages.length,2);assert.equal(reopened.resume.workbench.checkpoint.intent,'核对两级处理的时序与复位');
   timings.resumeAfterRestartMs=Math.round(performance.now()-restartStart);
   const startRun=performance.now(),run=await cli(['verify',join(root,'verify.json')]);assert.equal(run.status,'passed');timings.simulationRunMs=Math.round(performance.now()-startRun);
   const original=await readFile(join(root,'rtl/stage.sv'),'utf8');await writeFile(join(root,'rtl/stage.sv'),original.replace('data_i + BIAS','data_i - BIAS'));
   const impact=await cli(['import-impact',imported.reportFile]),runs=await cli(['runs']);assert.equal(impact.affectedModuleIds.length,2);assert.equal(impact.unaffectedModuleIds.length,1);assert.equal(runs.runs[0].fresh,false);
   const review=await fetch(`${url}/api/review`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelHash:committed.modelHash,reviewer:'fixture'})});assert.equal(review.status,422);
   const report={toolVersion,sourceBuildId:opened.service.buildId,recordedAt:new Date().toISOString(),fixture:'examples/rtl-intake',scenario:'raw RTL → elaboration → candidate → human-save fixture → graph question → CLI context → candidate-linked reply → checkpoint → service restart → RTL simulation → source-change invalidation',timings,cliCalls,model:{modules:imported.modules,connections:imported.connections,fidelity:'partial'},restored:{threads:1,messages:2,checkpoint:true,candidate:true,module:true,manualContextReentry:0},sourceChange:{affectedModules:impact.affectedModuleIds.length,unaffectedModules:impact.unaffectedModuleIds.length,verificationFresh:false},verification:{status:run.status,checks:run.checks,toolVersion:run.steps[0].toolVersion},totalMs:Math.round(performance.now()-begin),note:'自动化临时工作区测量，非人类可读性或效率提升百分比；第一次构建是否需要会影响时间。仿真只验证此 RTL 样例，不证明导入模型完整。'};
   if(reportPath)await writeFile(resolve(reportPath),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
   console.log(JSON.stringify(report,null,2));
  }finally{await cli(['stop']).catch(()=>undefined);await rm(root,{recursive:true,force:true});}
}

export async function checkReadingEdits() {
  const result = await promisify(execFile)('python3', ['-B', join(toolRoot, 'scripts/checks/reading-edit.py')], { timeout: 30_000 });
  console.log(result.stdout.trimEnd());
}

export async function checkRtlFixture() {
  const version = spawnSync('verilator', ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.error?.message ?? version.stderr);
  console.log(version.stdout.trim());
  const build = await mkdtemp(join(tmpdir(), 'rtlarch-rtl-'));
  const run = (program: string, args: string[], timeout: number) => spawnSync(program, args, {
    cwd: build, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024,
  });
  try {
    const fixtureRoot = join(toolRoot, 'examples/tiny-stream');
    const fixture = modelSchema.parse(JSON.parse(await readFile(join(fixtureRoot, 'model.json'), 'utf8')));
    console.log(`初始 RTL fixture hash=${modelHash(fixture)}`);
    const sources = ['rtl/rv_fifo.sv', 'rtl/add_const.sv', 'rtl/stream_path.sv', 'rtl/tiny_stream.sv', 'tb/tb_tiny_stream.sv'];
    const compiled = run('verilator', ['--binary', '--timing', '--assert', '--top-module', 'tb_tiny_stream',
      '--Mdir', join(build, 'obj'), '-j', '2', ...sources.map(file => join(fixtureRoot, file))], 180_000);
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}\n${compiled.error ?? ''}`);
    const binary = join(build, 'obj/Vtb_tiny_stream');
    const normal = run(binary, [], 30_000);
    assert.equal(normal.status, 0, `${normal.stdout}\n${normal.stderr}\n${normal.error ?? ''}`);
    assert.match(normal.stdout, /PASS fixture/);
    console.log(normal.stdout.trimEnd());
    const timeout = run(binary, ['+force_timeout'], 30_000);
    assert.ifError(timeout.error);
    assert(timeout.status !== 0 || timeout.signal);
    assert.match(`${timeout.stdout}${timeout.stderr}`, /TIMEOUT:/);
    console.log('PASS timeout negative control');
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}
