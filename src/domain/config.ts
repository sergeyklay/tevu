/** The resolved configuration model. */

/** Settings shared by every benchmark case. */
type RunSettings = {
  output_dir: string;
  concurrency: number;
  repeat: number;
  timeout: string;
  stop_grace: string;
  check_timeout?: string;
};

/** One provider an agent block copies from the operator's configuration of that agent. */
export type AgentProviderSetting = {
  /** Key of the provider in that configuration's `provider` map. */
  id: string;
  /** A name from the same block's `secrets`, written as the provider's API key. */
  api_key?: string;
};

/** Parsed agent block settings; `secrets`, `env`, and `providers` default to `[]`. */
type AgentSettings = {
  command: string;
  secrets: string[];
  env: string[];
  providers: AgentProviderSetting[];
};

/** Parsed Jira Cloud connection settings. */
export type JiraTrackerSettings = {
  url: string;
  email: string;
  token: string;
};

/** One repository setup command: executable and literal arguments, no shell; the array form of a check's `run`. */
export type SetupCommand = [string, ...string[]];

/** A repository's setup block; a phase key is present only when its list holds at least one command. */
export interface RepositorySetup {
  before_agent?: SetupCommand[];
  before_checks?: SetupCommand[];
  timeout: string;
  env: string[];
}

/** One configured source repository. */
export type RepositoryDefinition = {
  id: string;
  /** Path entry: the repository. GitHub entry: its managed clone. Relative to its base until `resolveConfig`, then absolute. */
  path: string;
  /** Present exactly for a GitHub entry: the `github` value as written. */
  github?: string;
  setup?: RepositorySetup;
};

/** One resolved benchmark model entry: what the benchmark compares. */
export interface ModelDefinition {
  id: string;
  model: `${string}/${string}`;
  effort: string;
  agent: string;
}

/** A model role a configuration may declare under `roles`. */
export type ModelRoleName = 'criteria' | 'grader' | 'summary';

/** One resolved model role: a model entry without `id`, with `agent` materialized. */
export type ModelRole = Omit<ModelDefinition, 'id'>;

/** One-time tracker import snapshot stored on a task. */
type ImportedTaskSource = {
  kind: 'jira' | 'github';
  key: string;
  url: string;
  imported_at: string;
  title: string;
  body: string;
};

/** A task's reference solution, read once by `tevu task add`; field contract in the configuration reference. */
export type TaskReference =
  | { kind: 'pull-request'; identifier: string; commits: string[]; merge_commit?: string }
  | { kind: 'commit'; identifier: string; commits: [string] };

/**
 * A command check's resolved shape with every default materialized. `run` is
 * either a command line that `/bin/sh -c` runs, or an executable followed by
 * literal arguments that run without a shell.
 */
export interface CommandCheck {
  id: string;
  description: string;
  run: string | [string, ...string[]];
  timeout: string;
  exit_codes: number[];
  env: string[];
  required: boolean;
}

/** A manual check's resolved shape: assessed by a human through `tevu assess`. */
interface ManualCheck {
  id: string;
  description: string;
  manual: true;
  required: boolean;
}

/** A graded check's resolved shape: graded by `roles.grader` against its description. */
interface GradedCheck {
  id: string;
  description: string;
  required: boolean;
}

/** One acceptance or done check: a command check, a manual check, or a graded check. */
export type CheckDefinition = CommandCheck | ManualCheck | GradedCheck;

/** Which evaluator resolves one check's verdict. */
export type CheckEvaluator = 'command' | 'manual' | 'grader';

/** Which check collection a check belongs to. */
export type CheckCategory = 'acceptance' | 'definition-of-done';

/** Resolves a live check definition's evaluator: `manual` when declared, `command` when it has `run`, `grader` otherwise. */
export function checkEvaluator(check: CheckDefinition): CheckEvaluator {
  if ('run' in check) {
    return 'command';
  }
  if ('manual' in check) {
    return 'manual';
  }
  return 'grader';
}

/** One resolved acceptance-driven benchmark task pinned to a repository commit. */
export interface TaskDefinition {
  id: string;
  title: string;
  repo: string;
  base_commit: string;
  /** Present only when the file declares it: the agent time limit of every case of this task, replacing `run.timeout`. */
  timeout?: string;
  prompt: string;
  description: string;
  source?: ImportedTaskSource;
  reference?: TaskReference;
  readiness: string[];
  checks: {
    /** Present only when the file declares it; `[]` declares nothing to restore. */
    restore?: string[];
    /** Present only when the file declares it; absolute after `resolveConfig`. */
    overlay?: string;
    acceptance: CheckDefinition[];
    done: CheckDefinition[];
  };
}

/** One resolved tevu configuration: every default materialized, ready for its consumers. */
export interface TevuConfig {
  version: 1;
  run: RunSettings;
  agents: Record<string, AgentSettings>;
  trackers?: { jira?: JiraTrackerSettings };
  repositories: RepositoryDefinition[];
  models: ModelDefinition[];
  /** Present only when the file declares `roles`; each key only when declared. */
  roles?: Partial<Record<ModelRoleName, ModelRole>>;
  tasks: TaskDefinition[];
}

/** A repository setup phase, named by its configuration key. */
export type SetupPhase = 'before_agent' | 'before_checks';
