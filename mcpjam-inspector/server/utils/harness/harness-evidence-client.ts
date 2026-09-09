/**
 * The proxy's half of the harness tool-call evidence protocol.
 *
 * One instance per harness TURN. It turns the bridge's evidence hook into two
 * durable, acknowledged writes against the backend's service-token routes, and
 * it is the component that decides whether a tool call is allowed to reach the
 * user's server at all.
 *
 * ## The protocol, and what each half is protecting
 *
 *   START — written and acknowledged BEFORE the call executes. If it cannot be
 *   acknowledged, the call does not run. That looks harsh for a recording
 *   feature until you look at the alternative: a call that executed with no
 *   record of having started is INVISIBLE. The turn's evidence would be
 *   internally consistent, complete-looking, and missing a call the model
 *   really made — and a merger trusting it grades that real call as a
 *   hallucination.
 *
 *   SETTLE — written and acknowledged BEFORE the result returns to the harness,
 *   with a bounded retry budget. If the budget runs out the result is still
 *   returned: the call already happened, its side effects are real, and
 *   re-executing it to record it better would be worse than recording it
 *   incompletely. The durable `started` row left behind is what makes the loss
 *   visible — the turn reads as incomplete and grades from narration.
 *
 * ## Budget
 *
 * Every attempt here sits between the model and its tool result, so the budget
 * is measured in wall clock, not tries. Worst case is
 * `EVIDENCE_MAX_ATTEMPTS` attempts plus the backoff between them, on each of
 * two writes — see the constants below, which are sized to stay well inside a
 * harness CLI's per-tool timeout. A slow evidence backend must degrade a run to
 * narration grading, never make its tool calls time out.
 */
import { logger } from "../logger.js";
import { writeUntilAcknowledged } from "../acknowledged-write.js";
import type { WriteAttempt } from "../acknowledged-write.js";

/**
 * Attempts per write, and the backoff between them. Worst case per write is
 * roughly 250ms + 1s of waiting plus three request round trips — comfortably
 * inside the per-tool timeouts a harness CLI allows (Claude Code's default MCP
 * tool timeout is on the order of a minute), and small enough that a degraded
 * backend slows a turn rather than breaking it.
 */
const EVIDENCE_MAX_ATTEMPTS = 3;
const EVIDENCE_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Hard wall-clock ceiling on ONE write (all attempts and backoff together),
 * started when the write begins — NOT when the request was armed, because the
 * user's tool runs between start and settle and a slow-but-legitimate tool
 * must not eat the settle's budget.
 *
 * The per-attempt timeout alone cannot bound a write: 3 × 10s attempts plus
 * backoff is ~31s, and paid on BOTH writes that is over the ~60s Claude Code
 * MCP tool timeout the budget exists to stay inside. 15s per write caps the
 * whole evidence overhead of one call at ~30s worst case, leaving the rest of
 * the window for the tool itself.
 */
export const EVIDENCE_WRITE_BUDGET_MS = 15_000;

/**
 * Per-iteration circuit breaker over the evidence sink.
 *
 * The per-write budget bounds ONE call's overhead; a dead or stalling sink
 * would still charge every subsequent call in the turn its full budget,
 * because the client is rebuilt per proxied HTTP request and remembers
 * nothing. This registry is the memory: after `BREAKER_THRESHOLD` consecutive
 * failed writes for an iteration, further writes fail FAST for
 * `BREAKER_OPEN_MS` — a refused start is still fail-closed (the tool call is
 * refused either way), it just stops making the model wait 15s to hear it.
 * One probe is allowed when the window lapses; a success closes it.
 *
 * Per-instance, deliberately: a shared breaker would need the very evidence
 * plane it is guarding. Keyed by iteration so one broken run cannot trip
 * another's capture.
 */
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;
const breakerByIteration = new Map<
  string,
  { consecutiveFailures: number; openedAtMs?: number }
>();

export const evidenceSinkBreaker = {
  /** True ⇒ skip the attempts entirely; the write is reported failed. */
  isOpen(key: string, now = Date.now()): boolean {
    const state = breakerByIteration.get(key);
    if (!state || state.consecutiveFailures < BREAKER_THRESHOLD) return false;
    if (
      state.openedAtMs !== undefined &&
      now - state.openedAtMs >= BREAKER_OPEN_MS
    ) {
      // Half-open: one probe write gets through; its outcome decides.
      state.consecutiveFailures = BREAKER_THRESHOLD - 1;
      delete state.openedAtMs;
      return false;
    }
    return true;
  },
  recordFailure(key: string, now = Date.now()): void {
    const state = breakerByIteration.get(key) ?? { consecutiveFailures: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= BREAKER_THRESHOLD) {
      state.openedAtMs ??= now;
    }
    breakerByIteration.set(key, state);
    // Opportunistic bound: entries are deleted on success, so growth means
    // many failing iterations at once; drop the stalest rather than leak.
    if (breakerByIteration.size > 512) {
      const oldest = breakerByIteration.keys().next().value;
      if (oldest !== undefined) breakerByIteration.delete(oldest);
    }
  },
  recordSuccess(key: string): void {
    breakerByIteration.delete(key);
  },
  resetForTest(): void {
    breakerByIteration.clear();
  },
};

