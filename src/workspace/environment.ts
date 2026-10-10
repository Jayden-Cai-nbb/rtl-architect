import { access, mkdir, readFile, realpath, symlink, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashValue } from '../core/export';

export const toolRoot = fileURLToPath(new URL('../../', import.meta.url));
export const toolVersion: string = JSON.parse(readFileSync(join(toolRoot, 'package.json'), 'utf8')).version;
export const loader = join(toolRoot, 'node_modules/tsx/dist/loader.mjs');
export const skillRoot = join(toolRoot, '.agents/skills/rtl-architect');

export class ToolError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
export async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function workspaceIdentity(workspace: string) {
  const workspaceRoot = await realpath(workspace);
  return { workspaceRoot, workspaceId: hashValue({ workspaceRoot }) };
}
export async function locateWorkspace(explicit?: string) {
  const selected = explicit ?? process.env.RTLARCH_WORKSPACE;
  const start = await realpath(resolve(selected || '.'));
  if (selected) return start;
  let current = start;
  while (true) {
    if (await exists(join(current, 'architecture/model.json'))) return current;
    const parent = dirname(current); if (parent === current) return start; current = parent;
  }
}
export async function installLink(target: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await lstat(destination);
    if (await realpath(destination).catch(() => '') === await realpath(target)) return { path: destination, installed: false };
    throw new ToolError('INSTALL_CONFLICT', `目标已存在，未覆盖：${destination}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await symlink(target, destination);
  return { path: destination, installed: true };
}
