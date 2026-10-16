/**
 * Model entries, model roles, and their model checks.
 */

import { log } from '@clack/prompts';

import { ModelIdentifierSchema } from '@/config/schema';
import { isFixedEnvironmentName } from '@/domain/fixed-environment';
import { deriveModelEntryId } from '@/interface/derived-identifiers';
import {
  askConfirm,
  askDefaultedText,
  askText,
  promptOptions,
  WizardCancelledError,
} from '@/interface/wizard-questions';
import {
  validateModel,
  validateNonWhitespace,
  validateVariableName,
  validateVariableNameGrammar,
} from '@/interface/wizard-validators';

import { describeUnsetNames, RETRY_NEXT_STEP, warnLines, warnRetainedDirectory } from './shared';
import { runWait, runWaitReporting } from './wait';

import type { TaskWizardDependencies } from './shared';
import type { ModelDefinitionInput } from '@/config/schema';
import type { AgentProviderSetting } from '@/domain/config';
import type { ValidationFinding } from '@/domain/errors';
import type { WizardIo } from '@/interface/wizard-questions';

/** One role's setup-interview texts and effort default. */
type ModelRoleQuestionText = {
  confirm: string;
  modelQuestion: string;
  effortQuestion: string;
  defaultEffort: string;
};

const MODEL_ROLE_QUESTION_TEXT: Record<'criteria' | 'grader', ModelRoleQuestionText> = {
  grader: {
    confirm: 'Grade checks with a model?',
    modelQuestion: 'Grader model',
    effortQuestion: 'Grader effort',
    defaultEffort: 'medium',
  },
  criteria: {
    confirm: 'Draft criteria with a model?',
    modelQuestion: 'Criteria model',
    effortQuestion: 'Criteria effort',
    defaultEffort: 'high',
  },
};

/** Captures an optional `roles.<roleName>` declaration during bootstrap; absent on decline. */
export async function interviewModelRole(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  checkState: ModelCheckState,
  roleName: 'criteria' | 'grader',
): Promise<{ model: `${string}/${string}`; effort: string } | undefined> {
  const texts = MODEL_ROLE_QUESTION_TEXT[roleName];
  const wantsRole = await askConfirm(io, { message: texts.confirm, initialValue: true });
  if (!wantsRole) {
    return undefined;
  }
  const model = await askCheckedModel(io, dependencies, texts.modelQuestion, checkState);
  const effort = await askDefaultedText(io, {
    message: texts.effortQuestion,
    defaultValue: texts.defaultEffort,
    validate: validateNonWhitespace,
  });
  return { model, effort };
}

type MutableAgentDraft = {
  command: string;
  secrets: string[];
  env: string[];
  providers: AgentProviderSetting[];
};

/** What the model check keeps across the setup interview's model questions. */
export type ModelCheckState = {
  /** The agent block every accepted model so far needs. */
  agent: MutableAgentDraft;
  /** The recorded API key variable answer per provider; an empty answer is a recorded answer. */
  keys: Map<string, string>;
  /** Unset variables already reported, so each name prints once per run. */
  printedUnset: Set<string>;
  /** The variables the Jira answers name; a copied provider never receives them. */
  jiraNames: ReadonlySet<string>;
};

/** Why one model answer was refused; each variant becomes one warning. */
type ModelCheckFailure =
  | { kind: 'config-unreadable'; findings: readonly ValidationFinding[] }
  | { kind: 'provider-rejected'; provider: string; findings: readonly ValidationFinding[] }
  | { kind: 'not-listed'; model: string }
  | { kind: 'listing-failed'; detail: string };

/**
 * Asks a model question and checks the answer, re-asking with the refused
 * answer filled in until the agent lists the model. Copies the answer's
 * provider from the operator's configuration into the agent block on the way.
 */
async function askCheckedModel(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  message: string,
  state: ModelCheckState,
): Promise<`${string}/${string}`> {
  let answer = await askText(io, { message, validate: validateModel });
  for (;;) {
    const parsed = ModelIdentifierSchema.safeParse(answer);
    if (parsed.success) {
      const failure = await checkRound(io, dependencies, state, parsed.data);
      if (failure === undefined) {
        return parsed.data;
      }
      warnLines(io, dependencies.redact, describeModelCheckFailure(failure));
    }
    answer = await askText(io, { message, initialValue: answer, validate: validateModel });
  }
}

/**
 * Checks one model answer against a candidate copy of the agent block, which
 * replaces the accepted block only when the answer passes, so a refused
 * answer leaves no provider or variable behind. Returns `undefined` when the
 * answer is accepted.
 */
