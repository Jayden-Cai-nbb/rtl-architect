import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { optionalJson, ToolError } from './environment';
import { atomicWrite } from './repository';
import type { ServiceInfo } from '../core/service';

export const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
type Owner = { pid: number; instanceId: string };
function owner(value: unknown): Owner | undefined {
  if (value && typeof value === 'object' && 'pid' in value && 'instanceId' in value && Number.isInteger(value.pid) && Number(value.pid) > 0 && typeof value.instanceId === 'string') return value as Owner;
}
export async function acquireService(workspace: string) {
  const dir = join(workspace, '.rtlarch'), lock = join(dir, 'service.lock'), recovery = join(dir, 'recover.lock');
  const mine: Owner = { pid: process.pid, instanceId: randomUUID() };
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await writeFile(lock, JSON.stringify(mine), { flag: 'wx' }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = owner(await optionalJson(lock).catch(() => undefined));
      if (!previous || processAlive(previous.pid)) throw new ToolError('SERVICE_RUNNING', '该工作区已有服务或正在启动；请用 rtlarch status/stop 操作该服务。');
      // Serialize stale-lock recovery and recheck ownership inside the recovery guard.
      try { await mkdir(recovery); } catch { throw new ToolError('SERVICE_RECOVERY_BUSY', '另一个进程正在恢复工作区服务锁，请稍后重试。'); }
      try {
        const current = owner(await optionalJson(lock));
        if (current && !processAlive(current.pid)) await rm(lock);
      } finally { await rm(recovery, { recursive: true }); }
      if (attempt === 2) throw new ToolError('SERVICE_RUNNING', '工作区服务正在变更，请重试。');
    }
  }
  return {
    instanceId: mine.instanceId,
    publish: (info: ServiceInfo) => atomicWrite(join(dir, 'runtime.json'), JSON.stringify(info, null, 2) + '\n'),
    release: async () => {
      for (const file of ['runtime.json', 'service.lock']) {
        const path = join(dir, file);
        const current = await readFile(path, 'utf8').then(s => JSON.parse(s) as Owner).catch(() => undefined);
        if (current?.instanceId === mine.instanceId) await rm(path, { force: true });
      }
    },
  };
}
