/**
 * STRUCTURED evidence that one of OUR layers failed an agent turn, stamped by
 * the producer that knew it and never recovered later from prose. Read only by
 * the eval infra-error classifier (`services/evals/infra-error-classification.ts`).
 * A failure with no producer-typed evidence carries none and stays
 * unclassified — the safe direction, since it keeps counting as it does today.
 */
export type InfraFailureSource =
  /** Our `/stream` backend's categorized `{code, statusCode}` envelope. */
  | "backend_model"
  /** The provider's own typed answer to a direct call (an AI SDK `APICallError`). */
  | "provider_call"
  /** An agent runtime's typed provider failure (Claude Code, Codex). */
  | "harness_runtime"
  /** A typed sandbox setup step: resolve, wake or reserve the box. */
  | "sandbox_setup"
  /** A typed platform setup step: the credential-broker lease. */
  | "platform_setup";

/**
 * Who controls the model endpoint a model-layer failure came from.
 *
 * - `platform`: MCPJam's own key, gateway or model proxy.
 * - `byok_hosted`: a first-party hosted provider reached with the customer's
 *   own credential (OpenAI, Anthropic, Google, OpenRouter, …).
 * - `customer_hosted`: an endpoint the customer controls — a `custom:`
 *   provider, Ollama, a base-URL deployment (Azure, Bedrock) — whose 5xx or
 *   429 can be produced at will, so it is never evidence of OUR failure.
 */
export type ModelEndpointOwnership =
  "platform" | "byok_hosted" | "customer_hosted";

export type InfraFailureEvidence = {
  source: InfraFailureSource;
  /** The producer's own machine code (`provider_error`, `codex_unauthorized`, …). */
  code?: string;
  /**
   * The HTTP status of the FAILING layer: the upstream provider's for a model
   * failure, the control plane's for a setup step. Never our own `/stream`
   * response status.
   */
  httpStatus?: number;
  /** Model-layer sources only; absent ⇒ unknown, which never classifies. */
  endpoint?: ModelEndpointOwnership;
};

/**
 * Hosted providers whose endpoint the SDK fixes (no customer base URL) — the
 * set the backend's `buildOrgModel` and the Inspector's `createLlmModel` build
 * without one.
 */
const FIRST_PARTY_HOSTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "mistral",
  "deepseek",
  "xai",
  "openrouter",
  "moonshotai",
  "z-ai",
  "qwen",
  "minimax",
]);

/** Ownership of a customer-credential endpoint, from its provider key. */
export function byokEndpointOwnership(
  provider: string | undefined,
): ModelEndpointOwnership {
  return provider && FIRST_PARTY_HOSTED_PROVIDERS.has(provider)
    ? "byok_hosted"
    : "customer_hosted";
}

/** An integer HTTP status, or `undefined`. */
export function httpStatusOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

/**
 * Evidence from an AI SDK `APICallError` — directly, or as a `RetryError`'s
 * `lastError` — or `undefined`. Only the model-call layer throws these, so the
 * status is the endpoint's own answer; the caller stamps who owns it.
 */
export function providerCallEvidenceOf(
  error: unknown,
): InfraFailureEvidence | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (record.name === "AI_RetryError") {
    return providerCallEvidenceOf(record.lastError);
  }
  if (record.name !== "AI_APICallError") return undefined;
  const httpStatus = httpStatusOrUndefined(record.statusCode);
  return {
    source: "provider_call",
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}
