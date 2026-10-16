/**
 * Repository entries and the task's repository.
 */

import { log } from '@clack/prompts';

import { describeManagedCloneError } from '@/application/managed-clone';
import { managedCloneLocation, parseGitHubRepository } from '@/domain/github-reference';
import { deriveGitHubRepositoryId, deriveLocalRepositoryId } from '@/interface/derived-identifiers';
import {
  askConfirm,
  askSelect,
  askText,
  promptOptions,
  WizardCancelledError,
} from '@/interface/wizard-questions';
import { validateNonWhitespace } from '@/interface/wizard-validators';

import { describeManagedCloneOrPrerequisiteFailure, RETRY_NEXT_STEP, warnLines } from './shared';
import { runWait } from './wait';

import type { TaskWizardDependencies } from './shared';
import type { RepositoryInput } from '@/config/schema';
import type { RepositoryDefinition } from '@/domain/config';
import type { ValidationFinding } from '@/domain/errors';
import type { ParsedGitHubRepository } from '@/domain/github-reference';
import type { LocalRepositoryNaming } from '@/interface/derived-identifiers';
import type { WizardIo } from '@/interface/wizard-questions';

const NEW_REPOSITORY_CHOICE = '__add-new-repository__';

const GITHUB_GRAMMAR_MESSAGE =
  'github must be OWNER/REPO or https://HOST/OWNER/REPO, with a HOST of letters, digits, hyphens, and dots, and without surrounding spaces, user info, a port, a query, or a fragment';

/** Collects at least one source repository during bootstrap. */
export async function interviewRepositories(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
): Promise<RepositoryInput[]> {
  const repositories: RepositoryInput[] = [];
  const takenIds = new Set<string>();
  do {
    const entry = await interviewRepositoryEntry(io, dependencies, takenIds);
    takenIds.add(entry.id);
    repositories.push(entry);
  } while (await askConfirm(io, { message: 'Add another repository?', initialValue: false }));
  return repositories;
}

/**
 * Asks the source and location of one repository: a local path, or a GitHub
 * repository tevu clones itself. The ID is derived from the final answers.
 *
 * A GitHub entry's `path` is set to its managed-clone location up front, the
 * same value the configuration schema derives on load, so every downstream
 * consumer (reference resolution, base-commit fetching) locates the clone
 * the same way whether the entry came from the file or from this interview.
 */
async function interviewRepositoryEntry(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  takenIds: ReadonlySet<string>,
  prefill?: RepositoryPrefill,
): Promise<RepositoryDefinition> {
  return askRepositoryLocation(io, dependencies, takenIds, prefill);
}

/** The answers of one repository entry, to open its questions again with them filled in. */
type RepositoryPrefill = { source: 'path' | 'github'; location: string };

export function repositoryPrefill(
  repository: Pick<RepositoryInput, 'path' | 'github'>,
): RepositoryPrefill {
  return repository.github === undefined
    ? { source: 'path', location: repository.path ?? '' }
    : { source: 'github', location: repository.github };
}

/**
 * Asks the source and location of a repository and derives its ID from them,
 * so the ID always follows the final answers. The location opens with the
 * prefill's value only while the source stays the prefill's source.
 */
export async function askRepositoryLocation(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  takenIds: ReadonlySet<string>,
  prefill: RepositoryPrefill | undefined,
): Promise<RepositoryDefinition> {
  const source = await askSelect<'path' | 'github'>(io, {
    message: 'Repository source',
    options: [
      { value: 'path', label: 'Local path' },
      { value: 'github', label: 'GitHub, cloned by tevu' },
    ],
    ...(prefill === undefined ? {} : { initialValue: prefill.source }),
  });
  const location = prefill?.source === source ? prefill.location : undefined;
  if (source === 'path') {
    const { path, naming } = await askLocalRepositoryPath(io, dependencies, location);
    return { id: deriveLocalRepositoryId(naming, takenIds), path };
  }
  const github = await askGitHubRepository(io, dependencies, location);
  return {
    id: deriveGitHubRepositoryId(github, takenIds),
    path: managedCloneLocation(github),
    github: github.text,
  };
}

/**
 * Asks a local repository path, re-asking with the refused answer filled in
 * until it lies in a Git repository, and reads its naming in the same wait.
 */
async function askLocalRepositoryPath(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  initialAnswer: string | undefined,
): Promise<{ path: string; naming: LocalRepositoryNaming }> {
  let answer = await askText(io, {
    message: 'Local path',
    ...(initialAnswer === undefined ? {} : { initialValue: initialAnswer }),
    validate: validateNonWhitespace,
  });
  for (;;) {
    const path = answer;
    const naming = await runWait(io, `Checking ${path}`, async () =>
      (await dependencies.isGitRepository(path))
        ? dependencies.readLocalRepositoryNaming(path)
        : undefined,
    );
    if (naming !== undefined) {
      return { path, naming };
    }
    warnLines(io, dependencies.redact, {
      headline: `${path} isn't a Git repository.`,
      next: 'Fix the path below. Press Enter to retry, or Ctrl-C to cancel.',
    });
    answer = await askText(io, {
      message: 'Local path',
      initialValue: path,
      validate: validateNonWhitespace,
    });
  }
}

/**
 * Asks a GitHub repository answer, re-prompting with the grammar message until
 * it parses, then reads it from its remote, re-asking with the refused answer
 * filled in until the read succeeds.
 */
