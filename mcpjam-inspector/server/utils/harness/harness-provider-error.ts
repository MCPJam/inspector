/**
 * STRUCTURED failure evidence for a harness turn, preserved from the producer
 * that actually knew it.
 *
 * A harness turn dies in one of three of OUR layers — the model provider the
 * in-sandbox agent called, the sandbox it ran in, or the platform plumbing
 * between them (box reservation, credential broker) — or for a reason that
 * says something about the customer's server. Telling those apart is what lets
 * an eval exclude and refund a provider outage instead of scoring it against
 * the server (`server/services/evals/infra-error-classification.ts`).
 *
 * The rule this module exists to hold: the evidence is TYPED AT THE PRODUCER
 * and carried as fields, never recovered later from prose. Both bridges run
 * inside the sandbox and talk to the host over the harness wire, whose error
 * part is `error: unknown` and whose bridge serializer flattens an `Error` to
 * `{name, message, stack}`. So the hosted Claude Code bridge
 * (`claude-code-typed-errors.ts`) sends a PLAIN OBJECT of this shape instead
 * of a string, read back with {@link harnessFailureEvidenceOf}; Codex already
 * forwards its typed `codexErrorInfo` as a `raw` notification, read with
 * {@link codexProviderEvidenceFromNotification}. A producer that has no structured
 * evidence sends what it always sent, and the failure stays unclassified — the
 * diagnostic gap is recorded, not papered over by reading stderr or model text.
 *
 * Kept free of Node and server imports: pure data shaping, unit-testable.
 */

/** Discriminator a bridge stamps on a typed model-provider failure. */
export const HARNESS_PROVIDER_ERROR_NAME = "HarnessProviderError";

/** What a bridge sends over the wire for a typed provider failure. */
export type HarnessProviderErrorWire = {
  name: typeof HARNESS_PROVIDER_ERROR_NAME;
  message: string;
  /** Always the model layer: a bridge only types failures of its model calls. */
  source: "model";
  /** Adapter-scoped structured code (`claude_code_rate_limit`, `codex_unauthorized`, …). */
  code?: string;
  /** Upstream HTTP status, when the agent runtime reported one. */
  httpStatus?: number;
};

/** Which of OUR layers raised a harness failure. */
export type HarnessFailureLayer = "model" | "sandbox" | "platform";

/** The structured fields an infra classifier may read. Never prose. */
export type HarnessFailureEvidence = {
  layer?: HarnessFailureLayer;
  code?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  isRetryable?: boolean;
};

/**
 * Thrown by a typed harness SETUP step — sandbox resolution/wake, box
 * reservation, credential-broker lease installation — so the turn's catch can
 * report the layer it came from instead of folding it into a provider failure.
 */
export class HarnessInfraSetupError extends Error {
  override readonly name = "HarnessInfraSetupError";
  readonly harnessFailure: HarnessFailureEvidence & {
    layer: "sandbox" | "platform";
  };

  constructor(
    message: string,
    evidence: HarnessFailureEvidence & { layer: "sandbox" | "platform" },
  ) {
    super(message);
    this.harnessFailure = evidence;
  }
}

function finiteStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

/** True for the plain object a bridge sends for a typed provider failure. */
export function isHarnessProviderErrorWire(
  value: unknown,
): value is HarnessProviderErrorWire {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.name === HARNESS_PROVIDER_ERROR_NAME &&
    record.source === "model" &&
    typeof record.message === "string"
  );
}

/**
 * The structured evidence a thrown harness failure carries, or `undefined`.
 *
 * Three producers, each read by type, never by message:
 *  - {@link HarnessInfraSetupError} from a typed setup step;
 *  - {@link HarnessProviderErrorWire} from a bridge;
 *  - an AI SDK `APICallError` (`statusCode` + `isRetryable`) — directly or as
 *    a `RetryError`'s `lastError` — which only the model call layer throws.
 */
