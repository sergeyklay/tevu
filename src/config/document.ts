/**
 * Configuration document rendering and append-only splicing.
 *
 * `renderConfigDocument` writes a brand-new configuration file from a
 * validated (pre-default) input value. `appendToConfigText` splices a new
 * task, and optionally a new repository, into an existing configuration's
 * text without disturbing any other byte, comment, or blank line.
 */

import { Document, Scalar, YAMLSeq, isSeq, parseDocument } from "yaml";

import type { Node } from "yaml";
import type {
  CheckInput,
  ModelDefinitionInput,
  RepositoryInput,
  TaskInput,
  TevuConfigInput,
} from "./schema.ts";
import type { TevuResult } from "../domain/types.ts";

/** Redaction boundary applied to every decoded string before it becomes YAML. */
export type ConfigRendering = { redact: (text: string) => string };

/**
 * Renders a brand-new configuration document from validated input,
 * in the canonical key order, applying every rendering rule shared with
 * `appendToConfigText`: omitted defaults, a double-quoted `base_commit`,
 * flow-style check argv/exit codes/env, and redaction before serialization.
 */
export function renderConfigDocument(
  config: TevuConfigInput,
  rendering: ConfigRendering,
): TevuResult<string, "ArtifactError"> {
  const guard = createGuardedRedactor(rendering);
  const entries: Array<[string, unknown]> = [
    ["version", 1],
    ["run", buildRunNode(config.run, guard)],
    ["agents", buildAgentsNode(config.agents, guard)],
  ];
  if (config.trackers !== undefined) {
    entries.push(["trackers", buildTrackersNode(config.trackers, guard)]);
  }
  entries.push(
    ["repositories", config.repositories.map((repository) => buildRepositoryNode(repository, guard))],
    ["models", config.models.map((model) => buildModelNode(model, guard))],
    ["tasks", config.tasks.map((task) => buildTaskNode(task, guard))],
  );

  const failure = guard.failure();
  if (failure !== null) {
    return failure;
  }
  const blocks = entries.map(([key, value]) => renderTopLevelBlock(key, value));
  return { ok: true, value: `${blocks.join("\n\n")}\n` };
}

/**
 * Splices a rendered task, and optionally a rendered repository, into the
 * `tasks` and `repositories` block sequences of an existing configuration's
 * text. Every byte outside the insertion points is preserved; a flow-style
 * target list is refused with a finding and no text is returned.
 */
export function appendToConfigText(
  text: string,
  addition: { task: TaskInput; repository?: RepositoryInput },
  rendering: ConfigRendering,
): TevuResult<string, "ConfigValidationError" | "ArtifactError"> {
  const guard = createGuardedRedactor(rendering);
  const taskLines = renderItemLines(buildTaskNode(addition.task, guard));
  const repositoryLines =
    addition.repository === undefined ? null : renderItemLines(buildRepositoryNode(addition.repository, guard));
  const failure = guard.failure();
  if (failure !== null) {
    return failure;
  }

  const document = parseDocument(text, { version: "1.2", schema: "core" });
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";

  const tasksSeq = document.get("tasks", true);
  if (!isSeq(tasksSeq)) {
    return artifactFailure("append-configuration", "tasks is not a sequence node in the existing configuration");
  }
  if (tasksSeq.flow === true) {
    return flowStyleFinding("tasks");
  }

  let repositoriesSeq: YAMLSeq | null = null;
  if (addition.repository !== undefined) {
    const node = document.get("repositories", true);
    if (!isSeq(node)) {
      return artifactFailure(
        "append-configuration",
        "repositories is not a sequence node in the existing configuration",
      );
    }
    if (node.flow === true) {
      return flowStyleFinding("repositories");
    }
    repositoriesSeq = node;
  }

  const insertions: Array<TevuResult<{ offset: number; text: string }, "ArtifactError">> = [
    buildInsertion(text, tasksSeq, taskLines, lineEnding),
  ];
  if (repositoriesSeq !== null && repositoryLines !== null) {
    insertions.push(buildInsertion(text, repositoriesSeq, repositoryLines, lineEnding));
  }
  const failedInsertion = insertions.find((insertion): insertion is Extract<(typeof insertions)[number], { ok: false }> => !insertion.ok);
  if (failedInsertion !== undefined) {
    return failedInsertion;
  }
  const successfulInsertions = insertions
    .filter((insertion): insertion is Extract<(typeof insertions)[number], { ok: true }> => insertion.ok)
    .map((insertion) => insertion.value)
    // Insert at the later offset first so the earlier offset stays valid.
    .sort((a, b) => b.offset - a.offset);

  let result = text;
  for (const insertion of successfulInsertions) {
    result = result.slice(0, insertion.offset) + insertion.text + result.slice(insertion.offset);
  }
  return { ok: true, value: result };
}

