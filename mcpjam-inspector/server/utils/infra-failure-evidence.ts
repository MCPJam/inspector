/**
 * STRUCTURED evidence that one of OUR layers failed an agent turn.
 *
 * An eval trial can die because MCPJam's infrastructure failed — the model
 * provider answered 503, our gateway's quota ran out, a sandbox would not come
 * up — or for a reason that says something about the customer's MCP server.
 * Telling those apart is what lets an eval exclude and refund the first kind
 * instead of scoring it against the server
 * (`services/evals/infra-error-classification.ts`).
 *
 * The rule this type exists to hold: the evidence is TYPED AT THE PRODUCER and
 * carried as fields, never recovered later from prose. Every producer stamps
 * its own `source`, and a failure with no producer-typed evidence carries none
 * and stays unclassified — the safe direction, since it keeps counting exactly
 * as it does today.
 *
 * A status the customer's MCP server or one of its tools returned never
 * becomes evidence: no producer below sees one.
 */
export type InfraFailureSource =
  /**
   * MCPJam's own `/stream` backend categorized its model call: the
   * `{code, statusCode}` envelope of a non-OK response or a mid-stream error
   * chunk. Only the backend's allowlisted provider/account codes classify.
   */
  | "backend_model"
  /**
   * The model provider's own typed answer to a call this process made
   * directly (an AI SDK `APICallError`), so its status IS the provider's.
   */
  | "provider_call"
  /**
   * An agent runtime's typed provider failure: a Claude Code error category,
   * a Codex `codexErrorInfo` variant.
   */
  | "harness_runtime"
  /** A typed sandbox setup step: resolving, waking or reserving the box. */
  | "sandbox_setup"
  /** A typed platform setup step: installing the credential-broker lease. */
  | "platform_setup";

export type InfraFailureEvidence = {
  source: InfraFailureSource;
  /** The producer's own machine code (`provider_overloaded`, `codex_unauthorized`, …). */
  code?: string;
  /**
   * The HTTP status of the FAILING layer: the upstream provider's for a model
   * failure, the control plane's for a setup step. Never the status of our own
   * `/stream` response, which answers an uncategorized failure with a bare 500.
   */
  httpStatus?: number;
};

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
 * Evidence from an AI SDK `APICallError` — directly, or as the `lastError` of
 * the SDK's `RetryError` — or `undefined` for anything else.
 *
 * Only the model-call layer throws these (`postJsonToApi` and friends), so
 * their `statusCode` is the provider's answer. Read by NAME rather than by
 * `instanceof`: the eval stream hands the error over as the object the SDK
 * built, and a second copy of the provider package would fail `instanceof`.
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
