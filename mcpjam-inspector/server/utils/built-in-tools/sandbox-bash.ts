/**
 * `bash` bound to an EPHEMERAL SANDBOX — a disposable box the caller already
 * provisioned for this unit of work.
 *
 * Unlike the chat `bash` tool (`built-in-tools/bash.ts`), which resolves the
 * caller's PERSONAL computer via reserve→sandbox-info, this binds directly to a
 * KNOWN sandbox id (mcpjam-backend `evalSandboxes.provisionEvalSandbox` for an
 * eval iteration, `journeySandboxes.provisionJourneySandbox` for a swarm
 * attempt). The personal computer stays banned from both: it is mutable
 * per-user state that a reproducible run can't reproduce, and — the reason
 * swarm bash was suppressed outright in #3595 — every session in a run would
 * otherwise SHARE the launcher's one box, so one session's writes leak into the
 * next.
 *
 * `execute` returns `{ error }` instead of throwing so the model relays
 * problems conversationally rather than breaking the turn.
 *
 * KNOWN GAP (flagged follow-up, not a blocker): commands run here are not
 * written to the durable command log the personal path records via
 * `recordComputerCommand`. An ephemeral box has no `projectComputers` row to
 * attribute a command to, so auditing needs its own scope-aware surface.
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
import { resolveWorkingDirectory } from "../computers/path-confine.js";
import { logger } from "../logger.js";

// Same catalog id as the chat bash tool, so the model sees a uniform `bash`.
export const SANDBOX_BASH_TOOL_NAME = "bash";

const MODEL_OUTPUT_CAP = 16_000;
/** `stdout`/`stderr` are capped, so the detected URL list must be too —
 * otherwise a command emitting thousands of links reintroduces the unbounded
 * payload the cap exists to prevent. */
const MAX_AUTH_URLS = 20;

/** Where commands run when the binding names no working directory. */
export const DEFAULT_SANDBOX_WORKDIR = "/home/user";

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
}

export interface SandboxBashToolOptions {
  /** The ephemeral sandbox the caller provisioned for this unit of work. */
  sandboxId: string;
  /**
   * Working directory for every command. NOT merely a confinement boundary —
   * on the personal path this is where commands actually execute
   * (`run-command.ts` `resolveWorkingDirectory`), so a host that configured one
   * must get the same behaviour here or its commands silently relocate.
   * Omitted ⇒ {@link DEFAULT_SANDBOX_WORKDIR}.
   */
  workdir?: string;
  /** Mirrors the host's requireToolApproval. */
  requireToolApproval?: boolean;
}

export function buildSandboxBashTool(
  opts: SandboxBashToolOptions,
  runner: BashRunner = e2bRunner
): ToolSet[string] {
  // Confined the same way the personal path confines it, so a host config can't
  // point an ephemeral shell outside the home root either.
  //
  // An unusable value FAILS the tool rather than degrading to "no workdir".
  // Degrading looks harmless but isn't: the session would keep running in the
  // sandbox's default directory, silently reading and writing different files
  // than the host asked for. `runComputerCommand` surfaces the same error and
  // refuses to execute — and preserving that parity is the entire reason this
  // path resolves the workdir at all.
  const resolved = resolveWorkingDirectory(opts.workdir);
  const workdir = "workdir" in resolved ? resolved.workdir : undefined;
  const workdirError = "error" in resolved ? resolved.error : undefined;
  return tool({
    description:
      "Run a bash command in this run's disposable sandbox — a fresh Linux " +
      "workstation booted from the pinned environment image. The box exists " +
      "for this session alone and is destroyed afterwards, so the environment " +
      "is identical every run and nothing written here is visible to any " +
      "other session. Commands run non-interactively.",
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
    needsApproval: opts.requireToolApproval === true,
    execute: async (
      { command, timeoutSeconds },
      { abortSignal }
    ): Promise<RunComputerCommandResult> => {
      if (workdirError) return { error: workdirError };
      const timeoutMs =
        Math.min(
          Math.max(timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
          MAX_COMMAND_TIMEOUT_S
        ) * 1000;
      try {
        const result = await runner({
          sandboxId: opts.sandboxId,
          // The command is passed through VERBATIM and the working directory
          // travels as the runner's own `cwd` (which also creates the directory
          // on first use). A `cd <dir> && <command>` prefix would be wrong, not
          // merely inelegant: shell precedence makes `cd … && start-server &
          // pwd` background the whole AND-list, so everything after the `&`
          // runs from the default directory instead of the configured one.
          command,
          ...(workdir ? { workdir } : {}),
          timeoutMs,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        const authUrls = detectAuthUrls(`${result.stdout}\n${result.stderr}`);
        return {
          stdout: truncate(result.stdout, MODEL_OUTPUT_CAP),
          stderr: truncate(result.stderr, MODEL_OUTPUT_CAP),
          exitCode: result.exitCode,
          ...(authUrls.length > 0
            ? { authUrls: authUrls.slice(0, MAX_AUTH_URLS) }
            : {}),
        };
      } catch (error) {
        if (abortSignal?.aborted) return { error: "Command was cancelled." };
        if (error instanceof TimeoutError) {
          return {
            error: `Command timed out after ${Math.round(timeoutMs / 1000)}s.`,
          };
        }
        logger.error("[sandbox-bash] exec failed", error);
        return { error: "Command failed to run in the sandbox." };
      }
    },
  });
}

/**
 * @deprecated Renamed {@link SANDBOX_BASH_TOOL_NAME} — the tool is no longer
 * eval-only. Kept so `evals-runner.ts` needs no edit for this rename.
 */
export const EVAL_BASH_TOOL_NAME = SANDBOX_BASH_TOOL_NAME;
/** @deprecated Renamed {@link buildSandboxBashTool}. */
export const buildEvalBashTool = buildSandboxBashTool;
/** @deprecated Renamed {@link SandboxBashToolOptions}. */
export type EvalBashToolOptions = SandboxBashToolOptions;
