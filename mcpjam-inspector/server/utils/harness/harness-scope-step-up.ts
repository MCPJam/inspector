import type { InsufficientScopeInfo } from "../../routes/web/hosted-elicitation.js";
import {
  scopeStepUpInfoFromToolError,
  type ScopeStepUpToolError,
} from "../insufficient-scope-step-up.js";
import { logger } from "../logger.js";
export { HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER } from "./mcp-config.js";

/**
 * Opaque per-turn header carried by every generated harness `.mcp.json` entry.
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

export function subscribeHarnessScopeStepUp(
  correlationId: string,
  listener: Listener,
): () => void {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return () => {};

  const listeners = listenersByCorrelationId.get(normalized) ?? new Set();
  listeners.add(listener);
  listenersByCorrelationId.set(normalized, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByCorrelationId.delete(normalized);
    }
  };
}

export function publishHarnessScopeStepUp(
  correlationId: string | undefined,
  info: InsufficientScopeInfo,
): void {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return;

  for (const listener of listenersByCorrelationId.get(normalized) ?? []) {
    try {
      listener(info);
    } catch (error) {
      logger.warn("[harness-scope-step-up] subscriber failed", {
        serverId: info.serverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
}