async function askGitHubRepository(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  initialAnswer: string | undefined,
): Promise<ParsedGitHubRepository & { text: string }> {
  let initialValue = initialAnswer;
  for (;;) {
    const text = (
      await askText(io, {
        message: 'GitHub repository',
        ...(initialValue === undefined ? {} : { initialValue }),
        validate: (value) =>
          parseGitHubRepository((value ?? '').trim()) === null ? GITHUB_GRAMMAR_MESSAGE : undefined,
      })
    ).trim();
    const parsed = parseGitHubRepository(text);
    if (parsed === null) {
      throw new Error('unreachable: askText only returns a value its validate callback accepted');
    }
    const checked = await runWait(io, `Checking ${text}`, () =>
      dependencies.checkGitHubRepository(parsed),
    );
    if (checked.ok) {
      return { ...parsed, text };
    }
    if (checked.error.kind === 'CancellationError') {
      throw new WizardCancelledError();
    }
    warnLines(io, dependencies.redact, {
      headline: `Can't read ${text} from GitHub.`,
      details: [describeManagedCloneError(checked.error)],
      next: 'Fix the repository below. Press Enter to retry, or Ctrl-C to cancel.',
    });
    initialValue = text;
  }
}

/**
 * Selects the task repository and checks it before any later question: a new
 * entry must pass the placement check, and a GitHub entry's managed clone is
 * ensured. A refusal warns and asks the repository again with the failed
 * choice filled in. A refused new entry stays listed as its own option, so
 * choosing it again re-runs the checks without asking its answers again, and
 * only the entry finally returned is written.
 */
export async function selectTaskRepository(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  // Accepts both a resolved `TevuConfig`'s repositories and a bootstrap
  // interview's, which never carry `setup`; only `id`, `path`, and `github` are read.
  repositories: readonly Pick<RepositoryInput, 'id' | 'path' | 'github'>[],
  outputDirectory: string,
): Promise<{
  repo: string;
  newRepository?: RepositoryDefinition;
  selectedRepository: Pick<RepositoryInput, 'id' | 'path' | 'github'>;
}> {
  const configuredIds = new Set(repositories.map((repository) => repository.id));
  let refused: RepositoryDefinition | undefined;
  let initial: string | undefined;
  for (;;) {
    const choice = await askSelect<string>(io, {
      message: 'Repository',
      options: [
        ...repositories.map((repository) => ({
          value: repository.id,
          label: repository.id,
          hint: describeRepositorySource(repository),
        })),
        ...(refused === undefined
          ? []
          : [
              {
                value: refused.id,
                label: refused.id,
                hint: `new, ${describeRepositorySource(refused)}`,
              },
            ]),
        { value: NEW_REPOSITORY_CHOICE, label: 'Add a repository' },
      ],
      ...(initial === undefined ? {} : { initialValue: initial }),
    });
    const newEntry =
      choice === NEW_REPOSITORY_CHOICE
        ? await interviewRepositoryEntry(
            io,
            dependencies,
            configuredIds,
            refused === undefined ? undefined : repositoryPrefill(refused),
          )
        : refused !== undefined && choice === refused.id
          ? refused
          : undefined;
    const entry = newEntry ?? repositories.find((repository) => repository.id === choice);
    if (entry === undefined) {
      throw new Error('unreachable: the repository select returns one of its own options');
    }

    if (newEntry !== undefined) {
      const findings = await runWait(io, 'Checking repositories', () =>
        dependencies.checkRepositoryPlacement(outputDirectory, [...repositories, newEntry]),
      );
      if (findings.length > 0) {
        warnLines(io, dependencies.redact, {
          headline: `Can't add repository ${newEntry.id}.`,
          details: describePlacementFindings(findings),
          next: `Choose another repository below, or pick Add a repository to change the answers. ${RETRY_NEXT_STEP}`,
        });
        refused = newEntry;
        initial = newEntry.id;
        continue;
      }
    }

    const { github } = entry;
    if (github !== undefined) {
      const ensured = await runWait(io, 'Preparing repository', () =>
        dependencies.ensureManagedCommits({ id: entry.id, github }, [], (line) =>
          log.step(dependencies.redact(line), promptOptions(io)),
        ),
      );
      if (!ensured.ok) {
        if (ensured.error.kind === 'CancellationError') {
          throw new WizardCancelledError();
        }
        warnLines(io, dependencies.redact, {
          headline: `Can't use repository ${entry.id}.`,
          details: [describeManagedCloneOrPrerequisiteFailure(ensured.error)],
          next: `Fix the cause or choose another repository below. ${RETRY_NEXT_STEP}`,
        });
        refused = newEntry ?? refused;
        initial = entry.id;
        continue;
      }
    }
    return {
      repo: entry.id,
      ...(newEntry === undefined ? {} : { newRepository: newEntry }),
      selectedRepository: entry,
    };
  }
}

/** One `<identifier>: <message>` detail line per placement finding. */
export function describePlacementFindings(findings: readonly ValidationFinding[]): string[] {
  return findings.map((finding) => `${finding.identifier}: ${finding.message}`);
}

/** `GitHub <github>` for a GitHub entry, its `path` otherwise. */
export function describeRepositorySource(
  repository: Pick<RepositoryInput, 'path' | 'github'>,
): string {
  return repository.github === undefined ? (repository.path ?? '') : `GitHub ${repository.github}`;
}
