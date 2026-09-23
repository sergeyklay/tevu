import { Buffer } from "node:buffer";

import type { IssueSnapshot, IssueTrackerAdapter, TevuResult } from "../../domain/types.ts";

/** Jira Cloud connection settings; credentials are read by environment variable name only. */
export type JiraCloudSettings = {
  baseUrl: string;
  emailEnvironmentVariable: string;
  tokenEnvironmentVariable: string;
};

/** Minimal structural response contract so tests can inject plain fakes. */
export type JiraHttpResponse = {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
};

/** Injected HTTP transport; redirects are never followed automatically. */
export type JiraFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; redirect: "manual" },
) => Promise<JiraHttpResponse>;

/** Effects injected into the Jira Cloud adapter; credentials are read by name only. */
export type JiraCloudDependencies = {
  fetch: JiraFetch;
  sleep: (milliseconds: number) => Promise<void>;
  getEnvironmentVariable: (name: string) => string | undefined;
};

/** Shared budget: at most three total requests per import, regardless of response class. */
const MAX_REQUESTS = 3;

/** Delay before the next request after a network failure or 5xx on attempts 1 and 2. */
const RETRY_DELAYS_MS: readonly number[] = [500, 1500];

const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * Creates the read-only, one-time Jira Cloud issue importer.
 *
 * Requests only summary and description over HTTPS with Basic authentication
 * from the configured environment variable names, rejects cross-origin
 * redirects, never persists or reports credential values, and never issues a
 * fourth request in one import.
 */
export function createJiraCloudAdapter(
  settings: JiraCloudSettings,
  dependencies: JiraCloudDependencies,
): IssueTrackerAdapter {
  return {
    async readIssue(
      issueKey: string,
    ): Promise<TevuResult<IssueSnapshot, "IssueImportError" | "CancellationError">> {
      const email = dependencies.getEnvironmentVariable(settings.emailEnvironmentVariable);
      if (email === undefined || email.length === 0) {
        return importError(issueKey, undefined, `environment variable "${settings.emailEnvironmentVariable}" is not set`);
      }
      const token = dependencies.getEnvironmentVariable(settings.tokenEnvironmentVariable);
      if (token === undefined || token.length === 0) {
        return importError(issueKey, undefined, `environment variable "${settings.tokenEnvironmentVariable}" is not set`);
      }

      let base: URL;
      try {
        base = new URL(settings.baseUrl);
      } catch {
        return importError(issueKey, undefined, "configured Jira base URL is malformed");
      }
      if (base.protocol !== "https:") {
        return importError(issueKey, undefined, "configured Jira base URL must use HTTPS");
      }

      const baseUrl = settings.baseUrl.replace(/\/+$/, "");
      const headers: Record<string, string> = {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`,
        Accept: "application/json",
      };

      let target = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description`;
      let requests = 0;

      while (requests < MAX_REQUESTS) {
        requests += 1;

        let response: JiraHttpResponse;
        try {
          response = await dependencies.fetch(target, { method: "GET", headers, redirect: "manual" });
        } catch {
          if (requests >= MAX_REQUESTS) {
            return importError(issueKey, undefined, `network failure on final attempt ${requests}`);
          }
          await dependencies.sleep(RETRY_DELAYS_MS[requests - 1] ?? 0);
          continue;
        }

        const status = response.status;

        if (status >= 300 && status < 400) {
          const location = response.headers.get("location");
          if (location === null) {
            return importError(issueKey, status, "redirect response without a Location header");
          }
          let redirected: URL;
          try {
            redirected = new URL(location, target);
          } catch {
            return importError(issueKey, status, "redirect response with a malformed Location header");
          }
          if (redirected.origin !== base.origin) {
            return importError(issueKey, status, `cross-origin redirect to ${redirected.origin} rejected`);
          }
          if (requests >= MAX_REQUESTS) {
            return importError(issueKey, status, "same-origin redirect would exceed the three-request budget");
          }
          target = redirected.toString();
          continue;
        }

        if (status === 429) {
          const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
          if (retryAfterSeconds === null) {
            return importError(
              issueKey,
              status,
              `rate limited with a missing, malformed, negative, or greater-than-${MAX_RETRY_AFTER_SECONDS}-second Retry-After`,
            );
          }
          if (requests >= MAX_REQUESTS) {
            return importError(issueKey, status, "rate limited on the final attempt of the three-request budget");
          }
          await dependencies.sleep(retryAfterSeconds * 1000);
          continue;
        }

        if (status >= 500) {
          if (requests >= MAX_REQUESTS) {
            return importError(issueKey, status, `server error ${status} on the final attempt`);
          }
          await dependencies.sleep(RETRY_DELAYS_MS[requests - 1] ?? 0);
          continue;
        }

        if (status < 200 || status >= 300) {
          return importError(issueKey, status, `issue is missing or inaccessible (HTTP ${status})`);
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return importError(issueKey, status, "response body is not valid JSON");
        }
        return decodeIssueResponse(issueKey, baseUrl, status, body);
      }

      return importError(issueKey, undefined, "three-request budget exhausted");
    },
  };
}

/**
 * Projects an Atlassian Document Format value to plain text, preserving the
 * textual descendants of unsupported nodes and turning hard breaks and block
 * boundaries into newlines.
 */
export function projectRichTextToPlainText(node: unknown): string {
  return nodeToText(node).trim();
}

const BLOCK_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "rule",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "panel",
  "mediaGroup",
  "mediaSingle",
  "taskList",
  "taskItem",
  "decisionList",
  "decisionItem",
  "expand",
  "nestedExpand",
]);

