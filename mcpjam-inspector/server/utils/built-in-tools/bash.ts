/**
 * `bash` built-in tool — Project Computers data plane (chat surface).
 *
 * Advertised for a turn only when the chatbox's pinned host config carries
 * `computer: { kind: "personal", toolset: "bash" }` AND the acting user is a
 * signed-in member (guests never see it; the runtime-config payload already
 * omits `computer` for guest actors). Same construction pattern as
 * `exa-web-search.ts`: the inspector defines the tool shape; authorization
 * and durable state live in Convex.
 *
 * Execute flow (see mcpjam-backend docs/project-computers.md):
 *   1. `ensureComputerReady` — POST /computers/reserve with the user's bearer
 *      (member-gated, idempotent, wakes a hibernated machine) and poll to
 *      `ready`. Surfaces provisioning status to the model as a clean error
 *      when the budget runs out.
 *   2. `/computers/sandbox-info` (shared secret) — vendor sandbox id. The
 *      browser can never make this exchange.
 *   3. E2B exec: `Sandbox.connect(sandboxId)` (auto-resumes a paused box)
 *      then `commands.run` with the host-configured workdir.
 *   4. Record the command to the Convex log (best-effort, idempotent on
 *      `toolCallId`).
 *   5. Return `{ stdout, stderr, exitCode, authUrls? }` — auth-looking URLs
 *      are lifted out so device-flow logins (`gh auth login`) are clickable.
 *
 * `execute` returns `{ error }` instead of throwing so the model can relay
 * problems conversationally instead of breaking the turn.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Sandbox, CommandExitError, TimeoutError } from "e2b";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
  recordComputerCommand,
} from "../computers/control-plane-client.js";
import { detectAuthUrls } from "../computers/auth-urls.js";
import { logger } from "../logger.js";

export const BASH_TOOL_NAME = "bash";

// Caps on what the model sees; the Convex log stores its own (smaller)
// preview and full-output archival is a backend follow-up.
const MODEL_OUTPUT_CAP = 16_000;
const DEFAULT_COMMAND_TIMEOUT_S = 120;
const MAX_COMMAND_TIMEOUT_S = 600;

export interface BashToolOptions {
  /** Bearer authorization forwarded to Convex (already in scope). */
  authHeader: string;
  /** Project whose (project, user) computer this turn runs on. */
  projectId: string;
  /** Host-pinned initial working directory, if any. */
  workdir?: string;
  /** Mirrors the host's requireToolApproval — a root shell must honor it. */
  requireToolApproval?: boolean;
}

interface BashExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Device-flow/login URLs detected in the output, for clickable rendering. */
  authUrls?: string[];
}

type BashRunner = (args: {
  sandboxId: string;
  command: string;
  workdir?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// Default runner — real E2B. Kept injectable so tests exercise the tool
// without a vendor account.
const e2bRunner: BashRunner = async ({
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

export function buildBashTool(
  opts: BashToolOptions,
  runner: BashRunner = e2bRunner
): ToolSet[string] {
  return tool({
    description:
      "Run a bash command on this project's personal cloud computer (a " +
      "persistent Linux workstation — files and installed tools survive " +
      "between commands and sessions). Commands run non-interactively; for " +
      "logins use device-flow commands (e.g. `gh auth login`) and relay the " +
      "verification URL to the user.",
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .max(10_000)
        .describe("Bash command to execute"),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_COMMAND_TIMEOUT_S)
        .optional()
        .describe(
          `Command timeout in seconds (default ${DEFAULT_COMMAND_TIMEOUT_S})`
        ),
    }),
    // A root shell on a personal machine must honor the host's approval
    // policy exactly like MCP/skill tools do.
    needsApproval: opts.requireToolApproval === true,
    execute: async (
      { command, timeoutSeconds },
      { toolCallId, abortSignal }
    ): Promise<BashExecOutput | { error: string }> => {
      if (!isComputersDataPlaneConfigured()) {
        return { error: "Computers are not configured on this server." };
      }

      const ready = await ensureComputerReady({
        bearer: opts.authHeader,
        projectId: opts.projectId,
        signal: abortSignal,
      });
      if (!ready.ok) {
        return { error: `Computer unavailable: ${ready.error}` };
      }
      const computerId = ready.value.computerId;

      const info = await getComputerSandboxInfo({
        computerId,
        signal: abortSignal,
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
          Math.max(timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
          MAX_COMMAND_TIMEOUT_S
        ) * 1000;

      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        result = await runner({
          sandboxId: info.value.providerComputerId,
          command,
          workdir: opts.workdir,
          timeoutMs,
          signal: abortSignal,
        });
      } catch (error) {
        if (abortSignal?.aborted) {
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

      // Best-effort durable log; never fails the tool call. toolCallId is the
      // idempotency key, so an AI-SDK retry can't double-log.
      await recordComputerCommand({
        computerId,
        commandId: toolCallId,
        source: "chat",
        command,
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
    },
  });
}
