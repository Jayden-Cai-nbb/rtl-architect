import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const workspace = resolve(process.env.RTLARCH_WORKSPACE || '.');
await mkdir(resolve(workspace, 'architecture'), { recursive: true });
try {
  await copyFile(fileURLToPath(new URL('../examples/tiny-stream/model.json', import.meta.url)), resolve(workspace, 'architecture/model.json'), constants.COPYFILE_EXCL);
  console.log('已初始化 DRAFT 模型；未创建人工确认记录。');
} catch (error) { console.error('初始化失败；已有 model 时拒绝覆盖。', error); process.exitCode = 1; }
