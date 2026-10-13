import {verificationImpact} from '../core/verificationImpact';
import {assurance} from '../workspace/assurance';
import {conformanceSchema,runConformance} from '../workspace/conformance';
import {checkBindingsSchema,generateChecks} from '../workspace/contractChecks';
import {contextViewSchema} from '../workspace/contextView';
import {openWorkspace} from './open';
import {buildStatus} from '../workspace/build';
import {workActionSchema,workbenchSchema} from '../core/workbench';
import {studySchema,evaluateStudy} from '../core/studies';
import {yosysManifestSchema,importYosys,importImpact} from '../workspace/importYosys';
import {verificationProfileSchema,runVerification,verificationRuns} from '../workspace/verification';
import {RequestSizeError,serializeRequest} from '../core/transport';
import { semanticDiff } from '../core/diff';
import { validateModel } from '../core/engine';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { layoutSchema, modelSchema, proposalSchema, type Model } from '../core/schema';
import type { Snapshot, Preview } from '../core/api';
import { createTemplate } from '../core/templates';
import { modelHash } from '../core/export';
import { Repository } from '../workspace/repository';
import { exists, installLink, loader, locateWorkspace, skillRoot, toolRoot, toolVersion, ToolError, workspaceIdentity } from '../workspace/environment';
import { discoverService, ensureService, request, stopService } from './service-client';
import { startService } from '../server/service';
import { architectureContext } from '../workspace/context';
import { inputManifestSchema, sourceInventory } from '../workspace/inventory';

import { evidenceFreshness } from '../workspace/freshness';
import { exportBundle } from '../workspace/bundle';

