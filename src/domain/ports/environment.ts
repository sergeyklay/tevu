/** The `EnvironmentAdapter` contract, with the request and result shapes only it uses. */

import type { CaseWorkspace } from './git-workspace';
import type { TevuResult } from '@/domain/errors';
import type { EnvironmentVariableRecord } from '@/domain/run-records';

/** One file an agent adapter places in an agent home before the agent starts. */
export type AgentConfigurationFile = {
  /** Relative to the home's XDG_CONFIG_HOME; never empty, absolute, or with a `..` segment. */
  relativePath: string;
  /** Complete UTF-8 content. */
  text: string;
};

/** Complete replacement environment for one case recipient, plus its value-free manifest. */
export type IsolatedEnvironment = {
  caseId: string;
  recipient: 'agent' | 'evaluator';
  homeDirectory: string;
  temporaryDirectory: string;
  variables: Record<string, string>;
  variableManifest: EnvironmentVariableRecord[];
};

/** Immutable run-level snapshot of the parent PATH and configured variable values. */
export type ParentEnvironmentSnapshot = {
  path: string;
  agentValues: Record<string, string>;
  ordinaryEvaluatorValues: Record<string, string>;
  secretValues: string[];
};

/** Which environment variable names reach each recipient; never carries values. */
export type EnvironmentVariableNames = {
  /** One entry per `agents.<name>` block in configuration key order; each list in configuration order. */
  agents: Readonly<Record<string, { secrets: readonly string[]; env: readonly string[] }>>;
  /** Exactly `evaluatorEnvironmentNames(config)`, in its order. */
  ordinaryEvaluator: readonly string[];
  /** The variable `trackers.jira.token` references; the key is absent without a Jira tracker. */
  jiraTokenVariable?: string;
};

/** Agent and evaluator replacement environments for one case. */
export type CaseEnvironments = {
  agent: IsolatedEnvironment;
  evaluator: IsolatedEnvironment;
};

/** Paths and replacement variables of one model call; removed by `dispose`. */
export interface ModelCallEnvironment {
  rootDirectory: string;
  /** `<root>/work`, empty when created; the agent's working directory once `initializeEmptyRepository` makes it a Git top level. */
  workingDirectory: string;
  /** `<root>/agent/home`; the value of HOME and the `export` working directory. */
  homeDirectory: string;
  variables: Record<string, string>;
  /** Removes `rootDirectory` recursively; succeeds when it no longer exists. */
  dispose(): Promise<TevuResult<void, 'ArtifactError'>>;
}

/** Builds the run-level parent snapshot and per-case isolated replacement environments. */
export interface EnvironmentAdapter {
  snapshotParent(
    names: EnvironmentVariableNames,
  ): TevuResult<ParentEnvironmentSnapshot, 'PrerequisiteError'>;
  /** The names in `names` that tevu's own environment leaves unset, in input order. */
  unsetVariables(names: readonly string[]): string[];
  createCaseEnvironments(
    workspace: CaseWorkspace,
    snapshot: ParentEnvironmentSnapshot,
    names: EnvironmentVariableNames,
    agent: string,
    configurationFiles: readonly AgentConfigurationFile[],
  ): Promise<TevuResult<CaseEnvironments, 'IsolationError'>>;
  createModelCallEnvironment(
    snapshot: ParentEnvironmentSnapshot,
    agentVariables: { secrets: readonly string[]; env: readonly string[] },
    configurationFiles: readonly AgentConfigurationFile[],
  ): Promise<TevuResult<ModelCallEnvironment, 'ArtifactError'>>;
}
