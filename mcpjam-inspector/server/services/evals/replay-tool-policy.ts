import type { ConvexHttpClient } from "convex/browser";
import {
  evalSuiteFileToolPolicySchema,
  type EvalSuiteFileToolPolicy,
} from "@mcpjam/sdk/contract";

/** Iteration pages scanned when recovering a source run's tool policy. */
const REPLAY_POLICY_SCAN_PAGE_SIZE = 100;
const REPLAY_POLICY_SCAN_MAX_PAGES = 5;

export class ReplayToolPolicyUnrecoverableError extends Error {
  readonly code = "REPLAY_TOOL_POLICY_UNRECOVERABLE";

  constructor(sourceRunId: string) {
    super(
      `REPLAY_TOOL_POLICY_UNRECOVERABLE: run ${sourceRunId} recorded tool-policy activity but no policy snapshot, so this replay cannot reproduce its restrictions. Replays re-dial the original servers with the original credentials; running unrestricted would execute the calls the source run blocked.`,
    );
    this.name = "ReplayToolPolicyUnrecoverableError";
  }
}

/**
 * Recover the tool policy a source run executed under.
 *
 * A replay is NOT recorded playback: `buildReplayManager` re-dials the original
 * `url` with the original `accessToken`/`refreshToken` (`MCPServerReplayConfig`).
 * So a replay that loses the policy does not merely produce an incomparable
 * run — it performs, for real, the destructive calls the source run refused.
 *
 * The run row cannot carry the policy yet (a backend `toolPolicy` field is
 * Lane B), so the policy is read back from the per-iteration snapshot written
 * by `buildIterationFinishParams`. Iterations of one run always execute under
 * the same policy; the first snapshot found therefore decides, and any
 * disagreement is surfaced rather than silently resolved.
 *
 * Evidence of policy activity (`policyBlockCount` / `policyWarnings`) WITHOUT a
 * recoverable snapshot throws: it means the source predates the snapshot, and
 * guessing "no policy" is the one answer that cannot be safe.
 */
export async function recoverToolPolicyFromSourceRun(args: {
  convexClient: ConvexHttpClient;
  sourceRunId: string;
}): Promise<EvalSuiteFileToolPolicy | undefined> {
  const { convexClient, sourceRunId } = args;
  let cursor: string | null = null;
  let sawPolicyEvidence = false;
  let recovered: EvalSuiteFileToolPolicy | undefined;

  for (let page = 0; page < REPLAY_POLICY_SCAN_MAX_PAGES; page += 1) {
    const result = (await convexClient.query(
      "testSuites:listTestSuiteRunIterations" as any,
      {
        runId: sourceRunId,
        paginationOpts: {
          numItems: REPLAY_POLICY_SCAN_PAGE_SIZE,
          cursor,
        },
      },
    )) as {
      page?: Array<{ metadata?: Record<string, unknown> }>;
      isDone?: boolean;
      continueCursor?: string;
    };

    for (const iteration of result?.page ?? []) {
      const metadata = iteration?.metadata;
      if (!metadata || typeof metadata !== "object") continue;
      if (
        typeof metadata.policyBlockCount === "number" ||
        Array.isArray(metadata.policyWarnings)
      ) {
        sawPolicyEvidence = true;
      }
      if (recovered !== undefined || metadata.toolPolicy === undefined) continue;
      const parsed = evalSuiteFileToolPolicySchema.safeParse(
        metadata.toolPolicy,
      );
      if (parsed.success) {
        recovered = parsed.data;
      } else {
        // A snapshot we cannot validate is not a policy we can re-apply.
        sawPolicyEvidence = true;
      }
    }

    if (result?.isDone !== false || !result?.continueCursor) break;
    cursor = result.continueCursor;
  }

  if (recovered === undefined && sawPolicyEvidence) {
    throw new ReplayToolPolicyUnrecoverableError(sourceRunId);
  }
  return recovered;
}
