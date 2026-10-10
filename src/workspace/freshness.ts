import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Model } from '../core/schema';
import { modelHash } from '../core/export';

export type EvidenceState = 'matched' | 'changed' | 'missing' | 'unreadable' | 'outside_workspace' | 'changed_during_read';
/** Hash only explicitly declared workspace files. Never update provenance or approval. */
export async function evidenceFreshness(workspace: string, model: Model) {
  const root = await realpath(workspace);
  const cache = new Map<string, Promise<{ actualHash?: string; state?: EvidenceState; detail?: string }>>();
  async function digest(file: string) {
    const requested = resolve(root, file), rel = relative(root, requested);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return { state: 'outside_workspace' as const };
    try {
      const path = await realpath(requested), canonical = relative(root, path);
      if (canonical === '..' || canonical.startsWith('../') || isAbsolute(canonical)) return { state: 'outside_workspace' as const };
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile()) return { state: 'unreadable' as const, detail: '不是普通文件' };
        const hash = createHash('sha256');
        for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { state: 'changed_during_read' as const };
        return { actualHash: hash.digest('hex') };
      } finally { await handle.close(); }
    } catch (error) {
      return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' as const : 'unreadable' as const, detail: (error as NodeJS.ErrnoException).code ?? 'READ_FAILED' };
    }
  }
  const files: { id: string; file: string; sourceKind: string; expectedHash: string; actualHash?: string; state: EvidenceState; detail?: string; targets: NonNullable<Model['provenance']>['evidence'][number]['targets']; findings: string[] }[] = [];
  for (const evidence of model.provenance?.evidence ?? []) {
    if (!cache.has(evidence.file)) cache.set(evidence.file, digest(evidence.file));
    const result = await cache.get(evidence.file)!;
    files.push({ id: evidence.id, file: evidence.file, sourceKind: evidence.sourceKind, expectedHash: evidence.fileHash,
      ...result, state: result.state ?? (result.actualHash === evidence.fileHash ? 'matched' as const : 'changed' as const),
      targets: evidence.targets ?? [],
      findings: model.provenance?.findings.filter(f => f.evidenceIds.includes(evidence.id)).map(f => f.id) ?? [] });
  }
  return { modelHash: modelHash(model), checkedAt: new Date().toISOString(), status: !files.length ? 'unknown' as const : files.every(f => f.state === 'matched') ? 'fresh' as const : 'attention' as const,
    counts: Object.fromEntries(['matched', 'changed', 'missing', 'unreadable', 'outside_workspace', 'changed_during_read'].map(state => [state, files.filter(f => f.state === state).length])), files,
    note: '仅核对声明文件的字节摘要；不自动发现依赖，不判断行为影响，不修改批准。' };
}
