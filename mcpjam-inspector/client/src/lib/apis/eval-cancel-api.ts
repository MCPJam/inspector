/**
 * Cancelling an in-flight eval run, through the platform API.
 *
 * The browser used to call `testSuites:cancelTestSuiteRun` straight through
 * Convex. The v1 route wraps that same mutation but adds what a raw mutation
 * cannot: it checks the run actually belongs to the project in the URL, it is
 * idempotent on a run that is already cancelled, and it hands back the run's
 * new state instead of nothing.
 *
 * Transport is wrapped for the reason `eval-disclosure-api.ts` spells out:
 * `PlatformApiClient` would otherwise set its own `Authorization`, and
 * `authFetch` reads that as the caller owning its auth — skipping both its
 * header AND its 401 refresh-and-retry.
 */
import { PlatformApiClient, isPlatformApiError } from "@mcpjam/sdk/platform";
import type { PlatformEvalRun } from "@mcpjam/sdk/platform";
import { authFetch } from "@/lib/session-token";

/** Why a cancel did not happen. */
export type CancelEvalRunFailureKind =
  /** The run is already finished, so there is nothing to stop. */
  | "notCancellable"
  /** No such run in this project — deleted, or the wrong project. */
  | "notFound"
  /** This deployment does not serve the cancel route at all. */
  | "routeUnavailable"
  /** Network, timeout, auth, 5xx — the call did not complete. */
  | "requestFailed";

export class CancelEvalRunError extends Error {
  readonly kind: CancelEvalRunFailureKind;
  readonly status?: number;

  constructor(
    kind: CancelEvalRunFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = "CancelEvalRunError";
    this.kind = kind;
    this.status = options?.status;
  }
}

export function isCancelEvalRunError(
  error: unknown,
): error is CancelEvalRunError {
  return error instanceof CancelEvalRunError;
}

const cancelFetch: typeof fetch = (input, init) => {
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
    // Empty on purpose — `cancelFetch` strips it and `authFetch` supplies the
    // real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: cancelFetch,
  });
}

/**
 * A deployment that predates this route, as opposed to a run that is not there.
 *
 * Same rule as `eval-description-experiment-api.ts`: a BARE 404
 * (`codeSource === "status"`) is a router with no such path, while an
 * enveloped 404 is the route itself reporting a fact about the run. The caller
 * falls back to the Convex mutation on the first and reports the second.
 */
function isRouteUnavailable(
  status: number,
  code: string,
  codeSource?: "envelope" | "status",
): boolean {
  return (
    code === "FEATURE_NOT_SUPPORTED" ||
    code === "NOT_IMPLEMENTED" ||
    status === 501 ||
    status === 405 ||
    (status === 404 && codeSource === "status")
  );
}

/**
 * Stop one run.
 *
 * Resolves with the run in its cancelled state — including when it was already
 * cancelled, which the route treats as a no-op rather than an error.
 */
export async function cancelEvalRun(
  params: { projectId: string; runId: string },
  signal?: AbortSignal,
): Promise<PlatformEvalRun> {
  try {
    return await client().cancelEvalRun(
      { projectId: params.projectId, runId: params.runId },
      { signal },
    );
  } catch (error) {
    // A navigated-away surface must never paint an error.
    if (signal?.aborted) throw error;
    if (isPlatformApiError(error)) {
      if (isRouteUnavailable(error.status, error.code, error.codeSource)) {
        throw new CancelEvalRunError(
          "routeUnavailable",
          "This deployment cannot cancel runs over the API.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new CancelEvalRunError("notFound", "Run not found.", {
          status: error.status,
          cause: error,
        });
      }
      // The run finished between render and click. The envelope remaps the
      // route's 409 to a 400 `VALIDATION_ERROR`, so match on that, and keep
      // the route's own sentence — it names the status the run landed in.
      if (error.status === 400 || error.status === 409) {
        throw new CancelEvalRunError(
          "notCancellable",
          error.message || "This run already finished.",
          { status: error.status, cause: error },
        );
      }
      throw new CancelEvalRunError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new CancelEvalRunError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
