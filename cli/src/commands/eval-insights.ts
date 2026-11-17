/**
 * `cloud eval request-insights`, `cancel-insights` and `build-findings`: the
 * run page's Analyze button as commands. Results are read with
 * `cloud eval status --run <id>` (its `insights` envelope).
 */
import type { Command } from "commander";
import {
  buildEvalRunFindingsOperation,
  cancelEvalRunInsightsOperation,
  requestEvalRunInsightsOperation,
} from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import {
  addProjectOption,
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";

type RunOptions = PlatformOptions & {
  project?: string;
  run: string;
  force?: boolean;
};

/** `project` is required by the operation; the SDK resolves an absent one. */
function runInput(options: RunOptions) {
  // Trimmed here because `bindOperation` does not parse the operation's
  // schema, and a padded id would be encoded into a different path segment.
  const runId = options.run.trim();
  if (runId.length === 0) {
    throw usageError("Pass an eval run ID with --run.");
  }
  return {
    runId,
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.force ? { force: true } : {}),
  } as { project: string; runId: string; force?: boolean };
}

export function registerEvalInsightsCommands(evals: Command): void {
  bindOperation(
    addProjectOption(
      evals
        .command("request-insights")
        .description(
          "Start the findings analysis of a finished run, the one the app's run page runs. Returns immediately as pending; poll `eval status`. Included with MCPJam (no credits); it counts against the daily insight quota shared with goal, study and user-testing insights. Most finished runs are analyzed automatically, so check `eval status` first.",
        )
        .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
        .option(
          "--force",
          "Rerun over a finished analysis. Takes another unit of the daily insight quota.",
        ),
    ),
    requestEvalRunInsightsOperation,
    runInput,
  );

  bindOperation(
    addProjectOption(
      evals
        .command("cancel-insights")
        .description(
          "Stop a running analysis. The recovery path for a run stuck pending, which cannot be re-requested even with --force.",
        )
        .requiredOption("--run <id>", "Eval run ID (from `eval run`)"),
    ),
    cancelEvalRunInsightsOperation,
    runInput,
  );

  bindOperation(
    addProjectOption(
      evals
        .command("build-findings")
        .description(
          "Build a settled run's findings from its recorded evidence, so `request-insights` has something to explain. No model call and no quota. On a run never analyzed, a finished build starts the analysis automatically.",
        )
        .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
        .option("--force", "Rebuild over findings that already exist."),
    ),
    buildEvalRunFindingsOperation,
    runInput,
  );
}
