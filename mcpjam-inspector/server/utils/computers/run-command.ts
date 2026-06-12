/**
 * Shared exec core for Project Computers — one command, end to end:
 * reserve/wake (user bearer) → sandbox-info (shared secret) → vendor exec →
 * durable command log. Extracted from the `bash` built-in tool so the same
 * pipeline serves two callers with the same trust shape:
 *
 *   - the `bash` tool (chat surface) when THIS server is the data plane;
 *   - POST /api/web/computers/exec when this server is the data plane for a
 *     remote inspector that holds no vendor credentials (an OSS contributor's
 *     localhost — see remote-data-plane.ts).
 *
 * Soft failures return `{ error }` instead of throwing so the chat model can
 * relay them conversationally; the exec route returns the same shape.
 */
import { Sandbox, CommandExitError, TimeoutError } from "e2b";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
  recordComputerCommand,
} from "./control-plane-client.js";
import { detectAuthUrls } from "./auth-urls.js";
import { logger } from "../logger.js";

// Caps on what the model sees; the Convex log stores its own (smaller)
// preview and full-output archival is a backend follow-up.
const MODEL_OUTPUT_CAP = 16_000;
export const DEFAULT_COMMAND_TIMEOUT_S = 120;
export const MAX_COMMAND_TIMEOUT_S = 600;

export const COMPUTERS_NOT_CONFIGURED_ERROR =
  "Computers are not configured on this server.";

export interface ComputerExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Device-flow/login URLs detected in the output, for clickable rendering. */
  authUrls?: string[];
}

export type RunComputerCommandResult = ComputerExecOutput | { error: string };

export type BashRunner = (args: {
  sandboxId: string;
  command: string;
  workdir?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// Default runner — real E2B. Kept injectable so tests exercise the pipeline
// without a vendor account.
export const e2bRunner: BashRunner = async ({
  sandboxId,
  command,
  workdir,
  timeoutMs,
  signal,
}) => {
  const sandbox = await Sandbox.connect(sandboxId);
  try {
    const result = await sandbox.commands.run(command, {
      ...(workdir ? { cwd: workdir } : {}),
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error) {
    // Non-zero exit is a normal shell outcome, not a tool failure.
    if (error instanceof CommandExitError) {
      return {
        stdout: error.stdout,
        stderr: error.stderr,
        exitCode: error.exitCode ?? 1,
      };
    }
    throw error;
  }
};

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
}

export interface RunComputerCommandArgs {
  /** Bearer authorization forwarded to Convex (authz + wake). */
  authHeader: string;
  /** Project whose (project, user) computer this command runs on. */
  projectId: string;
  command: string;
  /** Idempotency key for the durable command log (tool call id). */
  commandId: string;
  source: "chat" | "terminal-api";
  workdir?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export async function runComputerCommand(
  args: RunComputerCommandArgs,
  runner: BashRunner = e2bRunner
): Promise<RunComputerCommandResult> {
  if (!isComputersDataPlaneConfigured()) {
    return { error: COMPUTERS_NOT_CONFIGURED_ERROR };
  }

  const ready = await ensureComputerReady({
    bearer: args.authHeader,
    projectId: args.projectId,
    signal: args.signal,
  });
  if (!ready.ok) {
    return { error: `Computer unavailable: ${ready.error}` };
  }
  const computerId = ready.value.computerId;

  const info = await getComputerSandboxInfo({
    computerId,
    signal: args.signal,
  });
  if (!info.ok) {
    return { error: `Computer unavailable: ${info.error}` };
  }
  if (!info.value.providerComputerId) {
    return {
      error: "Computer is still provisioning — try again in a moment.",
    };
  }

  const timeoutMs =
    Math.min(
      Math.max(args.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
      MAX_COMMAND_TIMEOUT_S
    ) * 1000;

  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await runner({
      sandboxId: info.value.providerComputerId,
      command: args.command,
      workdir: args.workdir,
      timeoutMs,
      signal: args.signal,
    });
  } catch (error) {
    if (args.signal?.aborted) {
      return { error: "Command was cancelled." };
    }
    if (error instanceof TimeoutError) {
      return {
        error: `Command timed out after ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    logger.error("[bash-tool] exec failed", error);
    return { error: "Command failed to run on the computer." };
  }

  // Best-effort durable log; never fails the call. commandId is the
  // idempotency key, so an AI-SDK retry can't double-log.
  await recordComputerCommand({
    computerId,
    commandId: args.commandId,
    source: args.source,
    command: args.command,
    status: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    outputPreview: `${result.stdout}\n${result.stderr}`.trim(),
  }).catch(() => {});

  const authUrls = detectAuthUrls(`${result.stdout}\n${result.stderr}`);
  return {
    stdout: truncate(result.stdout, MODEL_OUTPUT_CAP),
    stderr: truncate(result.stderr, MODEL_OUTPUT_CAP),
    exitCode: result.exitCode,
    ...(authUrls.length > 0 ? { authUrls } : {}),
  };
}
