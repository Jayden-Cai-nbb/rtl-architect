import {validateReadingRefs} from '../web/graph/readingRefs';
import {verificationImpact} from '../core/verificationImpact';
import {contextView,type ContextViewOptions} from './contextView';
import {architectureContext} from './context';
import {verificationRuns} from './verification';
import {reviewDependencies,reviewState} from '../core/reviewImpact';
import {workbenchSchema,workActionSchema,emptyWorkbench,workTargetState,type WorkTarget,type WorkbenchSnapshot} from '../core/workbench';
import {candidateRefSchema,evaluateStudy,type CandidateRef,type Study} from '../core/studies';
import {toolVersion} from './environment';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyCommands, EngineError, validateModel } from '../core/engine';
import { semanticDiff, stableStringify, hardwareChangeSummary } from '../core/diff';
import { idSchema, hashSchema, moduleReviewsSchema, layoutSchema, modelSchema, proposalSchema, reviewSchema, type Layout, type Model, type Review } from '../core/schema';
import { moduleDocument, moduleIssues, specMarkdown } from '../core/spec';
import { contractData, hashValue, modelHash, specText } from '../core/export';
import type { RegisteredProposal } from '../core/api';
import { readEvidence } from './evidence';
const storedProposalSchema = z.strictObject({ schemaVersion: z.literal(1), id: hashSchema, proposal: proposalSchema, candidateHash: hashSchema, createdAt: z.iso.datetime(), createdWith:z.string().optional() });
export class ApiError extends Error { constructor(public status: number, message: string, public code = status === 409 ? 'VERSION_CONFLICT' : 'INVALID_REQUEST') { super(message); } }
export async function atomicWrite(file: string, content: string, renameFile = rename): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: 'wx' }); await renameFile(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export class Repository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly workspace: string, private writer = atomicWrite) {}
  private path(name: string) { return resolve(this.workspace, name); }
  private queue<T>(fn: () => Promise<T>): Promise<T> { const task = this.tail.then(fn); this.tail = task.catch(() => undefined); return task; }
  private async read(name: string): Promise<unknown> { return JSON.parse(await readFile(this.path(name), 'utf8')); }
  private async optional(name: string): Promise<unknown | undefined> { try { return await this.read(name); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } }
  private async save(name: string, value: unknown) { await this.writer(this.path(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); }
  private async snapshot() {
    const model = modelSchema.parse(await this.read('architecture/model.json'));
    const issues = validateModel(model);
    if (issues.some(i => i.blocks.includes('commit'))) throw new EngineError(issues);
    const hash = modelHash(model), rawReview = await this.optional('architecture/review.json');
    const review: Review | undefined = rawReview === undefined ? undefined : reviewSchema.parse(rawReview);
    const records = moduleReviewsSchema.parse(await this.optional('architecture/module-reviews.json') ?? { schemaVersion: 1, modules: {} });
    return {model, modelHash:hash, issues, ...reviewState(model,hash,review,records)};
  }
  getModel() { return this.queue(() => this.snapshot()); }
  private async candidateModel(ref:CandidateRef,current:{model:Model;modelHash:string}){
    const record=await this.readProposal(ref.proposalId),state=this.proposalState(record,current.modelHash);
    if(record.candidateHash!==ref.modelHash||state==='STALE')throw new ApiError(409,'候选 ID/hash 已过期或不匹配','CANDIDATE_STALE');
    const model=state==='APPLIED'?current.model:this.candidate(current.model,current.modelHash,record.proposal).model;
    if(modelHash(model)!==ref.modelHash)throw new ApiError(409,'候选重建版本不符','CANDIDATE_STALE');return model;
  }
  private async candidateEvaluation(ref:CandidateRef,current:{model:Model;modelHash:string}){
    const model=await this.candidateModel(ref,current),runs=await verificationRuns(this.workspace,ref.modelHash);
    return {candidate:ref,issues:validateModel(model),runs:runs.filter(r=>'modelHash' in r&&r.modelHash===ref.modelHash),note:'只读核对该候选版本及已有证据；未执行新实验，也不把结构检查当作性能测量。'};
  }
  getCandidateEvaluation(input:unknown){return this.queue(async()=>this.candidateEvaluation(candidateRefSchema.parse(input),await this.snapshot()));}
  compareCandidates(input:unknown){return this.queue(async()=>{
    const {before,after}=z.strictObject({before:modelSchema,after:modelSchema}).parse(input);
    const side=async(model:Model)=>{const hash=modelHash(model);return {modelHash:hash,issues:validateModel(model),runs:(await verificationRuns(this.workspace,hash)).filter(r=>'modelHash' in r&&r.modelHash===hash)};};
    return {readOnly:true,before:await side(before),after:await side(after),diff:semanticDiff(before,after),summary:hardwareChangeSummary(before,after)};
  });}
  private async studyState(study:Study,current:{model:Model;modelHash:string}){
    try{
      if(study.modelHash!==current.modelHash)throw new Error('预算基线已变化');
      for(const option of study.options){if(option.candidate)await this.candidateModel(option.candidate,current);
        const hash=option.candidate?.modelHash??study.modelHash,runs=option.runIds.length?await verificationRuns(this.workspace,hash):[];
        if(option.runIds.some(id=>!runs.some(r=>r.id===id&&r.fresh&&'modelHash' in r&&r.modelHash===hash)))throw new Error('预算关联实验已过期或不属于此版本');
      }
      return {id:study.id,stale:false,reason:'预算仍绑定所记录的候选与假设；数值为派生下界'};
    }catch(e){return {id:study.id,stale:true,reason:String(e)};}
  }
  private async workbenchSnapshot():Promise<WorkbenchSnapshot> {
    const snapshot=await this.snapshot(),workbench=workbenchSchema.parse(await this.optional('architecture/workbench.json')??emptyWorkbench());
    const state=async(target:WorkTarget)=>{
      const proposal=target.proposalId?await this.readProposal(target.proposalId).catch(()=>undefined):undefined;
      const proposalState=proposal?this.proposalState(proposal,snapshot.modelHash):undefined;
      const targetModel=proposal&&proposalState==='READY'?this.candidate(snapshot.model,snapshot.modelHash,proposal.proposal).model:snapshot.model;
      const result=workTargetState(targetModel,modelHash(targetModel),target);
      if(target.proposalId&&(!proposal||proposalState==='STALE'))return {...result,canLocate:false,reason:'原候选已过期或不可用',proposalState:proposalState??'MISSING'};
      return {...result,...(proposalState?{proposalState}:{})};
    };
    const threadStates=await Promise.all(workbench.threads.map(async t=>({id:t.id,...await state(t.target)})));
    const studyStates=await Promise.all(workbench.studies.map(s=>this.studyState(s,snapshot)));
    const decisionStates=await Promise.all((workbench.decisions??[]).map(async d=>({id:d.id,options:await Promise.all(d.options.map(async o=>{
      let stale=false,reason='记录的候选版本可读；选择不代表验证通过';
      const history=await verificationRuns(this.workspace,o.candidate.modelHash);
      const experiments=o.experiments.map(e=>{const r=history.find(r=>r.id===e.runId&&'modelHash' in r&&r.modelHash===e.modelHash);return {runId:e.runId,status:r?.status??'UNKNOWN',fresh:!!r?.fresh};});
      try{
        await this.candidateModel(o.candidate,snapshot);
        if(experiments.some(e=>!e.fresh))throw new Error('实验版本、来源或报告已失效');
        if(o.budget){const s=workbench.studies.find(s=>s.id===o.budget!.studyId),b=s?.options.find(b=>b.id===o.budget!.optionId);if(!s||studyStates.find(x=>x.id===s.id)?.stale||stableStringify(b?.candidate)!==stableStringify(o.candidate))throw new Error('关联预算已过期或对应其他候选');}
      }catch(e){stale=true;reason=String(e);}
      return {id:o.id,stale,reason,experiments};
    }))})));
    return {workbench,workbenchHash:hashValue(workbench),modelHash:snapshot.modelHash,threadStates,checkpointState:workbench.checkpoint?await state(workbench.checkpoint.target):null,studyStates,decisionStates};
  }
  getWorkbench(){return this.queue(()=>this.workbenchSnapshot());}
  getContextView(options:ContextViewOptions){return this.queue(async()=>contextView(await this.snapshot(),options));}
  getContext(moduleId?:string,index?:number){return this.queue(async()=>{
    const snapshot=await this.snapshot(),work=await this.workbenchSnapshot();
    const owner=snapshot.model.modules.find(m=>m.id===moduleId);
    if(moduleId&&!owner)throw new ApiError(422,'模块不存在','MODULE_NOT_FOUND');
    if(index!==undefined&&(!Number.isSafeInteger(index)||!owner?.instances||index<owner.instances.from||index>owner.instances.to))throw new ApiError(422,'数组索引超出范围','INSTANCE_INDEX');
    const threads=work.workbench.threads.filter(t=>t.status!=='resolved'&&(!t.target.object||index===undefined||t.target.object.instancePath.at(-1)?.index===index)&&(!moduleId||!t.target.moduleId||t.target.moduleId===moduleId||t.target.connectionIds.some(id=>snapshot.model.connections.some(l=>l.id===id&&(l.from.moduleId===moduleId||l.to.moduleId===moduleId)))));
    return {...architectureContext(snapshot,moduleId,index),collaboration:{workbenchHash:work.workbenchHash,checkpoint:work.workbench.checkpoint,openCount:threads.length,threads:threads.slice(-25).map(t=>({...t,messages:t.messages.slice(-4),...work.threadStates.find(s=>s.id===t.id)})),studies:work.workbench.studies.filter(s=>!moduleId||s.moduleIds.includes(moduleId)).map(s=>({id:s.id,title:s.title,modelHash:s.modelHash,versionChanged:s.modelHash!==snapshot.modelHash})),note:'讨论是独立记录；回答用 workbench 命令提交，用户确认解决不等于架构批准。完整历史可用 workbench 读取。'}};
  });}
  getResume(){return this.queue(async()=>{
    const snapshot=await this.snapshot(),work=await this.workbenchSnapshot();
    const names=await readdir(this.path('proposals/registered')).catch(e=>{if(e.code==='ENOENT')return [] as string[];throw e;});
    const proposals=await Promise.all(names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(async name=>{const p=await this.readProposal(name.slice(0,-5));return {id:p.id,reason:p.proposal.reason,createdAt:p.createdAt,candidateHash:p.candidateHash,state:this.proposalState(p,snapshot.modelHash)};}));
    proposals.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const active=work.workbench.threads.filter(t=>t.status!=='resolved'),pending=active.filter(t=>t.status==='open').length;
    return {...work,design:snapshot.model.design,reviewStatus:snapshot.reviewStatus,reviewNeeded:snapshot.moduleReviews.filter(r=>r.status!=='APPROVED').map(r=>({moduleId:r.moduleId,reasons:r.reasons})),proposals,runs:await verificationRuns(this.workspace,snapshot.modelHash),nextActions:[...(pending?[`回答 ${pending} 个尚未处理的问题`]:[]),...(active.length>pending?[`核对 ${active.length-pending} 个已答复问题`]:[]),...(proposals.some(p=>p.state==='READY')?['查看尚未保存的候选方案']:[]),...(work.workbench.checkpoint?[work.workbench.checkpoint.nextStep]:[])]};
  });}

  updateWorkbench(input:unknown){return this.queue(async()=>{
    const parsed=workActionSchema.parse(input),current=await this.workbenchSnapshot();
    if(current.workbenchHash!==parsed.baseHash)throw new ApiError(409,'讨论记录已更新；请重新加载后再发送，输入内容不会自动丢弃。','WORKBENCH_CONFLICT');
    const {model,modelHash:hash}=await this.snapshot(),a=parsed.action,w=current.workbench,now=new Date().toISOString();
    const uid=()=>`w_${randomUUID().replaceAll('-','')}`;
    const checkTarget=async(target:WorkTarget)=>{
      const record=target.proposalId?await this.readProposal(target.proposalId):undefined;
      const candidate=record&&this.proposalState(record,hash)==='READY'?this.candidate(model,hash,record.proposal).model:model;
      if(modelHash(candidate)!==target.modelHash)throw new ApiError(409,'讨论对象的版本已变化；请核对当前对象后重新发送。');
      const state=workTargetState(candidate,modelHash(candidate),target);if(!state.canLocate||record&&this.proposalState(record,hash)==='STALE')throw new ApiError(422,state.reason,'WORK_TARGET_INVALID');
    };
    if(a.kind==='ask'){
      await checkTarget(a.target);w.threads.push({id:uid(),target:a.target,title:a.title,status:'open',createdAt:now,updatedAt:now,messages:[{id:uid(),author:'user',text:a.text,createdAt:now,modelHash:a.target.modelHash}]});
    }else if(a.kind==='checkpoint'){
      await checkTarget(a.target);w.checkpoint={intent:a.intent,nextStep:a.nextStep,target:a.target,updatedAt:now};
    }else if(a.kind==='study'){
      if(a.study.modelHash!==hash)throw new ApiError(409,'方案预算对应旧模型');
      evaluateStudy(a.study);
      if(a.study.options.some(o=>o.candidate)&&a.study.options.some(o=>!o.candidate))throw new ApiError(422,'候选预算的每个方案都必须绑定自己的 ID/hash');
      for(const o of a.study.options){
        const target=o.candidate?await this.candidateModel(o.candidate,{model,modelHash:hash}):model;
        if(a.study.moduleIds.some(id=>!target.modules.some(m=>m.id===id)))throw new ApiError(422,'预算引用不存在的候选模块');
        const runs=await verificationRuns(this.workspace,o.candidate?.modelHash??hash);
        for(const id of o.runIds){const run=runs.find(r=>r.id===id);if(!run||!run.fresh||!o.candidate&&run.status!=='passed'||!('moduleIds' in run)||!a.study.moduleIds.every(m=>run.moduleIds?.includes(m)))throw new ApiError(422,'关联验证必须对应此方案版本、输入新鲜并覆盖预算模块');}
      }
      const index=w.studies.findIndex(s=>s.id===a.study.id);
      if(index>=0)throw new ApiError(409,'此预算已保存；修订请使用新的 ID，保留原始假设与结果。','STUDY_EXISTS');
      w.studies.push(a.study);
    }else if(a.kind==='decision'){
      const d=a.decision;
      if(w.decisions?.some(x=>x.id===d.id))throw new ApiError(409,'决策记录已存在；修订使用新 ID');
      if(d.threadIds.some(id=>!w.threads.some(t=>t.id===id)))throw new ApiError(422,'关联问题不存在');
      for(const o of d.options){
        const evaluated=await this.candidateEvaluation(o.candidate,{model,modelHash:hash});
        if(o.budget){const s=w.studies.find(s=>s.id===o.budget!.studyId),b=s?.options.find(b=>b.id===o.budget!.optionId);if(!s||stableStringify(b?.candidate)!==stableStringify(o.candidate)||(await this.studyState(s,{model,modelHash:hash})).stale)throw new ApiError(422,'预算不属于该候选版本或已过期');}
        if(o.experiments.some(e=>e.modelHash!==o.candidate.modelHash||!evaluated.runs.some(r=>r.id===e.runId&&r.modelHash===e.modelHash&&r.fresh)))throw new ApiError(422,'实验不属于该候选版本或已过期','EXPERIMENT_VERSION');
      }
      (w.decisions??=[]).push({...d,createdAt:now,choices:[]});
    }else if(a.kind==='choose_decision'){
      const d=w.decisions?.find(d=>d.id===a.decisionId),option=d?.options.find(o=>o.id===a.optionId),state=current.decisionStates.find(s=>s.id===a.decisionId)?.options.find(o=>o.id===a.optionId);
      if(!d||!option)throw new ApiError(422,'决策或选项不存在');
      if(!state||state.stale)throw new ApiError(409,'选项版本或关联依据已过期；修订决策记录后再选择');
      d.choices.push({optionId:a.optionId,reason:a.reason,author:'user',createdAt:now});
    }else{
      const t=w.threads.find(t=>t.id===a.threadId);if(!t)throw new ApiError(404,'讨论不存在');
      if(a.modelHash!==hash)throw new ApiError(409,'当前模型已变化，请重新读取上下文');
      if(a.kind==='reply'){
        if(a.proposalId){const p=await this.readProposal(a.proposalId);if(this.proposalState(p,hash)==='STALE')throw new ApiError(409,'回复关联的提案已过期');}
        t.messages.push({id:uid(),author:a.author,text:a.text,createdAt:now,modelHash:hash,...(a.proposalId?{proposalId:a.proposalId}:{})});t.status=a.author==='agent'?'addressed':'open';
      }else t.status=a.kind==='resolve'?'resolved':'open';
      t.updatedAt=now;
    }
    await this.save('architecture/workbench.json',workbenchSchema.parse(w));return this.workbenchSnapshot();
  });}
  getEvidence(input: unknown) {
    return this.queue(async () => {
      const parsed = z.strictObject({ id: idSchema, modelHash: hashSchema, proposal: proposalSchema.optional() }).parse(input);
      const current = await this.snapshot();
      const model = parsed.proposal ? this.candidate(current.model, current.modelHash, parsed.proposal).model : current.model;
      if (modelHash(model) !== parsed.modelHash) throw new ApiError(409, '证据所属模型版本已变化，请重新加载');
      return { modelHash: parsed.modelHash, ...await readEvidence(this.workspace, model, parsed.id) };
    });
  }
  private async layoutSnapshot() {
    const layout: Layout = layoutSchema.parse(await this.optional('architecture/layout.json') ?? { schemaVersion: 1, scopes: {} });
    return { layout, layoutHash: hashValue(layout) };
  }
  getLayout() { return this.queue(() => this.layoutSnapshot()); }
  putLayout(input: unknown) {
    return this.queue(async () => {
      const parsed = z.strictObject({ baseLayoutHash: hashSchema, layout: layoutSchema }).parse(input);
      const current = await this.layoutSnapshot();
      if (current.layoutHash !== parsed.baseLayoutHash) throw new ApiError(409, '布局版本冲突，请重新加载布局');
      const { model } = await this.snapshot();
      for (const [scope, layout] of Object.entries(parsed.layout.scopes)) {
        if (!model.modules.some(m => m.id === scope && m.kind === 'subsystem')) throw new ApiError(422, '布局 scope 不存在');
        const allowed = new Set([...(model.localSignals?.filter(n=>n.scope===scope).map(n=>`local:${scope}:${n.id}`)??[]), ...model.modules.filter(m => m.parent === scope).map(m => m.id), ...model.modules.find(m => m.id === scope)!.interfaces.map(i => `boundary:${scope}:${i.id}`)]);
        if (Object.keys(layout.positions).some(id => !allowed.has(id))) throw new ApiError(422, '布局包含非当前 scope 节点');
        try{validateReadingRefs(model,scope,layout.reading);}catch(e){throw new ApiError(422,e instanceof Error?e.message:String(e));}
      }
      await this.save('architecture/layout.json', parsed.layout);
      return { layout: parsed.layout, layoutHash: hashValue(parsed.layout) };
    });
  }
  private candidate(model: Model, hash: string, input: unknown) {
    const proposal = proposalSchema.parse(input);
    if (proposal.baseHash !== hash) throw new ApiError(409, '模型版本冲突：请保留提案，重新加载并显式重新预览');
    const result = applyCommands(model, proposal.commands);
    return { model: result.model, candidateHash: modelHash(result.model), diff: semanticDiff(model, result.model), summary:hardwareChangeSummary(model,result.model), impact:verificationImpact(model,result.model), issues: result.issues };
  }
  preview(input: unknown) { return this.queue(async () => { const current = await this.snapshot(); const { model, ...preview } = this.candidate(current.model, current.modelHash, input); return { ...preview, candidate: model }; }); }
  private async readProposal(id: string) {
    hashSchema.parse(id);
    const raw = await this.optional(`proposals/registered/${id}.json`);
    if (!raw) throw new ApiError(404, '提案不存在，请检查工作区和链接。', 'PROPOSAL_NOT_FOUND');
    const record = storedProposalSchema.parse(raw);
    if (record.id !== id || hashValue(record.proposal) !== id) throw new ApiError(422, '已登记的提案内容被修改，请重新生成提案。', 'PROPOSAL_CORRUPT');
    return record;
  }
  private proposalState(record: z.infer<typeof storedProposalSchema>, currentHash: string): RegisteredProposal['state'] {
    return record.candidateHash === currentHash ? 'APPLIED' : record.proposal.baseHash === currentHash ? 'READY' : 'STALE';
  }
  registerProposal(input: unknown) {
    return this.queue(async () => {
      const current = await this.snapshot(), proposal = proposalSchema.parse(input), candidate = this.candidate(current.model, current.modelHash, proposal);
      const id = hashValue(proposal), path = `proposals/registered/${id}.json`;
      const record = await this.optional(path) ? await this.readProposal(id) : { schemaVersion: 1 as const, id, proposal, candidateHash: candidate.candidateHash, createdAt: new Date().toISOString(),createdWith:toolVersion };
      if (record.candidateHash !== candidate.candidateHash) throw new ApiError(409, '该提案的候选规则已变化，请生成新提案。', 'PROPOSAL_OUTDATED');
      if (!await this.optional(path)) await this.save(path, record);
      return { id, createdWith:record.createdWith??null, createdAt: record.createdAt, state: this.proposalState(record, current.modelHash), modelHash: current.modelHash, candidateHash: candidate.candidateHash, diff: candidate.diff, issues: candidate.issues };
    });
  }
  getProposal(id: string): Promise<RegisteredProposal> {
    return this.queue(async () => {
      const record = await this.readProposal(id), current = await this.snapshot(), state = this.proposalState(record, current.modelHash);
      let preview;
      if (state === 'READY') {
        const { model, ...result } = this.candidate(current.model, current.modelHash, record.proposal);
        if (result.candidateHash !== record.candidateHash) throw new ApiError(409, '候选版本不再匹配，请重新预览新提案。', 'PROPOSAL_OUTDATED');
        preview = { ...result, candidate: model };
      }
      return { ...record, state, modelHash: current.modelHash, ...(preview ? { preview } : {}) };
    });
  }
  listProposals() {
    return this.queue(async () => {
      const current = await this.snapshot();
      const names = await readdir(this.path('proposals/registered')).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
      const records = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => this.readProposal(name.slice(0, -5))));
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => ({ id: record.id, reason: record.proposal.reason, createdWith:record.createdWith??null, createdAt: record.createdAt, baseHash: record.proposal.baseHash, candidateHash: record.candidateHash, state: this.proposalState(record, current.modelHash) }));
    });
  }
  commit(input: unknown) {
    return this.queue(async () => {
      const parsed = z.strictObject({ proposal: proposalSchema, candidateHash: hashSchema }).parse(input);
      const current = await this.snapshot(), candidate = this.candidate(current.model, current.modelHash, parsed.proposal);
      if (candidate.candidateHash !== parsed.candidateHash) throw new ApiError(409, '候选 hash 与预览不一致，请重新预览');
      await this.save('architecture/model.json', candidate.model);
      return this.snapshot();
    });
  }
  getSpec(moduleId?: string) {
    return this.queue(async () => {
      const current = await this.snapshot();
      if (moduleId) { idSchema.parse(moduleId); if (!current.model.modules.some(m => m.id === moduleId)) throw new ApiError(422, '模块不存在'); }
      return { modelHash: current.modelHash, reviewStatus: current.reviewStatus, markdown: specMarkdown(current.model, current.modelHash, current.reviewStatus, current.issues, moduleId) };
    });
  }
  reviewModule(input: unknown) {
    return this.queue(async () => {
      const parsed = z.strictObject({ modelHash: hashSchema, moduleId: idSchema, reviewer: z.string().trim().min(1) }).parse(input);
      const current = await this.snapshot();
      if (parsed.modelHash !== current.modelHash) throw new ApiError(409, '确认版本已过期');
      if (!current.model.modules.some(m => m.id === parsed.moduleId)) throw new ApiError(422, '模块不存在');
      if (moduleIssues(current.model, current.issues, parsed.moduleId).some(i => i.blocks.includes('review'))) throw new ApiError(422, '当前模块仍有阻断问题');
      const records = moduleReviewsSchema.parse(await this.optional('architecture/module-reviews.json') ?? { schemaVersion: 1, modules: {} });
      records.modules[parsed.moduleId] = { modelHash: parsed.modelHash, reviewer: parsed.reviewer, reviewedAt: new Date().toISOString(),...reviewDependencies(current.model,parsed.moduleId) };
      await this.save('architecture/module-reviews.json', records);
      return this.snapshot();
    });
  }
  handoff(moduleId: string) {
    return this.queue(async () => {
      idSchema.parse(moduleId);
      const current = await this.snapshot();
      if (current.reviewStatus !== 'APPROVED' || current.issues.some(i => i.blocks.includes('review'))) throw new ApiError(422, 'RTL 交接需要全部模块审阅完成并批准当前架构', 'REVIEW_REQUIRED');
      if (!current.model.modules.some(m => m.id === moduleId)) throw new ApiError(422, '模块不存在');
      const exported = await this.optional('generated/contract.json');
      if (!exported || stableStringify(exported) !== stableStringify(contractData(current.model))) throw new ApiError(409, '导出合同缺失、陈旧或与当前 IR 不一致，请从 GUI 重新导出', 'CONTRACT_OUTDATED');
      return { approvalAssurance:'local_record', verificationAssurance:'not_implied_by_handoff', modelHash: current.modelHash, reviewStatus: current.reviewStatus, design: current.model.design, ...moduleDocument(current.model, moduleId), clocks: current.model.clocks, resets: current.model.resets, reviews: current.moduleReviews, instruction: '实现必须遵守该版本的接口、参数、复位、背压、不变量和验收条件；不满足时先提架构变更。此交接不证明行为 RTL 一致性。' };
    });
  }
  review(input: unknown) {
    return this.queue(async () => {
      const parsed = z.strictObject({ modelHash: hashSchema, reviewer: z.string().trim().min(1) }).parse(input), current = await this.snapshot();
      if (current.modelHash !== parsed.modelHash) throw new ApiError(409, '确认版本已过期');
      if (current.issues.some(i => i.blocks.includes('review'))) throw new ApiError(422, '存在阻断问题，不能人工确认');
      if (current.moduleReviews.some(r => r.status !== 'APPROVED')) throw new ApiError(422, '请先从顶层向下逐模块确认当前版本');
      await this.save('architecture/review.json', { ...parsed, reviewedAt: new Date().toISOString() });
      return this.snapshot();
    });
  }
  export(input: unknown) {
    return this.queue(async () => {
      const parsed = z.strictObject({ modelHash: hashSchema, kind: z.enum(['spec', 'contract']) }).parse(input), current = await this.snapshot();
      if (current.modelHash !== parsed.modelHash) throw new ApiError(409, '导出版本已过期');
      if (parsed.kind === 'contract' && (current.reviewStatus !== 'APPROVED' || current.issues.some(i => i.blocks.includes('review')))) throw new ApiError(422, '正式合同需要当前模型已人工确认且无阻断问题');
      const file = parsed.kind === 'spec' ? 'generated/spec.md' : 'generated/contract.json';
      await this.save(file, parsed.kind === 'spec' ? specText(current.model, current.reviewStatus, current.issues) : contractData(current.model));
      return { file, modelHash: current.modelHash, reviewStatus: current.reviewStatus };
    });
  }
}
