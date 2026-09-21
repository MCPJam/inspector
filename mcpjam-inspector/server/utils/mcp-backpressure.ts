import { z } from "zod";
import { HOSTED_MODE } from "../config.js";
import { logger } from "./logger.js";
import { abortableSleep } from "./run-supervisor/backoff.js";
import { withDeadline } from "./run-supervisor/deadline.js";
import { retryAfterMsOf } from "./run-supervisor/retry.js";

export interface McpAdmissionCoordinator {
  admit(
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; retryAfterMs: number; reason: string }>;
  report(observation: { status: number; retryAfterMs?: number }): Promise<void>;
}

export class McpAdmissionError extends Error {
  readonly name = "McpAdmissionError";
  constructor(
    readonly code:
      | "mcp_admission_unavailable"
      | "mcp_admission_queue_full"
      | "mcp_admission_wait_exhausted",
  ) {
    // Do not inherit a transport error's retryable wording. These failures
    // occurred before dispatch (or while recording pressure), not at the MCP.
    super(`MCP request admission stopped (${code})`);
  }
}

// Bound waiting work across managers in this worker. Shared pacing/cooldowns
// live in Convex; this map is only the local memory-pressure guard.
const pendingByKey = new Map<string, number>();

function requiresAdmission(
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") return false;
  // Cancellation must be able to reach a server even when work is queued.
  if (typeof init?.body === "string") {
    try {
      if (JSON.parse(init.body)?.method === "notifications/cancelled")
        return false;
    } catch {
      /* Transport validates the body. */
    }
  }
  return true;
}

export function createMcpBackpressureFetch(options: {
  key: string;
  fetch: typeof fetch;
  coordinator: McpAdmissionCoordinator;
  jitter?: () => number;
  maxPending?: number;
  enabled?: () => boolean;
  onWait?: (info: { reason: string; delayMs: number }) => void;
  onAdmitted?: (waitedMs: number) => void;
  onPressure?: (info: { status: number; retryAfterMs?: number }) => void;
}): typeof fetch {
  const enabled = options.enabled ?? (() => true);
  let feedbackFailed = false;
  return (async (input, init) => {
    if (!enabled() || !requiresAdmission(input, init))
      return options.fetch(input, init);
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    if (feedbackFailed)
      throw new McpAdmissionError("mcp_admission_unavailable");
    const pending = pendingByKey.get(options.key) ?? 0;
    if (pending >= (options.maxPending ?? 64))
      throw new McpAdmissionError("mcp_admission_queue_full");
    pendingByKey.set(options.key, pending + 1);
    const startedAt = Date.now();
    const budgetMs = 60_000;
    const deadline = withDeadline(signal ?? undefined, budgetMs, "toolCall");
    try {
      while (enabled()) {
        deadline.signal.throwIfAborted();
        const decision = await options.coordinator.admit(deadline.signal);
        deadline.signal.throwIfAborted();
        if (decision.allowed) break;
        // Positive jitter ONLY: Retry-After is a minimum, never shortened.
        const delayMs =
          Math.max(25, decision.retryAfterMs) +
          (options.jitter ?? (() => Math.floor(Math.random() * 100)))();
        if (
          !Number.isFinite(delayMs) ||
          Date.now() + delayMs >= startedAt + budgetMs
        )
          throw new McpAdmissionError("mcp_admission_wait_exhausted");
        options.onWait?.({ reason: decision.reason, delayMs });
        const until = Date.now() + delayMs;
        // Recheck the kill switch locally, without polling Convex early.
        while (enabled() && Date.now() < until) {
          deadline.signal.throwIfAborted();
          await abortableSleep(
            Math.min(250, until - Date.now()),
            deadline.signal,
          );
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof McpAdmissionError) throw error;
      throw new McpAdmissionError(
        deadline.signal.aborted
          ? "mcp_admission_wait_exhausted"
          : "mcp_admission_unavailable",
      );
    } finally {
      deadline.dispose();
      const remaining = (pendingByKey.get(options.key) ?? 1) - 1;
      if (remaining > 0) pendingByKey.set(options.key, remaining);
      else pendingByKey.delete(options.key);
    }
    signal?.throwIfAborted();
    options.onAdmitted?.(Date.now() - startedAt);
    // Exactly one upstream dispatch. Admission retries never replay this call.
    const response = await options.fetch(input, init);
    const retryAfterMs = retryAfterMsOf({ response });
    if (
      enabled() &&
      (response.status === 429 ||
        (response.status === 503 && retryAfterMs !== undefined))
    ) {
      const pressure = {
        status: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
      options.onPressure?.(pressure);
      try {
        await options.coordinator.report(pressure);
      } catch {
        feedbackFailed = true;
        void response.body?.cancel().catch(() => undefined);
        throw new McpAdmissionError("mcp_admission_unavailable");
      }
    }
    return response;
  }) as typeof fetch;
}

const decisionSchema = z.object({
  allowed: z.boolean(),
  retryAfterMs: z.number().finite().nonnegative(),
  reason: z.enum(["ready", "pacing", "cooldown"]),
});

export function hostedMcpBackpressureFetch(options: {
  fetch: typeof fetch;
  projectId: string;
  serverId: string;
  userId?: string | null;
}): typeof fetch {
  const enabled = () =>
    HOSTED_MODE &&
    (process.env.MCPJAM_MCP_BACKPRESSURE_SERVER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .includes(options.serverId);
  if (!enabled()) return options.fetch;
  const endpoint = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!endpoint || !serviceToken || !options.userId)
    throw new McpAdmissionError("mcp_admission_unavailable");
  const scope = {
    projectId: options.projectId,
    serverId: options.serverId,
    userId: options.userId,
  };
  const request = async (
    action: "admit" | "report",
    extra: object,
    signal?: AbortSignal,
  ) => {
    const deadline = withDeadline(signal, 5_000, "toolCall");
    try {
      const response = await fetch(
        `${endpoint}/internal/mcp-backpressure/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-inspector-service-token": serviceToken,
          },
          body: JSON.stringify({ ...scope, ...extra }),
          signal: deadline.signal,
        },
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new McpAdmissionError("mcp_admission_unavailable");
      }
      return await response.json();
    } finally {
      deadline.dispose();
    }
  };
  return createMcpBackpressureFetch({
    key: options.serverId,
    fetch: options.fetch,
    enabled,
    coordinator: {
      admit: async (signal) =>
        decisionSchema.parse(await request("admit", {}, signal)),
      report: async (pressure) => {
        z.object({ recorded: z.literal(true) }).parse(
          await request("report", pressure),
        );
      },
    },
    onWait: (info) =>
      logger.info("[mcp.backpressure] waiting", {
        serverId: options.serverId,
        ...info,
      }),
    onAdmitted: (waitedMs) =>
      logger.info("[mcp.backpressure] admitted", {
        serverId: options.serverId,
        waitedMs,
      }),
    onPressure: (info) =>
      logger.info("[mcp.backpressure] upstream pressure", {
        serverId: options.serverId,
        ...info,
      }),
  });
}
