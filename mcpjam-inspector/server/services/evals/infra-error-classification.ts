/**
 * Did OUR infrastructure fail this trial — and if so, how?
 *
 * Every eval trial records two separate facts: did our infrastructure work,
 * and did the agent succeed. This module decides the first one, and the answer
 * is never allowed to leak into the second: a classified trial is recorded
 * `status: "failed"` + `infraError` (see `@/shared/eval-infra-error`), which
 * every reader excludes from the verdict and the backend refunds.
 *
 * THE RULES:
 *
 *  1. TRUSTED SOURCE FIRST. Only evidence a typed producer stamped with its
 *     `source` is read (`utils/infra-failure-evidence.ts`). A 401/429/503 the
 *     customer's MCP server or one of its tools returned never carries one, so
 *     it is never enough. Prose is never read: an error with no structured
 *     evidence stays UNCLASSIFIED and keeps counting, the safe direction.
 *  2. OUR BACKEND'S CODES ARE AN ALLOWLIST. `/stream` answers every failure it
 *     could not categorize with `unknown_error` and a bare 500 — which can be a
 *     tool result that broke the request as easily as an outage. So a
 *     `backend_model` failure classifies ONLY on a provider/account code the
 *     backend assigned, and its status is the UPSTREAM provider's from the
 *     envelope, never our own response's. There is no status-only fallback.
 *  3. THE CODE TABLE before anything status-based. The gateway reports an
 *     upstream 429 as `mcpjam_rate_limit`, which is also on the account-limit
 *     list — asking a status classifier first would file a provider throttle
 *     as a wallet problem. `agent_turn_limit` is the platform's per-user
 *     burst/daily admission cap: `account_limit`, never a turn timeout (the
 *     word "turn" in a code says nothing about a clock).
 *  4. A direct provider call (`provider_call`) has no code, so its status
 *     decides — through {@link classifyRetry} with NO message, so the prose
 *     arm cannot fire.
 *
 * A TURN TIMEOUT is not an input here at all: the runner records it as a
 * measured failure before consulting this. A turn budget is the user's ceiling,
 * and excluding latency-bound failures would inflate scores.
 */
import type {
  EvalInfraError,
  EvalInfraErrorClass,
  EvalInfraErrorLayer,
} from "@/shared/eval-infra-error";
import { accountLimitCode } from "@/shared/swarm-attempt-error";
import type { InfraFailureEvidence } from "../../utils/infra-failure-evidence.js";
import { classifyRetry } from "../../utils/run-supervisor/retry.js";

type Row = {
  class: EvalInfraErrorClass;
  layer: EvalInfraErrorLayer;
  retryable: boolean;
};

const MODEL = "model" as const;

/**
 * An account or admission limit the backend answered with — the list in
 * `shared/swarm-attempt-error.ts`, matched EXACTLY against the code, minus
 * `guest_input_too_large`: an input-size cap can be tripped by the server
 * under test's own oversized tool output. (`mcpjam_rate_limit` is on that list
 * too, but the table below files it first, as the upstream throttle it is.)
 */
function isAccountLimitCode(code: string): boolean {
  return (
    code !== "guest_input_too_large" &&
    accountLimitCode(undefined, code) === code
  );
}

/** Backend codes whose meaning does not depend on a status. */
const BACKEND_CODE_TABLE: Readonly<Record<string, Row>> = {
  mcpjam_rate_limit: { class: "rate_limited", layer: MODEL, retryable: true },
  provider_rate_limit: { class: "rate_limited", layer: MODEL, retryable: true },
  mcpjam_api_error: { class: "auth", layer: MODEL, retryable: false },
  mcpjam_config_error: {
    class: "configuration",
    layer: MODEL,
    retryable: false,
  },
  provider_not_allowlisted: {
    class: "configuration",
    layer: MODEL,
    retryable: false,
  },
  invalid_model: { class: "configuration", layer: MODEL, retryable: false },
  model_retired: { class: "configuration", layer: MODEL, retryable: false },
};

/** An upstream status, read as a provider failure — or `undefined`. */
function upstreamStatusRow(status: number | undefined): Row | undefined {
  if (status === undefined) return undefined;
  if (status === 429)
    return { class: "rate_limited", layer: MODEL, retryable: true };
  if (status >= 500) {
    return { class: "provider_unavailable", layer: MODEL, retryable: true };
  }
  return undefined;
}

function classifyBackendModel(
  code: string | undefined,
  status: number | undefined,
): Row | undefined {
  if (!code) return undefined;
  const row = BACKEND_CODE_TABLE[code];
  if (row) return row;
  if (isAccountLimitCode(code)) {
    return { class: "account_limit", layer: "platform", retryable: false };
  }
  switch (code) {
    // The backend mints both from MESSAGE TEXT when the error carried no
    // status (`categorizeError` in `convex/stream/routes.ts`): "overloaded" or
    // "timeout" anywhere in a generic error. Accepted only with the upstream
    // status that proves a provider answered.
    case "provider_overloaded":
    case "streaming_error":
    // A provider error is ours only when the provider itself failed.
    case "provider_error":
      return upstreamStatusRow(status);
    // Thrown only for a failure the backend's executor already judged
    // PROVIDER-SIDE (network, 5xx, 401/403/404/408/429) when the selection
    // forbade the fallback that would have absorbed it.
    case "fallback_prohibited":
      if (status === 401 || status === 403) {
        return { class: "auth", layer: MODEL, retryable: false };
      }
      if (status === 404) {
        return { class: "configuration", layer: MODEL, retryable: false };
      }
      return (
        upstreamStatusRow(status) ?? {
          class: "provider_unavailable",
          layer: MODEL,
          retryable: true,
        }
      );
    default:
      // `unknown_error`, `invalid_request`, `policy_no_zdr_endpoint`, and every
      // code this table does not know: unclassified.
      return undefined;
  }
}

