/**
 * Configuration questions for a missing file.
 */

import { log } from '@clack/prompts';

import { AGENT_NAMES, HttpsUrlSchema, referencedVariableName } from '@/config/schema';
import {
  askConfirm,
  askDefaultedText,
  askInteger,
  askSelect,
  askText,
  promptOptions,
} from '@/interface/wizard-questions';
import {
  splitNames,
  unsetVariableProblem,
  validateDuration,
  validateHttpsUrl,
  validateNonWhitespace,
  validateVariableName,
  validateVariableNameGrammar,
} from '@/interface/wizard-validators';

import { interviewModelRole, interviewModels } from './models';
import {
  askRepositoryLocation,
  describePlacementFindings,
  describeRepositorySource,
  interviewRepositories,
  repositoryPrefill,
} from './repositories';
import { warnLines } from './shared';
import { runWait } from './wait';

import type { ModelCheckState } from './models';
import type { TaskWizardDependencies } from './shared';
import type { TevuConfigInput } from '@/config/schema';
import type { JiraTrackerSettings } from '@/domain/config';
import type { WizardIo } from '@/interface/wizard-questions';

const OUTPUT_DIRECTORY_CHOICE = '__change-output-directory__';

/** Captures every required top-level setting for a missing configuration file. */
export async function interviewBootstrap(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  requireJira: boolean,
): Promise<Omit<TevuConfigInput, 'version' | 'tasks'>> {
  log.step('New configuration', promptOptions(io));
  let outputDirectory = await askOutputDirectory(io);
  const concurrency = await askInteger(io, 'Concurrent cases', 1, 32, 2);
  const timeout = await askDefaultedText(io, {
    message: 'Agent time limit',
    defaultValue: '10m',
    validate: validateDuration,
  });
  const stopGrace = await askDefaultedText(io, {
    message: 'Stop grace period',
    defaultValue: '3s',
    validate: validateDuration,
  });
  const checkTimeout = await askDefaultedText(io, {
    message: 'Check time limit',
    defaultValue: '5m',
    validate: validateDuration,
  });
  const command = await askAgentCommand(io, dependencies);
  const takenNames = new Set<string>();
  const { isVariableSet } = dependencies;
  const secrets = await askVariableNames(io, 'Secret variable names', takenNames, isVariableSet);
  const env = await askVariableNames(io, 'Non-secret variable names', takenNames, isVariableSet);
  const agentNames = new Set([...secrets, ...env]);
  const jira = await interviewJiraSettings(io, requireJira, agentNames, isVariableSet);
  let repositories = await interviewRepositories(io, dependencies);
  for (;;) {
    const findings = await runWait(io, 'Checking repositories', () =>
      dependencies.checkRepositoryPlacement(outputDirectory, repositories),
    );
    if (findings.length === 0) {
      break;
    }
    warnLines(io, dependencies.redact, {
      headline: "Can't save the output directory and repository answers.",
      details: describePlacementFindings(findings),
      next: 'Choose an answer to change below, or press Ctrl-C to cancel.',
    });
    const choice = await askSelect<string>(io, {
      message: 'Answer to change',
      options: [
        { value: OUTPUT_DIRECTORY_CHOICE, label: 'Output directory', hint: outputDirectory },
        ...repositories.map((repository) => ({
          value: repository.id,
          label: `Repository ${repository.id}`,
          hint: describeRepositorySource(repository),
        })),
      ],
      initialValue: OUTPUT_DIRECTORY_CHOICE,
    });
    if (choice === OUTPUT_DIRECTORY_CHOICE) {
      outputDirectory = await askOutputDirectory(io, outputDirectory);
      continue;
    }
    const current = repositories.find((repository) => repository.id === choice);
    if (current === undefined) {
      throw new Error('unreachable: the answer select returns one of its own options');
    }
    const otherIds = new Set(
      repositories
        .filter((repository) => repository.id !== current.id)
        .map((repository) => repository.id),
    );
    const changed = await askRepositoryLocation(
      io,
      dependencies,
      otherIds,
      repositoryPrefill(current),
    );
    repositories = repositories.map((repository) =>
      repository.id === current.id ? changed : repository,
    );
  }
  const checkState: ModelCheckState = {
    agent: { command, secrets, env, providers: [] },
    keys: new Map(),
    printedUnset: new Set(),
    jiraNames:
      jira === undefined
        ? new Set()
        : new Set([referencedVariableName(jira.email), referencedVariableName(jira.token)]),
  };
  const models = await interviewModels(io, dependencies, checkState);
  const grader = await interviewModelRole(io, dependencies, checkState, 'grader');
  const criteria = await interviewModelRole(io, dependencies, checkState, 'criteria');
  const { agent } = checkState;
  return {
    run: {
      output_dir: outputDirectory,
      concurrency,
      timeout,
      stop_grace: stopGrace,
      check_timeout: checkTimeout.trim(),
    },
    agents: {
      [AGENT_NAMES[0]]: {
        command: agent.command,
        secrets: agent.secrets,
        env: agent.env,
        ...(agent.providers.length === 0 ? {} : { providers: agent.providers }),
      },
    },
    ...(jira === undefined ? {} : { trackers: { jira } }),
    repositories,
    models,
    ...(criteria === undefined && grader === undefined
      ? {}
      : {
          roles: {
            ...(criteria === undefined ? {} : { criteria }),
            ...(grader === undefined ? {} : { grader }),
          },
        }),
  };
}

