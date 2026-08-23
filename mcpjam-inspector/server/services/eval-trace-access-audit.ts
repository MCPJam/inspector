/**
 * Inspector-side client for the backend's eval per-iteration read audit
 * (`POST /internal/v1/evals/iteration-read`; see mcpjam-backend
 * `convex/http.ts` and `convex/evalTraceAccessAudit.ts`).
 *
 * ============================================================================
 * WHY THIS FORWARDS TWO CREDENTIALS
 * ============================================================================
 *
 * The backend route wants both, for two different reasons, and neither
 * substitutes for the other:
 *
 *   * `x-inspector-service-token` AUTHORIZES the call. Writing an audit row on
 *     someone else's behalf is a privileged act, and possession of this token
 *     is what says the caller is our deployed server rather than the public.
 *
 *   * `Authorization: Bearer <convex jwt>` NAMES THE HUMAN. The backend
 *     resolves the actor from it.
 *
 * The identity deliberately is NOT derived here. Our own view of the caller is
 * uneven: `mcpjamUserId` is set only on the API-key branch of `bearer-auth`,
 * and the eval v1 routes do not mount `optional-actor`. Deriving the actor at
 * this layer would therefore attribute API-key reads and silently DROP session
 * reads — an audit trail blank for exactly the callers someone is most likely
 * asking about, which is worse than an empty one because it looks like an
 * answer. `getConvexBearerForRequest` already hands back a bearer for BOTH
 * kinds of caller (a session JWT passed through, or a delegated JWT minted for
 * an API key's WorkOS user), and both carry the person's `externalId` as
 * `sub`, so forwarding it lets one backend path resolve either.
 *
 * ============================================================================
 * DEPLOY ORDERING
 * ============================================================================
 *
 * The backend route must be deployed BEFORE this ships. Until then the request
 * hits Convex's routing 404 — which `recordEvalIterationRead` treats like any
 * other failure: it logs once and the read still returns. That is a
 * deliberately soft landing rather than a guarantee the ordering does not
 * matter; an undeployed backend means no audit rows at all, which is the
 * failure this lane exists to remove.
 */

import { getInternalBackendConfig } from "./internal-backend.js";
import { reportRouteFailure } from "../utils/route-error-report.js";

const ITERATION_READ_PATH = "/internal/v1/evals/iteration-read";

/**
 * How long the audit POST may stay in flight.
 *
 * `fetch` has no default timeout, so a backend that accepts the connection and
 * then stalls would hold this request — and its socket — open indefinitely.
 * The call is detached from the read path (see below), so this deadline is not
 * about latency; it is about not accumulating pending work under a backend
 * that is up enough to accept connections and not up enough to answer.
 */
const AUDIT_REQUEST_TIMEOUT_MS = 5_000;

/** Which of the two per-iteration read routes served the request. */
export type EvalIterationReadMode = "trace" | "steps";

export interface EvalIterationReadAudit {
  /** The Convex bearer for the CALLING user — never the service token. */
  convexAuthToken: string;
  iterationId: string;
  mode: EvalIterationReadMode;
  /**
   * Size of the trace envelope that was served, when one resolved at all.
   *
   * Omitted — not zero — when no trace resolved, which is the ordinary case
   * for a `steps` read of a still-running iteration. "There was no trace" and
   * "the trace was empty" are different facts and the backend keeps them
   * distinct.
   */
  traceBytes?: number;
  stepCount?: number;
}

/**
 * Record one per-iteration read, best-effort.
 *
 * NEVER throws and never rejects: this is called AFTER the read the caller
 * asked for has already resolved, so a backend outage, an undeployed route or
 * a slow network must not turn a served response into a 500. A failure is
 * reported once through the centralized path and swallowed.
 *
 * Callers DETACH this rather than awaiting it (`void recordEvalIterationRead`).
 * Awaiting would put a best-effort audit write on the critical path of a read
 * that has already succeeded — a stalled backend would then show up as a slow
 * `/trace`, which is the caller's problem for our bookkeeping. Detaching is
 * safe precisely because this function swallows its own failures: there is no
 * rejection to go unhandled.
 *
 * That trade only works in a long-lived process, which is what the Inspector
 * server is (Railway / Electron), NOT a serverless invocation that may be
 * frozen the moment its response is returned. Revisit if that ever changes —
 * there the row would be silently lost.
 */
export async function recordEvalIterationRead(
  audit: EvalIterationReadAudit
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AUDIT_REQUEST_TIMEOUT_MS
  );
  try {
    const { convexUrl, serviceToken } = getInternalBackendConfig();
    const response = await fetch(`${convexUrl}${ITERATION_READ_PATH}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
        // The CALLER's bearer. The backend reads the actor off this; the
        // service token above is only permission to ask.
        authorization: `Bearer ${audit.convexAuthToken}`,
      },
      body: JSON.stringify({
        iterationId: audit.iterationId,
        mode: audit.mode,
        ...(audit.traceBytes !== undefined
          ? { traceBytes: audit.traceBytes }
          : {}),
        ...(audit.stepCount !== undefined
          ? { stepCount: audit.stepCount }
          : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`eval iteration-read audit returned ${response.status}`);
    }
  } catch (error) {
    // `hop: "mcpjam_internal"` — this is our own backend, so a failure here is
    // ours to fix rather than a caller's or a third-party server's.
    reportRouteFailure("[v1.evals] iteration read not audited", error, {
      source: "v1.evals.iteration-read-audit",
      hop: "mcpjam_internal",
      context: { mode: audit.mode },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Byte size of a resolved trace envelope, or `undefined` when there is none.
 *
 * A size, never a sample: the audit answers "how much left the product", not
 * "what was in it". Serialization failure yields `undefined` rather than a
 * guess — a wrong number in an audit row is worse than an absent one.
 */
export function measureTraceBytes(trace: unknown): number | undefined {
  if (trace === null || trace === undefined) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(trace) ?? "", "utf8");
  } catch {
    return undefined;
  }
}
