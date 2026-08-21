/**
 * The /conformance page's two ways to grade a server against a directory.
 *
 * ## The hosted half is the SDK's client, not a copy of it
 *
 * `PlatformApiClient` already speaks every one of these endpoints, with typed
 * parameters, URL encoding, a timeout, and — for the starts — a field-by-field
 * body build that exists because the routes are `strictObject` and an unknown
 * key is a 400 rather than an ignored extra. This module previously
 * hand-rolled all of that, including a second copy of that last rule, written
 * from the same reasoning without knowing the first existed. Two
 * implementations of one wire contract drift; the one nobody is looking at
 * drifts first.
 *
 * It is safe to use here: `sdk/src/platform` is CI-guarded against `node:`
 * imports and `process.env` on both source and dist, precisely so it can run
 * in a browser and a Worker as well as in Node.
 *
 * ## Why the transport is wrapped
 *
 * The client sets its own `authorization` header from `getAuth`. `authFetch`
 * treats a caller-provided Authorization as "this caller owns its auth" and
 * skips BOTH its own header and its refresh-and-retry on 401 — so passing the
 * client straight through would quietly cost the session self-healing that
 * every other hosted call in this app has. Stripping the header on the way
 * out hands ownership back to `authFetch`, which is the component that knows
 * how to renew it.
 *
 * ## The local half is a different shape and stays hand-written
 *
 * Local runs are synchronous, free, unpersisted, and structurally unable to
 * spend — the route has no observations flag at all. That is one `localPost`,
 * not a lifecycle, and there is no platform client for `/api/mcp`.
 */

import { PlatformApiClient } from "@mcpjam/sdk/platform";
import type {
  PlatformReadinessRun,
  PlatformReadinessRunReceipt,
  PlatformReadinessSubmissionMode,
} from "@mcpjam/sdk/platform";
import type {
  ClaudeReadinessResult,
  OpenAIReadinessResult,
  OpenAISubmissionMode,
} from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { localPost } from "@/lib/apis/local-post";
import {
  getHostedProjectId,
  resolveHostedServerId,
  tryResolveProjectServer,
} from "@/lib/apis/web/context";

export type DirectoryReadinessPublisher = "claude" | "openai";

export type DirectoryReadinessResult =
  | ClaudeReadinessResult
  | OpenAIReadinessResult;

/** The run row and receipt, named by the contract that produces them. */
export type ReadinessRun = PlatformReadinessRun;
export type ReadinessRunReceipt = PlatformReadinessRunReceipt;
export type ReadinessRunStatus = PlatformReadinessRun["status"];
export type HostedSubmissionMode = PlatformReadinessSubmissionMode;

/**
 * The submission shapes a HOSTED run can grade.
 *
 * Two of OpenAI's four carry a package and there is no upload for it, so those
 * only ever run on the CLI. Offering them here and failing at the API would
 * teach a submitter that readiness is broken rather than that they are on the
 * wrong surface. Typed against the platform union so a fifth mode cannot
 * appear here without this list being reconsidered.
 */
export const HOSTED_SUBMISSION_MODES = [
  "mcp-only",
  "mcp-imported-skills",
] as const satisfies readonly HostedSubmissionMode[];

/** Terminal states: nothing about this run will change again. */
export function isTerminalRunStatus(status: ReadinessRunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/** True when the app can reach the hosted run lifecycle for this server. */
export function canRunHostedReadiness(serverNameOrId: string): boolean {
  return tryResolveProjectServer(serverNameOrId) !== null;
}

/**
 * `authFetch`, with the client's own Authorization removed.
 *
 * See the module header: leaving it in place makes `authFetch` treat this as a
 * caller that owns its credentials, and the 401 refresh-and-retry is exactly
 * what a long poll against a session that expires mid-run needs.
 */
const readinessFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return authFetch(input as Parameters<typeof authFetch>[0], {
    ...init,
    headers,
  });
};

