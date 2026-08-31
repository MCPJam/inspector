/**
 * `bash` bound to an EPHEMERAL SANDBOX — a disposable box the caller already
 * provisioned for this unit of work.
 *
 * Unlike the chat `bash` tool (`built-in-tools/bash.ts`), which resolves the
 * caller's PERSONAL computer via reserve→sandbox-info, this binds directly to a
 * KNOWN sandbox id (mcpjam-backend `evalSandboxes.provisionEvalSandbox` for an
 * eval iteration, `journeySandboxes.provisionJourneySandbox` for a swarm
 * attempt, `scenarioSandboxes.provisionScenarioSandbox` for a scenario
 * conversation). The personal computer stays banned from all three: it is
 * mutable per-user state that a reproducible run can't reproduce, and — the
 * reason swarm bash was suppressed outright in #3595 — every session would
 * otherwise SHARE one box, so one session's writes leak into the next.
 *
 * LIFETIME IS PART OF THE CONTRACT, not a comment. Eval and swarm boxes die
 * with their unit of work; a scenario box survives between the turns of one
 * conversation. `opts.lifetime` picks which of those the tool DESCRIPTION
 * states, because a model that believes its files vanish behaves differently
 * from one that knows they persist.
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
  /**
   * How long the bound box lives, which the model is TOLD — because it changes
   * how the model works.
   *
   *  - `run`          — one eval iteration / one swarm attempt. Destroyed when
   *                     the unit of work ends. The default, and the only
   *                     lifetime that existed before scenario sandboxes.
   *  - `conversation` — a scenario conversation. The box SURVIVES between turns
   *                     and is reclaimed only after a long idle gap.
   *
   * Not cosmetic. A model told its filesystem is destroyed after every run will
   * re-create scratch files each turn, inline work it should have written to
   * disk, and never refer back to something it built earlier — which is exactly
   * the multi-step workflow a persistent shell exists to enable.
   */
  lifetime?: "run" | "conversation";
  /**
   * MATERIALIZED project secrets, exported into every command's environment.
   *
   * This is how a credential reaches a CLI the model runs: `stripe customers
   * list` needs `STRIPE_API_KEY` in its process environment, and no amount of
   * prompt engineering substitutes for that.
   *
   * SANDBOX BINDINGS ONLY. This tool is built only where a
   * `TrustedSandboxBinding` exists, which is the whole condition: the local
   * runner executes on the user's own machine behind an env allowlist, and the
   * remote data plane would carry the value in a request body to a plane that
   * is not this box's. Neither gets secrets, and neither builds this tool.
   *
   * Values travel in `envs`, never in the command string.
   */
  secretEnv?: Record<string, string>;
  /**
   * Called when `secretEnv` is ACTUALLY handed to a command, once per command
   * that carries it.
   *
   * The delivery stamp lives here rather than at the route because the route
   * only knows a destination looked available. A conversation that advertises
   * bash and never calls it, or whose first call fails before exec, delivered
   * nothing — and `lastDeliveredAt` is read by someone deciding whether a
   * credential is dormant enough to delete.
   */
  onSecretEnvDelivered?: () => void;
}

const LIFETIME_DESCRIPTION: Record<
  NonNullable<SandboxBashToolOptions["lifetime"]>,
  string
> = {
  run:
    "Run a bash command in this run's disposable sandbox — a fresh Linux " +
    "workstation booted from the pinned environment image. The box exists " +
    "for this session alone and is destroyed afterwards, so the environment " +
    "is identical every run and nothing written here is visible to any " +
    "other session. Commands run non-interactively.",
  conversation:
    "Run a bash command in this conversation's sandbox — a Linux workstation " +
    "booted from the pinned environment image. The box PERSISTS across the " +
    "turns of this conversation: files you write and packages you install " +
    "are still there next turn, so you can build up work over several steps. " +
    "It is private to this conversation (no other conversation can see it) " +
    "and is reclaimed after a long idle period, at which point you would be " +
    "told the state was lost. Commands run non-interactively.",
};

export function buildSandboxBashTool(
  opts: SandboxBashToolOptions,
  runner: BashRunner = e2bRunner,
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
    description: LIFETIME_DESCRIPTION[opts.lifetime ?? "run"],
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
          `Command timeout in seconds (default ${DEFAULT_COMMAND_TIMEOUT_S})`,
        ),
    }),
    needsApproval: opts.requireToolApproval === true,
    execute: async (
      { command, timeoutSeconds },
      { abortSignal },
    ): Promise<RunComputerCommandResult> => {
      if (workdirError) return { error: workdirError };
      const timeoutMs =
        Math.min(
          Math.max(timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
          MAX_COMMAND_TIMEOUT_S,
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
          ...(opts.secretEnv && Object.keys(opts.secretEnv).length > 0
            ? { envs: opts.secretEnv }
            : {}),
        });
        // The values are now in a real process's environment. Fired AFTER the
        // call returns, so a command that threw before exec records nothing.
        if (opts.secretEnv && Object.keys(opts.secretEnv).length > 0) {
          opts.onSecretEnvDelivered?.();
        }
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
