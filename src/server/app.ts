import {requestLimitBytes,RequestSizeError} from '../core/transport';
import express from 'express';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { protocolVersion, type ServiceInfo } from '../core/service';
import { toolVersion, ToolError, workspaceIdentity } from '../workspace/environment';
import { EngineError } from '../core/engine';
import { ApiError, Repository } from '../workspace/repository';
export function createApp(repository: Repository, apiPort = 4317, webPort = 5173, staticDirectory?: string, options: { service?: ServiceInfo; shutdown?: () => void } = {}) {
  const app = express(); app.disable('x-powered-by');
  const identity = workspaceIdentity(repository.workspace);
  const instanceId = randomUUID();
  const service = async (): Promise<ServiceInfo> => options.service ?? { product: 'rtl-architect', protocolVersion, toolVersion, ...await identity, instanceId, pid: process.pid, apiUrl: `http://127.0.0.1:${apiPort}`, webUrl: `http://127.0.0.1:${webPort}` };
  const hosts = new Set([`127.0.0.1:${apiPort}`, `127.0.0.1:${webPort}`]);
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host ?? '')) { res.status(422).json({ message: '拒绝未知 Host' }); return; }
    if (req.headers.origin && ![...hosts].some(host => req.headers.origin === `http://${host}`)) { res.status(422).json({ message: '拒绝非本地 Origin' }); return; }
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) { res.status(422).json({ message: 'Content-Type 必须为 application/json' }); return; }
    next();
  });
  app.use(async (req, res, next) => {
    const current = await service();
    res.setHeader('X-RTLArch-Workspace', current.workspaceId);
    if (req.headers['x-rtlarch-workspace'] && req.headers['x-rtlarch-workspace'] !== current.workspaceId) throw new ApiError(409, '服务属于其他工作区，请重新打开目标项目的审阅链接。', 'WORKSPACE_MISMATCH');
    next();
  });
  app.get('/api/health', async (_req, res) => res.json(await service()));
  app.post('/api/runtime/stop', (_req, res) => { if (!options.shutdown) throw new ApiError(422, '此服务不支持远程停止', 'STOP_UNSUPPORTED'); res.json({ stopping: true }); options.shutdown(); });
  app.get('/api/context', async (req, res) => {
    const id = typeof req.query.moduleId === 'string' ? req.query.moduleId : undefined;
    const index=req.query.index===undefined?undefined:Number(req.query.index);
    res.json(await repository.getContext(id,index));
  });
  app.use(express.json({ limit: requestLimitBytes, strict: true }));
  if (!staticDirectory) app.get('/', (_req, res) => res.redirect(302, `http://127.0.0.1:${webPort}/`));
  app.get('/api/workbench',async(_req,res)=>res.json(await repository.getWorkbench()));
  app.post('/api/workbench',async(req,res)=>res.json(await repository.updateWorkbench(req.body)));
  app.get('/api/resume',async(_req,res)=>res.json(await repository.getResume()));
  app.get('/api/model', async (_req, res) => res.json(await repository.getModel()));
  app.get('/api/spec', async (req, res) => res.json(await repository.getSpec(typeof req.query.moduleId === 'string' ? req.query.moduleId : undefined)));
  app.get('/api/handoff/:moduleId', async (req, res) => res.json(await repository.handoff(String(req.params.moduleId))));
  app.post('/api/review/module', async (req, res) => res.json(await repository.reviewModule(req.body)));
  app.get('/api/layout', async (_req, res) => res.json(await repository.getLayout()));
  app.put('/api/layout', async (req, res) => res.json(await repository.putLayout(req.body)));
  app.post('/api/preview', async (req, res) => res.json(await repository.preview(req.body)));
  app.post('/api/evidence', async (req, res) => res.json(await repository.getEvidence(req.body)));
  app.post('/api/proposals', async (req, res) => res.json(await repository.registerProposal(req.body)));
  app.get('/api/proposals', async (_req, res) => res.json(await repository.listProposals()));
  app.get('/api/proposals/:id', async (req, res) => res.json(await repository.getProposal(String(req.params.id))));
  app.post('/api/commit', async (req, res) => res.json(await repository.commit(req.body)));
  app.post('/api/review', async (req, res) => res.json(await repository.review(req.body)));
  app.post('/api/export', async (req, res) => res.json(await repository.export(req.body)));
  if (staticDirectory) app.use(express.static(staticDirectory, { dotfiles: 'deny' }));
  app.use((_req, res) => { res.status(404).json({ message: '接口不存在' }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const oversized=error as {type?:string;length?:number;received?:number};
    if(oversized.type==='entity.too.large'){const size=oversized.length??oversized.received??Number(_req.headers['content-length']??0),failure=new RequestSizeError(size);res.status(413).json({code:failure.code,message:failure.message,details:{actualBytes:size,limitBytes:requestLimitBytes},issues:[]});return;}
    const status = error instanceof ApiError ? error.status : error instanceof ZodError || error instanceof EngineError || (error as { type?: string }).type?.startsWith('entity.') ? 422 : 500;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiError || error instanceof ToolError ? error.code : error instanceof EngineError ? 'MODEL_INVALID' : status === 422 ? 'VALIDATION_ERROR' : 'WORKSPACE_IO';
    res.status(status).json({ code, message: status === 500 ? `工作区文件操作失败：${message}` : message, issues: error instanceof EngineError ? error.issues : error instanceof ZodError ? error.issues.map(i => ({ code: 'SCHEMA', severity: 'error', blocks: ['commit', 'review'], target: i.path.join('.'), message: i.message })) : [] });
  });
  return app;
}