/** Asks the output directory, opening with `refused` filled in when the answer is asked again. */
async function askOutputDirectory(io: WizardIo, refused?: string): Promise<string> {
  return askDefaultedText(io, {
    message: 'Output directory',
    defaultValue: 'runs',
    ...(refused === undefined ? {} : { initialValue: refused }),
    validate: validateNonWhitespace,
  });
}

/**
 * Asks the agent command and probes it behind a spinner, re-asking with the
 * failed command filled in until the probe passes.
 */
async function askAgentCommand(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
): Promise<string> {
  let command = await askDefaultedText(io, {
    message: 'Agent command',
    defaultValue: AGENT_NAMES[0],
    validate: validateNonWhitespace,
  });
  for (;;) {
    const probed = await runWait(io, `Checking ${command}`, () => dependencies.probeAgent(command));
    if (probed.ok) {
      return command;
    }
    const detail =
      probed.error.kind === 'PrerequisiteError'
        ? `expected ${probed.error.expected}${probed.error.actual === undefined ? '' : `, actual ${probed.error.actual}`}`
        : probed.error.reason;
    warnLines(io, dependencies.redact, {
      headline: `Can't run ${command}.`,
      details: [detail],
      next: 'Fix the command below. Press Enter to retry, or Ctrl-C to cancel.',
    });
    command = await askText(io, {
      message: 'Agent command',
      initialValue: command,
      validate: validateNonWhitespace,
    });
  }
}

/**
 * Asks one pass-through agent variable list, names only.
 *
 * Every name follows the single-name rules and must be new across both agent
 * lists; accepted names join `takenNames` so the next list sees them.
 */
async function askVariableNames(
  io: WizardIo,
  message: string,
  takenNames: Set<string>,
  isVariableSet: (name: string) => boolean,
): Promise<string[]> {
  const validateName = validateVariableName(takenNames, isVariableSet);
  const answer = await askDefaultedText(io, {
    message,
    defaultValue: '',
    placeholder: 'none',
    validate: (raw) => {
      const seen = new Set<string>();
      for (const name of splitNames(raw ?? '')) {
        const problem = validateName(name);
        if (problem !== undefined) {
          return problem;
        }
        if (seen.has(name)) {
          return `"${name}" is listed more than once`;
        }
        seen.add(name);
      }
      return undefined;
    },
  });
  const names = splitNames(answer);
  for (const name of names) {
    takenNames.add(name);
  }
  return names;
}

/** Captures optional Jira Cloud settings; forced when `task add --jira` started the wizard. */
async function interviewJiraSettings(
  io: WizardIo,
  requireJira: boolean,
  agentNames: ReadonlySet<string>,
  isVariableSet: (name: string) => boolean,
): Promise<JiraTrackerSettings | undefined> {
  const wantsJira =
    requireJira ||
    (await askConfirm(io, {
      message: 'Import issues from Jira?',
      initialValue: false,
    }));
  if (!wantsJira) {
    return undefined;
  }
  const validateCredentialName = (raw: string | undefined): string | undefined => {
    const name = raw ?? '';
    const grammar = validateVariableNameGrammar(name);
    if (grammar !== undefined) {
      return grammar;
    }
    if (agentNames.has(name)) {
      return 'Jira credential variables must not also be passed to the agent';
    }
    return isVariableSet(name) ? undefined : unsetVariableProblem(name);
  };
  let answer = await askText(io, { message: 'Jira site URL', validate: validateHttpsUrl });
  let url: string | undefined;
  while (url === undefined) {
    const parsed = HttpsUrlSchema.safeParse(answer);
    if (parsed.success) {
      url = parsed.data;
    } else {
      answer = await askText(io, {
        message: 'Jira site URL',
        initialValue: answer,
        validate: validateHttpsUrl,
      });
    }
  }
  const email = await askText(io, {
    message: 'Jira email variable',
    validate: validateCredentialName,
  });
  const token = await askText(io, {
    message: 'Jira token variable',
    validate: validateCredentialName,
  });
  return { url, email: `$${email}`, token: `$${token}` };
}
