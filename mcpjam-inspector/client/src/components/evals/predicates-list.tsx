import type { Predicate, PredicateResult } from "@/shared/eval-matching";
import type { EvalIteration } from "./types";

/**
 * Read the persisted predicate verdicts off `iteration.metadata.predicates`,
 * defensively. The Convex round-trip preserves shape but the type bound is
 * `unknown`, so each row is validated before we render it — a malformed entry
 * is skipped, not rendered with `undefined`s.
 *
 * Returns `null` when there is no predicate gate to render (no predicates ever
 * authored, or every row was malformed). The caller hides the section.
 */
export function parseIterationPredicates(
  metadata: EvalIteration["metadata"],
): PredicateResult[] | null {
  if (!metadata) return null;
  const raw = (metadata as Record<string, unknown>).predicates;
  if (!Array.isArray(raw)) return null;
  const out: PredicateResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.passed !== "boolean") continue;
    if (typeof row.reason !== "string") continue;
    if (!row.predicate || typeof row.predicate !== "object") continue;
    const predicate = row.predicate as Record<string, unknown>;
    if (typeof predicate.type !== "string") continue;
    out.push({
      predicate: predicate as unknown as Predicate,
      passed: row.passed,
      reason: row.reason,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Render the per-iteration predicate gate. Each row shows the authored
 * assertion (e.g. `responseContains "refund issued"`) and the evaluator's
 * deterministic reason (e.g. `final assistant message contains "refund
 * issued"`). The reason string is the load-bearing diagnostic — it tells you
 * *why* the gate decided as it did and is the property a CI gate hinges on.
 */
export function PredicatesList({ predicates }: { predicates: PredicateResult[] }) {
  if (predicates.length === 0) return null;
  const failed = predicates.filter((r) => !r.passed).length;
  const passed = predicates.length - failed;
  const allPassed = failed === 0;

  return (
    <div
      role="region"
      aria-label="Checks"
      className="space-y-2 rounded-md border border-border/40 bg-muted/10 p-3"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Checks
        </div>
        <div
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            allPassed
              ? "bg-green-500/15 text-green-700 dark:text-green-300"
              : "bg-red-500/15 text-red-700 dark:text-red-300"
          }`}
        >
          {allPassed
            ? `${predicates.length} / ${predicates.length} checks passed`
            : `${passed} / ${predicates.length} checks passed`}
        </div>
      </div>

      <ul className="space-y-1.5">
        {predicates.map((row, i) => (
          <PredicateRow key={i} row={row} />
        ))}
      </ul>
    </div>
  );
}

function PredicateRow({ row }: { row: PredicateResult }) {
  return (
    <li
      className={`rounded border p-2 ${
        row.passed
          ? "border-green-500/20 bg-green-500/5"
          : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            row.passed
              ? "bg-green-500/15 text-green-700 dark:text-green-300"
              : "bg-red-500/15 text-red-700 dark:text-red-300"
          }`}
          aria-label={row.passed ? "passed" : "failed"}
        >
          {row.passed ? "PASS" : "FAIL"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-xs font-medium">
              {row.predicate.type}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {summarizePredicate(row.predicate)}
            </span>
          </div>
          <div
            className={`mt-1 whitespace-pre-wrap break-words text-[11px] leading-tight ${
              row.passed ? "text-muted-foreground" : "text-foreground"
            }`}
          >
            {row.reason}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * One-line summary of *what was asserted*, derived from the predicate fields.
 * Complements `row.reason` (which says *whether the assertion held* and why).
 *
 * Total by construction. `parseIterationPredicates` validates the row envelope
 * (`passed`/`reason`/`type`) but NOT each variant's payload, so a
 * malformed-but-typed predicate — or a predicate type newer than this build —
 * must degrade to an empty summary rather than throw during render. The row's
 * PASS/FAIL badge and `reason` stay visible regardless, and the `type` is
 * already shown next to this summary, so the empty fallback loses nothing.
 */
export function summarizePredicate(predicate: Predicate): string {
  try {
    switch (predicate.type) {
      case "toolCalledWith": {
        const mode = predicate.args.argumentMatching ?? "partial";
        const minCount = predicate.minCount ?? 1;
        const suffix = minCount > 1 ? `, ≥${minCount}×` : "";
        return `tool "${predicate.toolName}" with ${briefArgs(predicate.args.args)} (${mode}${suffix})`;
      }
      case "toolCalledAtLeastOnce":
        return `tool "${predicate.toolName}" called ≥1×`;
      case "toolNeverCalled":
        return `tool "${predicate.toolName}" never called`;
      case "firstToolWas":
        return `first tool was "${predicate.toolName}"`;
      case "responseContains":
        return `needle "${truncate(predicate.needle, 60)}"${
          predicate.caseSensitive ? " (case-sensitive)" : ""
        }`;
      case "responseMatches":
        return `pattern /${truncate(predicate.pattern, 60)}/`;
      case "noToolErrors":
        return "no tool errors";
      case "finalAssistantMessageNonEmpty":
        return "final assistant message non-empty";
      case "tokenBudgetUnder":
        return `tokens < ${predicate.tokens.toLocaleString()}`;
    }
  } catch {
    // A row whose `type` is valid but whose payload is missing/wrong (corruption,
    // producer bug, or schema skew) would otherwise throw on field access here.
  }
  return "";
}

function briefArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args ?? {});
  if (keys.length === 0) return "{}";
  const shown = keys
    .slice(0, 2)
    .map((k) => `${k}=${previewValue(args[k])}`)
    .join(", ");
  const more = keys.length > 2 ? ` +${keys.length - 2}` : "";
  return `{${shown}${more}}`;
}

function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string")
    return value.length > 20 ? `"${value.slice(0, 20)}…"` : `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? `[${value.length}]` : "{…}";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