async function checkRound(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  state: ModelCheckState,
  model: `${string}/${string}`,
): Promise<ModelCheckFailure | undefined> {
  let hasAskedKey = false;
  for (;;) {
    const candidate: MutableAgentDraft = {
      command: state.agent.command,
      secrets: [...state.agent.secrets],
      env: [...state.agent.env],
      providers: state.agent.providers.map((provider) => ({ ...provider })),
    };
    const inspected = await runWait(io, 'Checking model', () =>
      dependencies.inspectModelProvider(candidate, model),
    );
    if (!inspected.ok) {
      return { kind: 'config-unreadable', findings: inspected.error.findings };
    }
    const { provider, definition } = inspected.value;
    if (definition.defined) {
      if (!candidate.providers.some((entry) => entry.id === provider)) {
        candidate.providers.push({ id: provider });
      }
      for (const name of [...definition.keyVariables, ...definition.otherVariables]) {
        declareSecret(state, candidate, name);
      }
      const isKeyUnknown = definition.keyVariables.length === 0 || definition.apiKey === 'value';
      if (isKeyUnknown && !state.keys.has(provider)) {
        state.keys.set(
          provider,
          await askKeyVariable(io, dependencies, state, provider, undefined),
        );
      }
    }
    const key = state.keys.get(provider) ?? '';
    if (key !== '') {
      const entry = candidate.providers.find((candidateEntry) => candidateEntry.id === provider);
      if (definition.defined && entry !== undefined) {
        entry.api_key = key;
      }
      declareSecret(state, candidate, key);
    }

    const outcome = await runWaitReporting(
      io,
      'Checking model',
      () => dependencies.checkModelAccess(candidate, model),
      (settled) => {
        if (settled.status !== 'provider-rejected' && settled.retainedDirectory !== null) {
          warnRetainedDirectory(io, dependencies.redact, settled.retainedDirectory);
        }
      },
    );
    if (outcome.status === 'provider-rejected') {
      return { kind: 'provider-rejected', provider, findings: outcome.findings };
    }
    if (outcome.retainedDirectory !== null) {
      warnRetainedDirectory(io, dependencies.redact, outcome.retainedDirectory);
    }
    if (outcome.status === 'cancelled') {
      throw new WizardCancelledError();
    }
    if (outcome.status === 'listing-failed') {
      return { kind: 'listing-failed', detail: outcome.detail };
    }
    if (
      outcome.status === 'not-listed' &&
      !definition.defined &&
      outcome.unsetVariables.length > 0
    ) {
      warnLines(io, dependencies.redact, {
        headline: `${model} can't be checked while ${describeUnsetNames(outcome.unsetVariables)} in this terminal, so it is kept as entered.`,
      });
      for (const name of outcome.unsetVariables) {
        state.printedUnset.add(name);
      }
      state.agent = candidate;
      return undefined;
    }
    for (const name of outcome.unsetVariables) {
      if (!state.printedUnset.has(name)) {
        state.printedUnset.add(name);
        warnLines(io, dependencies.redact, {
          headline: `${name} isn't set in this terminal. Runs will need it.`,
        });
      }
    }
    if (outcome.status === 'listed') {
      state.agent = candidate;
      return undefined;
    }
    if (definition.defined || hasAskedKey) {
      return { kind: 'not-listed', model };
    }
    const answer = await askKeyVariable(
      io,
      dependencies,
      state,
      provider,
      state.keys.get(provider),
    );
    state.keys.set(provider, answer);
    hasAskedKey = true;
    if (answer === '') {
      return { kind: 'not-listed', model };
    }
  }
}

/**
 * Adds `name` to the candidate's secrets unless it is already declared, is
 * not a variable name, is fixed by the isolation contract, or belongs to the
 * Jira answers. A skipped name stays visible to the provider reader, which
 * refuses a definition that references it.
 */
function declareSecret(state: ModelCheckState, candidate: MutableAgentDraft, name: string): void {
  const isDeclarable =
    !candidate.secrets.includes(name) &&
    !candidate.env.includes(name) &&
    validateVariableNameGrammar(name) === undefined &&
    !isFixedEnvironmentName(name) &&
    !state.jiraNames.has(name);
  if (isDeclarable) {
    candidate.secrets.push(name);
  }
}

/** Asks the variable that holds a provider's API key; empty when the operator names none. */
async function askKeyVariable(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  state: ModelCheckState,
  provider: string,
  previous: string | undefined,
): Promise<string> {
  const validateName = validateVariableName(new Set(state.agent.env), dependencies.isVariableSet);
  return askDefaultedText(io, {
    message: `API key variable for ${provider}`,
    defaultValue: '',
    placeholder: 'none',
    ...(previous === undefined || previous === '' ? {} : { initialValue: previous }),
    validate: (raw) => {
      const problem = validateName(raw);
      if (problem !== undefined) {
        return problem;
      }
      return state.jiraNames.has(raw ?? '')
        ? 'Jira credential variables must not also be passed to the agent'
        : undefined;
    },
  });
}

function describeModelCheckFailure(failure: ModelCheckFailure): {
  headline: string;
  details: readonly string[];
  next: string;
} {
  switch (failure.kind) {
    case 'config-unreadable':
      return {
        headline: "Can't read your OpenCode config.",
        details: failure.findings.map((finding) => finding.message),
        next: `Update your OpenCode settings. ${RETRY_NEXT_STEP}`,
      };
    case 'provider-rejected':
      return {
        headline: `Can't copy provider ${failure.provider} from your OpenCode config.`,
        details: failure.findings.map((finding) => finding.message),
        next: `Update your OpenCode settings. ${RETRY_NEXT_STEP}`,
      };
    case 'not-listed':
      return {
        headline: `OpenCode can't find ${failure.model}.`,
        details: [],
        next: `Update your OpenCode settings or edit the model below. ${RETRY_NEXT_STEP}`,
      };
    case 'listing-failed':
      return {
        headline: "Can't list OpenCode models.",
        details: [failure.detail],
        next: RETRY_NEXT_STEP,
      };
  }
}

/** Collects at least two model entries during bootstrap. */
export async function interviewModels(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  checkState: ModelCheckState,
): Promise<ModelDefinitionInput[]> {
  const models: ModelDefinitionInput[] = [];
  const usedIds = new Set<string>();
  for (;;) {
    const model = await askCheckedModel(io, dependencies, 'Model', checkState);
    const effort = await askText(io, {
      message: 'Reasoning effort',
      validate: validateNonWhitespace,
    });
    const id = deriveModelEntryId(model, effort, usedIds);
    usedIds.add(id);
    models.push({ id, model, effort });
    if (models.length < 2) {
      log.info('Add a second model to compare.', promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: 'Add another model?',
      initialValue: false,
    });
    if (!wantsMore) {
      return models;
    }
  }
}
