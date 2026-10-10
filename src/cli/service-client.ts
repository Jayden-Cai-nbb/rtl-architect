import {serializeRequest} from '../core/transport';
import { open, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serviceInfoSchema, type ServiceInfo } from '../core/service';
import { loader, optionalJson, toolRoot, toolVersion, ToolError, workspaceIdentity, exists } from '../workspace/environment';

export type ClientOptions = { apiPort?: number; allowOlderVersion?: boolean };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function localUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/') throw new ToolError('SERVICE_METADATA_INVALID', '服务地址必须是本机 loopback HTTP 地址。');
  return parsed.origin;
}
async function probe(workspace: string, base: string, allowOlderVersion = false) {
  let response: Response;
  try { response = await fetch(`${localUrl(base)}/api/health`, { signal: AbortSignal.timeout(1500) }); }
  catch { return undefined; }
  const raw = await response.json().catch(() => undefined), parsed = serviceInfoSchema.safeParse(raw);
  if (!response.ok || !parsed.success) throw new ToolError('SERVICE_INCOMPATIBLE', '该地址上的服务不支持当前接口；请停止旧版本服务后重启。');
  const info = parsed.data, identity = await workspaceIdentity(workspace);
  if (info.workspaceId !== identity.workspaceId || info.workspaceRoot !== identity.workspaceRoot) throw new ToolError('WORKSPACE_MISMATCH', '该服务属于其他工作区，已拒绝连接。', { expected: identity.workspaceRoot, actual: info.workspaceRoot });
  localUrl(info.apiUrl); localUrl(info.webUrl);
  if (info.apiUrl !== localUrl(base)) throw new ToolError('SERVICE_METADATA_INVALID', '服务报告的 API 地址与实际连接地址不一致。');
  if (!allowOlderVersion && info.toolVersion !== toolVersion) throw new ToolError('VERSION_MISMATCH', `服务为 ${info.toolVersion}，工具为 ${toolVersion}；请运行 rtlarch stop 后重试。`);
  return info;
}
export async function discoverService(workspace: string, options: ClientOptions = {}) {
  if (options.apiPort !== undefined) {
    const info = await probe(workspace, `http://127.0.0.1:${options.apiPort}`, options.allowOlderVersion);
    if (!info) throw new ToolError('SERVICE_UNAVAILABLE', '指定 API 端口没有可用服务；未自动改连其他服务。');
    return info;
  }
  const raw = await optionalJson(join(workspace, '.rtlarch/runtime.json'));
  if (!raw) return undefined;
  const parsed = serviceInfoSchema.safeParse(raw);
  if (!parsed.success) throw new ToolError('SERVICE_METADATA_INVALID', '工作区 .rtlarch/runtime.json 格式无效，请检查服务记录。');
  const identity = await workspaceIdentity(workspace);
  // A workspace copy must never follow the original workspace's runtime record.
  if (parsed.data.workspaceId !== identity.workspaceId || parsed.data.workspaceRoot !== identity.workspaceRoot) throw new ToolError('WORKSPACE_MISMATCH', '服务记录属于另一个路径；复制项目时请排除 .rtlarch/。');
  return probe(workspace, parsed.data.apiUrl, options.allowOlderVersion);
}
export async function ensureService(workspace: string, options: ClientOptions = {}) {
  const existing = await discoverService(workspace, options); if (existing) return existing;
  if (!await exists(join(workspace, 'architecture/model.json'))) throw new ToolError('WORKSPACE_NOT_INITIALIZED', '工作区没有架构模型；请先运行 rtlarch init --workspace <目录>。');
  const dir = join(workspace, '.rtlarch'); await mkdir(dir, { recursive: true });
  const log = await open(join(dir, 'service.log'), 'a');
  const child = spawn(process.execPath, ['--import', loader, join(toolRoot, 'src/server/index.ts')], {
    cwd: workspace, env: { ...process.env, RTLARCH_WORKSPACE: workspace, RTLARCH_MANAGED: '1', RTLARCH_MODE: 'demo' },
    detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  let spawnError: Error | undefined; child.on('error', error => { spawnError = error; }); child.unref(); await log.close();
  for (let attempt = 0; attempt < 80; attempt++) {
    await pause(100);
    if (spawnError) throw new ToolError('SERVICE_START_FAILED', spawnError.message);
    const info = await discoverService(workspace, options); if (info) return info;
    // Another simultaneous start may own the lock and still be publishing its endpoint.
    if (child.exitCode !== null && attempt > 15) break;
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  const detail = (await readFile(join(dir, 'service.log'), 'utf8').catch(() => '')).slice(-3000);
  const permissionDenied = /\b(EPERM|EACCES)\b/.test(detail);
  throw new ToolError(permissionDenied ? 'SERVICE_PERMISSION_DENIED' : 'SERVICE_START_FAILED', permissionDenied ? '本地服务受到权限限制；通过当前环境的权限流程重试，或先用 context --offline 读取。不要切换到其他项目服务。' : '本地服务启动失败；详情见 .rtlarch/service.log。', detail);
}
export async function request<T = unknown>(info: ServiceInfo, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${info.apiUrl}/api/${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: serializeRequest(body).json }),
    headers: { 'Content-Type': 'application/json', 'X-RTLArch-Workspace': info.workspaceId }, signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new ToolError(result.code || `HTTP_${response.status}`, result.message || 'API 请求失败', { status: response.status, issues: result.issues ?? [], ...result.details });
  return result as T;
}
export async function stopService(workspace: string, options: ClientOptions = {}) {
  const info = await discoverService(workspace, { ...options, allowOlderVersion: true });
  if (!info) return { stopped: false };
  await request(info, 'runtime/stop', {});
  for (let attempt = 0; attempt < 60; attempt++) {
    await pause(100);
    const current = await discoverService(workspace, { ...options, allowOlderVersion: true }).catch(error => {
      if (error instanceof ToolError && error.code === 'SERVICE_UNAVAILABLE') return undefined; throw error;
    });
    if (!current || current.instanceId !== info.instanceId) return { stopped: true, instanceId: info.instanceId };
  }
  throw new ToolError('SERVICE_STOP_TIMEOUT', '停止请求已发送，但服务尚未退出。');
}
