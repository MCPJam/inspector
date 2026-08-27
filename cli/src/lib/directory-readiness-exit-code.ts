/**
 * Exit code for a finished directory-readiness run.
 *
 * SEPARATE FROM `conformanceExitCode`, and not because the semantics differ —
 * they are deliberately identical — but because the SHAPES do. A conformance
 * result reports `{passed, outcome}`; a readiness result reports a single
 * `status` of `ready | not-ready | incomplete` and has no `passed` at all.
 * Feeding one to the other would read `undefined` as `passed: false` and
 * silently map every incomplete run to `1`, which is the one confusion this
 * product exists to prevent.
 *
 * The three codes carry the same meanings they do everywhere else in this CLI:
 *
 *   0  ready       — every dispositive lane was evaluated and none failed
 *   1  not-ready   — the target was graded and something disqualifying was found
 *   3  incomplete  — the run did not establish enough to say either way
 *
 * `2` is reserved for usage errors, which is why the third state is `3`.
 *
 * INCOMPLETE IS NOT A FAILURE, and collapsing it into `1` would be the CI
 * equivalent of reporting a clean bill of health for a page nobody read — a
 * gate that fails identically whether somebody's connector is broken or our
 * own run could not reach it teaches its owner nothing. It is also why no
 * infrastructure condition may ever map to `1`: a timeout, an unreachable
 * host, a cancelled run are all `3`, because none of them is a statement about
 * the target.
 *
 * Read structurally rather than by SDK type so a result from an older
 * `@mcpjam/sdk` still maps: an unrecognised status is `3`, never `0`.
 */
export function directoryReadinessExitCode(result: {
  status?: string;
}): number {
  switch (result.status) {
    case "ready":
      return 0;
    case "not-ready":
      return 1;
    default:
      return 3;
  }
}

/**
 * The one-line verdict, on stderr.
 *
 * Same channel discipline as the conformance reporters beside it: stdout
 * carries the machine-readable result and nothing else, so a `--reporter`
 * payload stays pipeable; this line is for the human watching the terminal and
 * is suppressed by `--quiet`. It never affects the exit code — it annotates
 * the verdict rather than deciding it.
 */
export function reportReadinessVerdict(
  result: { status?: string; summary?: string },
  command: { optsWithGlobals(): { quiet?: boolean } },
): void {
  if (command.optsWithGlobals().quiet) return;
  const status = result.status ?? "unknown";
  const label =
    status === "ready"
      ? "READY"
      : status === "not-ready"
      ? "NOT READY"
      : "INCOMPLETE";
  const summary = result.summary ? ` — ${result.summary}` : "";
  process.stderr.write(`${label}${summary}\n`);
}

/**
 * The gaps, on stderr, when a run did not establish everything.
 *
 * A lane that reports `missingInputs` is telling the reader exactly what to
 * supply to close it, and that sentence is worth more than the verdict it sits
 * under — a submitter whose run came back `incomplete` needs the next action,
 * not the adjective. Printed for every run, not only incomplete ones: a lane
 * can carry a gap while the rollup still reads `ready`, and hiding that would
 * make a partial pass look total.
 */
export function reportReadinessGaps(
  result: {
    lanes?: Array<{
      lane: string;
      coverage?: { missingInputs?: string[]; notEvaluated?: number };
    }>;
  },
  command: { optsWithGlobals(): { quiet?: boolean } },
): void {
  if (command.optsWithGlobals().quiet) return;
  const gaps = (result.lanes ?? []).filter(
    (lane) =>
      (lane.coverage?.missingInputs?.length ?? 0) > 0 ||
      (lane.coverage?.notEvaluated ?? 0) > 0,
  );
  if (gaps.length === 0) return;

  process.stderr.write(`Gaps (${gaps.length}):\n`);
  for (const lane of gaps) {
    const inputs = lane.coverage?.missingInputs ?? [];
    const detail =
      inputs.length > 0
        ? `supply ${inputs.join(", ")}`
        : `${lane.coverage?.notEvaluated} check(s) could not run`;
    process.stderr.write(`  ${lane.lane}: ${detail}\n`);
  }
}
