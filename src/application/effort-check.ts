/**
 * Effort checks: compares each requested `effort` with the variants an agent
 * reports for its model, and builds the findings and the checks a run records.
 * Pure: reads no clock, no environment, and no file.
 *
 * Entry points: {@link checkEfforts} for a whole configuration and
 * {@link checkRoleEffort} for one model call, where no repository exists.
 */

import { gradedChecksOf } from '@/evaluation/grading';

import type {
  EffortCheck,
  EffortChecks,
  ModelListing,
  ModelRoleName,
  TevuConfig,
  ValidationFinding,
} from '@/domain/types';

/** What one listing told about one model. */
export type ModelVariantEvidence =
  | { kind: 'no-listing' }
  | { kind: 'not-listed' }
  | { kind: 'listed'; variants: readonly string[] | null };

type EffortCheckInput = {
  config: TevuConfig;
  /** Per agent name, its listing when it settled as `listed`. */
  listings: ReadonlyMap<string, Extract<ModelListing, { outcome: 'listed' }>>;
  /** Per agent name, its adapter's `repositoryConfigurationEntries()`. */
  repositoryConfigurationEntries: ReadonlyMap<string, readonly string[]>;
  /** Per task ID, `SourceValidation.rootEntries` of its base commit; a task without a key was not inspected. */
  rootEntries: ReadonlyMap<string, readonly string[]>;
};

type EffortSubject = { model: string; agent: string; command: string; effort: string };

const ROLE_NAMES = ['criteria', 'grader', 'summary'] as const;

/**
 * Checks one role's effort where no repository exists, as in a model call.
 *
 * An effort outside the reported variants is `unsupported`; an effort the
 * evidence cannot decide is `unverified`.
 */
export function checkRoleEffort(request: {
  role: ModelRoleName;
  agent: string;
  command: string;
  model: string;
  effort: string;
  evidence: ModelVariantEvidence;
}): EffortCheck {
  const { role, evidence, ...subject } = request;
  return checkAgainstEvidence(subject, evidence, (variants) => ({
    status: 'unsupported',
    reason: callReason(subject, role, variants),
  }));
}

/**
 * Checks every configured model entry and declared role and builds their findings.
 *
 * Findings follow configuration order: model entries, then `roles.criteria`,
 * `roles.grader`, and `roles.summary`. Only a `roles.grader` finding can be an
 * error, and only when a task declares a graded check.
 */
export function checkEfforts(input: EffortCheckInput): {
  checks: EffortChecks;
  findings: ValidationFinding[];
} {
  const { config, listings } = input;
  const findings: ValidationFinding[] = [];
  const models: Record<string, EffortCheck> = {};
  for (const entry of config.models) {
    const subject = subjectOf(config, entry);
    const evidence = evidenceOf(listings.get(entry.agent), entry.model);
    const check = checkAgainstEvidence(subject, evidence, (variants) =>
      checkEntryAgainstRepositories(input, subject, variants),
    );
    models[entry.id] = check;
    const finding = effortFinding(`models.${entry.id}.effort`, check, evidence, true);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }

  const hasGradedCheck = config.tasks.some((task) => gradedChecksOf(task).length > 0);
  const roles: EffortChecks['roles'] = {};
  for (const roleName of ROLE_NAMES) {
    const role = config.roles?.[roleName];
    if (role === undefined) {
      continue;
    }
    const subject = subjectOf(config, role);
    const evidence = evidenceOf(listings.get(role.agent), role.model);
    const check = checkRoleEffort({ role: roleName, ...subject, evidence });
    roles[roleName] = check;
    const canBlock = roleName === 'grader' && hasGradedCheck;
    const finding = effortFinding(`roles.${roleName}.effort`, check, evidence, canBlock);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }
  return { checks: { models, roles }, findings };
}

function subjectOf(
  config: TevuConfig,
  holder: { model: string; agent: string; effort: string },
): EffortSubject {
  return {
    model: holder.model,
    agent: holder.agent,
    command: config.agents[holder.agent]?.command ?? holder.agent,
    effort: holder.effort,
  };
}

function evidenceOf(
  listing: Extract<ModelListing, { outcome: 'listed' }> | undefined,
  model: string,
): ModelVariantEvidence {
  if (listing === undefined) {
    return { kind: 'no-listing' };
  }
  if (!listing.models.includes(model)) {
    return { kind: 'not-listed' };
  }
  return { kind: 'listed', variants: listing.variants.get(model) ?? null };
}

