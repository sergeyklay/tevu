/** The `IssueTrackerAdapter` contract, with the result shape only it uses. */

import type { TevuResult } from '@/domain/errors';

/** One tracker issue read once during task creation. */
export type IssueSnapshot = {
  /** Jira: issue key. GitHub: `OWNER/REPO#NUMBER` from gh's `url` field. */
  issueKey: string;
  issueUrl: string;
  /** Jira: summary. GitHub: title. */
  summary: string;
  /** Jira: plain-text projection. GitHub: Markdown body, unmodified. */
  description: string;
};

/** Read-only, one-time issue import shared by every tracker adapter. */
export interface IssueTrackerAdapter {
  readIssue(
    reference: string,
  ): Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>>;
}
