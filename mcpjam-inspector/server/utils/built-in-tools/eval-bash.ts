/**
 * Eval-only `bash` tool — bound to a reproducible eval sandbox.
 *
 * Unlike the chat `bash` tool (`built-in-tools/bash.ts`), which resolves the
 * caller's PERSONAL computer via reserve→sandbox-info, this binds directly to a
 * KNOWN ephemeral sandbox id that the eval runner already provisioned for the
 * iteration (mcpjam-backend `evalSandboxes.provisionEvalSandbox`). The personal
 * computer stays banned from evals; this is the reproducible, per-iteration
 * path: a fresh box from the suite's pinned image, torn down after the run.
 *
 * `execute` returns `{ error }` instead of throwing so the model relays
 * problems conversationally rather than breaking the turn.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { TimeoutError } from "e2b";
import {
  DEFAULT_COMMAND_TIMEOUT_S,
  MAX_COMMAND_TIMEOUT_S,
  e2bRunner,
  type BashRunner,
  type RunComputerCommandResult,
} from "../computers/run-command.js";
import { detectAuthUrls } from "../computers/auth-urls.js";
import { logger } from "../logger.js";

// Same catalog id as the chat bash tool, so the model sees a uniform `bash`.
export const EVAL_BASH_TOOL_NAME = "bash";

const MODEL_OUTPUT_CAP = 16_000;

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
}

export interface EvalBashToolOptions {
  /** The ephemeral sandbox the eval runner provisioned for this iteration. */
  sandboxId: string;
  /** Mirrors the host's requireToolApproval. */
  requireToolApproval?: boolean;
}

export function buildEvalBashTool(
  opts: EvalBashToolOptions,
  runner: BashRunner = e2bRunner
): ToolSet[string] {
  return tool({
    description:
      "Run a bash command in this eval's reproducible sandbox — a fresh Linux " +
      "workstation booted from the suite's pinned image. State resets between " +
      "iterations, so the environment is identical every run. Commands run " +
      "non-interactively.",
    inputSchema: z.object({
      command: z.string().min(1).max(10_000).describe("Bash command to execute"),
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
    needsApproval: opts.requireToolApproval === true,
    execute: async (
      { command, timeoutSeconds },
      { abortSignal }
    ): Promise<RunComputerCommandResult> => {
      const timeoutMs =
        Math.min(
          Math.max(timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
          MAX_COMMAND_TIMEOUT_S
        ) * 1000;
      try {
        const result = await runner({
          sandboxId: opts.sandboxId,
          command,
          timeoutMs,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        const authUrls = detectAuthUrls(`${result.stdout}\n${result.stderr}`);
        return {
          stdout: truncate(result.stdout, MODEL_OUTPUT_CAP),
          stderr: truncate(result.stderr, MODEL_OUTPUT_CAP),
          exitCode: result.exitCode,
          ...(authUrls.length > 0 ? { authUrls } : {}),
        };
      } catch (error) {
        if (abortSignal?.aborted) return { error: "Command was cancelled." };
        if (error instanceof TimeoutError) {
          return {
            error: `Command timed out after ${Math.round(timeoutMs / 1000)}s.`,
          };
        }
        logger.error("[eval-bash] exec failed", error);
        return { error: "Command failed to run in the eval sandbox." };
      }
    },
  });
}
