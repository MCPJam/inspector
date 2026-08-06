import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import type { Predicate, PredicateResult } from "@/shared/eval-matching";
import type { EvalTraceWidgetRenderObservationView } from "@/shared/eval-trace";
import { RenderObservationCard } from "./browser-artifacts-view";
import {
  EVAL_FAILED_BADGE_STRONG_CLASS,
  EVAL_PASSED_BADGE_STRONG_CLASS,
} from "./constants";
import type { EvalIteration } from "./types";

/**
 * Predicate types that assert against per-widget render observations. Their rows
 * get the matching render card(s) inline as evidence — the same data the
 * evaluator graded on (status / latency / console errors), so the verdict and
 * its proof live together. See `sdk/src/predicates/evaluate.ts`.
 */
const WIDGET_RENDER_PREDICATE_TYPES = new Set<Predicate["type"]>([
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
]);

/**
 * Render observations a widget predicate row should show as evidence: scoped to
 * the predicate's `toolName` when set (mirrors the evaluator's `renderScope`),
 * otherwise every observation. Empty for non-widget predicates.
 */
function evidenceObservations(
  predicate: Predicate,
  observations: EvalTraceWidgetRenderObservationView[],
): EvalTraceWidgetRenderObservationView[] {
  if (!WIDGET_RENDER_PREDICATE_TYPES.has(predicate.type)) return [];
  const toolName = (predicate as { toolName?: string }).toolName;
  return toolName
    ? observations.filter((o) => o.toolName === toolName)
    : observations;
}

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
    // Preserve a per-turn scope when present so the UI can group a turn's
    // checks under that turn (and the case-level list can exclude them).
    const scope = parseTurnScope(row.scope);
    out.push({
      predicate: predicate as unknown as Predicate,
      passed: row.passed,
      reason: row.reason,
      ...(scope ? { scope } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/** Validate `{ kind: "turn", promptIndex }` defensively (metadata is unknown). */
function parseTurnScope(
  value: unknown,
): { kind: "turn"; promptIndex: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  if (s.kind !== "turn") return undefined;
  if (typeof s.promptIndex !== "number" || !Number.isInteger(s.promptIndex)) {
    return undefined;
  }
  return { kind: "turn", promptIndex: s.promptIndex };
}

/**
 * Render the per-iteration predicate gate. Each row shows the authored
 * assertion (e.g. `responseContains "refund issued"`) and the evaluator's
 * deterministic reason (e.g. `final assistant message contains "refund
 * issued"`). The reason string is the load-bearing diagnostic — it tells you
 * *why* the gate decided as it did and is the property a CI gate hinges on.
 */
export function PredicatesList({
  predicates,
  observations = [],
}: {
  predicates: PredicateResult[];
  /**
   * Per-widget render observations from the iteration trace blob. Widget-render
   * predicate rows (e.g. `widgetRendered`) show the matching card(s) as inline
   * evidence. Optional/absent until the blob loads → rows render without it.
   */
  observations?: EvalTraceWidgetRenderObservationView[];
}) {
  if (predicates.length === 0) return null;
  const failed = predicates.filter((r) => !r.passed).length;
  const passed = predicates.length - failed;
  const allPassed = failed === 0;
  const caseLevel = predicates.filter((r) => !r.scope);
  const stepScoped = predicates.filter((r) => r.scope?.kind === "turn");

  const renderGroup = (
    title: string,
    rows: PredicateResult[],
    keyPrefix: string,
  ) =>
    rows.length === 0
      ? null
      : (
          <div className="space-y-1.5">
            <div className="text-[10px] font-medium text-muted-foreground">
              {title}
            </div>
            <ul className="space-y-1.5">
              {rows.map((row, i) => (
                <PredicateRow
                  key={`${keyPrefix}-${i}`}
                  row={row}
                  observations={observations}
                />
              ))}
            </ul>
          </div>
        );

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
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            allPassed ? EVAL_PASSED_BADGE_STRONG_CLASS : EVAL_FAILED_BADGE_STRONG_CLASS
          }`}
        >
          {allPassed ? (
            <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <XCircle className="h-3 w-3 shrink-0" aria-hidden />
          )}
          {allPassed
            ? `${predicates.length} / ${predicates.length} checks passed`
            : `${passed} / ${predicates.length} checks passed`}
        </div>
      </div>

      {renderGroup("Global gates", caseLevel, "case")}
      {renderGroup("Step checks", stepScoped, "step")}
    </div>
  );
}

/**
 * A single check, rendered as a native `<details>` disclosure — clickable
 * (and keyboard/screen-reader accessible for free, unlike a `div onClick`)
 * regardless of predicate type. Previously only widget-render predicates got
 * an expand affordance (for their evidence cards); every other predicate
 * (`responseContains`, `toolCalledWith`, …) rendered as static, unclickable
 * markup. Failed rows start expanded — the reason stays "impossible to
 * miss" inline, per PUR-24 — while passed rows start collapsed to keep a
 * long checks list scannable; either can be toggled by clicking anywhere on
 * the summary row.
 */
function PredicateRow({
  row,
  observations,
}: {
  row: PredicateResult;
  observations: EvalTraceWidgetRenderObservationView[];
}) {
  const evidence = evidenceObservations(row.predicate, observations);
  return (
    <li
      className={`rounded border ${
        row.passed
          ? "border-border/40 bg-background/40"
          : "border-red-500/40 bg-red-500/5"
      }`}
    >
      <details className="group" open={!row.passed}>
        <summary className="flex cursor-pointer list-none items-start gap-2 p-2 [&::-webkit-details-marker]:hidden">
          <span
            className={`mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              row.passed
                ? EVAL_PASSED_BADGE_STRONG_CLASS
                : EVAL_FAILED_BADGE_STRONG_CLASS
            }`}
          >
            {row.passed ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden />
            ) : (
              <XCircle className="h-3 w-3" aria-hidden />
            )}
            {row.passed ? "PASS" : "FAIL"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-xs font-medium">
                {row.predicate.type}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {summarizePredicate(row.predicate)}
              </span>
            </span>
          </span>
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-open:hidden" />
          <ChevronDown className="mt-0.5 hidden h-3.5 w-3.5 shrink-0 text-muted-foreground group-open:block" />
        </summary>
        <div className="space-y-1.5 px-2 pb-2 pl-[26px]">
          <div
            className={`whitespace-pre-wrap break-words text-[11px] leading-tight ${
              row.passed ? "text-muted-foreground" : "text-red-600 dark:text-red-400"
            }`}
          >
            {row.reason}
          </div>
          {evidence.length > 0 ? (
            <div data-testid="predicate-render-evidence">
              <div className="text-[11px] text-muted-foreground">
                {evidence.length === 1
                  ? "Rendered widget"
                  : `${evidence.length} rendered widgets`}
              </div>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                {evidence.map((obs) => (
                  <RenderObservationCard
                    key={`${obs.toolCallId}-${obs.ts}`}
                    observation={obs}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </details>
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
      case "turnCountUnder":
        return `user turns < ${predicate.turns.toLocaleString()}`;
      case "widgetRendered":
        return `widget rendered${
          predicate.toolName ? ` for "${predicate.toolName}"` : ""
        }`;
      case "widgetRenderLatencyUnder":
        return `widget render < ${predicate.ms.toLocaleString()}ms${
          predicate.toolName ? ` for "${predicate.toolName}"` : ""
        }`;
      case "widgetNoConsoleErrors":
        return `no widget console errors${
          predicate.toolName ? ` for "${predicate.toolName}"` : ""
        }`;
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
