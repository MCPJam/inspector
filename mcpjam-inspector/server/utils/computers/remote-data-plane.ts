/**
 * Remote data plane for Project Computers.
 *
 * Being the data plane requires `E2B_API_KEY` + the shared secrets —
 * credentials a locally-run OSS inspector must never hold (the vendor key is
 * billable; the secret resolves ANY user's sandbox id). Instead, a local
 * server can name a deployed inspector via the NON-secret
 * `COMPUTERS_REMOTE_DATA_PLANE_URL` and forward both data-plane operations
 * there, keeping authorization per-user end to end:
 *
 *   - terminal: the browser opens its WebSocket against the remote origin
 *     (advertised via GET /api/web/computers/config); auth is unchanged —
 *     the Convex-minted per-user terminal token works on any data plane
 *     holding the verify secret.
 *   - bash exec: `execViaRemoteDataPlane` POSTs /api/web/computers/exec with
 *     the user's bearer; the remote forwards it to Convex `/computers/reserve`
 *     which authorizes exactly as if that server had received the chat turn.
 *
 * Local configuration (real secrets) always wins over the remote URL — a
 * deployed data plane never delegates, so there is no forwarding loop.
 *
 * `COMPUTERS_REMOTE_DATA_PLANE_URL` is an explicit override, not the primary
 * path — hand-setting it per environment (per dev laptop, per PR preview) is
 * exactly the manual-config problem this module exists to avoid. When it's
 * unset, `initComputersRemoteDataPlaneDiscovery` (called once at server
 * startup) asks THIS deployment's own Convex for the answer via the
 * non-secret `/computers/data-plane-url` route (`mcpjam-backend
 * convex/computersDataPlane.ts`) and caches it — every server pointed at the
 * same Convex deployment auto-discovers the same data plane with zero
 * per-environment config.
 */
import { logger } from "../logger.js";
import {
  COMPUTERS_NOT_CONFIGURED_ERROR,
  type RunComputerCommandResult,
} from "./run-command.js";
import { type ExecutionScope } from "../execution-scope.js";
import {
  getConvexHttpUrl,
  isComputersDataPlaneConfigured,
} from "./control-plane-client.js";

function normalizeDataPlaneUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Populated once by `initComputersRemoteDataPlaneDiscovery`; null until then
 *  (or forever, if discovery is skipped/fails — same as today's unconfigured
 *  state). */
let discoveredRemoteUrl: string | null = null;

/** Origin of the deployed data plane, or null when unset/undiscovered.
 *  Stays synchronous — some callers (the harness pre-flight check) need a
 *  cheap, non-network check — by reading a value resolved ahead of time
 *  rather than fetching on every call. */
export function getComputersRemoteDataPlaneUrl(): string | null {
  const explicit = normalizeDataPlaneUrl(
    process.env.COMPUTERS_REMOTE_DATA_PLANE_URL?.trim()
  );
  return explicit ?? discoveredRemoteUrl;
}

export function resetComputersRemoteDataPlaneDiscoveryForTests(): void {
  discoveredRemoteUrl = null;
}

/**
 * Resolves the auto-discovered data-plane URL once at server startup so
 * `getComputersRemoteDataPlaneUrl` can stay synchronous everywhere else.
 * Call once during boot, before the server starts accepting requests.
 *
 * Skips the network call entirely when an explicit override is already set,
 * or when this server holds real secrets itself (`isComputersDataPlaneConfigured`)
 * — a deployed data plane never delegates, so it has nothing to discover.
 * Never throws: a failed or skipped lookup just leaves Computers
 * unconfigured, same as today's behavior with no env var set.
 */
export async function initComputersRemoteDataPlaneDiscovery(): Promise<void> {
  if (process.env.COMPUTERS_REMOTE_DATA_PLANE_URL?.trim()) return;
  if (isComputersDataPlaneConfigured()) return;
  const base = getConvexHttpUrl();
  if (!base) return;
  try {
    const response = await fetch(
      new URL("/computers/data-plane-url", base).toString(),
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return;
    const payload = (await response.json()) as { url?: unknown };
    discoveredRemoteUrl = normalizeDataPlaneUrl(
      typeof payload.url === "string" ? payload.url : null
    );
  } catch (error) {
    logger.error("[computers] data-plane auto-discovery failed", error);
  }
}

function isExecResult(payload: unknown): payload is RunComputerCommandResult {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.error === "string") return true;
  return (
    typeof p.stdout === "string" &&
    typeof p.stderr === "string" &&
    typeof p.exitCode === "number"
  );
}

export async function execViaRemoteDataPlane(args: {
  /** Bearer authorization forwarded verbatim (the remote re-validates it). */
  authHeader: string;
  projectId: string;
  /** Phase 3 scope forwarded so the remote reserve re-resolves live access. */
  executionScope?: ExecutionScope;
  command: string;
  commandId: string;
  workdir?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<RunComputerCommandResult> {
  const base = getComputersRemoteDataPlaneUrl();
  if (!base) {
    return { error: COMPUTERS_NOT_CONFIGURED_ERROR };
  }

  const trimmed = args.authHeader.trim();
  const authorization = /^bearer\s/i.test(trimmed)
    ? trimmed
    : `Bearer ${trimmed}`;

  let response: Response;
  try {
    response = await fetch(`${base}/api/web/computers/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        projectId: args.projectId,
        ...(args.executionScope ? { executionScope: args.executionScope } : {}),
        command: args.command,
        commandId: args.commandId,
        ...(args.workdir ? { workdir: args.workdir } : {}),
        ...(args.timeoutSeconds !== undefined
          ? { timeoutSeconds: args.timeoutSeconds }
          : {}),
      }),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    if (args.signal?.aborted) {
      return { error: "Command was cancelled." };
    }
    logger.error("[computers] remote data plane exec network error", error);
    return { error: "Could not reach the computers data plane." };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // fall through with null payload
  }

  if (!response.ok) {
    // webError envelope: { code, message, … }.
    const message =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { message?: unknown }).message === "string"
        ? (payload as { message: string }).message
        : `remote exec failed (${response.status})`;
    return { error: `Computer unavailable: ${message}` };
  }

  if (isExecResult(payload)) return payload;
  return { error: "The computers data plane returned an unexpected response." };
}
