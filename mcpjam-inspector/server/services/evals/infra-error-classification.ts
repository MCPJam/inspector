/**
 * Did OUR infrastructure fail this trial — and if so, how?
 *
 * Every eval trial records two separate facts: did our infrastructure work,
 * and did the agent succeed. This module decides the first one, and the
 * answer is never allowed to leak into the second: a classified trial is
 * recorded `status: "failed"` + `infraError` (see `@/shared/eval-infra-error`),
 * which every reader excludes from the verdict and the backend refunds.
 *
 * THE RULES, in the order they are applied:
 *
 *  1. TRUSTED SOURCE FIRST. Only evidence a typed producer stamped with one of
 *     OUR layers is considered — a model-provider failure our backend
 *     categorized, a harness bridge's typed provider error, a typed sandbox or
 *     platform setup step. A 401/429/503 that the customer's MCP server or a
 *     tool returned never carries a layer, so it is never enough. Prose is
 *     never read: an error with no structured evidence stays UNCLASSIFIED and
 *     keeps counting, which is the safe direction.
 *  2. THE CODE TABLE before anything status-based. The hosted gateway reports
 *     an upstream 429 as `mcpjam_rate_limit`, which is also on the account-
 *     limit list — asking the generic retry classifier first would file a
 *     provider throttle as a wallet problem. `agent_turn_limit` is the
 *     platform's per-user burst/daily admission cap: `account_limit`, never a
 *     turn timeout (the word "turn" in a code says nothing about a clock).
 *  3. FALLBACK to {@link classifyRetry} with NO MESSAGE — just
 *     `{statusCode, code, retryAfterMs}` — so its prose arm cannot fire.
 *
 * A TURN TIMEOUT is not an input here at all: the runner records it as a
 * measured failure before classification is consulted. A turn budget is the
 * user's ceiling, and excluding (or retrying) latency-bound failures would
 * inflate scores.
 */
import type {
  EvalInfraError,
  EvalInfraErrorClass,
  EvalInfraErrorLayer,
} from "@/shared/eval-infra-error";
import { accountLimitCode } from "@/shared/swarm-attempt-error";
import { classifyRetry } from "../../utils/run-supervisor/retry.js";

/** The structured failure facts a runner holds for a failed turn. */
export type InfraFailureEvidence = {
  /**
   * Which of OUR layers a TYPED producer named. Absent ⇒ the producer had no
   * structured evidence, and the failure is unclassified whatever else is set.
   */
  layer?: EvalInfraErrorLayer;
  code?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  isRetryable?: boolean;
};

/** A classification plus the provider's own wait, for the retry gate (E2). */
export type ClassifiedInfraError = EvalInfraError & {
  /** The provider's Retry-After in ms, when it sent one. Not persisted. */
  retryAfterMs?: number;
};

type TableRow = {
  class: EvalInfraErrorClass;
  /** Overrides the producer's layer when the code itself names one. */
  layer?: EvalInfraErrorLayer;
  retryable: boolean;
};

/**
 * Codes whose meaning does not depend on a status. Harness codes are minted by
 * the bridges from the agent runtime's own typed error categories
 * (`harness-provider-error.ts`), never from text.
 */
const CODE_TABLE: Readonly<Record<string, TableRow>> = {
  provider_overloaded: { class: "provider_unavailable", retryable: true },
  mcpjam_rate_limit: { class: "rate_limited", layer: "model", retryable: true },
  provider_rate_limit: { class: "rate_limited", layer: "model", retryable: true },
  mcpjam_api_error: { class: "auth", layer: "model", retryable: false },
  invalid_model: { class: "configuration", retryable: false },
  model_retired: { class: "configuration", retryable: false },
  // Admission, not execution: no automatic retry in v1.
  agent_turn_limit: { class: "account_limit", layer: "platform", retryable: false },
  at_capacity: { class: "capacity", retryable: true },
  sandbox_at_capacity: { class: "capacity", layer: "sandbox", retryable: true },
  // Claude Code bridge (SDK assistant `error` categories).
  claude_code_rate_limit: { class: "rate_limited", layer: "model", retryable: true },
  claude_code_server_error: { class: "provider_unavailable", layer: "model", retryable: true },
  claude_code_overloaded: { class: "provider_unavailable", layer: "model", retryable: true },
  claude_code_authentication_failed: { class: "auth", layer: "model", retryable: false },
  claude_code_billing_error: { class: "account_limit", layer: "model", retryable: false },
  // Codex app-server (`codexErrorInfo` variants without a status dependency).
  codex_serverOverloaded: { class: "provider_unavailable", layer: "model", retryable: true },
  codex_internalServerError: { class: "provider_unavailable", layer: "model", retryable: true },
  codex_unauthorized: { class: "auth", layer: "model", retryable: false },
  codex_usageLimitExceeded: { class: "account_limit", layer: "model", retryable: false },
  // E2: the runner could not durably record an attempt's first dispatch, so
  // it refused it — our platform failed, and the attempt is never replayed.
  effect_dispatch_unrecorded: { class: "worker_lost", layer: "platform", retryable: false },
};

/** Codex connection-level variants: decided by the upstream status. */
const CODEX_CONNECTION_CODES = new Set([
  "codex_httpConnectionFailed",
  "codex_responseStreamConnectionFailed",
  "codex_responseStreamDisconnected",
  "codex_responseTooManyFailedAttempts",
]);