export type HarnessEvidenceOutcomeKind =
  "success" | "call_tool_error" | "jsonrpc_error";

export type HarnessEvidenceScope = {
  runId: string;
  iterationId: string;
  /** Minted per turn attempt; a retry/resume gets a fresh one. */
  turnId: string;
};

export type HarnessEvidenceClient = {
  /**
   * Durably record that a call is about to execute. `false` means the caller
   * must NOT execute it.
   */
  recordStart(call: {
    requestId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    startedAtMs: number;
  }): Promise<boolean>;
  /**
   * Durably record a complete outcome. Returns whether it was acknowledged;
   * the caller returns the result either way.
   */
  recordSettlement(settlement: {
    requestId: string;
    outcomeKind: HarnessEvidenceOutcomeKind;
    response: unknown;
    settledAtMs: number;
  }): Promise<boolean>;
  /**
   * Requests this client knows were started. The turn's completeness check
   * cross-references it: a request that started but is absent from the read is
   * the loss the protocol exists to surface.
   */
  readonly startedRequestIds: ReadonlySet<string>;
  /** Requests whose settlement never landed — the visible loss, in-process. */
  readonly unsettledRequestIds: ReadonlySet<string>;
};

type EvidenceTransportResponse = {
  status: number;
  body: Record<string, unknown> | null;
};

export type HarnessEvidenceTransport = (
  path: "start" | "settle",
  body: Record<string, unknown>,
  init: { signal?: AbortSignal },
) => Promise<EvidenceTransportResponse>;

/**
 * Classify one backend response.
 *
 * The backend states its own verdict on retryability (`retryable: false` on a
 * scope that is gone or a payload that will never fit), and it is believed:
 * retrying those spends a model's patience on a write that cannot succeed. An
 * unlabelled failure is retryable, because an unlabelled failure is usually a
 * transport hiccup.
 */
function classify(response: EvidenceTransportResponse): WriteAttempt<true> {
  if (response.status >= 200 && response.status < 300) {
    return { status: "acknowledged", value: true };
  }
  const body = response.body ?? {};
  const reason =
    typeof body.code === "string"
      ? body.code
      : typeof body.error === "string"
        ? body.error
        : `evidence write failed (${response.status})`;
  if (body.retryable === false) return { status: "permanent", reason };
  // Infra-generated 4xx that never carry a verdict body: a bare 429 (this
  // stack emits them — the harness proxy's own rate limiter does) or a 408
  // from a fronting proxy is a transient condition, and treating it as
  // permanent turns one throttled attempt into a refused tool call (start)
  // or a falsely incomplete turn (settle).
  if (response.status === 429 || response.status === 408) {
    return { status: "retryable", reason };
  }
  // Any other 4xx the backend did not label is a request this client built
  // wrong; repeating it verbatim will not fix it.
  if (response.status >= 400 && response.status < 500) {
    return { status: "permanent", reason };
  }
  return { status: "retryable", reason };
}

/**
 * Whether this inspector can write evidence at all.
 *
 * The same two variables the RPC-log sink needs, and the same meaning when
 * they are absent: no Convex service channel. The difference is what absence
 * costs — the sink degrades to an in-process bus, while capture cannot be
 * armed at all, so a run whose frozen decision says `capture: 'on'` must fail
 * BEFORE its first tool call rather than silently record nothing.
 */
export function isHarnessEvidenceConfigured(): boolean {
  return Boolean(
    process.env.CONVEX_HTTP_URL?.trim() &&
    process.env.INSPECTOR_SERVICE_TOKEN?.trim(),
  );
}

/**
 * The production transport: the backend's service-token evidence routes.
 *
 * A non-JSON body is reported as an empty body rather than thrown, so
 * `classify` still sees the status — a 502 from a proxy in front of Convex is
 * retryable, and losing that because the body was HTML would turn a blip into
 * a refused tool call.
 */
export function createConvexEvidenceTransport(): HarnessEvidenceTransport {
  return async (path, body, init) => {
    const base = process.env.CONVEX_HTTP_URL?.trim();
    const token = process.env.INSPECTOR_SERVICE_TOKEN?.trim();
    if (!base || !token) {
      return {
        status: 500,
        body: { code: "evidence_not_configured", retryable: false },
      };
    }
    const response = await fetch(
      new URL(`/eval-harness-tool-calls/${path}`, base).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inspector-service-token": token,
        },
        body: JSON.stringify(body),
        ...(init.signal ? { signal: init.signal } : {}),
      },
    );
    let parsed: Record<string, unknown> | null = null;
    try {
      const json = await response.json();
      parsed =
        json && typeof json === "object" && !Array.isArray(json)
          ? (json as Record<string, unknown>)
          : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };
}