function nodeToText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!isRecord(node)) {
    return "";
  }
  if (node["type"] === "hardBreak") {
    return "\n";
  }
  if (typeof node["text"] === "string") {
    return node["text"];
  }
  const content = Array.isArray(node["content"]) ? node["content"] : [];
  if (content.length === 0) {
    const attrs = isRecord(node["attrs"]) ? node["attrs"] : {};
    const attrText = attrs["text"] ?? attrs["shortName"];
    return typeof attrText === "string" ? attrText : "";
  }
  const text = content.map(nodeToText).join("");
  return BLOCK_NODE_TYPES.has(String(node["type"])) && text.length > 0 && !text.endsWith("\n")
    ? `${text}\n`
    : text;
}

function decodeIssueResponse(
  requestedKey: string,
  baseUrl: string,
  status: number,
  body: unknown,
): TevuResult<IssueSnapshot, "IssueImportError"> {
  if (!isRecord(body) || !isRecord(body["fields"])) {
    return importError(requestedKey, status, "issue response shape is malformed");
  }
  const fields = body["fields"];
  const summary = fields["summary"];
  if (typeof summary !== "string") {
    return importError(requestedKey, status, "issue response is missing a summary field");
  }
  const rawDescription = fields["description"];
  const description =
    rawDescription === null || rawDescription === undefined
      ? ""
      : projectRichTextToPlainText(rawDescription);
  const issueKey = typeof body["key"] === "string" && body["key"].length > 0 ? body["key"] : requestedKey;

  return {
    ok: true,
    value: {
      issueKey,
      issueUrl: `${baseUrl}/browse/${issueKey}`,
      summary,
      description,
    },
  };
}

/** Parses Retry-After as integer seconds from 0 through 30; anything else is malformed. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const seconds = Number.parseInt(trimmed, 10);
  return seconds > MAX_RETRY_AFTER_SECONDS ? null : seconds;
}

function importError(
  issueKey: string,
  status: number | undefined,
  reason: string,
): {
  ok: false;
  error: { kind: "IssueImportError"; tracker: "jira-cloud"; reference: string; status?: number; reason: string };
} {
  return {
    ok: false,
    error:
      status === undefined
        ? { kind: "IssueImportError", tracker: "jira-cloud", reference: issueKey, reason }
        : { kind: "IssueImportError", tracker: "jira-cloud", reference: issueKey, status, reason },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
