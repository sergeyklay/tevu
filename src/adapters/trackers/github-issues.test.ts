import { describe, expect, it, vi } from "vitest";

import { createGitHubIssuesAdapter, GH_CREDENTIAL_ENVIRONMENT_VARIABLES } from "./github-issues.ts";

import type {
  GhCapture,
  GhRun,
  GhRunRequest,
  GhRunResult,
  GitHubIssuesDependencies,
} from "./github-issues.ts";
import type { IssueSnapshot, TevuResult } from "../../domain/types.ts";

type ReadIssueResult = TevuResult<IssueSnapshot, "IssueImportError" | "CancellationError">;

function expectOk(result: ReadIssueResult): IssueSnapshot {
  if (!result.ok) {
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function expectIssueImportError(
  result: ReadIssueResult,
): Extract<ReadIssueResult, { ok: false }>["error"] & { kind: "IssueImportError" } {
  if (result.ok) {
    throw new Error(`expected an IssueImportError, got success: ${JSON.stringify(result.value)}`);
  }
  if (result.error.kind !== "IssueImportError") {
    throw new Error(`expected an IssueImportError, got ${result.error.kind}`);
  }
  return result.error;
}

function expectCancellation(result: ReadIssueResult): void {
  if (result.ok) {
    throw new Error(`expected a CancellationError, got success: ${JSON.stringify(result.value)}`);
  }
  expect(result.error.kind).toBe("CancellationError");
}

function buildCapture(text: string, truncated = false): GhCapture {
  return { text, truncated };
}

function buildLaunchedResult(overrides: Partial<Extract<GhRunResult, { launched: true }>> = {}): GhRunResult {
  return {
    launched: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: buildCapture(""),
    stderr: buildCapture(""),
    ...overrides,
  };
}

function fakeRun(result: GhRunResult): GhRun {
  return vi.fn(async () => result);
}

function buildDependencies(overrides: Partial<GitHubIssuesDependencies> = {}): GitHubIssuesDependencies {
  return {
    runGh: fakeRun(buildLaunchedResult()),
    parentEnvironment: { PATH: "/usr/bin", HOME: "/home/tevu" },
    cancellation: new AbortController().signal,
    ...overrides,
  };
}

function successStdout(overrides: Partial<{ number: number; title: string; body: string; url: string }> = {}): GhCapture {
  return buildCapture(
    JSON.stringify({
      number: 42,
      title: "Add export button",
      body: "Users need an export button",
      url: "https://github.com/octo/repo/issues/42",
      ...overrides,
    }),
  );
}

describe("GH_CREDENTIAL_ENVIRONMENT_VARIABLES", () => {
  it("names every token variable gh reads", () => {
    expect(GH_CREDENTIAL_ENVIRONMENT_VARIABLES).toEqual([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]);
  });
});

describe("createGitHubIssuesAdapter reference grammar", () => {
  it.each([
    { description: "an empty reference", reference: "" },
    { description: "a short form missing the issue number", reference: "octo/repo" },
    { description: "a short form with a zero issue number", reference: "octo/repo#0" },
    { description: "a short form with an owner starting with a hyphen", reference: "-octo/repo#1" },
    { description: "a short form naming the reserved repo name .", reference: "octo/.#1" },
    { description: "a URL with a non-https protocol", reference: "ftp://github.com/octo/repo/issues/1" },
    { description: "a URL carrying userinfo", reference: "https://user:pass@github.com/octo/repo/issues/1" },
    { description: "a URL carrying an explicit port", reference: "https://github.com:8443/octo/repo/issues/1" },
    { description: "a URL whose path kind is neither issues nor pull", reference: "https://github.com/octo/repo/commits/1" },
    { description: "a short form whose issue number exceeds the maximum", reference: "octo/repo#99999999999" },
  ])("rejects $description without calling gh", async ({ reference }) => {
    const runGh = vi.fn(fakeRun(buildLaunchedResult()));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue(reference));

    expect(error.reason).toBe("reference must be OWNER/REPO#NUMBER or https://HOST/OWNER/REPO/issues/NUMBER");
    expect(error.tracker).toBe("github-issue");
    expect(error.reference).toBe(reference);
    expect(runGh).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace from the reference before parsing and reporting it", async () => {
    const runGh = fakeRun(buildLaunchedResult({ stdout: successStdout() }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const snapshot = expectOk(await adapter.readIssue("  octo/repo#42  "));

    expect(snapshot.issueKey).toBe("octo/repo#42");
  });

  it("decodes a successful gh response into an issue snapshot", async () => {
    const runGh = fakeRun(buildLaunchedResult({ stdout: successStdout() }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const snapshot = expectOk(await adapter.readIssue("octo/repo#42"));

    expect(snapshot).toEqual({
      issueKey: "octo/repo#42",
      issueUrl: "https://github.com/octo/repo/issues/42",
      summary: "Add export button",
      description: "Users need an export button",
    });
  });
});

describe("createGitHubIssuesAdapter pull-request rejection", () => {
  it("rejects a pull-request reference before calling gh", async () => {
    const runGh = vi.fn(fakeRun(buildLaunchedResult()));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("https://github.com/octo/repo/pull/5"));

    expect(error.reason).toBe("the reference points to a pull request, not an issue");
    expect(runGh).not.toHaveBeenCalled();
  });

  it("rejects a decoded gh response whose url field names a pull request", async () => {
    const runGh = fakeRun(
      buildLaunchedResult({
        stdout: successStdout({ number: 5, url: "https://github.com/octo/repo/pull/5" }),
      }),
    );
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#5"));

    expect(error.reason).toBe("the reference points to a pull request, not an issue");
  });
});

describe("createGitHubIssuesAdapter cancellation", () => {
  it("returns a cancellation failure before launch without calling gh", async () => {
    const controller = new AbortController();
    controller.abort();
    const runGh = vi.fn(fakeRun(buildLaunchedResult()));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh, cancellation: controller.signal }));

    const result = await adapter.readIssue("octo/repo#42");

    expectCancellation(result);
    expect(runGh).not.toHaveBeenCalled();
  });

  it("returns a cancellation failure when gh reports it was cancelled during the run", async () => {
    const runGh = fakeRun(buildLaunchedResult({ cancelled: true }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const result = await adapter.readIssue("octo/repo#42");

    expectCancellation(result);
  });

  it("calls runGh at most once per import", async () => {
    const runGh = vi.fn(fakeRun(buildLaunchedResult({ stdout: successStdout() })));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    await adapter.readIssue("octo/repo#42");

    expect(runGh).toHaveBeenCalledTimes(1);
  });
});

describe("createGitHubIssuesAdapter launch failures", () => {
  it("reports gh as missing when the launch failure code is ENOENT", async () => {
    const runGh = fakeRun({ launched: false, code: "ENOENT", reason: "spawn gh ENOENT" });
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe(
      "GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com or enter the task manually",
    );
  });

  it("reports the launch failure code for any other launch failure", async () => {
    const runGh = fakeRun({ launched: false, code: "EACCES", reason: "spawn gh EACCES" });
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe("GitHub CLI (gh) could not be started: EACCES");
  });

  it("falls back to the runner reason when no launch failure code is available", async () => {
    const runGh = fakeRun({ launched: false, reason: "spawn gh failed unexpectedly" });
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe("GitHub CLI (gh) could not be started: spawn gh failed unexpectedly");
  });

  it("reports a timeout when gh does not respond within the deadline", async () => {
    const runGh = fakeRun(buildLaunchedResult({ timedOut: true, exitCode: null, signal: "SIGTERM" }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe("gh did not respond within 30 seconds");
  });
});

describe("createGitHubIssuesAdapter gh exit codes", () => {
  it.each([
    { host: "github.com", reference: "octo/repo#42", expectedReason: "gh is not authenticated; run gh auth login" },
    {
      host: "ghe.example.com",
      reference: "https://ghe.example.com/octo/repo/issues/42",
      expectedReason: "gh is not authenticated for ghe.example.com; run gh auth login --hostname ghe.example.com",
    },
  ])("reports an authentication failure for $host on exit code 4", async ({ reference, expectedReason }) => {
    const runGh = fakeRun(buildLaunchedResult({ exitCode: 4 }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue(reference));

    expect(error.reason).toBe(expectedReason);
  });

  it("reports a read failure with a stderr excerpt on exit code 1", async () => {
    const runGh = fakeRun(
      buildLaunchedResult({ exitCode: 1, stderr: buildCapture("GraphQL: Could not resolve to an issue") }),
    );
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe(
      "gh could not read the issue (not found, no access, or no connection): GraphQL: Could not resolve to an issue",
    );
  });

  it("reports a read failure with no excerpt suffix when stderr is empty", async () => {
    const runGh = fakeRun(buildLaunchedResult({ exitCode: 1, stderr: buildCapture("") }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe("gh could not read the issue (not found, no access, or no connection)");
  });

  it("reports gh's own cancellation exit code as an import cancellation", async () => {
    const runGh = fakeRun(buildLaunchedResult({ exitCode: 2 }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe("import cancelled (gh exited with code 2)");
  });

  it.each([
    { description: "a truncated capture", stdout: buildCapture("", true), expectedDetail: "output exceeds 1048576 bytes" },
    { description: "invalid JSON", stdout: buildCapture("{not json"), expectedDetail: "output is not valid JSON" },
    { description: "a JSON array", stdout: buildCapture("[]"), expectedDetail: "output is not a JSON object" },
    {
      description: "a missing number field",
      stdout: buildCapture(JSON.stringify({ title: "t", body: "b", url: "https://github.com/o/r/issues/1" })),
      expectedDetail: 'field "number" is missing or not a positive integer',
    },
    {
      description: "a missing title field",
      stdout: buildCapture(JSON.stringify({ number: 1, body: "b", url: "https://github.com/o/r/issues/1" })),
      expectedDetail: 'field "title" is missing or not a string',
    },
    {
      description: "a missing body field",
      stdout: buildCapture(JSON.stringify({ number: 1, title: "t", url: "https://github.com/o/r/issues/1" })),
      expectedDetail: 'field "body" is missing or not a string',
    },
    {
      description: "a missing url field",
      stdout: buildCapture(JSON.stringify({ number: 1, title: "t", body: "b" })),
      expectedDetail: 'field "url" is missing or not a string',
    },
    {
      description: "a url on the wrong host",
      stdout: buildCapture(
        JSON.stringify({ number: 1, title: "t", body: "b", url: "https://other-host.example/o/r/issues/1" }),
      ),
      expectedDetail: 'field "url" is not an issue URL on github.com',
    },
    {
      description: "a url whose issue number disagrees with the decoded number",
      stdout: buildCapture(
        JSON.stringify({ number: 1, title: "t", body: "b", url: "https://github.com/o/r/issues/2" }),
      ),
      expectedDetail: 'field "url" is not an issue URL on github.com',
    },
  ])("rejects $description on exit code 0 with a detailed reason", async ({ stdout, expectedDetail }) => {
    const runGh = fakeRun(buildLaunchedResult({ exitCode: 0, stdout }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#1"));

    expect(error.reason).toBe(`unexpected response from gh: ${expectedDetail}`);
  });

  it("reports an unexpected exit code with a stderr excerpt", async () => {
    const runGh = fakeRun(buildLaunchedResult({ exitCode: 3, stderr: buildCapture("unexpected gh failure") }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe("gh exited unexpectedly (exit code 3): unexpected gh failure");
  });

  it("reports a terminating signal with a stderr excerpt when not caused by a timeout or cancellation", async () => {
    const runGh = fakeRun(
      buildLaunchedResult({ exitCode: null, signal: "SIGKILL", stderr: buildCapture("killed by watchdog") }),
    );
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe("gh exited unexpectedly (signal SIGKILL): killed by watchdog");
  });
});

describe("createGitHubIssuesAdapter gh environment and request shape", () => {
  const parentEnvironment = {
    PATH: "/usr/bin",
    HOME: "/home/tevu",
    GH_TOKEN: "gh-token-value",
    GITHUB_TOKEN: "github-token-value",
    CLICOLOR_FORCE: "1",
    GH_FORCE_TTY: "1",
    GH_DEBUG: "1",
    DEBUG: "1",
    GH_ENTERPRISE_TOKEN: "enterprise-token",
    GITHUB_ENTERPRISE_TOKEN: "enterprise-token-2",
  };

  it.each([
    {
      description: "a short-form reference",
      reference: "octo/repo#42",
      canonicalUrl: "https://github.com/octo/repo/issues/42",
    },
    {
      description: "an Enterprise-host issue URL",
      reference: "https://ghe.example.com/octo/repo/issues/1",
      canonicalUrl: "https://ghe.example.com/octo/repo/issues/1",
    },
  ])(
    "builds the canonical argv and a replacement environment for $description",
    async ({ reference, canonicalUrl }) => {
      const cancellation = new AbortController().signal;
      const runGh = vi.fn(fakeRun(buildLaunchedResult()));
      const adapter = createGitHubIssuesAdapter(
        buildDependencies({ runGh, parentEnvironment, cancellation }),
      );

      await adapter.readIssue(reference);

      expect(runGh).toHaveBeenCalledTimes(1);
      const request = runGh.mock.calls[0]?.[0] as GhRunRequest;
      expect(request.argv).toEqual(["gh", "issue", "view", canonicalUrl, "--json", "number,title,body,url"]);
      expect(request.timeoutMs).toBe(30_000);
      expect(request.terminationGraceMs).toBe(3_000);
      expect(request.maxCaptureBytes).toBe(1_048_576);
      expect(request.cancellation).toBe(cancellation);

      expect(request.environment.GH_TOKEN).toBe("gh-token-value");
      expect(request.environment.GITHUB_TOKEN).toBe("github-token-value");
      expect(request.environment.HOME).toBe("/home/tevu");
      expect(request.environment.GH_PROMPT_DISABLED).toBe("1");
      expect(request.environment.GH_NO_UPDATE_NOTIFIER).toBe("1");
      expect(request.environment.NO_COLOR).toBe("1");
      for (const removed of ["CLICOLOR_FORCE", "GH_FORCE_TTY", "GH_DEBUG", "DEBUG", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
        expect(request.environment).not.toHaveProperty(removed);
      }
    },
  );
});

describe("createGitHubIssuesAdapter stderr excerpt masking", () => {
  it.each([
    { description: "a ghp_ token", token: `ghp_${"a".repeat(36)}`, residue: "a".repeat(20) },
    { description: "a github_pat_ token", token: `github_pat_${"b".repeat(36)}`, residue: "b".repeat(20) },
  ])("fully masks $description in the excerpt with no residual characters", async ({ token, residue }) => {
    const runGh = fakeRun(buildLaunchedResult({ exitCode: 1, stderr: buildCapture(`Bad credentials: ${token}`) }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toContain("[REDACTED]");
    expect(error.reason).not.toContain(token);
    expect(error.reason).not.toContain(residue);
  });

  it("truncates an excerpt line over 200 code points to 200 code points plus an ellipsis", async () => {
    const longLine = "x".repeat(250);
    const runGh = fakeRun(buildLaunchedResult({ exitCode: 1, stderr: buildCapture(longLine) }));
    const adapter = createGitHubIssuesAdapter(buildDependencies({ runGh }));

    const error = expectIssueImportError(await adapter.readIssue("octo/repo#42"));

    expect(error.reason).toBe(
      `gh could not read the issue (not found, no access, or no connection): ${"x".repeat(200)}...`,
    );
  });
});
