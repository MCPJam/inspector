/**
 * What the app shows when a setup or cleanup script didn't pass (EFTW-90).
 *
 * The runner records each script's outcome: an iteration's in its metadata
 * (`iterationScripts.setup` and `.cleanup`), the run's on the run row
 * (`scriptResults.runSetup` and `.runCleanup`). A failed setup means the
 * agent never ran; a failed cleanup is a warning that changes no result.
 */
import { redactForTelemetry, type NormalizedError } from "@mcpjam/sdk/browser";
import { scriptSlotTitle, type ScriptSlot } from "./code-grading-values";

export type ScriptResult = {
  status: "passed" | "failed" | "timeout" | "error";
  exitCode?: number;
  /** The last 8 KB of the script's stdout and stderr together. */
  output: string;
  durationMs?: number;
  /** Why the script couldn't run, when it couldn't. */
  error?: string;
};

export type RunScriptResults = {
  runSetup?: ScriptResult;
  runCleanup?: ScriptResult;
};

export type ScriptFailure = {
  slot: ScriptSlot;
  error: NormalizedError;
  /** The details panel's heading over the output, when there is output. */
  rawLabel?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isStatus(value: unknown): value is ScriptResult["status"] {
  return (
    value === "passed" ||
    value === "failed" ||
    value === "timeout" ||
    value === "error"
  );
}

/** One stored outcome; anything this app can't read is `undefined`. */
export function readScriptResult(value: unknown): ScriptResult | undefined {
  const row = record(value);
  if (!row || !isStatus(row.status)) return undefined;
  return {
    status: row.status,
    output: typeof row.output === "string" ? row.output : "",
    ...(typeof row.exitCode === "number" ? { exitCode: row.exitCode } : {}),
    ...(typeof row.durationMs === "number"
      ? { durationMs: row.durationMs }
      : {}),
    ...(typeof row.error === "string" && row.error ? { error: row.error } : {}),
  };
}

/** A script can print a secret it was given; the card shows the rest. */
function redacted(text: string): string {
  const out = redactForTelemetry(text);
  return typeof out === "string" ? out : "";
}

function whatHappened(result: ScriptResult): string {
  switch (result.status) {
    case "timeout":
      return "was stopped at its time limit";
    case "error":
      return "couldn't start";
    default:
      // The output says why; the exit code stays in the API, not the card.
      return "stopped with an error";
  }
}

const CONSEQUENCE: Record<ScriptSlot, string> = {
  runSetup: ", so no iteration started.",
  iterationSetup:
    ", so the agent didn't run. This iteration is left out of the pass rate.",
  iterationCleanup: ". This iteration's results are unchanged.",
  runCleanup: ". The run's results are unchanged.",
};

/** The card's title: what couldn't happen, and where to fix it. */
const TITLE: Record<ScriptSlot, string> = {
  runSetup:
    "Couldn't set up this run. Fix the script under Setup and cleanup in suite settings.",
  iterationSetup:
    "Couldn't set up this iteration. Fix the script under Setup and cleanup in suite settings.",
  iterationCleanup:
    "Couldn't clean up after this iteration. Fix the script under Setup and cleanup in suite settings.",
  runCleanup:
    "Couldn't clean up after this run. Fix the script under Setup and cleanup in suite settings.",
};

/**
 * The title when the script never started. The runner reports that only when
 * its sandbox, the write or the connection failed (`runPhaseScript`), so there
 * is nothing in the script to fix.
 */
const COULDNT_START_TITLE: Record<ScriptSlot, string> = {
  runSetup:
    "Couldn't set up this run: MCPJam couldn't start the script. Run the suite again.",
  iterationSetup:
    "Couldn't set up this iteration: MCPJam couldn't start the script. Run the suite again.",
  iterationCleanup:
    "Couldn't clean up after this iteration: MCPJam couldn't start the script. The next run cleans up as usual.",
  runCleanup:
    "Couldn't clean up after this run: MCPJam couldn't start the script. The next run cleans up as usual.",
};

function nextStep(setup: boolean, couldntStart: boolean): string {
  if (couldntStart) {
    return setup
      ? "Run the suite again. If the script still can't start, contact support."
      : "Nothing to change. The next run cleans up as usual.";
  }
  return setup
    ? "After you fix the script, run the suite again."
    : "After you fix the script, the next run cleans up as usual.";
}

/** The card for one script that didn't pass; `null` when it passed. */
export function scriptFailure(
  slot: ScriptSlot,
  result: ScriptResult | undefined,
): ScriptFailure | null {
  if (!result || result.status === "passed") return null;
  const setup = slot === "runSetup" || slot === "iterationSetup";
  const couldntStart = result.status === "error";
  const output = redacted(result.output).trim();
  return {
    slot,
    error: {
      slug: setup ? "eval/script_setup_failed" : "eval/script_cleanup_failed",
      title: couldntStart ? COULDNT_START_TITLE[slot] : TITLE[slot],
      oneLine: `The ${scriptSlotTitle(slot)} script ${whatHappened(result)}${CONSEQUENCE[slot]}`,
      likelyCauses: [],
      nextSteps: [nextStep(setup, couldntStart)],
      docsAnchor: "/evaluate/troubleshooting",
      severity: setup ? "error" : "warning",
      // A script that ran and failed is the suite's own; one that couldn't
      // start is MCPJam's, so only that one carries the "MCPJam issue" badge.
      origin: couldntStart ? "mcpjam" : "user_config",
      rawMessage: [output, redacted(result.error ?? "").trim()]
        .filter(Boolean)
        .join("\n\n"),
    },
    ...(output ? { rawLabel: "Script output" } : {}),
  };
}

function failures(pairs: Array<[ScriptSlot, unknown]>): ScriptFailure[] {
  return pairs.flatMap(([slot, value]) => {
    const failure = scriptFailure(slot, readScriptResult(value));
    return failure ? [failure] : [];
  });
}

export function iterationScriptFailures(iteration: {
  metadata?: Record<string, unknown>;
}): ScriptFailure[] {
  const scripts = record(iteration.metadata?.iterationScripts);
  return failures([
    ["iterationSetup", scripts?.setup],
    ["iterationCleanup", scripts?.cleanup],
  ]);
}

export function runScriptFailures(run: {
  scriptResults?: unknown;
}): ScriptFailure[] {
  const results = record(run.scriptResults);
  return failures([
    ["runSetup", results?.runSetup],
    ["runCleanup", results?.runCleanup],
  ]);
}

/**
 * Why this iteration's agent never ran, when a setup script is why: its own
 * Before each iteration script, or the run's Before the run script, after
 * which every iteration is Setup failed. Empty otherwise.
 */
export function setupScriptFailures(
  iteration: { status?: string; metadata?: Record<string, unknown> },
  run: { scriptResults?: unknown } | null | undefined,
): ScriptFailure[] {
  const own = iterationScriptFailures(iteration);
  if (own.some((failure) => failure.slot === "iterationSetup")) return own;
  if (iteration.status !== "setup_failed" || !run) return [];
  return runScriptFailures(run).filter(
    (failure) => failure.slot === "runSetup",
  );
}
