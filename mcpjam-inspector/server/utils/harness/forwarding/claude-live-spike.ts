/**
 * PLB-580 spike: can claude.ai's own MCP client reach MCPJam, and can we record
 * what it sends? Draft only, never merged.
 *
 * The forwarding route trusts a session grant that a cloud box's egress adds
 * and nothing inside the box can read. claude.ai calls from Anthropic's cloud,
 * so that cannot apply here. The spike stands in with a static secret header
 * (claude.ai custom connectors accept request headers) and a "turn" an
 * operator switches on before each prompt and off after it. Every frame is
 * recorded under the live turn, which is how a call is tied to its prompt.
 *
 * State lives in this process: a spike runs on one dev instance.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { redactForTelemetry, type RpcLogger } from "@mcpjam/sdk";
import { rpcLogBus } from "../../../services/rpc-log-bus.js";
import { probeSerializedSize } from "../../../../shared/rpc-log-truncation.js";
import { enqueueHarnessRpcLog } from "../harness-rpc-log-sink.js";
import { logger } from "../../logger.js";

export const SPIKE_KEY_HEADER = "x-mcpjam-spike-key";
export const SPIKE_CONTROL_HEADER = "x-mcpjam-spike-control";

export type ClaudeLiveSpikeConfig = {
  upstreamUrl: string;
  connectorSecret: string;
  controlSecret: string;
  /** The RPC log sink keys frames by server id; any stable string works. */
  serverId: string;
  projectId?: string;
  organizationId?: string;
};

/** Undefined unless every required variable is set: the route then answers 404. */
export function readClaudeLiveSpikeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeLiveSpikeConfig | undefined {
  const upstreamUrl = env.CLAUDE_LIVE_SPIKE_UPSTREAM_URL?.trim();
  const connectorSecret = env.CLAUDE_LIVE_SPIKE_CONNECTOR_SECRET?.trim();
  const controlSecret = env.CLAUDE_LIVE_SPIKE_CONTROL_SECRET?.trim();
  if (!upstreamUrl || !connectorSecret || !controlSecret) return undefined;
  // One secret must not open both doors: claude.ai holds the connector secret.
  if (connectorSecret === controlSecret) return undefined;
  return {
    upstreamUrl,
    connectorSecret,
    controlSecret,
    serverId: env.CLAUDE_LIVE_SPIKE_SERVER_ID?.trim() || "claude-live-spike",
    projectId: env.CLAUDE_LIVE_SPIKE_PROJECT_ID?.trim() || undefined,
    organizationId: env.CLAUDE_LIVE_SPIKE_ORGANIZATION_ID?.trim() || undefined,
  };
}

export function secretMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  if (!presented) return false;
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export type SpikeTurn = { id: string; label: string; startedAt: string };

/** The envelope a frame rode in. Only these names are kept; none is a credential. */
const RECORDED_HEADERS = [
  "user-agent",
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
] as const;

export type SpikeRecord =
  | {
      kind: "request";
      at: string;
      httpMethod: string;
      rpcMethod?: string;
      headers: Record<string, string>;
    }
  | {
      kind: "frame";
      at: string;
      direction: "send" | "receive";
      message: unknown;
    }
  | { kind: "refused"; at: string; httpMethod: string; reason: string };

/** Enough for a handful of prompts with widgets; older records drop first. */
const MAX_RECORDS_PER_TURN = 2_000;
const MAX_TURNS = 50;
const FRAME_LIMIT_BYTES = 1024 * 1024;

export type ClaudeLiveSpikeRecorder = ReturnType<
  typeof createClaudeLiveSpikeRecorder
>;

export function createClaudeLiveSpikeRecorder(config: ClaudeLiveSpikeConfig) {
  let live: SpikeTurn | undefined;
  const turns = new Map<string, { turn: SpikeTurn; records: SpikeRecord[] }>();
  /** Requests that arrive with no turn live are kept here, so a refusal is visible too. */
  const outside: SpikeRecord[] = [];

  const push = (list: SpikeRecord[], record: SpikeRecord) => {
    list.push(record);
    if (list.length > MAX_RECORDS_PER_TURN) list.shift();
  };

  return {
    liveTurn: () => live,

    start(label: string | undefined): SpikeTurn {
      const turn: SpikeTurn = {
        id: randomUUID(),
        label: label?.trim().slice(0, 80) || `turn-${turns.size + 1}`,
        startedAt: new Date().toISOString(),
      };
      turns.set(turn.id, { turn, records: [] });
      if (turns.size > MAX_TURNS) {
        const oldest = turns.keys().next().value;
        if (oldest !== undefined) turns.delete(oldest);
      }
      live = turn;
      return turn;
    },

    stop(): SpikeTurn | undefined {
      const ended = live;
      live = undefined;
      return ended;
    },

    request(turn: SpikeTurn, request: Request, rpcMethod?: string) {
      const headers: Record<string, string> = {};
      for (const name of RECORDED_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const list = turns.get(turn.id)?.records;
      if (list)
        push(list, {
          kind: "request",
          at: new Date().toISOString(),
          httpMethod: request.method,
          ...(rpcMethod ? { rpcMethod } : {}),
          headers,
        });
      logger.info(
        `[claude-live-spike] ${request.method} ${rpcMethod ?? "-"} turn=${turn.label}`,
      );
    },

    refused(request: Request, reason: string) {
      push(outside, {
        kind: "refused",
        at: new Date().toISOString(),
        httpMethod: request.method,
        reason,
      });
      logger.info(`[claude-live-spike] refused ${request.method}: ${reason}`);
    },

    /** Frames go to this turn's record, the Logs panel bus and the shared sink. */
    rpcLogger(turn: SpikeTurn): RpcLogger {
      const scopeId = `claude-live-spike:${turn.id}`;
      return ({ direction, message }) => {
        try {
          const safe = probeSerializedSize(message, FRAME_LIMIT_BYTES).exceeded
            ? { _truncated: true, limitBytes: FRAME_LIMIT_BYTES }
            : redactForTelemetry(message);
          const at = new Date().toISOString();
          const list = turns.get(turn.id)?.records;
          if (list) push(list, { kind: "frame", at, direction, message: safe });
          rpcLogBus.publish({
            serverId: config.serverId,
            scopeId,
            direction,
            timestamp: at,
            message: safe,
          });
          enqueueHarnessRpcLog({
            serverId: config.serverId,
            scopeId,
            direction,
            loggedAt: at,
            ...(config.projectId ? { projectId: config.projectId } : {}),
            ...(config.organizationId
              ? { organizationId: config.organizationId }
              : {}),
            message: safe,
          });
        } catch {
          // Recording is observation-only; the forwarded request must not fail on it.
          logger.warn("[claude-live-spike] a frame could not be recorded");
        }
      };
    },

    snapshot() {
      return {
        live: live ?? null,
        turns: [...turns.values()].map(({ turn, records }) => ({
          ...turn,
          records,
        })),
        refusedWithoutTurn: outside,
      };
    },
  };
}
