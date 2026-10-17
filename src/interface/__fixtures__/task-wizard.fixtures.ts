import { vi } from 'vitest';

import { FAKE_AGENT_NAME } from '@/config/__fixtures__/config.fixtures';
import { renderConfigDocument } from '@/config/document';
import { parseConfigText } from '@/config/load';

import { buildCliConfig, createOperations } from './program.fixtures';

import type { ProgramOperations } from './program.fixtures';
import type { TaskWizardInput } from '@/application/create-task';
import type { CriteriaDraftFailure } from '@/application/draft-criteria';
import type { ModelAccessOutcome } from '@/application/model-access';
import type { TevuConfig } from '@/domain/config';
import type { OperatorProvider } from '@/domain/ports/agent';

export function requireCreateTaskCall(operations: ProgramOperations): TaskWizardInput {
  const call = vi.mocked(operations.createTask).mock.calls[0]?.[0];
  if (call === undefined) {
    throw new Error('expected createTask to have captured one call');
  }
  return call;
}

/**
 * Renders the bootstrap answers and interviewed task through the real
 * document writer, then re-parses the result with the real config parser -
 * the same round trip `createTask` performs before its only write.
 */
export function renderAndParseBootstrap(call: TaskWizardInput): TevuConfig {
  if (call.bootstrap === undefined) {
    throw new Error('expected the captured createTask call to carry bootstrap answers');
  }
  const rendered = renderConfigDocument(
    { version: 1, ...call.bootstrap, tasks: [call.task] },
    { redact: (text) => text },
  );
  if (!rendered.ok) {
    throw new Error(`expected renderConfigDocument to succeed: ${JSON.stringify(rendered.error)}`);
  }
  const parsed = parseConfigText(rendered.value);
  if (!parsed.ok) {
    throw new Error(`expected the written configuration to parse: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

export function taskInterviewAnswers(repositoryChoice: string): unknown[] {
  return [
    'manual',
    repositoryChoice,
    '',
    'abc123',
    'Add an export button',
    'Export the current view as CSV.',
    'Implement CSV export for the current view.',
    'Repository is readable',
    false,
    'manual',
    'Export produces a CSV',
    true,
    false,
    'manual',
    'README documents the button',
    true,
    false,
  ];
}

export const EXIT_QUESTION =
  'Exit without saving? Every answer so far is lost, and tevu.yaml stays unchanged.';

export const EXIT_QUESTION_NEW_FILE =
  'Exit without saving? Every answer so far is lost, and tevu.yaml is not created.';

export const EXIT_QUESTION_WITH_DRAFT =
  'Exit without saving? Every answer so far is lost, including the criteria draft, and tevu.yaml stays unchanged.';

export const REFERENCE_HASH = '0123456789abcdef0123456789abcdef01234567';

const REFERENCE_PARENT = 'fedcba9876543210fedcba9876543210fedcba98';

/** A configuration whose `roles.criteria` is declared. */
export function buildCriteriaConfig(): TevuConfig {
  return {
    ...buildCliConfig(),
    roles: {
      criteria: { model: 'openai/criteria-model', effort: 'high', agent: FAKE_AGENT_NAME },
    },
  };
}

export function buildResolvedCommitReference(): {
  reference: { kind: 'commit'; identifier: string; commits: [string] };
  proposedBase: { commit: string; basis: 'commit-parent' };
} {
  return {
    reference: { kind: 'commit', identifier: 'HEAD~3', commits: [REFERENCE_HASH] },
    proposedBase: { commit: REFERENCE_PARENT, basis: 'commit-parent' },
  };
}

/** Answers every task question from the source through the readiness list when a reference resolves. */
export const READY_ANSWERS = [
  'manual',
  'repo-1',
  'HEAD~3',
  '',
  'Add an export button',
  'Export the current view as CSV.',
  'Implement CSV export for the current view.',
  'Repository is readable',
  false,
];

/** Answers every setup question up to and including "Add another model?" without typing the defaults. */
export const BOOTSTRAP_ANSWERS: unknown[] = [
  '/tmp/bench-artifacts',
  '4',
  '10m',
  '5s',
  '',
  'opencode',
  '',
  '',
  false,
  'path',
  '../repos/alpha',
  false,
  'provider/model-a',
  'high',
  'provider/model-b',
  'low',
  false,
];

/** The failed-draft causes with the lines the wizard prints after its headline and before its last line. */
export const DRAFT_FAILURE_CASES: Array<{
  name: string;
  failure: CriteriaDraftFailure;
  lines: string[];
  /** Whether the wizard offers `Draft the criteria again?` for this cause. */
  retryable: boolean;
}> = [
  {
    name: 'unreadable changes',
    failure: { cause: 'changes-unreadable', detail: 'git-diff: bad object' },
    lines: ["The reference solution's changes can't be read.", 'git-diff: bad object'],
    retryable: true,
  },
  {
    name: 'an unredactable prompt',
    failure: { cause: 'prompt-unredactable' },
    lines: ["The prompt couldn't be redacted, so the model wasn't called."],
    retryable: false,
  },
  {
    name: 'one unset variable',
    failure: { cause: 'variables-unset', names: ['ACME_KEY'] },
    lines: ["ACME_KEY isn't set in this terminal."],
    retryable: false,
  },
  {
    name: 'several unset variables',
    failure: { cause: 'variables-unset', names: ['ACME_KEY', 'ACME_BASE'] },
    lines: ["ACME_KEY, ACME_BASE aren't set in this terminal."],
    retryable: false,
  },
  {
    name: "the operator's model missing from the environment",
    failure: { cause: 'model-unavailable', model: 'litellm/anthropic/claude-opus-5' },
    lines: [
      "OpenCode can't find litellm/anthropic/claude-opus-5 in tevu's environment.",
      'Add its provider to agents.opencode.providers in tevu.yaml.',
    ],
    retryable: false,
  },
  {
    name: 'an effort the model has no variant for',
    failure: {
      cause: 'effort-unsupported',
      model: 'openai/criteria-model',
      effort: 'hihg',
      variants: ['high', 'low'],
    },
    lines: [
      'Criteria effort "hihg" is not a variant OpenCode reports for openai/criteria-model.',
      'Its variants: high, low.',
      'Set roles.criteria.effort in tevu.yaml to one of them.',
    ],
    retryable: false,
  },
  {
    name: 'a timeout',
    failure: { cause: 'timed-out', limit: '10m' },
    lines: ["The model didn't answer within 10m."],
    retryable: true,
  },
  {
    name: 'a failure that carries the agent message',
    failure: {
      cause: 'call-failed',
      agentMessage: 'Unexpected server error. Check server logs for details.',
      detail: 'run process exited with code 1: Unexpected server error.',
    },
    lines: ['OpenCode reported "Unexpected server error. Check server logs for details.".'],
    retryable: true,
  },
  {
    name: 'a failure without an agent message',
    failure: { cause: 'call-failed', detail: 'ModelCallError (failed): synthetic failure' },
    lines: ['The OpenCode call failed.', 'ModelCallError (failed): synthetic failure'],
    retryable: true,
  },
  {
    name: 'an invalid reply',
    failure: { cause: 'reply-invalid', defect: 'done is not an array' },
    lines: ["The model's reply wasn't a usable list."],
    retryable: true,
  },
];

export function draftFailureMessage(lines: readonly string[], retryable = false): string {
  const nextStep = retryable
    ? 'Press Enter to draft again, or choose No to enter the criteria yourself.'
    : 'Enter the criteria yourself.';
  return ["Couldn't draft criteria.", ...lines, nextStep].join('\n');
}

/**
 * The setup answers from the first question through "Add another model?".
 * An option replaces the answers its question consumes, so a test can script
 * an extra answer (a retry, a key variable) where the interview asks for it.
 */
export function setupAnswers(
  options: {
    command?: readonly unknown[];
    secrets?: string;
    env?: string;
    jira?: readonly unknown[];
    firstModel?: readonly unknown[];
    secondModel?: readonly unknown[];
  } = {},
): unknown[] {
  return [
    ...BOOTSTRAP_ANSWERS.slice(0, 5),
    ...(options.command ?? ['opencode']),
    options.secrets ?? '',
    options.env ?? '',
    ...(options.jira ?? [false]),
    ...BOOTSTRAP_ANSWERS.slice(9, 12),
    ...(options.firstModel ?? ['provider/model-a']),
    'high',
    ...(options.secondModel ?? ['provider/model-b']),
    'low',
    false,
  ];
}

/** A complete setup and task interview that declines both roles and saves. */
export function fullSetupAnswers(options: Parameters<typeof setupAnswers>[0] = {}): unknown[] {
  return [...setupAnswers(options), false, false, ...taskInterviewAnswers('alpha'), true];
}

export function operationsWithModelCheck(
  overrides: Partial<ProgramOperations> = {},
): ProgramOperations {
  return createOperations({ configExists: vi.fn(async () => false), ...overrides });
}

export function definedProvider(
  overrides: Partial<Extract<OperatorProvider, { defined: true }>> = {},
): OperatorProvider {
  return { defined: true, keyVariables: [], otherVariables: [], apiKey: 'absent', ...overrides };
}

/** Answers `inspectModelProvider` from a table keyed by provider; an absent provider is undefined. */
export function inspectingProviders(
  definitions: Record<string, OperatorProvider>,
): ProgramOperations['inspectModelProvider'] {
  return vi.fn<ProgramOperations['inspectModelProvider']>(async (_configPath, _agent, model) => {
    const provider = model.slice(0, model.indexOf('/'));
    return {
      ok: true as const,
      value: { provider, definition: definitions[provider] ?? { defined: false as const } },
    };
  });
}

export function accessOutcome(
  status: 'listed' | 'not-listed',
  overrides: { unsetVariables?: string[]; retainedDirectory?: string | null } = {},
): ModelAccessOutcome {
  const fields = { unsetVariables: [], retainedDirectory: null, ...overrides };
  return status === 'listed' ? { status, variants: null, ...fields } : { status, ...fields };
}

/** Operations for a configuration that declares `roles.criteria` and a reference that resolves and drafts. */
export function criteriaOperations(overrides: Partial<ProgramOperations> = {}): ProgramOperations {
  return createOperations({
    loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
    resolveReference: vi.fn(async () => ({
      ok: true as const,
      value: buildResolvedCommitReference(),
    })),
    draftCriteria: vi.fn(async () => ({
      status: 'drafted' as const,
      effort: { status: 'verified' as const },
      draft: { acceptance: ['a'], done: ['d'] },
      retainedDirectories: [],
    })),
    ...overrides,
  });
}
