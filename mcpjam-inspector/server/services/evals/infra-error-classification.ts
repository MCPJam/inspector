/**
 * Did OUR infrastructure fail this trial — and if so, how?
 *
 * A classified trial is recorded `status: "failed"` + `infraError` (see
 * `@/shared/eval-infra-error`), which every reader leaves out of the verdict
 * and the backend refunds. The rules, all fail-closed (unclassified keeps
 * counting, the safe direction):
 *
 *  1. Only producer-typed evidence (`utils/infra-failure-evidence.ts`); prose
 *     is never read, and a status the customer's MCP server or a tool returned
 *     never reaches a producer.
 *  2. A model-layer failure counts only from an endpoint WE or a first-party
 *     hosted provider control. A customer-controlled endpoint (`custom:`,
 *     Ollama, a base-URL deployment) can answer 503 at will.
 *  3. Our backend's codes are an allowlist, read before any status: `/stream`
 *     answers what it could not categorize with `unknown_error` + 500, and its
 *     own response status never stands in for the provider's.
 *  4. The harness model proxy answers its own refusals (lease caps, its own
 *     failures) with {@link HARNESS_PROXY_REFUSAL_STATUS}; a lease budget is a
 *     turn budget, so it counts like a turn timeout.
 *
 * A turn timeout never reaches this: the runner records it as measured first.
 */
import type {
  EvalInfraError,
  EvalInfraErrorClass,
  EvalInfraErrorLayer,
} from "@/shared/eval-infra-error";
import { accountLimitCode } from "@/shared/swarm-attempt-error";
import type { InfraFailureEvidence } from "../../utils/infra-failure-evidence.js";
import { classifyRetry } from "../../utils/run-supervisor/retry.js";

/**
 * The status the backend's harness model proxy answers ITS OWN refusals with
 * (`HARNESS_PROXY_REFUSAL_STATUS` in `convex/http.ts`): never a provider's.
 */
export const HARNESS_PROXY_REFUSAL_STATUS = 409;

type Row = {
  class: EvalInfraErrorClass;
  layer: EvalInfraErrorLayer;
  retryable: boolean;
};

const MODEL = "model" as const;

/**
 * An account or admission limit, matched exactly against the list in
 * `shared/swarm-attempt-error.ts` — minus `guest_input_too_large`, which the
 * server under test's own oversized output can trip.
 */
function isAccountLimitCode(code: string): boolean {
  return (
    code !== "guest_input_too_large" &&
    accountLimitCode(undefined, code) === code
  );
}

/** Backend codes whose meaning does not depend on a status. */
const BACKEND_CODE_TABLE: Readonly<Record<string, Row>> = {
  // The gateway's upstream throttle; also on the account-limit list, so first.
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

/** An upstream status read as a provider failure, or `undefined`. */
function upstreamStatusRow(status: number | undefined): Row | undefined {
  if (status === 429)
    return { class: "rate_limited", layer: MODEL, retryable: true };
  if (status !== undefined && status >= 500) {
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
    // Minted from message text when the error had no status; a provider error
    // is ours only when the provider itself answered 429/5xx.
    case "provider_overloaded":
    case "streaming_error":
    case "provider_error":
      return upstreamStatusRow(status);
    // Thrown only for a failure the backend already judged provider-side
    // (network, 5xx, 401/403/404/408/429) under a no-fallback selection.
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
      // `unknown_error`, `invalid_request`, and anything unknown.
      return undefined;
  }
}

/** Agent-runtime codes, minted by the bridges from the runtime's own types. */
const HARNESS_CODE_TABLE: Readonly<Record<string, Row>> = {
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

/** Codex connection-level variants: decided by their upstream status. */
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
  // The model proxy's own refusal: a lease cap or a proxy failure.
  if (status === HARNESS_PROXY_REFUSAL_STATUS || !code) return undefined;
  const row = HARNESS_CODE_TABLE[code];
  if (row) return row;
  if (!CODEX_CONNECTION_CODES.has(code)) return undefined;
  // No status: the connection itself failed on our provider path.
  if (status === undefined) {
    return { class: "provider_unavailable", layer: MODEL, retryable: true };
  }
  if (status === 401 || status === 403) {
    return { class: "auth", layer: MODEL, retryable: false };
  }
  return upstreamStatusRow(status);
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

const CAPACITY_CODES = new Set(["at_capacity", "sandbox_at_capacity"]);
/** The box itself is gone or past its ceiling. */
const SANDBOX_GONE_CODES = new Set(["sandbox_not_found", "sandbox_expiring"]);

/**
 * A typed setup failure counts only on a known code or a status that says our
 * side failed (408, 429, 5xx). A 400/403/404/422 from the control plane or the
 * broker is a refusal of this request, not an outage: unclassified.
 */
function classifySetup(
  layer: "sandbox" | "platform",
  code: string | undefined,
  status: number | undefined,
): Row | undefined {
  if (code && CAPACITY_CODES.has(code)) {
    return { class: "capacity", layer, retryable: true };
  }
  if (code && SANDBOX_GONE_CODES.has(code)) {
    return { class: "sandbox", layer: "sandbox", retryable: false };
  }
  if (code && isAccountLimitCode(code)) {
    return { class: "account_limit", layer: "platform", retryable: false };
  }
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return { class: "sandbox", layer, retryable: true };
  }
  return undefined;
}

/**
 * Classify a failed turn's structured evidence, or `undefined` when it is not
 * (provably) an infrastructure failure.
 */
export function classifyEvalInfraError(
  evidence: InfraFailureEvidence | undefined,
): EvalInfraError | undefined {
  if (!evidence) return undefined;
  const { code, httpStatus, endpoint } = evidence;
  const ourEndpoint = endpoint === "platform" || endpoint === "byok_hosted";
  let row: Row | undefined;
  switch (evidence.source) {
    case "backend_model":
      row = ourEndpoint ? classifyBackendModel(code, httpStatus) : undefined;
      break;
    case "harness_runtime":
      row = ourEndpoint ? classifyHarnessRuntime(code, httpStatus) : undefined;
      break;
    case "provider_call":
      row = ourEndpoint ? classifyProviderCall(httpStatus) : undefined;
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
