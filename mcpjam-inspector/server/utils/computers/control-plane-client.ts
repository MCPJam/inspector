/**
 * Convex control-plane client for Project Computers.
 *
 * The inspector server is the DATA plane (it holds `E2B_API_KEY` and the live
 * exec/PTY connections); Convex owns the durable rows. This module wraps the
 * backend's `/computers/*` HTTP routes (mcpjam-backend
 * `convex/computersDataPlane.ts`), reached via `CONVEX_HTTP_URL` like
 * `chatbox-runtime-config.ts` does:
 *
 *   reserve           user-bearer auth — reserve/wake/poll the acting user's
 *                     computer (idempotent; each poll also counts as activity)
 *   sandbox-info      shared-secret auth — Convex row id → vendor sandbox id.
 *                     The secret marks us as the deployed server; browsers
 *                     must never be able to make this exchange.
 *   commands          shared-secret auth — durable command log (idempotent)
 *   terminal-sessions shared-secret auth — session open/close records
 */
import { logger } from "../logger.js";
import { type ExecutionScope } from "../execution-scope.js";

const SECRET_HEADER = "x-computers-data-plane-secret";

export type ComputerStatus =
  | "requested"
  | "provisioning"
  | "ready"
  | "waking"
  | "hibernating"
  | "deleting"
  | "deleted"
  | "error";

export interface ReservedComputer {
  computerId: string;
  status: ComputerStatus;
  provider: string;
  lastError?: string;
}

export interface ComputerSandboxInfo {
  computerId: string;
  providerComputerId: string | null;
  provider: string;
  status: ComputerStatus;
  projectId: string;
  ownerUserId: string;
}

export type ControlPlaneResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string | null {
  return process.env.CONVEX_HTTP_URL?.trim() || null;
}

function getDataPlaneSecret(): string | null {
  return process.env.COMPUTERS_DATA_PLANE_SECRET?.trim() || null;
}

/** True when every env var the computers data plane needs is present. */
export function isComputersDataPlaneConfigured(): boolean {
  return Boolean(
    getConvexHttpUrl() && getDataPlaneSecret() && process.env.E2B_API_KEY
  );
}

async function postJson<T>(
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ControlPlaneResult<T>> {
  const base = getConvexHttpUrl();
  if (!base) {
    return { ok: false, status: 0, error: "CONVEX_HTTP_URL is not set" };
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    logger.error(`[computers] ${path} network error`, err);
    return { ok: false, status: 0, error: "network error" };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // fall through with null payload
  }
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `request failed (${response.status})`;
    return { ok: false, status: response.status, error };
  }
  return { ok: true, value: payload as T };
}

function secretHeaders(): Record<string, string> | null {
  const secret = getDataPlaneSecret();
  return secret ? { [SECRET_HEADER]: secret } : null;
}

function bearerHeader(raw: string): Record<string, string> {
  const value = raw.trim();
  return {
    authorization: /^bearer\s/i.test(value) ? value : `Bearer ${value}`,
  };
}

export interface EvalSandbox {
  sandboxId: string;
  sandboxRowId: string;
}

/**
 * Provision a fresh ephemeral sandbox for one eval iteration, pinned to the
 * run's frozen environment build (user-bearer auth). The body carries only the
 * run/iteration ids — the control plane resolves the image from the run's
 * configSnapshot, so this can never boot an arbitrary template.
 */
