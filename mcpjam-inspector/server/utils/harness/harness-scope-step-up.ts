import type { InsufficientScopeInfo } from "../../routes/web/hosted-elicitation.js";
import {
  scopeStepUpInfoFromToolError,
  type ScopeStepUpToolError,
} from "../insufficient-scope-step-up.js";
import { logger } from "../logger.js";
import { inspectorCommandBus } from "../../services/inspector-command-bus.js";
export {
  HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER,
  HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY,
} from "./mcp-config.js";

/**
 * Opaque per-turn marker carried by every generated harness `.mcp.json` entry.
 * It correlates a proxy-observed tool failure back to exactly one live chat
 * stream without broadcasting by server id.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeHarnessScopeStepUpCorrelationId(
  value: unknown
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export type HarnessScopeStepUpEvent = InsufficientScopeInfo & {
  /** Exact proxied operation, when the proxy observed a tools/call request. */
  toolName?: string;
  toolInput?: unknown;
};

const CROSS_INSTANCE_SCOPE_STEP_UP_MARKER = "mcpjam.harness-scope-step-up.v1";

type CrossInstanceHarnessScopeStepUpMessage = {
  type: typeof CROSS_INSTANCE_SCOPE_STEP_UP_MARKER;
  correlationId: string;
  event: HarnessScopeStepUpEvent;
};

type Listener = (info: HarnessScopeStepUpEvent) => void;
type ScopeStepUpSubscription = {
  correlationId: string;
  listener: Listener;
  serverIds: ReadonlySet<string>;
};
const subscriptionsByCorrelationId = new Map<
  string,
  Set<ScopeStepUpSubscription>
>();
const subscriptionsByServerId = new Map<string, Set<ScopeStepUpSubscription>>();

function normalizeServerId(serverId: string): string {
  return serverId.trim().toLowerCase();
}

/**
 * Whether a published challenge names one of these server ids, using the SAME
 * normalization this registry routes with. Subscribers must filter through
 * this rather than a bare `includes`: otherwise a case or whitespace variant
 * could be routed here and then dropped by the subscriber, so the Inspector
 * would open OAuth for a challenge the chat stream never showed.
 */
export function harnessScopeStepUpServerMatches(
  serverIds: readonly string[] | undefined,
  serverId: string
): boolean {
  if (!serverIds?.length) return false;
  const normalized = normalizeServerId(serverId);
  return serverIds.some(
    (candidate) => normalizeServerId(candidate) === normalized
  );
}

/** Order-independent structural key for a tool input, so `{a,b}` and `{b,a}`
 *  correlate. Lives beside the matcher that is its only consumer. */
export function stableHarnessValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableHarnessValue).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableHarnessValue(record[key])}`)
    .join(",")}}`;
}

/** One tool call the turn observed on the harness stream, as the correlator
 *  needs it. */
export interface ObservedHarnessToolCall {
  toolCallId: string;
  serverId?: string;
  toolName: string;
  input: unknown;
}

/**
 * Which observed tool call a scope challenge belongs to.
 *
 * TWO correlators, and the ID one wins whenever it can:
 *
 *  - `toolCallId`. A HOST-EXECUTED call raises its challenge inside `execute()`,
 *    where the AI SDK hands it the very `toolCallId` the stream reported for
 *    that call. That id is unique per call, so it is exact.
 *  - the (serverId, toolName, input) tuple. The NATIVE path's publisher is the
 *    signed proxy, which only ever saw an HTTP `tools/call` and has no id to
 *    give — so the tuple is all there is, and it stays the fallback.
 *
 * The tuple ALONE is wrong when a turn makes the same call twice with the same
 * arguments: `find` returns the FIRST match, so a challenge raised by the second
 * call would suspend and later resume the first, re-running a call that already
 * succeeded and leaving the failing one unresumed. When the challenge carries a
 * usable id, an id miss returns `undefined` rather than degrading to the tuple —
 * the correlator is re-run on every subsequent observed call, so a challenge
 * that lands before its own `tool-call` part still correlates, and never onto
 * the wrong call.
 */
export function matchHarnessScopeStepUpToolCall(args: {
  observed: readonly ObservedHarnessToolCall[];
  challenge: HarnessScopeStepUpEvent;
}): ObservedHarnessToolCall | undefined {
  const { observed, challenge } = args;
  const toolCallId = challenge.toolCallId?.trim();
  if (toolCallId) {
    return observed.find((call) => call.toolCallId === toolCallId);
  }
  return observed.find(
    (call) =>
      harnessScopeStepUpServerMatches(
        call.serverId ? [call.serverId] : [],
        challenge.serverId
      ) &&
      call.toolName === challenge.toolName &&
      stableHarnessValue(call.input) ===
        stableHarnessValue(challenge.toolInput ?? {})
  );
}

