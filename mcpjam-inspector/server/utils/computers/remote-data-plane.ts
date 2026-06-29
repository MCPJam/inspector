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
 */
import { logger } from "../logger.js";
import {
  COMPUTERS_NOT_CONFIGURED_ERROR,
  type RunComputerCommandResult,
} from "./run-command.js";
import { type ExecutionScope } from "../execution-scope.js";

/** Origin of the deployed data plane, or null when unset/invalid. */
export function getComputersRemoteDataPlaneUrl(): string | null {
  const raw = process.env.COMPUTERS_REMOTE_DATA_PLANE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
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