function build(
  row: TableRow,
  layer: EvalInfraErrorLayer,
  evidence: InfraFailureEvidence,
): ClassifiedInfraError {
  return {
    class: row.class,
    layer: row.layer ?? layer,
    retryable: row.retryable,
    ...(evidence.code ? { code: evidence.code } : {}),
    ...(evidence.httpStatus !== undefined
      ? { httpStatus: evidence.httpStatus }
      : {}),
    ...(evidence.retryAfterMs !== undefined
      ? { retryAfterMs: evidence.retryAfterMs }
      : {}),
  };
}

function byStatus(status: number | undefined): TableRow | undefined {
  if (status === 429) return { class: "rate_limited", retryable: true };
  if (status === 401 || status === 403) return { class: "auth", retryable: false };
  if (status !== undefined && status >= 500)
    return { class: "provider_unavailable", retryable: true };
  return undefined;
}

/**
 * Classify a failed turn's structured evidence, or return `undefined` when it
 * is not (provably) an infrastructure failure.
 */
export function classifyEvalInfraError(
  evidence: InfraFailureEvidence | undefined,
): ClassifiedInfraError | undefined {
  // 1. Trusted source: a typed producer must have named one of OUR layers.
  const layer = evidence?.layer;
  if (!evidence || !layer) return undefined;
  const { code, httpStatus } = evidence;

  // A typed SANDBOX failure is a sandbox failure whatever its status says;
  // only its retryability depends on the status.
  if (layer === "sandbox") {
    const capacity = code !== undefined && CODE_TABLE[code]?.class === "capacity";
    if (capacity) return build(CODE_TABLE[code!]!, layer, evidence);
    const retry = classifyRetry({
      ...(httpStatus !== undefined ? { statusCode: httpStatus } : {}),
      ...(code ? { code } : {}),
      ...(evidence.retryAfterMs !== undefined
        ? { retryAfterMs: evidence.retryAfterMs }
        : {}),
    });
    return build(
      {
        class: "sandbox",
        retryable:
          retry.class === "transient" ||
          retry.class === "capacity" ||
          retry.class === "rate_limited",
      },
      layer,
      evidence,
    );
  }

  // 2. The code table.
  if (code) {
    const row = CODE_TABLE[code];
    if (row) return build(row, layer, evidence);
    if (code === "provider_error" && httpStatus !== undefined && httpStatus >= 500) {
      return build({ class: "provider_unavailable", retryable: true }, layer, evidence);
    }
    if (code === "streaming_error" && evidence.isRetryable === true) {
      return build({ class: "provider_unavailable", retryable: true }, layer, evidence);
    }
    if (CODEX_CONNECTION_CODES.has(code)) {
      // A connection-level failure the runtime TYPED as one: with no status
      // it is still our provider path failing, never the customer's server.
      const row = byStatus(httpStatus) ?? {
        class: "provider_unavailable" as const,
        retryable: true,
      };
      return build({ ...row, layer: "model" }, layer, evidence);
    }
    if (code === "harness_broker_unavailable") {
      return build(
        {
          class: "sandbox",
          layer: "platform",
          retryable: httpStatus === undefined || httpStatus >= 500,
        },
        layer,
        evidence,
      );
    }
    const accountCode = accountLimitCode(undefined, code);
    if (accountCode) {
      return build(
        { class: "account_limit", layer: "platform", retryable: false },
        layer,
        evidence,
      );
    }
  }
  // Auth walls the provider (or our own credential) put up.
  if (httpStatus === 401 || httpStatus === 403) {
    return build({ class: "auth", retryable: false }, layer, evidence);
  }

  // 3. Fallback: the shared retry classifier, with NO message.
  const retry = classifyRetry({
    ...(httpStatus !== undefined ? { statusCode: httpStatus } : {}),
    ...(code ? { code } : {}),
    ...(evidence.retryAfterMs !== undefined
      ? { retryAfterMs: evidence.retryAfterMs }
      : {}),
  });
  switch (retry.class) {
    case "capacity":
      return build({ class: "capacity", retryable: true }, layer, evidence);
    case "rate_limited":
      return build({ class: "rate_limited", retryable: true }, layer, evidence);
    case "transient":
      return build(
        {
          class: layer === "platform" ? "sandbox" : "provider_unavailable",
          retryable: true,
        },
        layer,
        evidence,
      );
    default:
      return undefined;
  }
}

/** The rollout lever: `off` (default), `shadow`, or `on`. */
export type InfraClassifyMode = "off" | "shadow" | "on";

/**
 * `MCPJAM_EVAL_INFRA_CLASSIFY`. `shadow` writes only
 * `metadata.infraErrorShadow` (the row keeps today's `completed` status), so
 * false positives can be measured against real outcomes before `on` changes a
 * single score. Anything unrecognised reads as `off`.
 */
export function resolveInfraClassifyMode(
  env: NodeJS.ProcessEnv = process.env,
): InfraClassifyMode {
  const raw = env.MCPJAM_EVAL_INFRA_CLASSIFY?.trim().toLowerCase();
  if (raw === "on" || raw === "1" || raw === "true") return "on";
  if (raw === "shadow") return "shadow";
  return "off";
}

/** The persisted shape: the classification without the transient wait. */
export function toPersistedInfraError(
  classified: ClassifiedInfraError,
): EvalInfraError {
  const { retryAfterMs: _retryAfterMs, ...persisted } = classified;
  return persisted;
}
