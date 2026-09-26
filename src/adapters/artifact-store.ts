/**
 * Versioned atomic local artifact storage plus the YAML configuration store.
 *
 * Owns every filesystem operation for run artifacts: exclusive run-directory
 * creation, per-case append files, serialized run-manifest replacement, atomic
 * final-state JSON writes, exclusive non-stale assessment locking, and
 * regeneration reads with shape validation. Every payload crosses the injected
 * credential-secret redaction boundary before it reaches a designated sink:
 * structured JSON and YAML sinks redact decoded string content before
 * serialization so escape-serialized secrets cannot survive and numeric
 * metrics stay numbers, while text sinks redact whole text. A redaction
 * failure aborts the write with `ArtifactError`, never falling back to
 * unredacted output.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { describeCause } from '@/domain/describe-cause';
import { redactDecodedValue } from '@/domain/redaction';

import type {
  AgentEventRecord,
  AgentSessionExport,
  ArtifactStore,
  AssessmentArtifact,
  AssessmentLock,
  CaseResult,
  CheckResult,
  ConfigReadCause,
  ConfigStore,
  PatchArtifact,
  Redactor,
  RepeatSetting,
  ReportResult,
  RunManifest,
  RunResult,
  SetupPhase,
  TevuError,
  TevuResult,
} from '@/domain/types';

/** Construction inputs for the file-backed artifact store. */
export type ArtifactStoreOptions = {
  artifactsDirectory: string;
  redact: Redactor;
};

/** Construction inputs for the file-backed configuration store. */
export type ConfigStoreOptions = {
  redact: Redactor;
};

/** Run-relative POSIX paths of every artifact one case owns. */
type CaseArtifactPaths = {
  events: string;
  diagnostics: string;
  sessionExport: string;
  solutionPatch: string;
  checks: string;
  assessment: string;
  result: string;
  setupBeforeAgent: string;
  setupBeforeChecks: string;
};

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CASE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}--[a-z][a-z0-9-]{0,63}--[1-9][0-9]{0,15}$/;

const TERMINAL_LIFECYCLES = new Set<string>([
  'completed',
  'process-failed',
  'timed-out',
  'cancelled',
  'infrastructure-failed',
]);

const CASE_FILE = {
  events: 'events.jsonl',
  diagnostics: 'stderr.log',
  sessionExport: 'session.json',
  solutionPatch: 'solution.patch',
  checks: 'checks.json',
  assessment: 'assessment.json',
  result: 'result.json',
  setupBeforeAgent: 'setup-before-agent.log',
  setupBeforeChecks: 'setup-before-checks.log',
} as const;

const RUN_MANIFEST_FILE = 'run.json';
const REPORT_FILE = 'report.md';
const CASES_DIRECTORY = 'cases';
const ASSESSMENT_LOCK_DIRECTORY = 'assessment.lock';

/**
 * Returns the run-relative POSIX paths of every artifact the given case owns,
 * so orchestration builds its `ArtifactIndex` with the exact store layout.
 */
function caseArtifactPaths(caseId: string): CaseArtifactPaths {
  const base = path.posix.join(CASES_DIRECTORY, caseId);
  return {
    events: path.posix.join(base, CASE_FILE.events),
    diagnostics: path.posix.join(base, CASE_FILE.diagnostics),
    sessionExport: path.posix.join(base, CASE_FILE.sessionExport),
    solutionPatch: path.posix.join(base, CASE_FILE.solutionPatch),
    checks: path.posix.join(base, CASE_FILE.checks),
    assessment: path.posix.join(base, CASE_FILE.assessment),
    result: path.posix.join(base, CASE_FILE.result),
    setupBeforeAgent: path.posix.join(base, CASE_FILE.setupBeforeAgent),
    setupBeforeChecks: path.posix.join(base, CASE_FILE.setupBeforeChecks),
  };
}

/** Creates the file-backed `ArtifactStore` rooted at the configured artifacts directory. */
export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
  return new FileArtifactStore(options);
}