export function harnessFailureEvidenceOf(
  error: unknown,
): HarnessFailureEvidence | undefined {
  if (error instanceof HarnessInfraSetupError) return error.harnessFailure;
  if (isHarnessProviderErrorWire(error)) {
    const httpStatus = finiteStatus(error.httpStatus);
    return {
      layer: "model",
      ...(typeof error.code === "string" && error.code
        ? { code: error.code }
        : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  }
  // The AI SDK's retry wrapper: its `lastError` is the provider's own answer.
  if (
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AI_RetryError"
  ) {
    return harnessFailureEvidenceOf((error as { lastError?: unknown }).lastError);
  }
  if (
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AI_APICallError"
  ) {
    const record = error as Record<string, unknown>;
    const httpStatus = finiteStatus(record.statusCode);
    return {
      layer: "model",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(typeof record.isRetryable === "boolean"
        ? { isRetryable: record.isRetryable }
        : {}),
    };
  }
  return undefined;
}

/**
 * A display message for any thrown harness failure. A typed bridge error is a
 * plain object, and `String(obj)` would persist `[object Object]`.
 */
export function harnessFailureMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

// ── Codex app-server ─────────────────────────────────────────────────────────

/**
 * Structured provider evidence from a Codex app-server notification the
 * bridge passed through as a `raw` stream part, or `undefined`.
 *
 * Read HOST-SIDE on purpose: the bridge already forwards every notification
 * verbatim (`stream-translator.ts`, "nothing is silently dropped"), so the
 * typed `codexErrorInfo` reaches the host without changing a byte of the
 * bridge — whose bundle is a local runtime pack input.
 *
 * Only a TERMINAL failure counts: an `error` notification with `willRetry`
 * false, or a `turn/completed` whose turn failed. A retried error is not the
 * turn's outcome. `codexErrorInfo` follows the committed protocol schema
 * (`.spike-codex-appserver/schema/<version>/ServerNotification.json`): a bare
 * camelCase variant, or a one-key object whose value may carry the upstream
 * `httpStatusCode`.
 *
 * Only MODEL-CALL variants are typed. `sandboxError`, `badRequest`,
 * `contextWindowExceeded`, the policy variants and `other` stay unclassified:
 * a bad request can be caused by a tool schema the customer's server
 * advertised, and the rest are not our infrastructure failing.
 */
export function codexProviderEvidenceFromNotification(
  rawValue: unknown,
): HarnessFailureEvidence | undefined {
  if (!rawValue || typeof rawValue !== "object") return undefined;
  const notification = rawValue as { method?: unknown; params?: unknown };
  const params =
    notification.params && typeof notification.params === "object"
      ? (notification.params as Record<string, unknown>)
      : undefined;
  if (!params) return undefined;
  let turnError: unknown;
  if (notification.method === "error") {
    if (params.willRetry === true) return undefined;
    turnError = params.error;
  } else if (notification.method === "turn/completed") {
    const turn = params.turn as { status?: unknown; error?: unknown } | undefined;
    if (!turn || turn.status !== "failed") return undefined;
    turnError = turn.error;
  } else {
    return undefined;
  }
  if (!turnError || typeof turnError !== "object") return undefined;
  const info = (turnError as { codexErrorInfo?: unknown }).codexErrorInfo;
  let variant: string | undefined;
  let httpStatus: number | undefined;
  if (typeof info === "string") {
    variant = info;
  } else if (info && typeof info === "object") {
    const keys = Object.keys(info);
    if (keys.length === 1) {
      variant = keys[0];
      const payload = (info as Record<string, unknown>)[variant!];
      if (payload && typeof payload === "object") {
        httpStatus = finiteStatus(
          (payload as { httpStatusCode?: unknown }).httpStatusCode,
        );
      }
    }
  }
  if (!variant || !CODEX_MODEL_CALL_VARIANTS.has(variant)) return undefined;
  return {
    layer: "model",
    code: `codex_${variant}`,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

const CODEX_MODEL_CALL_VARIANTS = new Set([
  "serverOverloaded",
  "internalServerError",
  "unauthorized",
  "usageLimitExceeded",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
