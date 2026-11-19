import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashSchema, modelSchema } from '../core/schema';
import { hashValue, modelHash } from '../core/export';
import { replayAvailability, replayCapabilities } from '../core/replayCapability';
import {
  REPLAY_CHECKER_VERSION, replayMappingSchema, replaySamplesSchema, replayTransactions,
  type LegacyReplayResult, type ReplayMapping, type ReplayResult,
} from '../core/transactionReplay';
import type { StreamReplayResult } from '../core/streamReplay';
import { inputFile, newArtifactDirectory, workspacePath } from './artifacts';
import { verificationRun, verificationRuns } from './verification';
import { ToolError } from './environment';

const replayIdPattern = /^replay_[a-f0-9]{32}$/;
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(replayIdPattern),
  createdAt: z.iso.datetime({ offset: true }),
  checkerVersion: z.number().int().positive().optional(),
  modelHash: hashSchema,
  sourceDigest: hashSchema,
  runDigest: hashSchema,
  artifactDigest: hashSchema,
  pathDigest: hashSchema,
  mapping: replayMappingSchema,
  resultDigest: hashSchema,
});
const artifactLimit = 8 * 1024 * 1024;
const historyLimit = 100;
type RecordMetadata = z.infer<typeof recordSchema>;
type HistoryEntry = { id: string; record: RecordMetadata } | { id: string; error: string };
// Versioned fields may be absent in a historical payload. The stored result remains available for inspection.
type VersionedResultFields = 'checkerVersion' | 'observations' | 'environment' | 'coverage' | 'sampleIssue';
type HistoryResult = StreamReplayResult | (Omit<LegacyReplayResult, VersionedResultFields> & Partial<Pick<LegacyReplayResult, VersionedResultFields>>);
export type ReplayStaleReason = 'CHECKER_VERSION' | 'MODEL_CHANGED' | 'PATH_CHANGED' | 'RUN_CHANGED';
type Producer = Awaited<ReturnType<typeof verificationRun>>;
type ReplayAssurance = ReplayResult['status'] | 'STALE' | 'MANUAL';
type HistoryRecord = RecordMetadata & {
  result: HistoryResult;
  fresh: boolean;
  staleReason: ReplayStaleReason | null;
  verificationStatus: string;
  assurance: ReplayAssurance;
};

function assurance(mapping: ReplayMapping, run: Producer['summary'], result: HistoryResult): ReplayAssurance {
  if (mapping.origin === 'manual') return 'MANUAL';
  if (run.status !== 'passed') return 'FAILED';
  if (run.inputClosure !== 'declared_complete' || !run.toolVersionsKnown) return 'UNKNOWN';
  return result.status;
}

const readModel=async(workspace:string)=>modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString()));

export async function replayPreflight(workspace:string,moduleId:string|undefined,semantics:string){
  const model=await readModel(workspace);
  return {modelHash:modelHash(model),availability:replayAvailability(model,moduleId??model.design.top,semantics),
    independentVerification:replayCapabilities.independentVerification};
}

export async function replayVerification(workspace:string,moduleId:string){
  const model=await readModel(workspace), hash=modelHash(model);
  const runs=await verificationRuns(workspace,hash);
  return {modelHash:hash,runs:runs.filter(r=>r.stage==='simulation'&&r.moduleIds?.includes(moduleId))};
}

