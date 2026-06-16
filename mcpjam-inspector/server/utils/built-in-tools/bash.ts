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
import { isComputersDataPlaneConfigured } from "../computers/control-plane-client.js";
import { execViaRemoteDataPlane } from "../computers/remote-data-plane.js";
import {
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
  /** Host-pinned initial working directory, if any. */
  workdir?: string;
  /** Mirrors the host's requireToolApproval — a root shell must honor it. */
  requireToolApproval?: boolean;
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
    ): Promise<RunComputerCommandResult> => {
      const execArgs = {
        authHeader: opts.authHeader,
        projectId: opts.projectId,
        command,
        commandId: toolCallId,
        workdir: opts.workdir,
        timeoutSeconds,
        signal: abortSignal,
      };
      if (isComputersDataPlaneConfigured()) {
        return runComputerCommand({ ...execArgs, source: "chat" }, runner);
      }
      // No vendor credentials here — delegate to the deployed data plane
      // (or report unconfigured when no remote is named either).
      return execViaRemoteDataPlane(execArgs);
    },
  });
}
