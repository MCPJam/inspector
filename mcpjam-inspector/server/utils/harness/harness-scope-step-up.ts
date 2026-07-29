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
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

type Listener = (info: InsufficientScopeInfo) => void;
const listenersByCorrelationId = new Map<string, Set<Listener>>();
type ServerSubscription = {
  correlationId: string;
  listener: Listener;
};
const subscriptionsByServerId = new Map<string, Set<ServerSubscription>>();

function normalizeServerId(serverId: string): string {
  return serverId.trim().toLowerCase();
}

function notifyListener(
  listener: Listener,
  info: InsufficientScopeInfo,
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
  serverIds: readonly string[] = [],
): () => void {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return () => {};

  const listeners = listenersByCorrelationId.get(normalized) ?? new Set();
  listeners.add(listener);
  listenersByCorrelationId.set(normalized, listeners);

  const serverSubscriptions: Array<{
    serverId: string;
    subscription: ServerSubscription;
  }> = [];
  for (const rawServerId of new Set(serverIds)) {
    const serverId = normalizeServerId(rawServerId);
    if (!serverId) continue;
    const subscriptions =
      subscriptionsByServerId.get(serverId) ?? new Set<ServerSubscription>();
    const subscription = { correlationId: normalized, listener };
    subscriptions.add(subscription);
    subscriptionsByServerId.set(serverId, subscriptions);
    serverSubscriptions.push({ serverId, subscription });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByCorrelationId.delete(normalized);
    }
    for (const { serverId, subscription } of serverSubscriptions) {
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
  info: InsufficientScopeInfo,
): void {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  const correlatedListeners = normalized
    ? listenersByCorrelationId.get(normalized)
    : undefined;
  if (correlatedListeners?.size) {
    notifyInspector(info);
    for (const listener of correlatedListeners) {
      notifyListener(listener, info);
    }
    return;
  }

  // A resumed harness session can keep an MCP connection created by an older
  // turn, so its configured correlation may be absent or stale even though the
  // tool call still reaches this proxy. Recover only when exactly one live
  // harness turn selected this server. If two turns could receive the event,
  // drop it instead of opening OAuth in the wrong chat.
  const serverSubscriptions = subscriptionsByServerId.get(
    normalizeServerId(info.serverId),
  );
  if (serverSubscriptions?.size !== 1) return;
  notifyInspector(info);
  for (const subscription of serverSubscriptions) {
    notifyListener(subscription.listener, info);
  }
}

export function publishHarnessScopeStepUpFromToolError(
  correlationId: string | undefined,
  context: ScopeStepUpToolError,
): void {
  const info = scopeStepUpInfoFromToolError(context);
  if (info) {
    publishHarnessScopeStepUp(correlationId, info);
  }
}

/** Test seam: production cleanup happens through each subscription disposer. */
export function __resetHarnessScopeStepUpForTests(): void {
  listenersByCorrelationId.clear();
  subscriptionsByServerId.clear();
}