export async function importReplay(workspace: string, input: unknown, semantics?:string) {
  const mapping = replayMappingSchema.parse(input);
  const model = await readModel(workspace);
  const hash = modelHash(model);
  const availability=replayAvailability(model,mapping.moduleId,semantics,mapping.pathId);
  if(availability.status!=='DECLARED')throw new ToolError(
    availability.status==='NOT_DECLARED'?'REPLAY_PATH_NOT_DECLARED':`REPLAY_${availability.status}`,
    availability.message,{...availability,independentVerification:replayCapabilities.independentVerification});
  const path=model.modules.find(m=>m.id===mapping.moduleId)!.contract.transactionPaths!.find(p=>p.id===mapping.pathId)!;
  const producer = await verificationRun(workspace, hash, mapping.runId);
  const run = producer.summary;
  if (!run.fresh || run.stage !== 'simulation' || !producer.digest) throw new Error('需要当前模型和来源新鲜的 simulation verify 运行');
  const dir = await workspacePath(workspace, `evidence/runs/${mapping.runId}`);
  const artifact = await inputFile(dir, mapping.artifact, artifactLimit);
  if (!producer.artifacts.some(a => a.file === mapping.artifact && a.sha256 === artifact.sha256)) {
    throw new Error('轨迹必须是 verify 清单核对过的产物');
  }
  if (!producer.inputs.some(a => a.file === mapping.configuration)) throw new Error('configuration 必须指向本次 verify 输入文件');
  const samples = replaySamplesSchema.parse(JSON.parse(artifact.bytes.toString()));
  const result = replayTransactions(model, path, mapping, samples);
  const resultText = JSON.stringify(result) + '\n';
  if (Buffer.byteLength(resultText) > artifactLimit) throw new Error('回放结果超过 8 MiB 限额；请缩短显式场景，不截断记录');
  const id = 'replay_' + randomUUID().replaceAll('-', '');
  const record = {
    schemaVersion: 1 as const, id, createdAt: new Date().toISOString(), checkerVersion: REPLAY_CHECKER_VERSION, modelHash: hash,
    sourceDigest: hashValue(producer.inputs), runDigest: producer.digest, artifactDigest: artifact.sha256,
    pathDigest: hashValue(path), mapping, resultDigest: hashValue(result),
  };
  await mkdir(join(workspace, 'evidence'), { recursive: true });
  await workspacePath(workspace, 'evidence');
  await mkdir(join(workspace, 'evidence/replays'), { recursive: true });
  await workspacePath(workspace, 'evidence/replays');
  const output = await newArtifactDirectory(workspace, join(workspace, 'evidence/replays', id));
  await writeFile(join(output, 'result.json'), resultText, { flag: 'wx' });
  await writeFile(join(output, 'record.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return { ...record, result, verificationStatus: run.status, assurance: assurance(mapping, run, result) };
}

export async function replayRecords(workspace: string) {
  const model = await readModel(workspace);
  const hash = modelHash(model);
  const entries = await readdir(join(workspace, 'evidence/replays'), { withFileTypes: true })
    .catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const metadata: HistoryEntry[] = [];
  for (const dir of entries) {
    if (!dir.isDirectory() || !replayIdPattern.test(dir.name)) continue;
    const id = dir.name;
    try {
      const file = await inputFile(workspace, `evidence/replays/${id}/record.json`, artifactLimit);
      const record = recordSchema.parse(JSON.parse(file.bytes.toString()));
      if (record.id !== id) throw new Error('回放 ID 不符');
      metadata.push({ id, record });
    } catch (error) {
      metadata.push({ id, error: String(error) });
    }
  }
  const time = (entry: HistoryEntry) => 'record' in entry ? Date.parse(entry.record.createdAt) : -Infinity;
  metadata.sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));

  const records: (HistoryRecord | { id: string; assurance: 'UNKNOWN'; error: string })[] = [];
  const producers = new Map<string, Producer>();
  for (const entry of metadata.slice(0, historyLimit)) {
    const { id } = entry;
    try {
      if ('error' in entry) {
        records.push({ id, assurance: 'UNKNOWN', error: entry.error });
        continue;
      }
      const { record } = entry;
      const file = await inputFile(workspace, `evidence/replays/${id}/result.json`, artifactLimit);
      const result = JSON.parse(file.bytes.toString()) as HistoryResult;
      if (hashValue(result) !== record.resultDigest) throw new Error('回放结果摘要不符');
      let staleReason: ReplayStaleReason | null = null;
      let run: Producer['summary'] | undefined;
      if (record.checkerVersion !== REPLAY_CHECKER_VERSION || result.checkerVersion !== REPLAY_CHECKER_VERSION ||
          (record.mapping.schemaVersion === 2) !== ('schemaVersion' in result && result.schemaVersion === 2)) {
        staleReason = 'CHECKER_VERSION';
      } else if (record.modelHash !== hash) {
        staleReason = 'MODEL_CHANGED';
      } else {
        const { mapping } = record;
        const path = model.modules.find(m => m.id === mapping.moduleId)?.contract.transactionPaths?.find(p => p.id === mapping.pathId);
        if (!path || hashValue(path) !== record.pathDigest) {
          staleReason = 'PATH_CHANGED';
        } else {
          let producer = producers.get(mapping.runId);
          if (!producer) {
            producer = await verificationRun(workspace, hash, mapping.runId);
            producers.set(mapping.runId, producer);
          }
          run = producer.summary;
          if (!run.fresh || run.stage !== 'simulation' || producer.digest !== record.runDigest) staleReason = 'RUN_CHANGED';
        }
      }
      records.push({
        ...record, result, fresh: !staleReason, staleReason,
        verificationStatus: run?.status ?? 'UNKNOWN',
        assurance: run && !staleReason ? assurance(record.mapping, run, result) : 'STALE',
      });
    } catch (error) {
      records.push({ id, assurance: 'UNKNOWN', error: String(error) });
    }
  }
  return { modelHash: hash, checkerVersion: REPLAY_CHECKER_VERSION, records, limited: metadata.length > historyLimit,
    availability:replayAvailability(model,model.design.top) };
}
