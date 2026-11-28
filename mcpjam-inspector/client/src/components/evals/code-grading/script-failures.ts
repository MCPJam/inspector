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
      return result.exitCode === undefined
        ? "exited with an error"
        : `exited ${result.exitCode}`;
  }
}

const CONSEQUENCE: Record<ScriptSlot, string> = {
  runSetup: ", so no iteration started.",
  iterationSetup:
    ", so the agent didn't run. This iteration is left out of the pass rate.",
  iterationCleanup: ". This iteration's results are unchanged.",
  runCleanup: ". The run's results are unchanged.",
};

/** The card for one script that didn't pass; `null` when it passed. */
export function scriptFailure(
  slot: ScriptSlot,
  result: ScriptResult | undefined,
): ScriptFailure | null {
  if (!result || result.status === "passed") return null;
  const setup = slot === "runSetup" || slot === "iterationSetup";
  const output = redacted(result.output).trim();
  return {
    slot,
    error: {
      slug: setup ? "eval/script_setup_failed" : "eval/script_cleanup_failed",
      title: setup ? "Setup failed" : "Cleanup failed",
      oneLine: `The ${scriptSlotTitle(slot)} script ${whatHappened(result)}${CONSEQUENCE[slot]}`,
      likelyCauses: [],
      nextSteps: [
        setup
          ? "Fix the script under Setup and cleanup in suite settings, then run the suite again."
          : "Fix the script under Setup and cleanup in suite settings so the next run cleans up.",
      ],
      docsAnchor: "/evaluate/troubleshooting",
      severity: setup ? "error" : "warning",
      // The suite's own script failed, not MCPJam: no "MCPJam issue" badge.
      origin: "user_config",
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