type Options = { purpose?:string; maxBytes?:number; offset?:number; limit?:number; model?: string; layout?: string; index?:number; workspace?: string; module?: string; apiPort?: number; port?: number; name?: string; json: boolean; open: boolean; user: boolean; offline: boolean; restart:boolean; init:boolean };
function parseArgs() {
  const options: Options = { json: false, open: false, user: false, offline: false, restart:false, init:false }, positionals: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (['--json', '--open', '--user', '--offline', '--restart', '--init'].includes(arg)) { options[arg.slice(2) as 'json' | 'open' | 'user' | 'offline' | 'restart' | 'init'] = true; continue; }
    if (['--workspace', '--module', '--api-port', '--port', '--name', '--index', '--model', '--layout', '--purpose', '--max-bytes', '--offset', '--limit'].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new ToolError('USAGE', `${arg} 缺少参数`);
      if(arg==='--purpose'){options.purpose=value;continue;}
      if(['--max-bytes','--offset','--limit'].includes(arg)){const key=arg==='--max-bytes'?'maxBytes':arg.slice(2) as 'offset'|'limit';options[key]=Number(value);continue;}
      if(arg==='--index'){options.index=Number(value);if(!Number.isSafeInteger(options.index)||options.index<0)throw new ToolError('USAGE','index 必须为非负整数');continue;}
      if (arg === '--api-port' || arg === '--port') {
        const port = Number(value); if (!Number.isInteger(port) || port < (arg === '--port' ? 0 : 1) || port > 65535) throw new ToolError('USAGE', '端口超出有效范围');
        if (arg === '--api-port') options.apiPort = port; else options.port = port;
      } else options[arg.slice(2) as 'workspace' | 'module' | 'name' | 'model' | 'layout'] = value;
      continue;
    }
    if (arg.startsWith('-')) { if (arg === '--help' || arg === '-h') positionals.unshift('help'); else throw new ToolError('USAGE', `未知选项 ${arg}`); }
    else positionals.push(arg);
  }
  if (options.apiPort === undefined && process.env.RTLARCH_API_PORT) {
    const port = Number(process.env.RTLARCH_API_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError('USAGE', 'RTLARCH_API_PORT 无效');
    options.apiPort = port;
  }
  return { options, positionals };
}
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function main() {
  const { options, positionals } = parseArgs(), [command = 'help', argument, destination] = positionals;
  if (command === 'help') return { ok: true, toolVersion, commands: {
    checks:'checks <bindings.json> <新目录> --workspace . --json',conform:'conform <mapping.json> --workspace . --json',assurance:'assurance [--module ID] --workspace . --json', 'context-index':'context-index [--module ID] [--offset N] [--limit N] [--max-bytes N] --offline --json',
    open:'open --workspace . [--init] [--restart] [--json]（构建、续接并打开当前页面）', resume:'resume --workspace . --json（继续工作、问题、候选与验证）',workbench:'workbench [action.json] --workspace . --json',study:'study <budget.json> --json（只读计算，保存使用 workbench）',verify:'verify <profile.json> --workspace . --json（显式运行）',runs:'runs --workspace . --json',
    'import-yosys':'import-yosys <manifest.json> <新目录> --workspace . --json', 'import-impact':'import-impact <import.json> --workspace . --json',
    evidence: 'evidence [--model candidate.json] --workspace . --json（只读，不启动服务）', bundle: 'bundle <新目录> [--model candidate.json] [--layout layout.json] --workspace . --json',
    doctor: 'doctor --workspace . --json', init: 'init --workspace . [--name 名称]', start: 'start --workspace .', stop: 'stop --workspace .',
    serve: 'serve --workspace . [--port 0] [--api-port 4317]', context: 'context [moduleId] [--module moduleId] [--index N] [--purpose design|review|implementation|debug] [--max-bytes N] [--offline] --workspace . --json',
    compare: 'compare <before-model.json> <after-model.json> --json（只读，不启动服务）', schema: 'schema [model|proposal|inputs|layout]', inventory: 'inventory <inputs.json> --workspace . --json', draft: 'draft <model.json> [proposal.json] --workspace . [--open] --json',
    preview: 'preview <proposal.json> --workspace . --json', propose: 'propose <proposal.json> --workspace . [--open] --json',
    proposals: 'proposals --workspace . --json', handoff: 'handoff <moduleId> --workspace . --json', status: 'status --workspace . --json',
    validate: 'validate --workspace . --json', spec: 'spec [moduleId] --workspace . [--json]', export: 'export spec|contract --workspace .',
    install: 'install --workspace <目标项目> 或 install --user',
  }, note: '--open 返回可直接打开的审阅链接；不自动提交或批准。不弹出浏览器，适用于终端和 WSL。' };
  const supported = ['checks','conform','assurance','context-index','open','resume','workbench','study','verify','runs','import-yosys','import-impact','evidence', 'bundle', 'compare','doctor', 'init', 'start', 'stop', 'serve', 'context', 'schema', 'inventory', 'draft', 'preview', 'propose', 'proposals', 'handoff', 'status', 'validate', 'spec', 'export', 'install'];
  if (!supported.includes(command)) throw new ToolError('USAGE', `未知命令 ${command}，运行 rtlarch help 查看用法。`);
  const maxArgs = ['checks','draft','compare','import-yosys'].includes(command) ? 3 : ['conform','workbench','study','verify','import-impact','bundle', 'context', 'schema', 'inventory', 'preview', 'propose', 'handoff', 'spec', 'export'].includes(command) ? 2 : 1;
  if (positionals.length > maxArgs) throw new ToolError('USAGE', '命令包含多余参数');
  if((options.purpose||options.maxBytes!==undefined||options.offset!==undefined||options.limit!==undefined)&&!['context','context-index'].includes(command))throw new ToolError('USAGE','上下文选项仅用于 context/context-index');
  if(command==='context'&&!options.purpose&&(options.maxBytes!==undefined||options.offset!==undefined||options.limit!==undefined))throw new ToolError('USAGE','局部字节预算需配合 --purpose');
  if(command==='context'&&(options.offset!==undefined||options.limit!==undefined))throw new ToolError('USAGE','分页仅用于 context-index');
  if(options.init && command!=='open')throw new ToolError('USAGE','--init 仅用于 open，无模型时创建未定义的草稿');
  if(options.restart && command!=='open')throw new ToolError('USAGE','--restart 仅用于 open，且只影响指定工作区');
  if (options.model && !['evidence','bundle'].includes(command) || options.layout && command !== 'bundle') throw new ToolError('USAGE', '--model 仅用于 evidence/bundle；--layout 仅用于 bundle');
  if (options.port !== undefined && command !== 'serve') throw new ToolError('USAGE', '--port 仅用于 serve；后台服务自动分配端口。');
  if (options.open && !['draft', 'propose'].includes(command)) throw new ToolError('USAGE', '--open 仅用于 draft/propose。');
  if (options.module && !['context-index','assurance','context', 'handoff', 'spec'].includes(command)) throw new ToolError('USAGE', '--module 不适用于此命令。');
  if(options.index!==undefined&&(command!=='context'||!(options.module??argument)))throw new ToolError('USAGE','--index 需配合 context 的模块 ID');
  if (options.user && command !== 'install') throw new ToolError('USAGE', '--user 仅用于 install。');
  if (options.offline && !['context-index','context','resume','workbench'].includes(command)) throw new ToolError('USAGE', '--offline 仅用于只读 context。');
  if (options.offline && options.apiPort !== undefined) throw new ToolError('USAGE', '--offline 不连接 API，请移除 --api-port / RTLARCH_API_PORT。');
  if (options.name && command !== 'init') throw new ToolError('USAGE', '--name 仅用于 init。');
  if (['bundle', 'draft', 'preview', 'propose', 'export', 'inventory'].includes(command) && !argument || command === 'handoff' && !(options.module ?? argument)) throw new ToolError('USAGE', '命令缺少必要参数，请运行 rtlarch help。');
  if (command === 'export' && !['spec', 'contract'].includes(argument)) throw new ToolError('USAGE', 'export 仅支持 spec/contract。');
  if(command==='compare'){
    if(!argument||!destination)throw new ToolError('USAGE','compare 需要两个模型 JSON 文件');
    const [before,after]=await Promise.all([argument,destination].map(async file=>modelSchema.parse(JSON.parse(await readFile(resolve(file),'utf8')))));
    return {ok:true,toolVersion,command,readOnly:true,beforeHash:modelHash(before),afterHash:modelHash(after),diff:semanticDiff(before,after),impact:verificationImpact(before,after),beforeIssues:validateModel(before),afterIssues:validateModel(after),note:'候选比较不影响提交基线；提交仍须以工作区当前 hash 预览。'};
  }
  if(command==='study'){if(!argument)throw new ToolError('USAGE','study 需要预算文件');return {ok:true,toolVersion,...evaluateStudy(JSON.parse(await readFile(resolve(argument),'utf8')))};}
  if (command === 'schema') {
    const extra={checks:checkBindingsSchema,conformance:conformanceSchema,context:contextViewSchema,workbench:workbenchSchema,workAction:workActionSchema,study:studySchema,verification:verificationProfileSchema,yosys:yosysManifestSchema};
    if(argument in extra)return {ok:true,toolVersion,[argument]:z.toJSONSchema(extra[argument as keyof typeof extra])};
    if (argument === 'layout') return { ok: true, toolVersion, layout: z.toJSONSchema(layoutSchema) };
    if (argument === 'inputs') return { ok: true, toolVersion, inputs: z.toJSONSchema(inputManifestSchema) };
    if (argument && !['model', 'proposal'].includes(argument)) throw new ToolError('USAGE', 'schema 支持 model/proposal/inputs/layout/workbench/workAction/study/verification/yosys');
    return { ok: true, toolVersion, ...(argument === 'model' ? { model: z.toJSONSchema(modelSchema) } : argument === 'proposal' ? { proposal: z.toJSONSchema(proposalSchema) } : { model: z.toJSONSchema(modelSchema), proposal: z.toJSONSchema(proposalSchema) }) };
  }
  if (command === 'install' && options.user) return { ok: true, toolVersion, links: [
    await installLink(join(toolRoot, 'bin/rtlarch'), join(homedir(), '.local/bin/rtlarch')),
    await installLink(skillRoot, join(homedir(), '.agents/skills/rtl-architect')),
  ], entry: join(homedir(), '.local/bin/rtlarch'), note: '当前机器安装，引用现有工具目录；移动工具目录后需重新安装。若当前终端 PATH 尚无 ~/.local/bin，可直接调用返回的 entry，或重新登录终端。' };
  if (command === 'init'||options.init) await mkdir(resolve(options.workspace ?? process.env.RTLARCH_WORKSPACE ?? '.'), { recursive: true });
  const workspace = await locateWorkspace(options.workspace), identity = await workspaceIdentity(workspace);
  const envelope = (data: object) => ({ ok: true, toolVersion, command, ...identity, ...data });
  if(command==='import-yosys'){if(!argument||!destination)throw new ToolError('USAGE','import-yosys 需要清单与新输出目录');return envelope(await importYosys(workspace,JSON.parse(await readFile(resolve(argument),'utf8')),destination));}
  if(command==='import-impact'){if(!argument)throw new ToolError('USAGE','import-impact 需要导入记录');return envelope(await importImpact(workspace,JSON.parse(await readFile(resolve(argument),'utf8'))));}
  if(command==='verify'){if(!argument)throw new ToolError('USAGE','verify 需要显式验证清单');const run=await runVerification(workspace,JSON.parse(await readFile(resolve(argument),'utf8')));if(run.status!=='passed')process.exitCode=1;return envelope({...run,ok:run.status==='passed',...(run.status!=='passed'?{error:{code:'VERIFICATION_FAILED',message:`验证未通过：${run.status}`}}:{})});}
  if(command==='checks'){if(!argument||!destination)throw new ToolError('USAGE','checks 需要映射与新目录');return envelope(await generateChecks(workspace,JSON.parse(await readFile(resolve(argument),'utf8')),resolve(destination)));}
  if(command==='conform'){if(!argument)throw new ToolError('USAGE','conform 需要显式映射');const report=await runConformance(workspace,JSON.parse(await readFile(resolve(argument),'utf8')));if(report.status!=='MATCH')process.exitCode=1;return envelope({...report,ok:report.status==='MATCH'});}
  if(command==='assurance')return envelope(await assurance(workspace,await new Repository(workspace).getModel(),options.module));
  if(command==='runs'){const current=await new Repository(workspace).getModel();return envelope({runs:await verificationRuns(workspace,current.modelHash)});}
  if(options.offline&&command==='resume')return envelope({...await new Repository(workspace).getResume(),readMode:'disk'});
  if(options.offline&&command==='workbench'){if(argument)throw new ToolError('USAGE','离线工作台只读；写入必须通过所属工作区服务');return envelope(await new Repository(workspace).getWorkbench());}

  const moduleId = options.module ?? argument;
  if (options.module && argument && options.module !== argument) throw new ToolError('USAGE', '模块参数不一致');
  if (command === 'evidence' || command === 'bundle') {
    const repository = new Repository(workspace);
    const snapshot = options.model ? undefined : await repository.getModel();
    const model = snapshot?.model ?? modelSchema.parse(JSON.parse(await readFile(resolve(options.model!), 'utf8')));
    if (command === 'evidence') {
      const report = await evidenceFreshness(workspace, model), ok = report.status === 'fresh';
      if (!ok) process.exitCode = 1;
      return envelope({ ...report, ok, readOnly: true, ...(!ok ? { error: { code: report.status === 'unknown' ? 'EVIDENCE_UNKNOWN' : 'EVIDENCE_ATTENTION', message: '声明来源未全部核对匹配；详见 files，不自动改变批准。' } } : {}) });
    }
    const layout = options.layout ? layoutSchema.parse(JSON.parse(await readFile(resolve(options.layout), 'utf8'))) : snapshot ? (await repository.getLayout()).layout : undefined;
    const result = await exportBundle(workspace, argument, model, snapshot, layout);
    if (!result.geometryPassed) process.exitCode = 1;
    return envelope({ ...result, ok: result.geometryPassed, ...(!result.geometryPassed ? { error: { code: 'DIAGRAM_QUALITY_FAILED', message: '诊断包已保存；存在节点重叠、穿越节点或未路由，请检查质量记录。' } } : {}) });
  }
  if (command === 'inventory') {
    const inventory = await sourceInventory(workspace, JSON.parse(await readFile(resolve(argument), 'utf8')));
    if (!inventory.inputsAvailable) process.exitCode = 1;
    return envelope({ ...inventory, ok: inventory.inputsAvailable, ...(!inventory.inputsAvailable ? { error: { code: 'INPUTS_UNAVAILABLE', message: '显式输入清单有缺失、非普通文件或读取期间变化的条目；详见 files/assets/includeDirectories。' } } : {}) });
  }
  if(command==='context-index'||command==='context'&&options.purpose){const query=contextViewSchema.parse({purpose:command==='context-index'?'index':options.purpose,moduleId,index:options.index,maxBytes:options.maxBytes,offset:options.offset,limit:options.limit});const data=options.offline?await new Repository(workspace).getContextView(query):await request<object>(await ensureService(workspace,options),'context-view?'+new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])));const result=envelope({...data,readMode:options.offline?'disk':'service'});const bytes=Buffer.byteLength(JSON.stringify(result,null,2));if(bytes>query.maxBytes)throw new ToolError('CONTEXT_BUDGET_TOO_SMALL','包含工作区信息的结果超过字节预算，请增加 --max-bytes',{requiredBytes:bytes});return result;}
  if (command === 'context' && options.offline) return envelope({ ...await new Repository(workspace).getContext(moduleId, options.index), readMode: 'disk', note: '只读文件快照，未启动/核对服务；提交前仍须在线预览并检查版本。' });
  if (command === 'install') return envelope({ links: [await installLink(skillRoot, join(workspace, '.agents/skills/rtl-architect'))] });
  if (command === 'doctor') {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    checks.push({ name: 'runtime', ok: process.version === 'v24.18.1' && await exists(loader), detail: `${process.version}; ${process.execPath}` });
    const build=await buildStatus();checks.push({ name:'web',ok:build.current,detail:build.current?'页面与当前源码匹配':'页面缺失或已过期；运行 rtlarch open' });
    try { await new Repository(workspace).getModel(); checks.push({ name: 'model', ok: true, detail: '模型可读取；语义问题请运行 validate' }); }
    catch (error) { checks.push({ name: 'model', ok: false, detail: (error as NodeJS.ErrnoException).code === 'ENOENT' ? '先运行 rtlarch init --workspace <目录>' : String(error) }); }
    let service;
    try { service = await discoverService(workspace, options); checks.push({ name: 'service', ok: true, detail: service ? `已连接 ${service.apiUrl}` : '尚未启动；context/propose 等命令会按需启动' }); }
    catch (error) { checks.push({ name: 'service', ok: false, detail: error instanceof Error ? error.message : String(error) }); }
    const ready = checks.every(c => c.ok); if (!ready) process.exitCode = 1;
    return envelope({ ok: ready, ready, readyForRead: checks.filter(c => ['runtime', 'model'].includes(c.name)).every(c => c.ok), serviceReadiness: service ? 'running' : checks.find(c => c.name === 'service')?.ok ? 'not_checked' : 'unavailable', note: 'ready 仅表示静态检查及已有服务身份正常；未运行服务时没有测试监听权限。启动失败可先 context --offline 读取。', checks, service: service ?? null, ...(!ready ? { error: { code: 'ENVIRONMENT_NOT_READY', message: '请处理未通过的检查项。' } } : {}) });
  }
  if (command === 'init'||(options.init&&!await exists(join(workspace,'architecture/model.json')))) {
    const top = { ...createTemplate('top', 'top', 'subsystem'), parent: null, clock:null,reset:null,timing:'unknown' as const,parameters:{} };
    const model: Model = { schemaVersion: 3, design: { id: 'design', name: options.name || basename(workspace), top: 'top' }, clocks: [], resets: [], modules: [top], connections: [], specification: { summary: '', requirements: [], decisions: [], openQuestions: ['请定义目标、约束、接口和验收条件；时钟与复位尚未定义。'] } };
    await mkdir(join(workspace, 'architecture'), { recursive: true });
    const initial = modelSchema.parse(model);
    try { await writeFile(join(workspace, 'architecture/model.json'), JSON.stringify(initial, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolError('WORKSPACE_EXISTS', '已有模型，未覆盖。'); throw error; }
    if(command==='init')return envelope({ modelHash: modelHash(initial), reviewStatus: 'DRAFT', file: join(workspace, 'architecture/model.json') });
  }
  if(command==='open')return envelope(await openWorkspace(workspace,options));
  if (command === 'stop') return envelope(await stopService(workspace, options));
  if (command === 'serve') {
    const running = await startService(workspace, { port: options.port, apiPort: options.apiPort });
    output(envelope({ service: running.info, reviewUrl: `${running.info.webUrl}/?workspace=${identity.workspaceId}` }));
    process.once('SIGTERM', () => void running.close()); process.once('SIGINT', () => void running.close());
    await running.closed; return;
  }
  const info = await ensureService(workspace, options);
  const reviewUrl = (id?: string) => `${info.webUrl}/?workspace=${identity.workspaceId}${id ? `&proposal=${id}` : ''}`;
  if(command==='resume')return envelope(await request<object>(info,'resume'));
  if(command==='workbench')return envelope(await request<object>(info,'workbench',argument?JSON.parse(await readFile(resolve(argument),'utf8')):undefined));
  if (command === 'start') return envelope({ service: info, reviewUrl: reviewUrl() });
  if (command === 'context') return envelope(await request<object>(info, `context${moduleId ? `?moduleId=${encodeURIComponent(moduleId)}${options.index!==undefined?`&index=${options.index}`:''}` : ''}`));
  if (command === 'status' || command === 'validate') {
    const snapshot = await request<Snapshot>(info, 'model');
    const blocked = snapshot.issues.some(i => i.blocks.length);
    if (command === 'validate' && blocked) process.exitCode = 1;
    return envelope({ modelHash: snapshot.modelHash, reviewStatus: snapshot.reviewStatus, modules: snapshot.model.modules.length, moduleReviews: snapshot.moduleReviews, issues: snapshot.issues, reviewUrl: reviewUrl(), ...(command === 'validate' && blocked ? { ok: false, error: { code: 'MODEL_INCOMPLETE', message: '架构存在待解决问题。' } } : {}) });
  }
  if (command === 'spec') {
    const spec = await request<{ markdown: string }>(info, `spec${moduleId ? `?moduleId=${encodeURIComponent(moduleId)}${options.index!==undefined?`&index=${options.index}`:''}` : ''}`);
    if (!options.json) { console.log(spec.markdown); return; } return envelope(spec);
  }
  if (command === 'handoff' && moduleId) return envelope(await request<object>(info, `handoff/${encodeURIComponent(moduleId)}`));
  if (command === 'export' && ['spec', 'contract'].includes(argument)) {
    const current = await request<Snapshot>(info, 'model'); return envelope(await request<object>(info, 'export', { modelHash: current.modelHash, kind: argument }));
  }
  if (command === 'proposals') {
    const items = await request<{ id: string }[]>(info, 'proposals'); return envelope({ proposals: items.map(item => ({ ...item, reviewUrl: reviewUrl(item.id) })) });
  }
  if (command === 'draft' && argument) {
    const model = modelSchema.parse(JSON.parse(await readFile(resolve(argument), 'utf8'))), current = await request<Snapshot>(info, 'model');
    const proposal = proposalSchema.parse({ baseHash: current.modelHash, reason: `审阅 AI 架构：${model.design.name}`, commands: [{ op: 'replace_architecture', model }] });
    const payload=serializeRequest(proposal);
    const preview = await request<Preview>(info, 'preview', proposal);
    const file = resolve(destination || join(workspace, 'proposals', `draft-${randomUUID()}.json`));
    await mkdir(dirname(file), { recursive: true });
    const canonicalFile = join(await realpath(dirname(file)), basename(file));
    if (/^(architecture|generated|\.rtlarch)(\/|$)/.test(relative(workspace, canonicalFile))) throw new ToolError('OUTPUT_PROTECTED', '提案不能写入 architecture/、generated/ 或 .rtlarch/');
    await writeFile(canonicalFile, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx' });
    let registered: { id: string } | undefined;
    try { if (options.open) registered = await request<{ id: string }>(info, 'proposals', proposal); }
    catch (error) {
      if (error instanceof ToolError) error.details = { file: canonicalFile, original: error.details };
      throw error;
    }
    return envelope({ file: canonicalFile, requestBytes:payload.bytes, requestLimitBytes:payload.limitBytes, modelHash: current.modelHash, candidateHash: preview.candidateHash, issues: preview.issues, diff: preview.diff,
      ...(registered ? { proposalId: registered.id, reviewUrl: reviewUrl(registered.id) } : {}), committed: false });
  }
  if (['preview', 'propose'].includes(command) && argument) {
    const proposal = proposalSchema.parse(JSON.parse(await readFile(resolve(argument), 'utf8')));
    if (command === 'preview') return envelope({ ...await request<Preview>(info, 'preview', proposal), committed: false });
    const registered = await request<{ id: string }>(info, 'proposals', proposal);
    return envelope({ ...registered, proposalId: registered.id, reviewUrl: reviewUrl(registered.id), committed: false });
  }
  throw new ToolError('USAGE', '命令缺少参数，运行 rtlarch help 查看用法。');
}
try { const result = await main(); if (result !== undefined) output(result); }
catch (error) {
  const systemCode = (error as NodeJS.ErrnoException)?.code;
  const code = error instanceof RequestSizeError ? error.code : error instanceof ToolError ? error.code : error instanceof ZodError ? 'SCHEMA_INVALID' : systemCode === 'EEXIST' ? 'OUTPUT_EXISTS' : systemCode === 'ENOENT' ? 'FILE_NOT_FOUND' : systemCode === 'EADDRINUSE' ? 'PORT_IN_USE' : 'COMMAND_FAILED';
  output({ ok: false, toolVersion, error: { code, message: error instanceof Error ? error.message : String(error), ...(error instanceof RequestSizeError ? {details:{actualBytes:error.actualBytes,limitBytes:error.limitBytes}} : {}), ...(error instanceof ToolError && error.details !== undefined ? { details: error.details } : error instanceof ZodError ? { issues: error.issues } : {}) } });
  process.exitCode = 1;
}
