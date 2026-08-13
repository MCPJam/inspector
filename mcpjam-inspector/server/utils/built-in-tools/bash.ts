/**
 * `bash` built-in tool — Project Computers data plane (chat surface).
 *
 * `bash` is a computer-backed CATALOG id: it's advertised for a turn only
 * when the host's `builtInToolIds` carries `"bash"` AND the host attaches a
 * `computer` resource — both gates live in `registry.ts`'s
 * `resolveHostTools`, the single construction path for host tools. Guests
 * are included: Convex accepts guest bearers on `/computers/reserve` and
 * contains cost via the guest daily start cap + idle-delete sweep. Same
 * shape pattern as `exa-web-search.ts`: the inspector defines the tool;
 * authorization and durable state live in Convex.
 *
 * The exec pipeline (reserve → sandbox-info → E2B exec → command log) lives
 * in `computers/run-command.ts`, shared with the /api/web/computers/exec
 * route. When THIS server isn't a configured data plane (an OSS
 * contributor's localhost — no vendor key, no secrets), the tool delegates
 * the exec to the deployed inspector named by
 * `COMPUTERS_REMOTE_DATA_PLANE_URL`, forwarding the user's bearer; Convex
 * authorizes it identically either way. See
 * `computers/remote-data-plane.ts`.
 *
 * `execute` returns `{ error }` instead of throwing so the model can relay
 * problems conversationally instead of breaking the turn.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { HOSTED_MODE } from "../../config.js";
import { type ExecutionScope } from "../execution-scope.js";
import { execViaRemoteDataPlane } from "../computers/remote-data-plane.js";
import {
  resolvePersonalComputerEngine,
  type ComputerEngine,
} from "../computers/engine.js";
import {
  LOCAL_COMPUTER_UNAVAILABLE_ERROR,
  runLocalComputerCommand,
} from "../computers/local-machine.js";
import {
  COMPUTERS_NOT_CONFIGURED_ERROR,
  DEFAULT_COMMAND_TIMEOUT_S,
  MAX_COMMAND_TIMEOUT_S,
  e2bRunner,
  runComputerCommand,
  type BashRunner,
  type RunComputerCommandResult,
} from "../computers/run-command.js";

export const BASH_TOOL_NAME = "bash";

export interface BashToolOptions {
  /** Bearer authorization forwarded to Convex (already in scope). */
  authHeader: string;
  /** Project whose (project, user) computer this turn runs on. */
  projectId: string;
  /**
   * Phase 3 execution scope from the server-resolved runtime config; forwarded
   * to the reserve call so the backend re-resolves live access. Absent ⇒ legacy.
   */
  executionScope?: ExecutionScope;
  /** Host-pinned initial working directory, if any. */
  workdir?: string;
  /** Mirrors the host's requireToolApproval — a root shell must honor it. */
  requireToolApproval?: boolean;
  /**
   * Resolved-and-actor-coerced execution engine (see `computers/engine.ts`).
   * ABSENT reproduces the legacy cloud-family fork exactly — every caller
   * that doesn't opt in is behavior-preserved.
   */
  engine?: ComputerEngine;
  /**
   * The turn EXPLICITLY asked for the local engine (validated route parse).
   * Only read when the engine resolves `unavailable`, to pick the honest
   * error: "the local engine isn't available" beats the generic
   * "computers are not configured" when the user asked for their machine.
   */
  localEngineRequested?: boolean;
}

export function buildBashTool(
  opts: BashToolOptions,
  runner: BashRunner = e2bRunner
): ToolSet[string] {
  // Legacy callers (no engine threaded) get exactly the old fork.
  const engine =
    opts.engine ?? resolvePersonalComputerEngine({ localConsentValid: false });
  const isLocal = engine === "local";
  // Stamped on NON-HOSTED turns only: hosted model-visible output and
  // persisted transcripts must stay byte-identical. e2b + delegated both
  // read "cloud" — the distinction is plumbing, not a place. A FAILED
  // explicit-local ask labels "local" too: the error is about the local
  // engine, and a "cloud" badge on it would misattribute the failure.
  const engineLabel: "local" | "cloud" =
    isLocal || (engine === "unavailable" && opts.localEngineRequested === true)
      ? "local"
      : "cloud";
  const annotate = (
    result: RunComputerCommandResult
  ): RunComputerCommandResult =>
    HOSTED_MODE ? result : { ...result, engine: engineLabel };
  return tool({
    description: isLocal
      ? "Run a bash command on the user's own machine — the same computer " +
        "this inspector runs on. Commands run as the user's account; files " +
        "persist between commands. Commands run non-interactively, and each " +
        "one may require the user's approval before it executes."
      : "Run a bash command on this project's personal cloud computer (a " +
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
    // policy exactly like MCP/skill tools do. The LOCAL engine goes further:
    // approval is ALWAYS on — a model-driven shell on the user's real machine
    // has no auto-approve in v1, whatever the host config says.
    needsApproval: isLocal ? true : opts.requireToolApproval === true,
    execute: async (
      { command, timeoutSeconds },
      { toolCallId, abortSignal }
    ): Promise<RunComputerCommandResult> => {
      if (isLocal) {
        return annotate(
          await runLocalComputerCommand({
            projectId: opts.projectId,
            command,
            commandId: toolCallId,
            timeoutSeconds,
            ...(abortSignal ? { signal: abortSignal } : {}),
          })
        );
      }
      const execArgs = {
        authHeader: opts.authHeader,
        projectId: opts.projectId,
        executionScope: opts.executionScope,
        command,
        commandId: toolCallId,
        workdir: opts.workdir,
        timeoutSeconds,
        signal: abortSignal,
      };
      if (engine === "e2b") {
        return annotate(
          await runComputerCommand({ ...execArgs, source: "chat" }, runner)
        );
      }
      if (engine === "delegated") {
        // No vendor credentials here — delegate to the deployed data plane.
        return annotate(await execViaRemoteDataPlane(execArgs));
      }
      return annotate({
        error: opts.localEngineRequested
          ? LOCAL_COMPUTER_UNAVAILABLE_ERROR
          : COMPUTERS_NOT_CONFIGURED_ERROR,
      });
    },
  });
}
