/**
 * A submission run's reviewer path: the checks that sign in as the
 * directory's reviewer, and discovery requested under other client
 * signatures.
 *
 * THE REVIEWER-ONLY RULE. Reviewer checks use the reviewer account's
 * credential and nothing else. The saved server's own credential is the
 * requester's, often a staff member's, and a rehearsal that passes as staff is
 * how a submission passes here and fails review. A run started without a
 * reviewer account reports those checks blocked, with the reason, and never
 * falls back to the run's other credential.
 */

import {
  directoryReviewerSpec,
  gatherDirectoryReviewerPath,
  probeDirectoryClientSignatures,
  type DirectoryAnswer,
  type DirectoryClientSignatureProbe,
  type DirectoryFlow,
  type DirectoryReviewerRunInput,
} from "@mcpjam/sdk";

/** The reviewer account a run was started with, or why it has none. */
export type ReadinessReviewerAccount =
  | { accountId: string; mcpHeaders: Record<string, string> }
  | { missing: string };

export interface ReviewerPathOptions {
  account: ReadinessReviewerAccount;
  flow: DirectoryFlow;
  answers: readonly DirectoryAnswer[];
}

/**
 * After the server's own evidence, so the probe requests the documents its
 * discovery found. Shares the run's transport, budget and cancellation.
 */
export async function gatherReviewerPath(
  options: ReviewerPathOptions,
  run: {
    target: string;
    fetchFn: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  documents: Partial<Record<DirectoryClientSignatureProbe["document"], string>>,
): Promise<DirectoryReviewerRunInput> {
  const { account } = options;
  const reviewerPath = await gatherDirectoryReviewerPath({
    account:
      "missing" in account
        ? account
        : {
            id: account.accountId,
            dial: {
              enteredUrl: run.target,
              fetchFn: run.fetchFn,
              mcpHeaders: account.mcpHeaders,
              signal: run.signal,
              timeoutMs: run.timeoutMs,
            },
          },
    spec: directoryReviewerSpec(options.flow, options.answers),
  });
  const clientSignatures = await probeDirectoryClientSignatures({
    documents,
    fetchFn: run.fetchFn,
    signal: run.signal,
  });
  return { reviewerPath, clientSignatures };
}
