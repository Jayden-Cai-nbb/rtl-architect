import {toolVersion} from './environment';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyCommands, EngineError, validateModel } from '../core/engine';
import { semanticDiff, stableStringify } from '../core/diff';
import { idSchema, hashSchema, moduleReviewsSchema, layoutSchema, modelSchema, proposalSchema, reviewSchema, type Layout, type Model, type Review, type ReviewStatus } from '../core/schema';
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
    const moduleReviews = model.modules.map(module => {
      const record = records.modules[module.id] ?? null;
      const status: ReviewStatus = !record ? 'DRAFT' : record.modelHash === hash ? 'APPROVED' : 'STALE';
      return { moduleId: module.id, status, record };
    });
    const reviewStatus: ReviewStatus = !review ? 'DRAFT' : review.modelHash === hash && moduleReviews.every(r => r.status === 'APPROVED') ? 'APPROVED' : 'STALE';
    return { model, modelHash: hash, issues, reviewStatus, review: review ?? null, moduleReviews };
  }
  getModel() { return this.queue(() => this.snapshot()); }
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
      }
      await this.save('architecture/layout.json', parsed.layout);
      return { layout: parsed.layout, layoutHash: hashValue(parsed.layout) };
    });
  }
  private candidate(model: Model, hash: string, input: unknown) {
    const proposal = proposalSchema.parse(input);
    if (proposal.baseHash !== hash) throw new ApiError(409, '模型版本冲突：请保留提案，重新加载并显式重新预览');
    const result = applyCommands(model, proposal.commands);
    return { model: result.model, candidateHash: modelHash(result.model), diff: semanticDiff(model, result.model), issues: result.issues };
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
      records.modules[parsed.moduleId] = { modelHash: parsed.modelHash, reviewer: parsed.reviewer, reviewedAt: new Date().toISOString() };
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
      return { modelHash: current.modelHash, reviewStatus: current.reviewStatus, design: current.model.design, ...moduleDocument(current.model, moduleId), clocks: current.model.clocks, resets: current.model.resets, reviews: current.moduleReviews, instruction: '实现必须遵守该版本的接口、参数、复位、背压、不变量和验收条件；不满足时先提架构变更。此交接不证明行为 RTL 一致性。' };
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