/** Creates the file-backed `ConfigStore`; `readText` reads the file directly, writes are atomic. */
export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  return {
    async exists(configPath: string): Promise<boolean> {
      try {
        await fs.access(path.resolve(configPath));
        return true;
      } catch (cause) {
        return systemErrorCode(cause) !== 'ENOENT';
      }
    },
    async requireDirectory(configPath: string): Promise<TevuResult<void, 'PrerequisiteError'>> {
      const directory = path.dirname(path.resolve(configPath));
      try {
        await fs.access(directory);
      } catch (cause) {
        if (systemErrorCode(cause) === 'ENOENT') {
          return {
            ok: false,
            error: {
              kind: 'PrerequisiteError',
              tool: 'configuration directory',
              expected: 'an existing directory',
              actual: `${directory} does not exist`,
            },
          };
        }
      }
      return okVoid();
    },
    readText(configPath: string) {
      return readConfigText(configPath);
    },
    async replaceText(
      configPath: string,
      text: string,
    ): Promise<TevuResult<void, 'ArtifactError'>> {
      const operation = 'replace-configuration';
      let redactedText: string;
      try {
        redactedText = options.redact(text);
      } catch (cause) {
        return artifactFailure(
          operation,
          `redaction failed; write aborted: ${describeCause(cause)}`,
        );
      }
      if (redactedText !== text) {
        return artifactFailure(
          operation,
          'configuration text contains the value of a secret variable; write aborted',
        );
      }
      const resolvedPath = path.resolve(configPath);
      const mode = await replacedFileMode(resolvedPath);
      if (!mode.ok) {
        return mode;
      }
      try {
        await atomicReplaceFile(resolvedPath, text, mode.value);
      } catch (cause) {
        return artifactFailure(
          operation,
          `cannot atomically replace configuration file: ${describeCause(cause)}`,
        );
      }
      return okVoid();
    },
  };
}

/**
 * Reads the UTF-8 configuration text at the given path.
 *
 * Establishes the path names a regular file through `stat` before ever
 * opening it, so a directory, FIFO, or permission failure is classified
 * consistently for every caller of `ConfigStore.readText`.
 */
async function readConfigText(configPath: string): Promise<TevuResult<string, 'ConfigReadError'>> {
  const absoluteConfigPath = path.resolve(configPath);

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(absoluteConfigPath);
  } catch (cause) {
    return configReadFailure(absoluteConfigPath, configPath, classify(cause));
  }
  if (!stats.isFile()) {
    return configReadFailure(absoluteConfigPath, configPath, 'not-a-file');
  }

  try {
    const text = await fs.readFile(absoluteConfigPath, 'utf8');
    return { ok: true, value: text };
  } catch (cause) {
    return configReadFailure(absoluteConfigPath, configPath, classify(cause));
  }
}

function configReadFailure(
  absolutePath: string,
  requestedPath: string,
  cause: ConfigReadCause,
): TevuResult<never, 'ConfigReadError'> {
  return {
    ok: false,
    error: { kind: 'ConfigReadError', path: absolutePath, requestedPath, cause },
  };
}

/** Classifies a `stat`/`readFile` failure by its system error code. */
function classify(cause: unknown): ConfigReadCause {
  const code = systemErrorCode(cause);
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'EISDIR':
      return 'not-a-file';
    default:
      return 'unreadable';
  }
}

/**
 * Resolves the permission bits `replaceText` must preserve (E4): the
 * replaced file's own mode bits, or `undefined` for a new file so the
 * temporary file keeps its default mode under the process umask. Any other
 * `stat` failure aborts the write with no mode resolved.
 */
async function replacedFileMode(
  resolvedPath: string,
): Promise<TevuResult<number | undefined, 'ArtifactError'>> {
  try {
    const stats = await fs.stat(resolvedPath);
    return { ok: true, value: stats.mode & 0o777 };
  } catch (cause) {
    if (systemErrorCode(cause) === 'ENOENT') {
      return { ok: true, value: undefined };
    }
    return artifactFailure(
      'replace-configuration',
      `cannot read the permissions of the configuration file: ${describeCause(cause)}`,
    );
  }
}

type ActiveRun = {
  runId: string;
  directory: string;
  caseDirectories: Map<string, string>;
};

class FileArtifactStore implements ArtifactStore {
  private readonly root: string;
  private readonly redact: Redactor;
  private activeRun: ActiveRun | null;
  private manifestChain: Promise<unknown>;
  private readonly appendChains: Map<string, Promise<unknown>>;

  constructor(options: ArtifactStoreOptions) {
    this.root = path.resolve(options.artifactsDirectory);
    this.redact = options.redact;
    this.activeRun = null;
    this.manifestChain = Promise.resolve();
    this.appendChains = new Map();
  }

  caseArtifactPaths(caseId: string): CaseArtifactPaths {
    return caseArtifactPaths(caseId);
  }