/**
 * Decides every row the two decision tables share: no listing, an unlisted
 * model, missing variant data, and a verified effort. `onUnreported` decides
 * an effort the listing reports no variant for.
 */
function checkAgainstEvidence(
  subject: EffortSubject,
  evidence: ModelVariantEvidence,
  onUnreported: (variants: readonly string[]) => EffortCheck,
): EffortCheck {
  const { model, agent, command, effort } = subject;
  switch (evidence.kind) {
    case 'no-listing':
      return {
        status: 'unverified',
        reason: `the variants of "${model}" were not read because agent "${agent}" produced no model listing`,
      };
    case 'not-listed':
      return {
        status: 'unverified',
        reason: `the variants of "${model}" were not read because agent "${agent}" does not list "${model}"`,
      };
    case 'listed':
      if (evidence.variants === null) {
        return {
          status: 'unverified',
          reason: `"${command} models --verbose" reports no variant data for "${model}", so effort "${effort}" is used as requested without verification; "${command}" applies no variant options when "${model}" has no variant of that name`,
        };
      }
      return evidence.variants.includes(effort)
        ? { status: 'verified' }
        : onUnreported(evidence.variants);
  }
}

/**
 * Decides a model entry whose effort is not among the reported variants: a
 * task without agent configuration at the root of its base commit runs the
 * model with default options, and any other task's repository may define it.
 */
function checkEntryAgainstRepositories(
  input: EffortCheckInput,
  subject: EffortSubject,
  variants: readonly string[],
): EffortCheck {
  const agentEntries = input.repositoryConfigurationEntries.get(subject.agent) ?? [];
  const uncovered: string[] = [];
  const undecided: string[] = [];
  for (const task of input.config.tasks) {
    const rootEntries = input.rootEntries.get(task.id);
    if (rootEntries === undefined) {
      undecided.push(`${task.id} (base commit not inspected)`);
      continue;
    }
    const configuration = rootEntries.filter((name) => agentEntries.includes(name)).sort();
    if (configuration.length === 0) {
      uncovered.push(task.id);
    } else {
      undecided.push(`${task.id} (${configuration.join(', ')})`);
    }
  }
  const { model, command } = subject;
  if (uncovered.length > 0) {
    const verb = variants.length > 0 ? 'would run' : 'run';
    return {
      status: 'unsupported',
      reason: `${unreportedClause(subject, variants)}, and these tasks have no agent configuration at the root of their base commit: ${uncovered.join(', ')}; their cases ${verb} "${model}" with its default options`,
    };
  }
  return {
    status: 'unverified',
    reason: `${unreportedClause(subject, variants)} without a task repository, and the repository of each task may define it: ${undecided.join(', ')}; it is used as requested without verification, and "${command}" applies no variant options when "${model}" has no variant of that name`,
  };
}

function callReason(
  subject: EffortSubject,
  role: ModelRoleName,
  variants: readonly string[],
): string {
  const verb = variants.length > 0 ? 'would run' : 'runs';
  return `${unreportedClause(subject, variants)}, so a ${role} call ${verb} "${subject.model}" with its default options`;
}

function unreportedClause(subject: EffortSubject, variants: readonly string[]): string {
  const { model, command, effort } = subject;
  return variants.length > 0
    ? `"${effort}" is not among the variants "${command} models --verbose" reports for "${model}" (${variants.join(', ')})`
    : `"${command} models --verbose" reports no variants for "${model}", so effort "${effort}" selects none`;
}

/**
 * The finding of one check, or `undefined` when it raises none: a verified
 * effort, and an undecided one whose listing failed or lacks the model, whose
 * cause is already an error finding. An effort outside a non-empty variant
 * list is an error only where `canBlock` holds.
 */
function effortFinding(
  identifier: string,
  check: EffortCheck,
  evidence: ModelVariantEvidence,
  canBlock: boolean,
): ValidationFinding | undefined {
  if (check.status === 'verified' || evidence.kind !== 'listed') {
    return undefined;
  }
  const hasVariants = evidence.variants !== null && evidence.variants.length > 0;
  const isBlocking = check.status === 'unsupported' && canBlock && hasVariants;
  return { severity: isBlocking ? 'error' : 'warning', identifier, message: check.reason };
}
