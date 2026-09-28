/**
 * What the grader compared for the focused miss — always visible.
 *
 * Not the counting caveats: those answer how 2/3 was reached. This is the
 * expected vs observed pair the sentence above already named, shown as lists
 * so the miss does not have to be spotted in a comma-joined line.
 */
import { EvaluateToolList } from "./evaluate-tool-list";

export function RunGradingPeek({
  expected,
  observed,
}: {
  expected: readonly string[];
  observed: readonly string[];
}) {
  if (expected.length === 0 && observed.length === 0) return null;

  // Matched by occurrence, so a case expecting two writes and observing one
  // reports the second missing rather than neither.
  const remaining = [...observed];
  const missing: string[] = [];
  for (const name of expected) {
    const at = remaining.indexOf(name);
    if (at === -1) missing.push(name);
    else remaining.splice(at, 1);
  }
  const missingSet = new Set(missing);
  const observedShown = observed.filter((name) => !missingSet.has(name));

  return (
    <section
      className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3"
      data-testid="run-grading-peek"
    >
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        Graded against
      </div>
      <div className="mt-2.5 grid gap-4 sm:grid-cols-2">
        <EvaluateToolList label="Expected" names={[...expected]} />
        <EvaluateToolList
          label="Observed"
          names={observedShown}
          missing={missing}
        />
      </div>
    </section>
  );
}