  async startRun(manifest: RunManifest): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'start-run';
    const invalid = describeManifestDefect(manifest);
    if (invalid !== null) {
      return artifactFailure(operation, invalid);
    }
    if (this.activeRun !== null) {
      return artifactFailure(
        operation,
        `run "${this.activeRun.runId}" is already active in this store instance`,
      );
    }
    try {
      await fs.mkdir(this.root, { recursive: true });
    } catch (cause) {
      return artifactFailure(
        operation,
        `cannot create artifacts root "${this.root}": ${describeCause(cause)}`,
      );
    }
    const runDirectory = path.join(this.root, manifest.runId);
    try {
      await fs.mkdir(runDirectory);
    } catch (cause) {
      if (systemErrorCode(cause) === 'EEXIST') {
        return artifactFailure(
          operation,
          `run directory already exists for run ID "${manifest.runId}"; run ID collision rejected`,
        );
      }
      return artifactFailure(
        operation,
        `cannot create run directory "${runDirectory}": ${describeCause(cause)}`,
      );
    }
    const caseDirectories = new Map<string, string>();
    for (const identity of manifest.cases) {
      const caseDirectory = path.join(runDirectory, CASES_DIRECTORY, identity.caseId);
      try {
        await fs.mkdir(caseDirectory, { recursive: true });
      } catch (cause) {
        return artifactFailure(
          operation,
          `cannot create case directory for "${identity.caseId}": ${describeCause(cause)}`,
        );
      }
      caseDirectories.set(identity.caseId, caseDirectory);
    }
    const redacted = redactValueForSink(this.redact, operation, manifest);
    if (!redacted.ok) {
      return redacted;
    }
    const serialized = serializeJsonForSink(operation, redacted.value);
    if (!serialized.ok) {
      return serialized;
    }
    const written = await this.queueManifestWrite(
      path.join(runDirectory, RUN_MANIFEST_FILE),
      serialized.value,
      operation,
    );
    if (!written.ok) {
      return written;
    }
    this.activeRun = { runId: manifest.runId, directory: runDirectory, caseDirectories };
    return okVoid();
  }

  async appendEvent(
    caseId: string,
    event: AgentEventRecord,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'append-event';
    const active = this.requireActiveCase(operation, caseId);
    if (!active.ok) {
      return active;
    }
    // Serializing the raw event first keeps an unserializable event an
    // artifact failure; redaction then works on decoded values so an
    // escape-serialized secret cannot survive and numeric fields stay numbers.
    try {
      JSON.stringify(event);
    } catch (cause) {
      return artifactFailure(
        operation,
        `event cannot be serialized as one JSON value: ${describeCause(cause)}`,
      );
    }
    const redacted = redactValueForSink(this.redact, operation, event);
    if (!redacted.ok) {
      return redacted;
    }
    const line = JSON.stringify(redacted.value);
    if (line.includes('\n') || line.includes('\r')) {
      return artifactFailure(
        operation,
        'redaction produced a multi-line event record; JSONL framing write aborted',
      );
    }
    return this.queueAppend(
      path.join(active.value.directory, CASE_FILE.events),
      `${line}\n`,
      operation,
    );
  }

  async appendDiagnostic(
    caseId: string,
    diagnosticLine: string,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'append-diagnostic';
    const active = this.requireActiveCase(operation, caseId);
    if (!active.ok) {
      return active;
    }
    const redacted = redactForSink(this.redact, operation, diagnosticLine);
    if (!redacted.ok) {
      return redacted;
    }
    return this.queueAppend(
      path.join(active.value.directory, CASE_FILE.diagnostics),
      `${redacted.value}\n`,
      operation,
    );
  }

  async writeSessionExport(
    caseId: string,
    sessionExport: AgentSessionExport,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'write-session-export';
    const active = this.requireActiveCase(operation, caseId);
    if (!active.ok) {
      return active;
    }
    return this.writeJsonSink(
      operation,
      active.value.directory,
      CASE_FILE.sessionExport,
      sessionExport,
    );
  }

  async writePatch(
    caseId: string,
    patch: PatchArtifact,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'write-patch';
    const active = this.requireActiveCase(operation, caseId);
    if (!active.ok) {
      return active;
    }
    if (patch.caseId !== caseId) {
      return artifactFailure(
        operation,
        `patch identity "${patch.caseId}" does not match case "${caseId}"`,
      );
    }
    const redacted = redactForSink(this.redact, operation, patch.content);
    if (!redacted.ok) {
      return redacted;
    }
    return this.writeTextFile(
      operation,
      path.join(active.value.directory, CASE_FILE.solutionPatch),
      redacted.value,
    );
  }

  async writeSetupLog(
    caseId: string,
    phase: SetupPhase,
    text: string,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'write-setup-log';
    const active = this.requireActiveCase(operation, caseId);
    if (!active.ok) {
      return active;
    }
    const redacted = redactForSink(this.redact, operation, text);
    if (!redacted.ok) {
      return redacted;
    }
    const fileName =
      phase === 'before_agent' ? CASE_FILE.setupBeforeAgent : CASE_FILE.setupBeforeChecks;
    return this.writeTextFile(
      operation,
      path.join(active.value.directory, fileName),
      redacted.value,
    );
  }

  async writeChecks(
    caseId: string,
    checks: CheckResult[],
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'write-checks';
    const active = this.requireActiveCase(operation, caseId);
    if (!active.ok) {
      return active;
    }
    const artifact = {
      schemaVersion: 1 as const,
      runId: active.value.runId,
      caseId,
      checks,
    };
    return this.writeJsonSink(operation, active.value.directory, CASE_FILE.checks, artifact);
  }

  async finalizeCase(result: CaseResult): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'finalize-case';
    const active = this.requireActiveCase(operation, result.identity.caseId);
    if (!active.ok) {
      return active;
    }
    if (result.schemaVersion !== 1) {
      return artifactFailure(operation, 'case result schemaVersion must be 1');
    }
    if (!TERMINAL_LIFECYCLES.has(result.lifecycle)) {
      return artifactFailure(
        operation,
        `case "${result.identity.caseId}" lifecycle "${result.lifecycle}" is not terminal`,
      );
    }
    return this.writeJsonSink(operation, active.value.directory, CASE_FILE.result, result);
  }

  async replaceCaseResult(
    runId: string,
    result: CaseResult,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'replace-case-result';
    if (result.schemaVersion !== 1) {
      return artifactFailure(operation, 'case result schemaVersion must be 1');
    }
    if (!TERMINAL_LIFECYCLES.has(result.lifecycle)) {
      return artifactFailure(
        operation,
        `case "${result.identity.caseId}" lifecycle "${result.lifecycle}" is not terminal`,
      );
    }
    const caseDirectory = this.resolveCaseDirectory(operation, runId, result.identity.caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const present = await directoryExists(caseDirectory.value);
    if (!present) {
      return artifactFailure(
        operation,
        `case "${result.identity.caseId}" does not exist in run "${runId}"`,
      );
    }
    return this.writeJsonSink(operation, caseDirectory.value, CASE_FILE.result, result);
  }

  async finalizeRun(result: RunResult): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'finalize-run';
    if (result.schemaVersion !== 1 || result.manifest.schemaVersion !== 1) {
      return artifactFailure(operation, 'run result schemaVersion must be 1');
    }
    const runId = result.manifest.runId;
    if (!RUN_ID_PATTERN.test(runId)) {
      return artifactFailure(operation, `run ID "${runId}" is not a valid identifier`);
    }
    const runDirectory =
      this.activeRun !== null && this.activeRun.runId === runId
        ? this.activeRun.directory
        : path.join(this.root, runId);
    const present = await directoryExists(runDirectory);
    if (!present) {
      return artifactFailure(operation, `run directory for "${runId}" does not exist`);
    }
    const redacted = redactValueForSink(this.redact, operation, result);
    if (!redacted.ok) {
      return redacted;
    }
    const serialized = serializeJsonForSink(operation, redacted.value);
    if (!serialized.ok) {
      return serialized;
    }
    const written = await this.queueManifestWrite(
      path.join(runDirectory, RUN_MANIFEST_FILE),
      serialized.value,
      operation,
    );
    if (!written.ok) {
      return written;
    }
    if (this.activeRun !== null && this.activeRun.runId === runId) {
      this.activeRun = null;
    }
    return okVoid();
  }

  async writeReport(
    runId: string,
    report: ReportResult,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'write-report';
    const runDirectory = this.resolveRunDirectory(operation, runId);
    if (!runDirectory.ok) {
      return runDirectory;
    }
    if (report.runId !== runId) {
      return artifactFailure(
        operation,
        `report identity "${report.runId}" does not match run "${runId}"`,
      );
    }
    const present = await directoryExists(runDirectory.value);
    if (!present) {
      return artifactFailure(operation, `run directory for "${runId}" does not exist`);
    }
    const redacted = redactForSink(this.redact, operation, report.markdown);
    if (!redacted.ok) {
      return redacted;
    }
    // The normalized run result is a structured JSON sink: it is redacted as a
    // decoded value so numeric metrics and schema versions stay numbers.
    let normalizedValue: unknown;
    try {
      normalizedValue = JSON.parse(report.normalizedJson);
    } catch (cause) {
      return artifactFailure(
        operation,
        `normalized run result is not valid JSON: ${describeCause(cause)}`,
      );
    }
    const normalizedRedacted = redactValueForSink(this.redact, operation, normalizedValue);
    if (!normalizedRedacted.ok) {
      return normalizedRedacted;
    }
    const normalizedSerialized = serializeJsonForSink(operation, normalizedRedacted.value);
    if (!normalizedSerialized.ok) {
      return normalizedSerialized;
    }
    const written = await this.writeTextFile(
      operation,
      path.join(runDirectory.value, 'result.json'),
      normalizedSerialized.value,
    );
    if (!written.ok) {
      return written;
    }
    return this.writeTextFile(
      operation,
      path.join(runDirectory.value, REPORT_FILE),
      redacted.value,
    );
  }

  async readRunManifest(runId: string): Promise<TevuResult<RunManifest, 'ArtifactError'>> {
    const operation = 'read-run-manifest';
    const runDirectory = this.resolveRunDirectory(operation, runId);
    if (!runDirectory.ok) {
      return runDirectory;
    }
    const parsed = await readJsonFile(operation, path.join(runDirectory.value, RUN_MANIFEST_FILE));
    if (!parsed.ok) {
      return parsed;
    }
    const value = parsed.value;
    if (!isRecord(value)) {
      return artifactFailure(operation, `run record for "${runId}" is not a JSON object`);
    }
    // After finalization run.json holds the full RunResult; before it, the manifest.
    const manifest = 'manifest' in value ? value['manifest'] : value;
    const defect = describeStoredManifestDefect(manifest, runId);
    if (defect !== null) {
      return artifactFailure(operation, defect);
    }
    return { ok: true, value: manifest as RunManifest };
  }

  async readRunResult(runId: string): Promise<TevuResult<RunResult, 'ArtifactError'>> {
    const operation = 'read-run-result';
    const runDirectory = this.resolveRunDirectory(operation, runId);
    if (!runDirectory.ok) {
      return runDirectory;
    }
    const parsed = await readJsonFile(operation, path.join(runDirectory.value, RUN_MANIFEST_FILE));
    if (!parsed.ok) {
      return parsed;
    }
    const value = parsed.value;
    if (!isRecord(value)) {
      return artifactFailure(operation, `run record for "${runId}" is not a JSON object`);
    }
    if (!('manifest' in value)) {
      return artifactFailure(
        operation,
        `run "${runId}" holds only a manifest; the run was never finalized`,
      );
    }
    if (
      value['schemaVersion'] !== 1 ||
      !Array.isArray(value['cases']) ||
      typeof value['exitCode'] !== 'number'
    ) {
      return artifactFailure(operation, `run result for "${runId}" has a malformed shape`);
    }
    const defect = describeStoredManifestDefect(value['manifest'], runId);
    if (defect !== null) {
      return artifactFailure(operation, defect);
    }
    return { ok: true, value: value as unknown as RunResult };
  }

  async readCaseResult(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<CaseResult, 'ArtifactError'>> {
    const operation = 'read-case-result';
    const caseDirectory = this.resolveCaseDirectory(operation, runId, caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const parsed = await readJsonFile(operation, path.join(caseDirectory.value, CASE_FILE.result));
    if (!parsed.ok) {
      return parsed;
    }
    const value = parsed.value;
    if (
      !isRecord(value) ||
      value['schemaVersion'] !== 1 ||
      !isRecord(value['identity']) ||
      value['identity']['caseId'] !== caseId ||
      !isNonEmptyString(value['identity']['agent']) ||
      !isPositiveSafeInteger(value['identity']['attempt']) ||
      !isRecord(value['artifacts'])
    ) {
      return artifactFailure(
        operation,
        `case result for "${caseId}" in run "${runId}" has a malformed shape`,
      );
    }
    return { ok: true, value: value as unknown as CaseResult };
  }

  async readEvents(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AgentEventRecord[], 'ArtifactError'>> {
    const operation = 'read-events';
    const caseDirectory = this.resolveCaseDirectory(operation, runId, caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const filePath = path.join(caseDirectory.value, CASE_FILE.events);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (cause) {
      if (systemErrorCode(cause) === 'ENOENT') {
        return artifactFailure(
          operation,
          `events artifact is missing for case "${caseId}" in run "${runId}"`,
        );
      }
      return artifactFailure(operation, `cannot read events artifact: ${describeCause(cause)}`);
    }
    const events: AgentEventRecord[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line === '') {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return artifactFailure(
          operation,
          `stored event line ${index + 1} is not one valid JSON value`,
        );
      }
      events.push(value);
    }
    return { ok: true, value: events };
  }

  async readSessionExport(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AgentSessionExport | null, 'ArtifactError'>> {
    const operation = 'read-session-export';
    const caseDirectory = this.resolveCaseDirectory(operation, runId, caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const filePath = path.join(caseDirectory.value, CASE_FILE.sessionExport);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (cause) {
      if (systemErrorCode(cause) !== 'ENOENT') {
        return artifactFailure(operation, `cannot read session export: ${describeCause(cause)}`);
      }
      // Absent is legitimate only when the finalized case explicitly recorded
      // the export as unavailable; anything else is a missing artifact.
      const result = await this.readCaseResult(runId, caseId);
      if (!result.ok) {
        return artifactFailure(
          operation,
          `session export for "${caseId}" is absent and the case result cannot confirm it as known unavailable: ${result.error.reason}`,
        );
      }
      if (result.value.artifacts.sessionExport === null) {
        return { ok: true, value: null };
      }
      return artifactFailure(
        operation,
        `session export artifact is missing for case "${caseId}" although the case result references it`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return artifactFailure(operation, 'stored session export is not valid JSON');
    }
    if (!isRecord(value)) {
      return artifactFailure(operation, 'stored session export is not a JSON object');
    }
    return { ok: true, value };
  }

  async readChecks(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<CheckResult[], 'ArtifactError'>> {
    const operation = 'read-checks';
    const caseDirectory = this.resolveCaseDirectory(operation, runId, caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const parsed = await readJsonFile(operation, path.join(caseDirectory.value, CASE_FILE.checks));
    if (!parsed.ok) {
      return parsed;
    }
    const value = parsed.value;
    if (
      !isRecord(value) ||
      value['schemaVersion'] !== 1 ||
      value['caseId'] !== caseId ||
      !Array.isArray(value['checks']) ||
      !value['checks'].every((check) => isRecord(check) && isNonEmptyString(check['checkId']))
    ) {
      return artifactFailure(
        operation,
        `checks artifact for "${caseId}" in run "${runId}" has a malformed shape`,
      );
    }
    return { ok: true, value: value['checks'] as CheckResult[] };
  }

  async readAssessment(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentArtifact | null, 'ArtifactError'>> {
    const operation = 'read-assessment';
    const caseDirectory = this.resolveCaseDirectory(operation, runId, caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const filePath = path.join(caseDirectory.value, CASE_FILE.assessment);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (cause) {
      if (systemErrorCode(cause) === 'ENOENT') {
        // A case is legitimately unassessed until the first `tevu assess`.
        return { ok: true, value: null };
      }
      return artifactFailure(operation, `cannot read assessment artifact: ${describeCause(cause)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return artifactFailure(operation, `assessment artifact for "${caseId}" is not valid JSON`);
    }
    const defect = describeAssessmentDefect(value, runId, caseId);
    if (defect !== null) {
      return artifactFailure(operation, defect);
    }
    return { ok: true, value: value as AssessmentArtifact };
  }

  async acquireAssessmentLock(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentLock, 'AssessmentConflictError' | 'ArtifactError'>> {
    const operation = 'acquire-assessment-lock';
    const caseDirectory = this.resolveCaseDirectory(operation, runId, caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const present = await directoryExists(caseDirectory.value);
    if (!present) {
      return artifactFailure(operation, `case "${caseId}" does not exist in run "${runId}"`);
    }
    const lockPath = path.join(caseDirectory.value, ASSESSMENT_LOCK_DIRECTORY);
    try {
      await fs.mkdir(lockPath);
    } catch (cause) {
      if (systemErrorCode(cause) === 'EEXIST') {
        return {
          ok: false,
          error: {
            kind: 'AssessmentConflictError',
            runId,
            caseId,
            reason: `assessment lock already exists at "${lockPath}"; another assess may be running, or the lock is stale and must be removed by the operator`,
          },
        };
      }
      return artifactFailure(operation, `cannot create assessment lock: ${describeCause(cause)}`);
    }
    let released = false;
    return {
      ok: true,
      value: {
        runId,
        caseId,
        release: async (): Promise<TevuResult<void, 'ArtifactError'>> => {
          if (released) {
            return artifactFailure(
              'release-assessment-lock',
              'assessment lock was already released',
            );
          }
          try {
            await fs.rmdir(lockPath);
          } catch (cause) {
            return artifactFailure(
              'release-assessment-lock',
              `cannot remove assessment lock "${lockPath}": ${describeCause(cause)}`,
            );
          }
          released = true;
          return okVoid();
        },
      },
    };
  }

  async replaceAssessment(
    artifact: AssessmentArtifact,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const operation = 'replace-assessment';
    const defect = describeAssessmentDefect(artifact, artifact.runId, artifact.caseId);
    if (defect !== null) {
      return artifactFailure(operation, defect);
    }
    const caseDirectory = this.resolveCaseDirectory(operation, artifact.runId, artifact.caseId);
    if (!caseDirectory.ok) {
      return caseDirectory;
    }
    const present = await directoryExists(caseDirectory.value);
    if (!present) {
      return artifactFailure(
        operation,
        `case "${artifact.caseId}" does not exist in run "${artifact.runId}"`,
      );
    }
    return this.writeJsonSink(operation, caseDirectory.value, CASE_FILE.assessment, artifact);
  }

  private requireActiveCase(
    operation: string,
    caseId: string,
  ): TevuResult<{ runId: string; directory: string }, 'ArtifactError'> {
    if (this.activeRun === null) {
      return artifactFailure(operation, 'no run is active; startRun must succeed first');
    }
    const directory = this.activeRun.caseDirectories.get(caseId);
    if (directory === undefined) {
      return artifactFailure(
        operation,
        `case "${caseId}" is not part of active run "${this.activeRun.runId}"`,
      );
    }
    return { ok: true, value: { runId: this.activeRun.runId, directory } };
  }

  private resolveRunDirectory(
    operation: string,
    runId: string,
  ): TevuResult<string, 'ArtifactError'> {
    if (!RUN_ID_PATTERN.test(runId)) {
      return artifactFailure(operation, `run ID "${runId}" is not a valid identifier`);
    }
    return { ok: true, value: path.join(this.root, runId) };
  }

  private resolveCaseDirectory(
    operation: string,
    runId: string,
    caseId: string,
  ): TevuResult<string, 'ArtifactError'> {
    const runDirectory = this.resolveRunDirectory(operation, runId);
    if (!runDirectory.ok) {
      return runDirectory;
    }
    if (!CASE_ID_PATTERN.test(caseId)) {
      return artifactFailure(operation, `case ID "${caseId}" is not a valid identifier`);
    }
    return { ok: true, value: path.join(runDirectory.value, CASES_DIRECTORY, caseId) };
  }

  private async writeJsonSink(
    operation: string,
    directory: string,
    fileName: string,
    value: unknown,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const redacted = redactValueForSink(this.redact, operation, value);
    if (!redacted.ok) {
      return redacted;
    }
    const serialized = serializeJsonForSink(operation, redacted.value);
    if (!serialized.ok) {
      return serialized;
    }
    return this.writeTextFile(operation, path.join(directory, fileName), serialized.value);
  }

  private async writeTextFile(
    operation: string,
    filePath: string,
    content: string,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    try {
      await atomicReplaceFile(filePath, content);
    } catch (cause) {
      return artifactFailure(
        operation,
        `cannot atomically write "${filePath}": ${describeCause(cause)}`,
      );
    }
    return okVoid();
  }

  private queueManifestWrite(
    filePath: string,
    content: string,
    operation: string,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const task = this.manifestChain.then(() => atomicReplaceFile(filePath, content));
    this.manifestChain = task.catch(() => undefined);
    return task.then(
      () => okVoid(),
      (cause) => artifactFailure(operation, `cannot write run manifest: ${describeCause(cause)}`),
    );
  }

  private queueAppend(
    filePath: string,
    text: string,
    operation: string,
  ): Promise<TevuResult<void, 'ArtifactError'>> {
    const previous = this.appendChains.get(filePath) ?? Promise.resolve();
    const task = previous.then(() => fs.appendFile(filePath, text, 'utf8'));
    this.appendChains.set(
      filePath,
      task.catch(() => undefined),
    );
    return task.then(
      () => okVoid(),
      (cause) =>
        artifactFailure(operation, `cannot append to "${filePath}": ${describeCause(cause)}`),
    );
  }
}

function okVoid(): { ok: true; value: void } {
  return { ok: true, value: undefined };
}

function artifactFailure(
  operation: string,
  reason: string,
): { ok: false; error: Extract<TevuError, { kind: 'ArtifactError' }> } {
  return { ok: false, error: { kind: 'ArtifactError', operation, reason } };
}

function systemErrorCode(cause: unknown): string | null {
  if (isRecord(cause) && typeof cause['code'] === 'string') {
    return cause['code'];
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function serializeJsonForSink(
  operation: string,
  value: unknown,
): TevuResult<string, 'ArtifactError'> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (cause) {
    return artifactFailure(operation, `cannot serialize artifact JSON: ${describeCause(cause)}`);
  }
  if (typeof serialized !== 'string') {
    return artifactFailure(operation, 'artifact serialized to no JSON value');
  }
  return { ok: true, value: `${serialized}\n` };
}

function redactForSink(
  redact: Redactor,
  operation: string,
  text: string,
): TevuResult<string, 'ArtifactError'> {
  let redacted: string;
  try {
    redacted = redact(text);
  } catch (cause) {
    return artifactFailure(operation, `redaction failed; write aborted: ${describeCause(cause)}`);
  }
  // The redactor is injected; a non-string result must fail closed, never sink raw text.
  if (typeof (redacted as unknown) !== 'string') {
    return artifactFailure(operation, 'redaction returned no text; write aborted');
  }
  return { ok: true, value: redacted };
}

function redactValueForSink(
  redact: Redactor,
  operation: string,
  value: unknown,
): TevuResult<unknown, 'ArtifactError'> {
  const result = redactDecodedValue(redact, value);
  if (result.ok) {
    return { ok: true, value: result.value };
  }
  return artifactFailure(operation, `redaction failed; write aborted: ${result.error.reason}`);
}

async function readJsonFile(
  operation: string,
  filePath: string,
): Promise<TevuResult<unknown, 'ArtifactError'>> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    if (systemErrorCode(cause) === 'ENOENT') {
      return artifactFailure(operation, `artifact "${filePath}" is missing`);
    }
    return artifactFailure(operation, `cannot read "${filePath}": ${describeCause(cause)}`);
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return artifactFailure(operation, `artifact "${filePath}" is not valid JSON`);
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stats = await fs.stat(directory);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Replaces the target atomically: exclusive temp file in the same directory,
 * fsync, then rename over the target. A failure never leaves a partial target.
 *
 * @param mode - Permission bits for the temporary (and so the final) file;
 * defaults to `0o644` under the process umask for a brand-new target (E4).
 */
async function atomicReplaceFile(
  filePath: string,
  content: string,
  preservedMode?: number,
): Promise<void> {
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tempPath, 'wx', preservedMode ?? 0o644);
  try {
    // The open mode is filtered by the umask, so a preserved mode needs an explicit chmod.
    if (preservedMode !== undefined) {
      await handle.chmod(preservedMode);
    }
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, filePath);
  } catch (cause) {
    await fs.rm(tempPath, { force: true });
    throw cause;
  }
}

/** Holds when `value` is a whole, non-negative-overflowing number of at least 1. */
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** Holds for a record whose `value` passes {@link isPositiveSafeInteger} and whose `source` is `"config"` or `"cli"`. */
function isRepeatSetting(value: unknown): value is RepeatSetting {
  return (
    isRecord(value) &&
    isPositiveSafeInteger(value['value']) &&
    (value['source'] === 'config' || value['source'] === 'cli')
  );
}

function describeManifestDefect(manifest: RunManifest): string | null {
  if (manifest.schemaVersion !== 1) {
    return 'run manifest schemaVersion must be 1';
  }
  if (!RUN_ID_PATTERN.test(manifest.runId)) {
    return `run ID "${manifest.runId}" is not a valid identifier`;
  }
  if (!isRepeatSetting(manifest.execution.repeat)) {
    return 'run manifest execution.repeat must be a whole number of at least 1 with source "config" or "cli"';
  }
  const seen = new Set<string>();
  for (const identity of manifest.cases) {
    if (!CASE_ID_PATTERN.test(identity.caseId)) {
      return `case ID "${identity.caseId}" is not a valid identifier`;
    }
    if (!isPositiveSafeInteger(identity.attempt)) {
      return `case "${identity.caseId}" attempt must be a whole number of at least 1`;
    }
    if (identity.caseId !== `${identity.taskId}--${identity.modelId}--${identity.attempt}`) {
      return `case ID "${identity.caseId}" does not equal "<task-id>--<model-id>--<attempt>"`;
    }
    if (seen.has(identity.caseId)) {
      return `case ID "${identity.caseId}" appears more than once`;
    }
    seen.add(identity.caseId);
  }
  return null;
}

function describeStoredManifestDefect(manifest: unknown, runId: string): string | null {
  if (
    !isRecord(manifest) ||
    manifest['schemaVersion'] !== 1 ||
    manifest['runId'] !== runId ||
    !Array.isArray(manifest['cases']) ||
    !isRecord(manifest['tools']) ||
    !isRecord(manifest['tools']['agentVersions']) ||
    !isRecord(manifest['execution']) ||
    !isRepeatSetting(manifest['execution']['repeat'])
  ) {
    return `stored manifest for run "${runId}" has a malformed shape or mismatched identity`;
  }
  return null;
}

function describeAssessmentDefect(value: unknown, runId: string, caseId: string): string | null {
  if (!isRecord(value)) {
    return `assessment artifact for "${caseId}" is not a JSON object`;
  }
  if (
    value['schemaVersion'] !== 1 ||
    value['runId'] !== runId ||
    value['caseId'] !== caseId ||
    !Number.isInteger(value['revision']) ||
    (value['revision'] as number) < 1 ||
    !Array.isArray(value['current']) ||
    !Array.isArray(value['history']) ||
    !value['current'].every((record) => isRecord(record) && isNonEmptyString(record['checkId'])) ||
    !value['history'].every(
      (record) =>
        isRecord(record) &&
        isNonEmptyString(record['checkId']) &&
        isNonEmptyString(record['replacedAt']),
    )
  ) {
    return `assessment artifact for "${caseId}" in run "${runId}" has a malformed shape or mismatched identity`;
  }
  return null;
}
