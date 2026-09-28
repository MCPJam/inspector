/**
 * Per-iteration provenance for `mcpjam cloud eval run --wait`: what each iteration
 * actually ran on, in the same words the inspector shows (both print the
 * SDK's `formatExecutionProvenanceLine`), plus a deviation line whenever the
 * execution record says the run differed from what was requested.
 *
 * An iteration recorded before execution records existed prints "not
 * recorded" — never a line guessed from its `model`/`provider` fields.
 */

import {
  executionDeviationTitle,
  executionRailLabel,
  formatExecutionDeviationLine,
  formatExecutionProvenanceLine,
  readExecutionRecord,
} from "@mcpjam/sdk";
import type {
  PlatformDisclosedModel,
  PlatformEvalIteration,
} from "@mcpjam/sdk/platform";

export type IterationProvenanceInput = {
  runId: string;
  iterations: readonly Pick<
    PlatformEvalIteration,
    "id" | "title" | "iterationNumber" | "execution"
  >[];
  /** Why the iterations could not be read, when they could not. */
  error?: string;
};

function iterationLabel(
  iteration: IterationProvenanceInput["iterations"][number]
): string {
  const title = iteration.title?.trim();
  return title
    ? `${title} #${iteration.iterationNumber}`
    : `iteration #${iteration.iterationNumber} (${iteration.id})`;
}

/** The human block, one line per iteration (plus one per deviation). */
export function formatIterationProvenance(
  runs: readonly IterationProvenanceInput[]
): string[] {
  const lines: string[] = [];
  for (const run of runs) {
    if (run.error !== undefined) {
      lines.push(
        `Iteration provenance (run ${run.runId}): unavailable — ${run.error}`
      );
      continue;
    }
    if (run.iterations.length === 0) continue;
    lines.push(`Iteration provenance (run ${run.runId}):`);
    const ordered = [...run.iterations].sort(
      (a, b) =>
        (a.title ?? "").localeCompare(b.title ?? "") ||
        a.iterationNumber - b.iterationNumber
    );
    for (const iteration of ordered) {
      const record = readExecutionRecord(iteration.execution);
      if (!record) {
        lines.push(`  ${iterationLabel(iteration)}: not recorded`);
        continue;
      }
      lines.push(
        `  ${iterationLabel(iteration)}: ${formatExecutionProvenanceLine(
          record
        )}`
      );
      if (record.deviation) {
        lines.push(`    ${formatExecutionDeviationLine(record.deviation)}`);
      }
    }
  }
  return lines;
}

/** Human mode only: JSON output stays a single parseable document. */
export function writeIterationProvenance(
  format: string,
  runs: readonly IterationProvenanceInput[],
  stream: NodeJS.WritableStream = process.stdout
): void {
  if (format !== "human") return;
  const lines = formatIterationProvenance(runs);
  if (lines.length === 0) return;
  stream.write(`${lines.join("\n")}\n`);
}

/**
 * The run disclosure's recorded facts for one model, when it was read off the
 * run's execution records: how many records, the rails they resolved to and
 * attempted, and any deviation. `null` for a disclosure read off the current
 * configuration (a pre-run disclosure) or from an older backend.
 */
export function formatRecordedExecutionDisclosure(
  model: Pick<PlatformDisclosedModel, "provenance" | "recorded">
): string | null {
  if (model.provenance !== "execution-record" || !model.recorded) return null;
  const { records, resolvedRails, attemptedRails, deviations } = model.recorded;
  const extraRails = attemptedRails.filter(
    (rail) => !resolvedRails.includes(rail)
  );
  return (
    `Recorded (${records} record${records === 1 ? "" : "s"}): ran via ${
      resolvedRails.map(executionRailLabel).join(", ") || "no rail recorded"
    }` +
    (extraRails.length > 0
      ? `; also attempted ${extraRails.map(executionRailLabel).join(", ")}`
      : "") +
    (deviations.length > 0
      ? `; deviations: ${deviations.map(executionDeviationTitle).join(", ")}`
      : "")
  );
}