export function createHarnessEvidenceClient(args: {
  scope: HarnessEvidenceScope;
  transport: HarnessEvidenceTransport;
  signal?: AbortSignal;
  /** Injectable for tests; production uses real timers. */
  sleep?: (ms: number) => Promise<void>;
}): HarnessEvidenceClient {
  const started = new Set<string>();
  const settled = new Set<string>();
  const unsettled = new Set<string>();
  const breakerKey = args.scope.iterationId;

  const write = async (
    path: "start" | "settle",
    body: Record<string, unknown>,
  ) => {
    if (evidenceSinkBreaker.isOpen(breakerKey)) {
      // The sink already failed BREAKER_THRESHOLD consecutive writes for this
      // iteration; failing fast preserves the harness's tool-call window
      // instead of spending another full budget hearing the same answer.
      return {
        acknowledged: false as const,
        reason: "evidence sink breaker open",
        attempts: 0,
        gaveUp: false,
      };
    }
    // The WRITE's own wall-clock ceiling, started here — not at arm time,
    // because the user's tool runs between start and settle and a slow tool
    // must not eat the settle's budget. Combined with the per-attempt timeout
    // below it bounds one call's total evidence overhead regardless of how a
    // stalling sink misbehaves.
    const writeBudget = AbortSignal.timeout(EVIDENCE_WRITE_BUDGET_MS);
    const writeSignal = args.signal
      ? AbortSignal.any([args.signal, writeBudget])
      : writeBudget;
    const result = await writeUntilAcknowledged<true>(
      async () => {
        // Per-ATTEMPT timeout, not per-write: a backend that accepts the
        // connection and then stalls would otherwise hold the tool call open
        // for as long as it liked, which is the one failure mode a retry
        // budget alone cannot bound.
        const timeout = AbortSignal.timeout(EVIDENCE_ATTEMPT_TIMEOUT_MS);
        const signal = AbortSignal.any([writeSignal, timeout]);
        return classify(await args.transport(path, body, { signal }));
      },
      {
        maxAttempts: EVIDENCE_MAX_ATTEMPTS,
        ...(args.sleep ? { sleep: args.sleep } : {}),
        signal: writeSignal,
      },
    );
    if (result.acknowledged) {
      evidenceSinkBreaker.recordSuccess(breakerKey);
    } else if (!args.signal?.aborted) {
      // A cancelled TURN is not a sick sink; only real write failures count
      // toward opening the breaker.
      evidenceSinkBreaker.recordFailure(breakerKey);
    }
    return result;
  };

  return {
    async recordStart(call) {
      const result = await write("start", {
        runId: args.scope.runId,
        iterationId: args.scope.iterationId,
        turnId: args.scope.turnId,
        requestId: call.requestId,
        serverId: call.serverId,
        toolName: call.toolName,
        // A STRING, not an object: `$`-prefixed keys (`$schema` above all) are
        // rewritten crossing the Convex argument boundary, and evidence that
        // paraphrases what the server received is not evidence.
        argumentsJson: JSON.stringify(call.arguments ?? {}),
        startedAtMs: call.startedAtMs,
      });

      if (!result.acknowledged) {
        logger.warn(
          "[harness-evidence] start not acknowledged; refusing call",
          {
            iterationId: args.scope.iterationId,
            turnId: args.scope.turnId,
            requestId: call.requestId,
            toolName: call.toolName,
            attempts: result.attempts,
            reason: result.reason,
          },
        );
        return false;
      }
      started.add(call.requestId);
      unsettled.add(call.requestId);
      return true;
    },

    async recordSettlement(settlement) {
      const result = await write("settle", {
        iterationId: args.scope.iterationId,
        requestId: settlement.requestId,
        outcomeKind: settlement.outcomeKind,
        responseJson: safeStringify(settlement.response),
        settledAtMs: settlement.settledAtMs,
      });

      if (!result.acknowledged) {
        // Left in `unsettled`, deliberately. This is the visible loss: the
        // turn's completeness check sees a started request with no settlement
        // and grades from narration instead of pretending the record is whole.
        logger.warn("[harness-evidence] settlement not acknowledged", {
          iterationId: args.scope.iterationId,
          turnId: args.scope.turnId,
          requestId: settlement.requestId,
          attempts: result.attempts,
          gaveUp: result.gaveUp,
          reason: result.reason,
        });
        return false;
      }
      settled.add(settlement.requestId);
      unsettled.delete(settlement.requestId);
      return true;
    },

    get startedRequestIds() {
      return started;
    },
    get unsettledRequestIds() {
      return unsettled;
    },
  };
}

/**
 * Serialize a response envelope, falling back to a marker rather than throwing.
 *
 * A result that cannot be serialized (a cycle, a BigInt) would otherwise take
 * the whole settlement down with it. The marker is NOT the result — it is
 * unparseable as one, so the merge treats the row as unreadable and the turn as
 * incomplete, which is the truthful outcome.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch (error) {
    return JSON.stringify({
      mcpjamEvidenceError: "unserializable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