/** Agent-runtime codes, minted by the bridges from the runtime's own types. */
const HARNESS_CODE_TABLE: Readonly<Record<string, Row>> = {
  // Claude Code (SDK assistant `error` categories; hosted bridge only).
  claude_code_rate_limit: {
    class: "rate_limited",
    layer: MODEL,
    retryable: true,
  },
  claude_code_server_error: {
    class: "provider_unavailable",
    layer: MODEL,
    retryable: true,
  },
  claude_code_overloaded: {
    class: "provider_unavailable",
    layer: MODEL,
    retryable: true,
  },
  claude_code_authentication_failed: {
    class: "auth",
    layer: MODEL,
    retryable: false,
  },
  claude_code_billing_error: {
    class: "account_limit",
    layer: MODEL,
    retryable: false,
  },
  // Codex app-server (`codexErrorInfo` variants with no status dependency).
  codex_serverOverloaded: {
    class: "provider_unavailable",
    layer: MODEL,
    retryable: true,
  },
  codex_internalServerError: {
    class: "provider_unavailable",
    layer: MODEL,
    retryable: true,
  },
  codex_unauthorized: { class: "auth", layer: MODEL, retryable: false },
  codex_usageLimitExceeded: {
    class: "account_limit",
    layer: MODEL,
    retryable: false,
  },
};

/** Codex connection-level variants: the runtime TYPED them as its provider path. */
const CODEX_CONNECTION_CODES = new Set([
  "codex_httpConnectionFailed",
  "codex_responseStreamConnectionFailed",
  "codex_responseStreamDisconnected",
  "codex_responseTooManyFailedAttempts",
]);

function classifyHarnessRuntime(
  code: string | undefined,
  status: number | undefined,
): Row | undefined {
  if (!code) return undefined;
  const row = HARNESS_CODE_TABLE[code];
  if (row) return row;
  if (CODEX_CONNECTION_CODES.has(code)) {
    if (status === 401 || status === 403) {
      return { class: "auth", layer: MODEL, retryable: false };
    }
    return (
      upstreamStatusRow(status) ?? {
        class: "provider_unavailable",
        layer: MODEL,
        retryable: true,
      }
    );
  }
  return undefined;
}

function classifyProviderCall(status: number | undefined): Row | undefined {
  if (status === 401 || status === 403) {
    return { class: "auth", layer: MODEL, retryable: false };
  }
  if (status === undefined) return undefined;
  switch (classifyRetry({ statusCode: status }).class) {
    case "rate_limited":
      return { class: "rate_limited", layer: MODEL, retryable: true };
    case "transient":
      return { class: "provider_unavailable", layer: MODEL, retryable: true };
    default:
      return undefined;
  }
}

/** Codes a control plane uses to say "full, try later" rather than "no". */
const CAPACITY_CODES = new Set(["at_capacity", "sandbox_at_capacity"]);
/** The box itself is gone or past its ceiling: retrying the turn cannot help. */
const SANDBOX_GONE_CODES = new Set(["sandbox_not_found", "sandbox_expiring"]);

function classifySetup(
  layer: "sandbox" | "platform",
  code: string | undefined,
  status: number | undefined,
): Row {
  if (code && CAPACITY_CODES.has(code)) {
    return { class: "capacity", layer, retryable: true };
  }
  // The broker's own billing refusals (`spend_budget_reached`, …).
  if (code && isAccountLimitCode(code)) {
    return { class: "account_limit", layer: "platform", retryable: false };
  }
  // A box that is gone is the SANDBOX layer whoever reported it.
  if (code && SANDBOX_GONE_CODES.has(code)) {
    return { class: "sandbox", layer: "sandbox", retryable: false };
  }
  // A typed setup failure is ours whatever its status says; only its
  // retryability depends on the status.
  const retry = classifyRetry({
    ...(status !== undefined ? { statusCode: status } : {}),
    ...(code ? { code } : {}),
  }).class;
  return {
    class: "sandbox",
    layer,
    retryable:
      status === undefined ||
      retry === "transient" ||
      retry === "capacity" ||
      retry === "rate_limited",
  };
}

/**
 * Classify a failed turn's structured evidence, or return `undefined` when it
 * is not (provably) an infrastructure failure.
 */
export function classifyEvalInfraError(
  evidence: InfraFailureEvidence | undefined,
): EvalInfraError | undefined {
  if (!evidence) return undefined;
  const { code, httpStatus } = evidence;
  let row: Row | undefined;
  switch (evidence.source) {
    case "backend_model":
      row = classifyBackendModel(code, httpStatus);
      break;
    case "harness_runtime":
      row = classifyHarnessRuntime(code, httpStatus);
      break;
    case "provider_call":
      row = classifyProviderCall(httpStatus);
      break;
    case "sandbox_setup":
      row = classifySetup("sandbox", code, httpStatus);
      break;
    case "platform_setup":
      row = classifySetup("platform", code, httpStatus);
      break;
    default:
      return undefined;
  }
  if (!row) return undefined;
  return {
    class: row.class,
    layer: row.layer,
    retryable: row.retryable,
    ...(code ? { code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}