type GuardedRedactor = {
  redact: (value: string) => string;
  failure: () => TevuResult<never, "ArtifactError"> | null;
};

function createGuardedRedactor(rendering: ConfigRendering): GuardedRedactor {
  let failure: TevuResult<never, "ArtifactError"> | null = null;
  return {
    redact(value) {
      if (failure !== null) {
        return value;
      }
      let redacted: string;
      try {
        redacted = rendering.redact(value);
      } catch (cause) {
        failure = artifactFailure(
          "render-configuration",
          `redaction failed while rendering the configuration: ${describeCause(cause)}`,
        );
        return value;
      }
      // The redactor is injected; a non-string result must fail closed, never sink raw text.
      if (typeof (redacted as unknown) !== "string") {
        failure = artifactFailure("render-configuration", "redaction returned no text while rendering the configuration");
        return value;
      }
      return redacted;
    },
    failure: () => failure,
  };
}

function buildRunNode(run: TevuConfigInput["run"], guard: GuardedRedactor): Record<string, unknown> {
  const node: Record<string, unknown> = {
    output_dir: guard.redact(run.output_dir),
    concurrency: run.concurrency,
    timeout: guard.redact(run.timeout),
    stop_grace: guard.redact(run.stop_grace),
  };
  if (run.check_timeout !== undefined) {
    node.check_timeout = guard.redact(run.check_timeout);
  }
  return node;
}

function buildAgentsNode(agents: TevuConfigInput["agents"], guard: GuardedRedactor): Record<string, unknown> {
  const opencode: Record<string, unknown> = { command: guard.redact(agents.opencode.command) };
  if (agents.opencode.secrets !== undefined && agents.opencode.secrets.length > 0) {
    opencode.secrets = agents.opencode.secrets.map((name) => guard.redact(name));
  }
  if (agents.opencode.env !== undefined && agents.opencode.env.length > 0) {
    opencode.env = agents.opencode.env.map((name) => guard.redact(name));
  }
  return { opencode };
}

function buildTrackersNode(
  trackers: NonNullable<TevuConfigInput["trackers"]>,
  guard: GuardedRedactor,
): Record<string, unknown> {
  if (trackers.jira === undefined) {
    return {};
  }
  return {
    jira: {
      url: guard.redact(trackers.jira.url),
      email: guard.redact(trackers.jira.email),
      token: guard.redact(trackers.jira.token),
    },
  };
}

function buildRepositoryNode(repository: RepositoryInput, guard: GuardedRedactor): Record<string, unknown> {
  return { id: guard.redact(repository.id), path: guard.redact(repository.path) };
}

function buildModelNode(model: ModelDefinitionInput, guard: GuardedRedactor): Record<string, unknown> {
  const node: Record<string, unknown> = {
    id: guard.redact(model.id),
    model: guard.redact(model.model),
    effort: guard.redact(model.effort),
  };
  if (model.agent !== undefined) {
    node.agent = guard.redact(model.agent);
  }
  return node;
}

function buildTaskNode(task: TaskInput, guard: GuardedRedactor): Record<string, unknown> {
  const node: Record<string, unknown> = {
    id: guard.redact(task.id),
    title: guard.redact(task.title),
  };
  if (task.repo !== undefined) {
    node.repo = guard.redact(task.repo);
  }
  node.base_commit = quotedScalar(guard.redact(task.base_commit));
  node.prompt = guard.redact(task.prompt);
  node.description = guard.redact(task.description);
  if (task.source !== undefined) {
    node.source = {
      kind: task.source.kind,
      key: guard.redact(task.source.key),
      url: guard.redact(task.source.url),
      imported_at: task.source.imported_at,
      title: guard.redact(task.source.title),
      body: guard.redact(task.source.body),
    };
  }
  node.readiness = task.readiness.map((item) => guard.redact(item));
  node.checks = {
    acceptance: task.checks.acceptance.map((check) => buildCheckNode(check, guard)),
    done: task.checks.done.map((check) => buildCheckNode(check, guard)),
  };
  return node;
}

function buildCheckNode(check: CheckInput, guard: GuardedRedactor): Record<string, unknown> {
  const node: Record<string, unknown> = {
    id: guard.redact(check.id),
    description: guard.redact(check.description),
  };
  if (check.manual === true) {
    node.manual = true;
  } else if (check.run !== undefined) {
    node.run = flowSeq(check.run.map((token) => guard.redact(token)));
    if (check.timeout !== undefined) {
      node.timeout = guard.redact(check.timeout);
    }
    if (check.exit_codes !== undefined && !isDefaultExitCodes(check.exit_codes)) {
      node.exit_codes = flowSeq(check.exit_codes);
    }
    if (check.env !== undefined && check.env.length > 0) {
      node.env = flowSeq(check.env.map((name) => guard.redact(name)));
    }
  }
  if (check.required !== undefined && check.required !== true) {
    node.required = check.required;
  }
  return node;
}

