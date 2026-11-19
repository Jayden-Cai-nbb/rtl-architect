import { checkAutomaticReading, checkFeedback, checkHardwareView, checkLayoutConstraints, checkOfflineDelivery, checkReadingGeometry } from './checks/diagrams';
import { checkCandidateQuality, checkReadingTasks, checkStateCone } from './checks/projections';
import { checkAssurance, checkAxisPair, checkEvidenceCoverage, checkStateObservation, checkStateUpdates, checkTransactionReplay, checkTypedExpressions } from './checks/verification';
import { checkManagedService, checkReadingEdits, checkRtlFixture, checkRtlWorkflow, checkSkillEntrypoints } from './checks/workflow';
import { checkDecisions, checkDraftsAndSourceImpact, checkParametersAndContext, checkRepository, checkReview, checkSemanticImport, checkStorageBudget, checkWorkObjects } from './checks/workspace';

const [requested, reportPath, ...extra] = process.argv.slice(2);
const groups = {
  workspace: [checkRepository, checkSemanticImport, checkParametersAndContext, checkReview, checkDraftsAndSourceImpact, checkWorkObjects, checkDecisions, checkStorageBudget],
  diagrams: [checkReadingGeometry, checkAutomaticReading, checkFeedback, checkHardwareView, checkLayoutConstraints, checkReadingTasks, checkCandidateQuality, checkStateCone, checkOfflineDelivery],
  verification: [checkAssurance, checkStateUpdates, checkEvidenceCoverage, checkStateObservation, checkTypedExpressions, checkAxisPair, checkTransactionReplay],
  workflow: [checkSkillEntrypoints, checkReadingEdits, checkManagedService, checkRtlFixture, () => checkRtlWorkflow(reportPath)],
};
const usage = 'npm run check [-- workspace|diagrams|verification|workflow [新报告.json]]';

if (requested === '--help') {
  console.log(usage);
} else {
  if (extra.length || (reportPath && requested !== 'workflow')) throw new Error(usage);
  if (requested && requested !== 'rtl' && !Object.hasOwn(groups, requested)) throw new Error(usage);
  const selected = requested === 'rtl' ? [['rtl', [checkRtlFixture]]] as const
    : Object.entries(groups).filter(([name]) => !requested || name === requested);
  let completed = 0;
  for (const [name, checks] of selected) {
    console.log(`\n[check] ${name}`);
    for (const check of checks) {
      await check();
      completed++;
    }
  }
  console.log(`通过 ${selected.length} 个检查分组、${completed} 个验证场景。`);
}
