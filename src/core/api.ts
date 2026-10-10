import type { Change } from './diff';
import type { Issue, Layout, Model, Proposal, Review, ReviewStatus } from './schema';
export type Snapshot = { model: Model; modelHash: string; issues: Issue[]; reviewStatus: ReviewStatus; review: Review | null; moduleReviews: { moduleId: string; status: ReviewStatus; record: Review | null }[] };
export type Preview = { candidate: Model; candidateHash: string; diff: Change[]; issues: Issue[] };
export type LayoutSnapshot = { layout: Layout; layoutHash: string };
export type RegisteredProposal = { createdWith?:string; id: string; proposal: Proposal; candidateHash: string; createdAt: string; state: 'READY' | 'STALE' | 'APPLIED'; modelHash: string; preview?: Preview };