function notifyListener(
  listener: Listener,
  info: HarnessScopeStepUpEvent
): void {
  try {
    listener(info);
  } catch (error) {
    logger.warn("[harness-scope-step-up] subscriber failed", {
      serverId: info.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function notifyInspector(info: InsufficientScopeInfo): void {
  inspectorCommandBus.notify({
    kind: "scope_step_up",
    serverId: info.serverId,
    ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
    ...(info.requiredScope ? { requiredScope: info.requiredScope } : {}),
    ...(info.resourceMetadataUrl
      ? { resourceMetadataUrl: info.resourceMetadataUrl }
      : {}),
    ...(info.errorDescription
      ? { errorDescription: info.errorDescription }
      : {}),
  });
}

export function subscribeHarnessScopeStepUp(
  correlationId: string,
  listener: Listener,
  serverIds: readonly string[] = []
): () => void {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return () => {};

  const normalizedServerIds = new Set(
    serverIds.map(normalizeServerId).filter(Boolean)
  );
  const subscription: ScopeStepUpSubscription = {
    correlationId: normalized,
    listener,
    serverIds: normalizedServerIds,
  };
  const correlatedSubscriptions =
    subscriptionsByCorrelationId.get(normalized) ?? new Set();
  correlatedSubscriptions.add(subscription);
  subscriptionsByCorrelationId.set(normalized, correlatedSubscriptions);

  for (const serverId of normalizedServerIds) {
    const subscriptions =
      subscriptionsByServerId.get(serverId) ??
      new Set<ScopeStepUpSubscription>();
    subscriptions.add(subscription);
    subscriptionsByServerId.set(serverId, subscriptions);
  }

  return () => {
    correlatedSubscriptions.delete(subscription);
    if (correlatedSubscriptions.size === 0) {
      subscriptionsByCorrelationId.delete(normalized);
    }
    for (const serverId of normalizedServerIds) {
      const subscriptions = subscriptionsByServerId.get(serverId);
      subscriptions?.delete(subscription);
      if (subscriptions?.size === 0) {
        subscriptionsByServerId.delete(serverId);
      }
    }
  };
}

export function publishHarnessScopeStepUp(
  correlationId: string | undefined,
  info: HarnessScopeStepUpEvent
): boolean {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  const correlatedSubscriptions = normalized
    ? subscriptionsByCorrelationId.get(normalized)
    : undefined;
  if (correlatedSubscriptions?.size) {
    const serverId = normalizeServerId(info.serverId);
    if (
      [...correlatedSubscriptions].some((subscription) =>
        subscription.serverIds.has(serverId)
      )
    ) {
      notifyInspector(info);
    }
    const notifiedListeners = new Set<Listener>();
    for (const subscription of correlatedSubscriptions) {
      if (notifiedListeners.has(subscription.listener)) continue;
      notifiedListeners.add(subscription.listener);
      notifyListener(subscription.listener, info);
    }
    return true;
  }

  // A resumed harness session can keep an MCP connection created by an older
  // turn, so its configured correlation may be absent or stale even though the
  // tool call still reaches this proxy. Recover only when exactly one live
  // harness turn selected this server. If two turns could receive the event,
  // drop it instead of opening OAuth in the wrong chat.
  const serverSubscriptions = subscriptionsByServerId.get(
    normalizeServerId(info.serverId)
  );
  if (serverSubscriptions?.size !== 1) return false;
  notifyInspector(info);
  for (const subscription of serverSubscriptions) {
    notifyListener(subscription.listener, info);
  }
  return true;
}

export function publishHarnessScopeStepUpFromToolError(
  correlationId: string | undefined,
  context: ScopeStepUpToolError
): void {
  const info = scopeStepUpInfoFromToolError(context);
  if (info) {
    publishHarnessScopeStepUp(correlationId, {
      ...info,
      ...(context.toolName ? { toolName: context.toolName } : {}),
      ...(Object.prototype.hasOwnProperty.call(context, "toolInput")
        ? { toolInput: context.toolInput }
        : {}),
    });
  }
}

/**
 * Build the control frame used when the harness MCP proxy and chat stream land
 * on different hosted replicas. It rides the existing short-lived shared RPC
 * sink but is consumed as control data, never rendered in the Logs panel.
 */
export function buildCrossInstanceHarnessScopeStepUpMessage(
  correlationId: string,
  event: HarnessScopeStepUpEvent
): CrossInstanceHarnessScopeStepUpMessage | undefined {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return undefined;
  return {
    type: CROSS_INSTANCE_SCOPE_STEP_UP_MARKER,
    correlationId: normalized,
    event,
  };
}

/** Validate and deliver a shared control frame on the chat-stream replica. */
export function consumeCrossInstanceHarnessScopeStepUpMessage(
  message: unknown
): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<CrossInstanceHarnessScopeStepUpMessage>;
  if (candidate.type !== CROSS_INSTANCE_SCOPE_STEP_UP_MARKER) return false;
  const correlationId = normalizeHarnessScopeStepUpCorrelationId(
    candidate.correlationId
  );
  const event = candidate.event;
  if (
    !correlationId ||
    !event ||
    typeof event !== "object" ||
    typeof event.serverId !== "string" ||
    (!event.requiredScope?.trim() && !event.resourceMetadataUrl?.trim())
  ) {
    // It is still a control marker, so consume malformed data instead of
    // leaking an internal frame into the user-visible RPC log.
    return true;
  }
  publishHarnessScopeStepUp(correlationId, event);
  return true;
}

/** Test seam: production cleanup happens through each subscription disposer. */
export function __resetHarnessScopeStepUpForTests(): void {
  subscriptionsByCorrelationId.clear();
  subscriptionsByServerId.clear();
}
