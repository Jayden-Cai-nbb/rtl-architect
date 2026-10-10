import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parameterSchema } from '../core/schema';
import { hashValue } from '../core/export';

const path = z.string().trim().min(1);
const entry=z.union([path,z.strictObject({path,stages:z.array(z.enum(['compile','simulation'])).min(1)})]);
export const inputManifestSchema = z.strictObject({
  top: z.string().trim().min(1), configuration: z.string().trim().min(1),
  parameters: z.record(z.string(), parameterSchema), defines: z.array(z.string()), includeDirs: z.array(path),
  files: z.array(entry).min(1), assets: z.array(entry),
});

// Explicit input list only: no HDL parser, project script execution or dependency inference.
export async function sourceInventory(workspace: string, input: unknown) {
  const manifest = inputManifestSchema.parse(input);
  const hashFile = async (file: string) => {
    const absolute = resolve(workspace, file);
    let handle;
    try {
      // stat first to avoid opening FIFOs/devices; inspect the opened file again before reading.
      if (!(await stat(absolute)).isFile()) return { file, status: 'not_file' as const };
      handle = await open(absolute, 'r');
      const before = await handle.stat();
      if (!before.isFile()) return { file, status: 'not_file' as const };
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) return { file, status: 'changed_during_read' as const };
      return { file, status: 'present' as const, bytes: before.size, sha256: hash.digest('hex') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, status: 'missing' as const };
      throw error;
    } finally { await handle?.close(); }
  };
  const files = await Promise.all(manifest.files.map(e=>hashFile(typeof e==='string'?e:e.path))), assets = await Promise.all(manifest.assets.map(e=>hashFile(typeof e==='string'?e:e.path)));
  const includeDirectories = await Promise.all(manifest.includeDirs.map(async file => {
    try { return { file, status: (await stat(resolve(workspace, file))).isDirectory() ? 'present' : 'not_directory' }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, status: 'missing' }; throw error; }
  }));
  const inputsAvailable = [...files, ...assets, ...includeDirectories].every(f => f.status === 'present');
  const available=(entries:z.infer<typeof entry>[],results:{status:string}[],stage:'compile'|'simulation')=>entries.every((e,i)=>typeof e!=='string'&&!e.stages.includes(stage)||results[i].status==='present');
  const ready=(stage:'compile'|'simulation')=>includeDirectories.every(f=>f.status==='present')&&available(manifest.files,files,stage)&&available(manifest.assets,assets,stage);
  const data = { schemaVersion: 1, manifest, files, assets, includeDirectories };
  return { ...data, sourceDigest: hashValue(data), inputsAvailable, compileInputsAvailable:ready('compile'), simulationInputsAvailable:ready('simulation'), note: '只核对显式输入清单及文件哈希；不解析 RTL、不自动发现 include/ROM、阶段可用仅指清单依赖齐全，不表示编译或仿真已执行/通过；未标注 stages 的条目保守计入两个阶段。' };
}