function isDefaultExitCodes(codes: readonly number[]): boolean {
  return codes.length === 1 && codes[0] === 0;
}

function flowSeq(values: readonly (string | number)[]): YAMLSeq {
  const seq = new YAMLSeq();
  seq.items = [...values];
  seq.flow = true;
  return seq;
}

function quotedScalar(value: string): Scalar<string> {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

const STRINGIFY_OPTIONS = { indent: 2, lineWidth: 0, flowCollectionPadding: false } as const;

function renderTopLevelBlock(key: string, value: unknown): string {
  const doc = new Document({ [key]: value });
  return doc.toString(STRINGIFY_OPTIONS).replace(/\n+$/, "");
}

function renderItemLines(value: Record<string, unknown>): string[] {
  const doc = new Document(value);
  const text = doc.toString(STRINGIFY_OPTIONS).replace(/\n+$/, "");
  return text.split("\n");
}

function indentAsSequenceItem(lines: readonly string[], dashColumn: number): string {
  const dashPrefix = `${" ".repeat(dashColumn)}- `;
  const continuationPrefix = " ".repeat(dashColumn + 2);
  return lines
    .map((line, index) => {
      if (index === 0) {
        return dashPrefix + line;
      }
      return line.length === 0 ? "" : continuationPrefix + line;
    })
    .join("\n");
}

/** Finds the column of the `-` indicator that introduces the item starting at `itemStart`. */
function dashColumnOf(text: string, itemStart: number): number {
  const lineStart = text.lastIndexOf("\n", itemStart - 1) + 1;
  const linePrefix = text.slice(lineStart, itemStart);
  const dashIndex = linePrefix.lastIndexOf("-");
  return dashIndex === -1 ? 0 : dashIndex;
}

function firstNonSpaceIndex(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== " " && line[index] !== "\t") {
      return index;
    }
  }
  return -1;
}

/**
 * Finds the offset right after the last line of the last item that is
 * indented deeper than the list's own `-` column, including a trailing
 * indented comment. Blank lines and column-zero comments that follow the item
 * stay after the insertion.
 *
 * The yaml range of a last item cannot be used as the end: it also swallows
 * trailing blank lines and comments up to the next key or the end of the text.
 */
function findInsertionOffset(text: string, lastItemRange: readonly [number, number, number], dashColumn: number): number {
  const firstLineBreak = text.indexOf("\n", lastItemRange[0]);
  if (firstLineBreak === -1) {
    return text.length;
  }
  let insertionOffset = firstLineBreak + 1;
  let lineStart = insertionOffset;
  while (lineStart < text.length) {
    const lineBreak = text.indexOf("\n", lineStart);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak + 1;
    const contentIndex = firstNonSpaceIndex(text.slice(lineStart, lineEnd).replace(/\r?\n$/, ""));
    if (contentIndex !== -1) {
      if (contentIndex <= dashColumn) {
        break;
      }
      insertionOffset = lineEnd;
    }
    lineStart = lineEnd;
  }
  return insertionOffset;
}

function nodeRange(node: Node): readonly [number, number, number] | null {
  return node.range ?? null;
}

function buildInsertion(
  text: string,
  seq: YAMLSeq,
  lines: readonly string[],
  lineEnding: string,
): TevuResult<{ offset: number; text: string }, "ArtifactError"> {
  const items = seq.items as Node[];
  const firstItem = items[0];
  const lastItem = items[items.length - 1];
  if (firstItem === undefined || lastItem === undefined) {
    return artifactFailure("append-configuration", "the target list has no items to anchor the insertion against");
  }
  const firstRange = nodeRange(firstItem);
  const lastRange = nodeRange(lastItem);
  if (firstRange === null || lastRange === null) {
    return artifactFailure("append-configuration", "the target list's items carry no source position");
  }
  const dashColumn = dashColumnOf(text, firstRange[0]);
  const offset = findInsertionOffset(text, lastRange, dashColumn);
  const indented = indentAsSequenceItem(lines, dashColumn);
  const body = lineEnding === "\r\n" ? indented.replace(/\n/g, "\r\n") : indented;
  const needsLeadingBreak = offset > 0 && !/(\r\n|\n)$/.test(text.slice(0, offset));
  const prefix = needsLeadingBreak ? lineEnding : "";
  return { ok: true, value: { offset, text: `${prefix}${body}${lineEnding}` } };
}

function flowStyleFinding(key: string): TevuResult<never, "ConfigValidationError"> {
  return {
    ok: false,
    error: {
      kind: "ConfigValidationError",
      findings: [
        {
          severity: "error",
          identifier: key,
          message: `task add appends only to a block-style list; rewrite ${key} in block style and run task add again`,
        },
      ],
    },
  };
}

function artifactFailure(operation: string, reason: string): TevuResult<never, "ArtifactError"> {
  return { ok: false, error: { kind: "ArtifactError", operation, reason } };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
