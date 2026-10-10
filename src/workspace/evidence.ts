import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Model } from '../core/schema';
import { ToolError } from './environment';

export async function readEvidence(workspace: string, model: Model, id: string) {
  const evidence = model.provenance?.evidence.find(e => e.id === id);
  if (!evidence) throw new ToolError('EVIDENCE_NOT_FOUND', '该版本没有此证据');
  const root = await realpath(workspace), file = await realpath(resolve(root, evidence.file));
  const path = relative(root, file);
  if (path.startsWith('..') || isAbsolute(path)) throw new ToolError('EVIDENCE_OUTSIDE_WORKSPACE', '证据文件不在当前工作区内；不读取外部路径');
  const info = await stat(file);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ToolError('EVIDENCE_TOO_LARGE', '内嵌预览仅支持 2 MB 以内文本文件，请在项目中查看原文件');
  const bytes = await readFile(file);
  if (bytes.includes(0)) throw new ToolError('EVIDENCE_NOT_TEXT', '该证据不是文本文件');
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  const lines = bytes.toString('utf8').split('\n'), start = Math.max(1, (evidence.line ?? 1) - 5), end = Math.min(lines.length, start + 199, (evidence.endLine ?? evidence.line ?? 60) + 5);
  return { evidence, actualHash, matches: actualHash === evidence.fileHash, totalLines: lines.length, startLine: start, text: lines.slice(start - 1, end).join('\n'), lineExists: (evidence.line ?? 1) <= lines.length };
}
