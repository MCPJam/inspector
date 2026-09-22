/**
 * Authoritative delivery of a harness MCP proxy policy block back to the turn.
 *
 * The proxy blocks the call on whichever replica served it; the run streams on
 * its own ("Stateless — any instance serves it"). The RESULT the harness reports
 * back cannot be relied on to carry the block: the Claude Code adapter flattens
 * an MCP result's content blocks to a bare string
 * (`@ai-sdk/harness-claude-code/dist/bridge/index.mjs`, `stringifyContent`), so
 * the `_meta` marker never reaches `run-harness-turn`.
 *
 * So the block rides the SAME channel a cross-instance scope step-up already
 * uses (`harness-scope-step-up.ts`): an in-process registry keyed by the turn's
 * opaque correlation id — which every generated `.mcp.json` entry already
 * carries — plus a control frame on the short-lived shared RPC-log sink for the
 * cross-replica case. The proxy KNOWS it blocked, so this is derived rather than
 * inferred from text.
 */
import {
  isToolPolicyDecisionReason,
  type ToolPolicyDecisionReason,
  type ToolSafetyClassification,
} from "@mcpjam/sdk/contract";
import { logger } from "../logger.js";
import {
  isRpcLogSinkConfigured,
  readCrossInstanceRpcLogs,
  type RpcLogCursor,
} from "./harness-rpc-log-sink.js";
// Same opaque per-turn id (`turnId`) the scope step-up channel correlates on —
// one normalizer so a value one channel routes cannot be dropped by the other.
import { normalizeHarnessScopeStepUpCorrelationId } from "./harness-scope-step-up.js";

export interface HarnessPolicyBlockEvent {
  serverId: string;
  toolName: string;
  reason: ToolPolicyDecisionReason;
  classification: ToolSafetyClassification;
  /** When the proxy refused the call, ms since epoch. */
  at: number;
}

const CROSS_INSTANCE_POLICY_BLOCK_MARKER = "mcpjam.harness-policy-block.v1";

type CrossInstanceHarnessPolicyBlockMessage = {
  type: typeof CROSS_INSTANCE_POLICY_BLOCK_MARKER;
  correlationId: string;
  event: HarnessPolicyBlockEvent;
};

type Listener = (event: HarnessPolicyBlockEvent) => void;
type Subscription = {
  correlationId: string;
  serverIds: ReadonlySet<string>;
  listener: Listener;
};

const subscriptions = new Set<Subscription>();

function normalizeServerId(serverId: string): string {
  return serverId.trim().toLowerCase();
}

export function subscribeHarnessPolicyBlocks(
  correlationId: string,
  listener: Listener,
  serverIds: readonly string[] = []
): () => void {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return () => {};
  const subscription: Subscription = {
    correlationId: normalized,
    serverIds: new Set(serverIds.map(normalizeServerId).filter(Boolean)),
    listener,
  };
  subscriptions.add(subscription);
  return () => {
    subscriptions.delete(subscription);
  };
}

/**
 * Deliver a block to the turn that configured this correlation id. Returns
 * whether a local subscriber took it, so the proxy only pays for the shared-sink
 * relay when the turn is streaming on another replica.
 *
 * Unlike the scope step-up channel there is NO single-live-turn fallback by
 * server id: this record ends up as measurement on a specific iteration, and
 * attributing a block to the wrong run is worse than a missing one (the turn's
 * own result-text detection still covers the uncorrelated case).
 */
export function publishHarnessPolicyBlock(
  correlationId: string | undefined,
  event: HarnessPolicyBlockEvent
): boolean {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return false;
  const serverId = normalizeServerId(event.serverId);
  let delivered = false;
  for (const subscription of subscriptions) {
    if (subscription.correlationId !== normalized) continue;
    if (!subscription.serverIds.has(serverId)) continue;
    delivered = true;
    try {
      subscription.listener(event);
    } catch (error) {
      logger.warn("[harness-policy-block] subscriber failed", {
        serverId: event.serverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return delivered;
}

/** Control frame for the cross-replica case; consumed as data, never rendered. */
export function buildCrossInstanceHarnessPolicyBlockMessage(
  correlationId: string,
  event: HarnessPolicyBlockEvent
): CrossInstanceHarnessPolicyBlockMessage | undefined {
  const normalized = normalizeHarnessScopeStepUpCorrelationId(correlationId);
  if (!normalized) return undefined;
  return {
    type: CROSS_INSTANCE_POLICY_BLOCK_MARKER,
    correlationId: normalized,
    event,
  };
}

/** Validate and deliver a shared control frame on the turn's replica. */
export function consumeCrossInstanceHarnessPolicyBlockMessage(
  message: unknown
): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<CrossInstanceHarnessPolicyBlockMessage>;
  if (candidate.type !== CROSS_INSTANCE_POLICY_BLOCK_MARKER) return false;
  const correlationId = normalizeHarnessScopeStepUpCorrelationId(
    candidate.correlationId
  );
  const event = candidate.event;
  if (
    !correlationId ||
    !event ||
    typeof event !== "object" ||
    typeof event.serverId !== "string" ||
    typeof event.toolName !== "string" ||
    !isToolPolicyDecisionReason(event.reason) ||
    typeof event.classification !== "string"
  ) {
    // Still OUR control marker: consume malformed data rather than leak an
    // internal frame into the user-visible RPC log.
    return true;
  }
  publishHarnessPolicyBlock(correlationId, {
    serverId: event.serverId,
    toolName: event.toolName,
    reason: event.reason,
    classification: event.classification,
    at: typeof event.at === "number" ? event.at : Date.now(),
  });
  return true;
}

/** How often a policied harness turn pulls other replicas' control frames. */
const CROSS_INSTANCE_POLL_MS = 1000;

/**
 * Pull policy-block control frames OTHER replicas wrote for these servers.
 *
 * The playground's Logs poll (`startCrossInstanceRpcLogPoll`) only runs for chat
 * streams, so an eval harness turn needs its own reader; the sink read excludes
 * this process's rows, so a block already delivered in-process is never pulled
 * twice. Best-effort and read-only: a failing sink costs the authoritative path,
 * not the turn. No-op when the sink isn't configured (single-instance /
 * self-hosted, where the in-process registry is the whole delivery).
 */
export function startCrossInstanceHarnessPolicyBlockPoll(
  serverIds: readonly string[]
): () => void {
  if (serverIds.length === 0 || !isRpcLogSinkConfigured()) return () => {};
  let stopped = false;
  const startedAt = Date.now();
  let cursors: RpcLogCursor[] = [...new Set(serverIds)].map((serverId) => ({
    serverId,
    sinceMs: startedAt,
  }));
  const seen = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const page = await readCrossInstanceRpcLogs({ servers: cursors });
      for (const entry of page.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        consumeCrossInstanceHarnessPolicyBlockMessage(entry.message);
      }
      // Adopt the sink's cursors verbatim (own-instance rows are filtered after
      // the scan, so a cursor derived from delivered frames would stall).
      cursors = page.cursors;
    } catch {
      // Observation of a refusal must never fail the turn.
    }
    if (!stopped) {
      timer = setTimeout(tick, CROSS_INSTANCE_POLL_MS);
      timer.unref?.();
    }
  };
  timer = setTimeout(tick, CROSS_INSTANCE_POLL_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Test seam: production cleanup happens through each subscription disposer. */
export function __resetHarnessPolicyBlockChannelForTests(): void {
  subscriptions.clear();
}
