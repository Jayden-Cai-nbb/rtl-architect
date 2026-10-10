import {coverageReport} from '../core/coverage';
import type { Snapshot } from '../core/api';
import { moduleDocument, moduleIssues } from '../core/spec';
import { specMarkdown } from '../core/spec';

export function architectureContext(snapshot: Snapshot, moduleId?: string, index?:number) {
  if (!moduleId) return { ...snapshot, coverage:coverageReport(snapshot.model), markdown: specMarkdown(snapshot.model, snapshot.modelHash, snapshot.reviewStatus, snapshot.issues) };
  const doc = moduleDocument(snapshot.model, moduleId, index);
  const related = new Set(doc.connections.flatMap(link => [link.from.moduleId, link.to.moduleId]).filter(id => id !== moduleId));
  const brief = (id: string) => {
    const module = snapshot.model.modules.find(m => m.id === id)!;
    return { id: module.id, name: module.name, kind: module.kind, parent: module.parent, clock: module.clock, reset: module.reset, timing: module.timing,
      parameters: module.parameters, interfaces: moduleDocument(snapshot.model, id).interfaces, responsibility: module.contract.responsibility };
  };
  const issues = moduleIssues(snapshot.model, snapshot.issues, moduleId);
  return {
    modelHash: snapshot.modelHash, reviewStatus: snapshot.reviewStatus, design: snapshot.model.design,
    module: doc.module, instance:doc.instance, parameterReport:doc.parameterReport, localSignals:doc.localSignals, interfaces: doc.interfaces, parent: doc.module.parent ? brief(doc.module.parent) : null,
    children: doc.children.map(m => brief(m.id)), neighbors: [...related].map(brief), connections: doc.connections,
    requirements: doc.requirements, decisions: doc.decisions, provenance: doc.provenance, clocks: snapshot.model.clocks, resets: snapshot.model.resets,
    designOpenQuestions: snapshot.model.specification?.openQuestions ?? [], issues,
    review: snapshot.moduleReviews.find(r => r.moduleId === moduleId),
    markdown: specMarkdown(snapshot.model, snapshot.modelHash, snapshot.reviewStatus, issues, moduleId, index),
  };
}