export async function provisionEvalSandbox(args: {
  bearer: string;
  runId: string;
  iterationId?: string;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<EvalSandbox>> {
  return postJson<EvalSandbox>(
    "/evals/sandbox/provision",
    bearerHeader(args.bearer),
    {
      runId: args.runId,
      ...(args.iterationId ? { iterationId: args.iterationId } : {}),
    },
    args.signal
  );
}

/** Release an eval sandbox (shared-secret auth; idempotent). */
export async function releaseEvalSandbox(args: {
  sandboxRowId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const headers = secretHeaders();
  if (!headers) return;
  const result = await postJson(
    "/evals/sandbox/release",
    headers,
    { sandboxRowId: args.sandboxRowId },
    args.signal
  );
  if (!result.ok) {
    // Best-effort: the GC cron reaps any box this misses by TTL.
    logger.warn("[evals] failed to release sandbox", {
      sandboxRowId: args.sandboxRowId,
      status: result.status,
      error: result.error,
    });
  }
}

/**
 * Reserve/wake the acting user's computer (user-bearer auth). Phase 3: when an
 * `executionScope` is supplied (from runtime-config), send it so the backend
 * re-resolves live access and applies per-swarm isolation/caps; otherwise fall
 * back to the legacy `{ projectId }` body. The scope is opaque to the client —
 * the backend is authoritative.
 */
export async function reserveComputer(args: {
  bearer: string;
  projectId: string;
  executionScope?: ExecutionScope;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<ReservedComputer>> {
  return postJson<ReservedComputer>(
    "/computers/reserve",
    bearerHeader(args.bearer),
    args.executionScope
      ? { executionScope: args.executionScope }
      : { projectId: args.projectId },
    args.signal
  );
}

/** Exchange a computer row id for its vendor sandbox info (secret auth). */
export async function getComputerSandboxInfo(args: {
  computerId: string;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<ComputerSandboxInfo>> {
  const headers = secretHeaders();
  if (!headers) {
    return {
      ok: false,
      status: 0,
      error: "COMPUTERS_DATA_PLANE_SECRET is not set",
    };
  }
  return postJson<ComputerSandboxInfo>(
    "/computers/sandbox-info",
    headers,
    { computerId: args.computerId },
    args.signal
  );
}

/** Record an executed command (secret auth; idempotent on commandId). */
export async function recordComputerCommand(args: {
  computerId: string;
  commandId: string;
  source: "chat" | "terminal-api";
  command: string;
  status: "completed" | "failed";
  exitCode?: number;
  outputPreview?: string;
}): Promise<void> {
  const headers = secretHeaders();
  if (!headers) return;
  const result = await postJson("/computers/commands", headers, { ...args });
  if (!result.ok) {
    // Best-effort log write: the command already ran; losing the record must
    // not fail the tool call.
    logger.warn("[computers] failed to record command", {
      computerId: args.computerId,
      status: result.status,
      error: result.error,
    });
  }
}

/** Record a terminal session transition (secret auth; idempotent). */
export async function recordTerminalSession(args: {
  sessionId: string;
  action: "open" | "close";
  computerId?: string;
}): Promise<void> {
  const headers = secretHeaders();
  if (!headers) return;
  const result = await postJson("/computers/terminal-sessions", headers, {
    sessionId: args.sessionId,
    action: args.action,
    ...(args.computerId ? { computerId: args.computerId } : {}),
  });
  if (!result.ok) {
    logger.warn("[computers] failed to record terminal session", {
      sessionId: args.sessionId,
      action: args.action,
      status: result.status,
      error: result.error,
    });
  }
}

/**
 * Reserve and poll until the computer is `ready` (provision-on-first-use and
 * wake-on-cold both converge here). Polling re-calls reserve — it's
 * idempotent, keeps `lastActiveAt` fresh so the idle sweep can't reclaim the
 * machine mid-wait, and rides the same authorization as the first call.
 */
export async function ensureComputerReady(args: {
  bearer: string;
  projectId: string;
  /** Phase 3 scope; forwarded verbatim to reserveComputer (legacy when absent). */
  executionScope?: ExecutionScope;
  signal?: AbortSignal;
  /** Overall budget. E2B cold provision is seconds; waking ~1s. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<ControlPlaneResult<ReservedComputer>> {
  const timeoutMs = args.timeoutMs ?? 75_000;
  const pollIntervalMs = args.pollIntervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const reserved = await reserveComputer(args);
    if (!reserved.ok) return reserved;
    const { status } = reserved.value;
    if (status === "ready") return reserved;
    if (status === "error") {
      return {
        ok: false,
        status: 502,
        error: reserved.value.lastError
          ? `computer failed to provision: ${reserved.value.lastError}`
          : "computer failed to provision",
      };
    }
    if (status === "deleting" || status === "deleted") {
      return { ok: false, status: 410, error: "computer was deleted" };
    }
    if (Date.now() + pollIntervalMs > deadline) {
      return {
        ok: false,
        status: 504,
        error: `computer not ready after ${Math.round(
          timeoutMs / 1000
        )}s (status: ${status})`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (args.signal?.aborted) {
      return { ok: false, status: 499, error: "cancelled" };
    }
  }
}
