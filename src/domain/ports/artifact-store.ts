/** The `ArtifactStore` contract and its roles, with the shapes only they use. */

import type { SetupPhase } from '@/domain/config';
import type { TevuResult } from '@/domain/errors';
import type {
  AgentEventRecord,
  AgentSessionExport,
  AssessmentArtifact,
  CaseGrading,
  CaseResult,
  CheckResult,
  ConclusionsArtifact,
  GradingArtifact,
  PatchArtifact,
  ReportResult,
  RunManifest,
  RunResult,
} from '@/domain/run-records';

/** Run-relative paths of every artifact one case owns inside its run directory. */
export type CaseArtifactPathIndex = {
  events: string;
  diagnostics: string;
  sessionExport: string;
  solutionPatch: string;
  checks: string;
  assessment: string;
  grading: string;
  result: string;
  setupBeforeAgent: string;
  setupBeforeChecks: string;
};

/** Exclusive assessment lock held across replacement and derived regeneration. */
export interface AssessmentLock {
  runId: string;
  caseId: string;
  release(): Promise<TevuResult<void, 'ArtifactError'>>;
}

/** Writes the artifacts of the run in progress, from `startRun` to `finalizeRun`. */
export interface RunRecorder {
  caseArtifactPaths(caseId: string): CaseArtifactPathIndex;
  startRun(manifest: RunManifest): Promise<TevuResult<void, 'ArtifactError'>>;
  appendEvent(caseId: string, event: AgentEventRecord): Promise<TevuResult<void, 'ArtifactError'>>;
  appendDiagnostic(caseId: string, line: string): Promise<TevuResult<void, 'ArtifactError'>>;
  writeSessionExport(
    caseId: string,
    sessionExport: AgentSessionExport,
  ): Promise<TevuResult<void, 'ArtifactError'>>;
  writePatch(caseId: string, patch: PatchArtifact): Promise<TevuResult<void, 'ArtifactError'>>;
  writeChecks(caseId: string, checks: CheckResult[]): Promise<TevuResult<void, 'ArtifactError'>>;
  writeGrading(caseId: string, grading: CaseGrading): Promise<TevuResult<void, 'ArtifactError'>>;
  /** Redacts the whole text, failing closed, then atomically writes the phase log in the case directory. */
  writeSetupLog(
    caseId: string,
    phase: SetupPhase,
    text: string,
  ): Promise<TevuResult<void, 'ArtifactError'>>;
  finalizeCase(result: CaseResult): Promise<TevuResult<void, 'ArtifactError'>>;
  /** Writes the final `run.json` and ends the active run. */
  finalizeRun(result: RunResult): Promise<TevuResult<void, 'ArtifactError'>>;
}

/**
 * Reads a finalized run's saved artifacts and writes the records built from
 * them: case results, `run.json`, `result.json`, `report.md`,
 * `conclusions.json`, and `summary.md`.
 */
export interface RunArchive {
  caseArtifactPaths(caseId: string): CaseArtifactPathIndex;
  /**
   * Atomically replaces one case's derived result record inside an existing
   * run directory. Unlike `finalizeCase`, this is the derived-write contract
   * for closed (already finalized) runs used by assessment and report
   * regeneration; it never requires an active run.
   */
  replaceCaseResult(runId: string, result: CaseResult): Promise<TevuResult<void, 'ArtifactError'>>;
  /** Replaces `run.json` of a finalized run with its regenerated record. */
  finalizeRun(result: RunResult): Promise<TevuResult<void, 'ArtifactError'>>;
  writeReport(runId: string, report: ReportResult): Promise<TevuResult<void, 'ArtifactError'>>;
  /** `null` when `conclusions.json` does not exist; a malformed file is an `ArtifactError`. */
  readConclusions(runId: string): Promise<TevuResult<ConclusionsArtifact | null, 'ArtifactError'>>;
  /** Atomically replaces `conclusions.json` of an existing run through the redacting JSON sink. */
  writeConclusions(artifact: ConclusionsArtifact): Promise<TevuResult<void, 'ArtifactError'>>;
  /** Atomically replaces `summary.md` of an existing run through the redacting text sink; `writeReport` stays unchanged. */
  writeSummary(runId: string, markdown: string): Promise<TevuResult<void, 'ArtifactError'>>;
  readRunManifest(runId: string): Promise<TevuResult<RunManifest, 'ArtifactError'>>;
  readRunResult(runId: string): Promise<TevuResult<RunResult, 'ArtifactError'>>;
  readCaseResult(runId: string, caseId: string): Promise<TevuResult<CaseResult, 'ArtifactError'>>;
  readEvents(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AgentEventRecord[], 'ArtifactError'>>;
  readSessionExport(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AgentSessionExport | null, 'ArtifactError'>>;
  readChecks(runId: string, caseId: string): Promise<TevuResult<CheckResult[], 'ArtifactError'>>;
  readGrading(runId: string, caseId: string): Promise<TevuResult<GradingArtifact, 'ArtifactError'>>;
  readAssessment(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentArtifact | null, 'ArtifactError'>>;
}

/** Takes a case's exclusive assessment lock and commits its next `assessment.json` revision. */
export interface AssessmentStore {
  acquireAssessmentLock(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentLock, 'AssessmentConflictError' | 'ArtifactError'>>;
  replaceAssessment(artifact: AssessmentArtifact): Promise<TevuResult<void, 'ArtifactError'>>;
}

/**
 * Every artifact role in one contract: what the file adapter implements and
 * the composition root wires. A use case receives a role, never this
 * interface.
 */
export interface ArtifactStore extends RunRecorder, RunArchive, AssessmentStore {}
