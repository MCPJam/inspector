/**
 * One run's iterations, read for the CHAIN each one carries.
 *
 * ── Why this read exists at all ──────────────────────────────────────────────
 *
 * D9's decision summary carries a per-trial chain, and the browser already
 * fetches it — but for NON-PASSING trials only. That filter is in the contract
 * assembler and is deliberate: diagnostics are evidence beneath a verdict, and
 * a trial that passed is not evidence of anything going wrong. It does mean a
 * reader who opens a passing trial has nothing to read, which is the gap this
 * closes: the iterations resource projects the same stage columns over every
 * row of the run, passing included.
 *
 * ── One chain type, one validator ────────────────────────────────────────────
 *
 * The rows are handed to the CONTRACT's own `assembleEvalRunDecisionChain`,
 * the same function D9's summary is built from. Two consequences, both the
 * point:
 *
 *   - the result is `EvalRunDecisionChain` — the type the decision card and
 *     the trial cards already render. No adapter type, no second shape;
 *   - the whole derivation is validated, not the rows one at a time. Row-level
 *     validation would accept five rows, or six out of order, and a renderer
 *     that numbers cards by position would then publish a different claim
 *     about which stages were blocked, because `notReached` is derived from
 *     POSITION.
 *
 * ── The bearer has one owner ─────────────────────────────────────────────────
 *
 * Same shim as the stage-analytics reader: the client's own `Authorization` is
 * stripped and `authFetch` supplies the real one. The route needs an entry in
 * `HOSTED_AUTH_PATH_PATTERNS`; without it this ships no header at all and the
 * 401 surfaces as "could not be loaded", which reads as a backend outage.
 */
import {
  assembleEvalRunDecisionChain,
  type EvalRunDecisionChain,
} from "@mcpjam/sdk/contract";
import { PlatformApiClient, isPlatformApiError } from "@mcpjam/sdk/platform";
import { authFetch } from "@/lib/session-token";

export type EvalRunIterationsFailureKind =
  | "notFound"
  | "routeUnavailable"
  | "invalidContract"
  | "requestFailed";

export class EvalRunIterationsError extends Error {
  readonly kind: EvalRunIterationsFailureKind;
  readonly status?: number;

  constructor(
    kind: EvalRunIterationsFailureKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EvalRunIterationsError";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
  }
}

export function isEvalRunIterationsError(
  error: unknown,
): error is EvalRunIterationsError {
  return error instanceof EvalRunIterationsError;
}

/** One trial's chain, keyed by the iteration it belongs to. */
export interface EvalRunIterationChain {
  iterationId: string;
  chain: EvalRunDecisionChain;
}

export interface EvalRunIterationChainsPage {
  items: EvalRunIterationChain[];
  /** Absent means this was the last page. */
  nextCursor?: string;
}

const iterationsFetch: typeof fetch = (input, init) => {
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
    // Empty on purpose — `iterationsFetch` strips it and `authFetch` supplies
    // the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: iterationsFetch,
  });
}

/**
 * A deployment without the route, as opposed to a run that is not there.
 *
 * Same discrimination the stage-analytics reader makes, and needed for the
 * same reason: `STATUS_FALLBACK_CODES` maps a bare 404 to `NOT_FOUND` exactly
 * like an enveloped one, so only the code's SOURCE separates "this build does
 * not serve that" from "no such run".
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

export async function fetchEvalRunIterationChains(
  params: {
    projectId: string;
    runId: string;
    cursor?: string;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<EvalRunIterationChainsPage> {
  let raw: unknown;
  try {
    raw = await client().listEvalRunIterations(
      {
        projectId: params.projectId,
        runId: params.runId,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      },
      { signal },
    );
  } catch (error) {
    // A caller's abort is the caller's, not a failure of the read.
    if (signal?.aborted) throw error;
    if (isPlatformApiError(error)) {
      if (isRouteUnavailable(error.status, error.code, error.codeSource)) {
        throw new EvalRunIterationsError(
          "routeUnavailable",
          "This deployment does not serve eval run iterations.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new EvalRunIterationsError("notFound", error.message, {
          status: error.status,
          cause: error,
        });
      }
      throw new EvalRunIterationsError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalRunIterationsError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const envelope = raw as { items?: unknown; nextCursor?: unknown } | null;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !Array.isArray(envelope.items)
  ) {
    throw new EvalRunIterationsError(
      "invalidContract",
      "The iterations response was not a page envelope.",
    );
  }
  if (
    envelope.nextCursor !== undefined &&
    typeof envelope.nextCursor !== "string"
  ) {
    throw new EvalRunIterationsError(
      "invalidContract",
      "The iterations page cursor was not a string.",
    );
  }

  const items: EvalRunIterationChain[] = [];
  for (const row of envelope.items) {
    const iteration = row as {
      id?: unknown;
      stageResults?: unknown;
      firstFailedStage?: unknown;
      failureCategory?: unknown;
      stageAnalyzerVersion?: unknown;
      stageResultsUnverified?: unknown;
    } | null;
    if (!iteration || typeof iteration !== "object") {
      throw new EvalRunIterationsError(
        "invalidContract",
        "An iterations page entry was not an object.",
      );
    }
    // IDENTITY, not shape. A row with no id cannot be joined to anything on
    // screen, and joining it to the wrong trial is worse than dropping it.
    if (typeof iteration.id !== "string" || iteration.id.length === 0) {
      throw new EvalRunIterationsError(
        "invalidContract",
        "An iterations page entry carried no iteration id.",
      );
    }
    items.push({
      iterationId: iteration.id,
      // The contract decides `verified` / `unverified` / `absent`. Nothing
      // here inspects the rows itself, which is what keeps this reader from
      // becoming a second opinion about whether a chain may be believed.
      chain: assembleEvalRunDecisionChain(
        iteration as Parameters<typeof assembleEvalRunDecisionChain>[0],
      ),
    });
  }

  return {
    items,
    ...(typeof envelope.nextCursor === "string"
      ? { nextCursor: envelope.nextCursor }
      : {}),
  };
}
