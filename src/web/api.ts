import {serializeRequest} from '../core/transport';
import type { Issue } from '../core/schema';
import { serviceInfoSchema, type ServiceInfo } from '../core/service';
import { version as frontendVersion } from '../../package.json';
declare const __RTLARCH_BUILD_ID__:string;
let workspaceId = new URLSearchParams(window.location.search).get('workspace') ?? undefined;
export class HttpError extends Error { constructor(public status: number, message: string, public issues: Issue[] = []) { super(message); } }
export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/${path}`, { ...(body === undefined ? {} : { method, body: serializeRequest(body).json }), headers: { 'Content-Type': 'application/json', ...(workspaceId ? { 'X-RTLArch-Workspace': workspaceId } : {}) } });
  const result = await response.json();
  if (!response.ok) throw new HttpError(response.status, result.message, result.issues);
  return result as T;
}
export async function bindWorkspace(): Promise<ServiceInfo> {
  const info = await api<unknown>('health').catch(error => {
    if (error instanceof HttpError && error.status === 404) throw new Error('后台仍是旧版本，请停止旧服务并重新启动 rtlarch，再打开新的审阅链接。'); throw error;
  });
  const parsed = serviceInfoSchema.safeParse(info);
  if (!parsed.success) throw new Error('后台接口版本不兼容，请重启服务。');
  if (parsed.data.toolVersion !== frontendVersion) throw new Error(`页面为 ${frontendVersion}，后台为 ${parsed.data.toolVersion}；请停止该工作区旧服务并重新启动，刷新页面或用 proposals 获取新链接。`);
  if (parsed.data.buildId && typeof __RTLARCH_BUILD_ID__!=='undefined' && parsed.data.buildId!==__RTLARCH_BUILD_ID__) throw new Error('页面和服务来自不同构建；请运行 rtlarch open --restart，然后打开返回的新链接。');
  if (workspaceId && workspaceId !== parsed.data.workspaceId) throw new Error('该链接属于其他工作区，请重新打开目标项目的审阅链接。');
  workspaceId = parsed.data.workspaceId;
  return parsed.data;
}