function client(): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "/api/v1",
    // Empty on purpose — `readinessFetch` strips it and `authFetch` supplies
    // the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: readinessFetch,
  });
}

// ── Local: synchronous, free, no run row ────────────────────────────────

export async function runLocalReadiness(
  publisher: DirectoryReadinessPublisher,
  serverNameOrId: string,
  options?: { submissionMode?: OpenAISubmissionMode },
): Promise<{ success: boolean; result: DirectoryReadinessResult }> {
  return localPost(`/api/mcp/conformance/readiness/${publisher}`, {
    serverId: serverNameOrId,
    ...(options?.submissionMode
      ? { submissionMode: options.submissionMode }
      : {}),
  });
}

// ── Hosted: start, poll, cancel, report ─────────────────────────────────

export async function startHostedReadiness(
  publisher: DirectoryReadinessPublisher,
  serverNameOrId: string,
  options: {
    submissionMode?: HostedSubmissionMode;
    includeLlmObservations?: boolean;
    idempotencyKey?: string;
  } = {},
): Promise<ReadinessRunReceipt> {
  const projectId = getHostedProjectId();
  const serverId = resolveHostedServerId(serverNameOrId);
  const shared = {
    projectId,
    serverId,
    ...(options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
    ...(options.includeLlmObservations === true
      ? { includeLlmObservations: true }
      : {}),
  };

  if (publisher === "openai") {
    if (!options.submissionMode) {
      // Never inferred: a guessed mode reports the package lane
      // `not-applicable`, which turns a missing input into a clean bill.
      throw new Error(
        "An OpenAI readiness run needs a declared submission mode.",
      );
    }
    return client().startOpenAIReadinessRun({
      ...shared,
      submissionMode: options.submissionMode,
    });
  }
  return client().startClaudeReadinessRun(shared);
}

export async function getHostedReadinessRun(
  runId: string,
  signal?: AbortSignal,
): Promise<ReadinessRun> {
  return client().getReadinessRun(
    { projectId: getHostedProjectId(), runId },
    { signal },
  );
}

/**
 * The newest run for this server and publisher, for a page that was reloaded.
 *
 * Only ever a FALLBACK for a mount with no run id in hand: two runs started
 * close together make "the newest" the wrong answer for whoever was watching
 * the older one.
 */
export async function findLatestHostedReadinessRun(
  publisher: DirectoryReadinessPublisher,
  serverNameOrId: string,
  signal?: AbortSignal,
): Promise<ReadinessRun | null> {
  const scope = tryResolveProjectServer(serverNameOrId);
  if (!scope) return null;
  const page = await client().listReadinessRuns(
    {
      projectId: scope.projectId,
      readinessKind: publisher,
      serverId: scope.serverId,
      limit: 1,
    },
    { signal },
  );
  return page.items[0] ?? null;
}

/**
 * Ask the platform to stop.
 *
 * The response is a synthetic `cancelled` rather than the row: the executing
 * node learns on its next heartbeat, so the run's REAL terminal state arrives
 * on a later poll. Callers keep polling after this returns.
 */
export async function cancelHostedReadinessRun(runId: string): Promise<void> {
  await client().cancelReadinessRun({
    projectId: getHostedProjectId(),
    runId,
  });
}

/**
 * The full graded report, fetched lazily.
 *
 * Megabytes are possible and the run row already carries everything the
 * collapsed section renders, so this is called when a reader opens the
 * findings rather than alongside every poll.
 */
export async function getHostedReadinessReport(
  runId: string,
  signal?: AbortSignal,
): Promise<DirectoryReadinessResult> {
  const report = await client().getReadinessReport(
    { projectId: getHostedProjectId(), runId },
    { signal },
  );
  // `unknown` by design at the client boundary — the narrow type lives in the
  // browser entry, and the caller narrows with `isOpenAIReadinessResult`.
  return report as DirectoryReadinessResult;
}
