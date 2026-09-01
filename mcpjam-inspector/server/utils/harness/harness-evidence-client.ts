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
  // A 4xx the backend did not label is a request this client built wrong;
  // repeating it verbatim will not fix it.
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

  const write = (path: "start" | "settle", body: Record<string, unknown>) =>
    writeUntilAcknowledged<true>(
      async () => {
        // Per-ATTEMPT timeout, not per-write: a backend that accepts the
        // connection and then stalls would otherwise hold the tool call open
        // for as long as it liked, which is the one failure mode a retry
        // budget alone cannot bound.
        const timeout = AbortSignal.timeout(EVIDENCE_ATTEMPT_TIMEOUT_MS);
        const signal = args.signal
          ? AbortSignal.any([args.signal, timeout])
          : timeout;
        return classify(await args.transport(path, body, { signal }));
      },
      {
        maxAttempts: EVIDENCE_MAX_ATTEMPTS,
        ...(args.sleep ? { sleep: args.sleep } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );

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
