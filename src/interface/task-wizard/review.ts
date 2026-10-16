/**
 * Final review and the save of the task wizard.
 */

import { note } from '@clack/prompts';

import { renderTevuError } from '@/interface/render-error';
import { askConfirm, promptOptions, WizardCancelledError } from '@/interface/wizard-questions';

import { describeRepositorySource } from './repositories';
import { warnLines } from './shared';
import { confirmExit, runWait, SAVING_WAIT_LABEL } from './wait';

import type { TaskWizardDependencies } from './shared';
import type { TaskWizardInput } from '@/application/create-task';
import type { CheckInput, TaskInput } from '@/config/schema';
import type { AgentProviderSetting, TaskDefinition } from '@/domain/config';
import type { WizardIo } from '@/interface/wizard-questions';

/**
 * Shows the single credential-redacted review and performs the one write once
 * the operator accepts it.
 *
 * A failed write warns and asks `Save` again with the same input, so no
 * answer is lost. Declining asks the exit question, and `No` asks `Save`
 * again. A write that succeeded stands whatever the signal state.
 */
export async function reviewAndSave(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  input: TaskWizardInput,
  graderDeclared: boolean,
): Promise<TaskDefinition> {
  note(dependencies.redact(renderTaskReview(input, graderDeclared)), 'Review', promptOptions(io));
  for (;;) {
    const accepted = await askConfirm(io, {
      message: `Save to ${input.configPath}?`,
      initialValue: true,
    });
    if (!accepted) {
      if (await confirmExit(io)) {
        throw new WizardCancelledError();
      }
      continue;
    }
    const saved = await runWait(
      io,
      SAVING_WAIT_LABEL,
      () => dependencies.createTask(input),
      (result) => result.ok,
    );
    if (saved.ok) {
      return saved.value;
    }
    if (saved.error.kind === 'CancellationError') {
      throw new WizardCancelledError();
    }
    const [firstLine = '', ...otherLines] = renderTevuError(saved.error, dependencies.redact);
    warnLines(io, dependencies.redact, {
      headline: `Couldn't save the task to ${input.configPath}.`,
      details: [firstLine.replace(/^error: /, ''), ...otherLines],
      next: 'Fix the cause, then press Enter to save again, or Ctrl-C to cancel.',
    });
  }
}

/** Renders the complete wizard input for the TTY-only final review. */
function renderTaskReview(input: TaskWizardInput, graderDeclared: boolean): string {
  const lines: string[] = [];
  if (input.bootstrap !== undefined) {
    const bootstrap = input.bootstrap;
    lines.push(
      'New configuration:',
      `  run.output_dir: ${bootstrap.run.output_dir}`,
      `  run.concurrency: ${bootstrap.run.concurrency}`,
      `  run.timeout: ${bootstrap.run.timeout}`,
      `  run.stop_grace: ${bootstrap.run.stop_grace}`,
      ...(bootstrap.run.check_timeout === undefined
        ? []
        : [`  run.check_timeout: ${bootstrap.run.check_timeout}`]),
      ...Object.entries(bootstrap.agents).flatMap(([name, settings]) => [
        `  agents.${name}.command: ${settings.command}`,
        `  agents.${name}.secrets: ${renderVariableList(settings.secrets ?? [])}`,
        `  agents.${name}.env: ${renderVariableList(settings.env ?? [])}`,
        `  agents.${name}.providers: ${renderProviderList(settings.providers ?? [])}`,
      ]),
    );
    if (bootstrap.roles?.criteria !== undefined) {
      lines.push(
        `  roles.criteria: ${bootstrap.roles.criteria.model} (effort ${bootstrap.roles.criteria.effort})`,
      );
    }
    if (bootstrap.roles?.grader !== undefined) {
      lines.push(
        `  roles.grader: ${bootstrap.roles.grader.model} (effort ${bootstrap.roles.grader.effort})`,
      );
    }
    if (bootstrap.trackers?.jira !== undefined) {
      lines.push(
        `  trackers.jira.url: ${bootstrap.trackers.jira.url}`,
        `  trackers.jira credentials: ${bootstrap.trackers.jira.email}, ${bootstrap.trackers.jira.token} (names only)`,
      );
    }
    for (const repository of bootstrap.repositories) {
      lines.push(`  repositories: ${repository.id} (${describeRepositorySource(repository)})`);
    }
    for (const model of bootstrap.models) {
      lines.push(`  models: ${model.id}: ${model.model} (effort ${model.effort})`);
    }
    lines.push('');
  }
  const task = input.task;
  lines.push(`Task ${task.id}:`);
  if (input.newRepository !== undefined) {
    lines.push(
      `  new repository ${input.newRepository.id}: ${describeRepositorySource(input.newRepository)}`,
    );
  }
  lines.push(
    `  repo: ${task.repo}`,
    `  base_commit: ${task.base_commit}`,
    `  title: ${task.title}`,
  );
  if (task.source === undefined) {
    lines.push('  source: (written by hand)');
  } else {
    lines.push(
      `  source: ${task.source.kind} ${task.source.key}`,
      `  imported at: ${task.source.imported_at}`,
      `  imported title: ${task.source.title}`,
      `  imported body: ${task.source.body}`,
    );
  }
  if (task.reference !== undefined) {
    lines.push(
      `  reference: ${task.reference.kind} ${task.reference.identifier}`,
      `  reference commits: ${task.reference.commits.length}`,
    );
    if (task.reference.kind === 'pull-request' && task.reference.merge_commit !== undefined) {
      lines.push(`  reference merge commit: ${task.reference.merge_commit}`);
    }
  }
  lines.push(`  description: ${task.description}`, `  prompt: ${task.prompt}`);
  for (const item of task.readiness) {
    lines.push(`  readiness: ${item}`);
  }
  for (const [label, checks] of [
    ['acceptance', task.checks.acceptance],
    ['done', task.checks.done],
  ] as const) {
    for (const check of checks) {
      lines.push(`  ${label} ${check.id}: ${renderCheck(check)}`);
    }
  }
  if (!graderDeclared && taskDeclaresGradedCheck(task)) {
    lines.push(
      'warning: roles.grader is not declared; tevu validate and tevu run refuse this task until it is',
    );
  }
  return lines.join('\n');
}

/** Holds when a check declares neither `run` nor `manual: true` (a graded check). */
function taskDeclaresGradedCheck(task: TaskInput): boolean {
  return [...task.checks.acceptance, ...task.checks.done].some(
    (check) => check.manual !== true && check.run === undefined,
  );
}

function renderVariableList(names: readonly string[]): string {
  return names.length === 0 ? '(none)' : names.join(', ');
}

function renderProviderList(providers: readonly AgentProviderSetting[]): string {
  return providers.length === 0
    ? '(none)'
    : providers
        .map((provider) =>
          provider.api_key === undefined
            ? provider.id
            : `${provider.id} (api_key ${provider.api_key})`,
        )
        .join(', ');
}

function renderCheck(check: CheckInput): string {
  const requirement = check.required === false ? 'optional' : 'required';
  if (check.manual === true) {
    return `${check.description} (${requirement}, manual)`;
  }
  if (check.run === undefined) {
    return `${check.description} (${requirement}, graded)`;
  }
  const env =
    check.env === undefined || check.env.length === 0 ? '' : `, variables ${check.env.join(',')}`;
  return (
    `${check.description} (${requirement}, command ${typeof check.run === 'string' ? check.run : check.run.join(' ')}, ` +
    `timeout ${check.timeout ?? 'run.check_timeout'}, ` +
    `exit codes ${(check.exit_codes ?? [0]).join(',')}${env})`
  );
}
