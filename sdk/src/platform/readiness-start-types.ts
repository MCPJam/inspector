/** Fields both start endpoints accept. */
export interface PlatformReadinessStartBody {
  /**
   * Deduplicates a retried POST.
   *
   * More load-bearing here than usual: a readiness run dials a third party's
   * server, and a retried start that created a second run would do that twice.
   */
  idempotencyKey?: string;
  /**
   * Add model-backed experience observations. CONSUMES MCPJam CREDITS.
   *
   * Off by default. Observations are non-dispositive — they can never make a
   * server not-ready — and a refused reservation makes no provider call and
   * completes the run with `llmObservations.reason` of
   * `billing_limit_reached`.
   */
  includeLlmObservations?: boolean;
  /**
   * Verify lazy authentication: the run calls at most two tools annotated
   * `readOnlyHint: true` — one public, one protected — WITHOUT credentials,
   * and grades how the protected call is refused. It never sends the saved
   * server's credential. Omit to run no tool calls at all.
   */
  lazyAuthProbe?: PlatformReadinessLazyAuthProbe;
  /**
   * Features the submitter claims, e.g. `"lazy-authentication"`. A claim is
   * reported as `claimed`; it is never itself evidence.
   */
  claimedFeatures?: string[];
}

/** The lazy-auth probe's request: explicit opt-in, and optional tool names. */
export interface PlatformReadinessLazyAuthProbe {
  /** Literal `true` to arm the probe. */
  enabled: true;
  /** The protected read-only tool to call without credentials. */
  toolName?: string;
  /** The public read-only tool to call without credentials. */
  publicToolName?: string;
}
