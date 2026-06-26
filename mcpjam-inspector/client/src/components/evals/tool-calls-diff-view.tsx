import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { evaluateToolCalls } from "@/shared/eval-matching";
import type { TraceViewerEvalToolCall } from "./trace-viewer";

/**
 * Expected-vs-actual tool-call diff, rendered as a single status-led ledger.
 *
 * The old layout promised an "Expected | Actual" two-column comparison but most
 * verdicts are one-sided (match / extra / missing / wrong-tool) — only an
 * argument diff is genuinely two-sided. So we collapse to one column where:
 *  - a colored left rail carries the verdict (scan the edge for problems;
 *    matches stay quiet, soft issues amber, hard misses red)
 *  - each call's args are summarized inline so the gist needs no expand
 *  - expanding shows full args; an arg diff expands to a compact per-key
 *    `old → new` instead of two raw JSON panes
 */
export function ToolCallsDiffView({
  expected,
  actual,
  isNegativeTest = false,
  isLoading = false,
  headerTrailing,
}: {
  expected: TraceViewerEvalToolCall[];
  actual: TraceViewerEvalToolCall[];
  isNegativeTest?: boolean;
  isLoading?: boolean;
  headerTrailing?: ReactNode;
}) {
  const result = useMemo(
    () => evaluateToolCalls(expected, actual, { isNegativeTest }),
    [expected, actual, isNegativeTest],
  );

  const rows = useMemo(
    () => buildPairedRows(expected, actual, result),
    [expected, actual, result],
  );

  const issueCount = rows.filter((r) => r.status !== "match").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
      <div className="flex shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <DiffBanner
            passed={result.passed}
            issueCount={issueCount}
            expectedCount={expected.length}
            actualCount={actual.length}
            isLoading={isLoading}
          />
        </div>
        {headerTrailing ? <div className="shrink-0">{headerTrailing}</div> : null}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 overflow-auto pr-0.5">
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/50 bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
            No expected or actual tool calls.
          </div>
        ) : (
          rows.map((row, idx) => (
            <DiffRow key={`pair-${idx}`} row={row} index={idx} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Banner ────────────────────────────────────────────────────────────────────

function DiffBanner({
  passed,
  issueCount,
  expectedCount,
  actualCount,
  isLoading,
}: {
  passed: boolean;
  issueCount: number;
  expectedCount: number;
  actualCount: number;
  isLoading: boolean;
}) {
  if (passed && issueCount === 0) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
        <span>
          All {expectedCount} expected tool call
          {expectedCount === 1 ? "" : "s"} matched.
        </span>
        {isLoading ? <LoadingDot /> : null}
      </div>
    );
  }

  if (isLoading && issueCount === 0) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
        Comparing tool calls…
        <LoadingDot />
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground">
      <span
        className="size-1.5 shrink-0 rounded-full bg-destructive"
        aria-hidden
      />
      <span className="min-w-0">
        <strong className="font-semibold">
          {issueCount} difference{issueCount === 1 ? "" : "s"}
        </strong>
        <span className="text-muted-foreground">
          {" "}
          · {expectedCount} expected, {actualCount} actual
        </span>
      </span>
      {isLoading ? <LoadingDot /> : null}
    </div>
  );
}

function LoadingDot() {
  return (
    <span
      data-testid="trace-viewer-actual-loading"
      className="ml-auto inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/60"
      aria-hidden
    />
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────────

type RowStatus = "match" | "arg-mismatch" | "name-mismatch" | "missing" | "extra";

interface PairedRow {
  status: RowStatus;
  expected: TraceViewerEvalToolCall | null;
  actual: TraceViewerEvalToolCall | null;
  /** Argument keys that differ between expected and actual (status === "arg-mismatch"). */
  diffKeys: Set<string>;
}

type Tone = "neutral" | "warn" | "bad";

const STATUS_META: Record<RowStatus, { label: string; tone: Tone }> = {
  match: { label: "match", tone: "neutral" },
  "arg-mismatch": { label: "arg diff", tone: "warn" },
  "name-mismatch": { label: "wrong tool", tone: "bad" },
  missing: { label: "missing", tone: "bad" },
  extra: { label: "unexpected", tone: "warn" },
};

function DiffRow({ row, index }: { row: PairedRow; index: number }) {
  const meta = STATUS_META[row.status];
  const expandable = isExpandable(row);
  // Auto-expand the genuinely two-sided rows (a comparison the eye needs to
  // line up); one-sided rows lead with an inline summary and stay collapsed.
  const [expanded, setExpanded] = useState(
    () => row.status === "arg-mismatch" || row.status === "name-mismatch",
  );

  const primary = row.actual ?? row.expected;
  // Inline preview only where the args are the interesting bit (something is
  // off). Matches stay a clean single line so the eye skims past them.
  const summary =
    !expanded && (row.status === "extra" || row.status === "missing")
      ? inlineSummary(row)
      : null;

  const header = (
    <>
      {expandable ? (
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        <span className={row.status === "missing" ? "text-muted-foreground line-through" : ""}>
          {row.expected?.toolName ?? row.actual?.toolName ?? "—"}
        </span>
        {row.status === "name-mismatch" && row.actual?.toolName ? (
          <>
            <span className="px-1 text-muted-foreground">→</span>
            <span className="text-foreground">{row.actual.toolName}</span>
          </>
        ) : null}
        {summary ? (
          <span className="ml-2 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "shrink-0 text-[10px] font-medium uppercase tracking-wide",
          toneLabel(meta.tone),
        )}
      >
        {meta.label}
      </span>
    </>
  );

  return (
    <div
      className={cn(
        "rounded-md border border-l-2 bg-background/40 transition-colors",
        toneRail(meta.tone),
      )}
    >
      {expandable ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/20"
        >
          {header}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-2.5 py-2">{header}</div>
      )}

      {expanded ? (
        <div className="border-t border-border/40 px-2.5 py-2">
          <ExpandedDetail row={row} primary={primary} />
        </div>
      ) : null}
    </div>
  );
}

function ExpandedDetail({
  row,
  primary,
}: {
  row: PairedRow;
  primary: TraceViewerEvalToolCall | null;
}) {
  if (row.status === "arg-mismatch") {
    return <ArgKeyDiff expected={row.expected} actual={row.actual} diffKeys={row.diffKeys} />;
  }

  if (row.status === "name-mismatch") {
    return (
      <div className="space-y-2">
        <SideArgs label="Expected" call={row.expected} />
        <SideArgs label="Actual" call={row.actual} />
      </div>
    );
  }

  // One-sided: match / extra / missing — a single args block with a quiet caption.
  const caption =
    row.status === "missing"
      ? "Expected, never called"
      : row.status === "extra"
        ? "Called, not expected"
        : "Arguments";
  return <SideArgs label={caption} call={primary} />;
}

function SideArgs({
  label,
  call,
}: {
  label: string;
  call: TraceViewerEvalToolCall | null;
}) {
  const entries = Object.entries(call?.arguments ?? {});
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      {entries.length === 0 ? (
        <div className="font-mono text-[11px] italic text-muted-foreground">
          {"{ }"}
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map(([key, value]) => (
            <ArgLine key={key} name={key} value={value} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-key diff for an argument mismatch: `key  old → new`, unchanged keys muted. */
function ArgKeyDiff({
  expected,
  actual,
  diffKeys,
}: {
  expected: TraceViewerEvalToolCall | null;
  actual: TraceViewerEvalToolCall | null;
  diffKeys: Set<string>;
}) {
  const exp = expected?.arguments ?? {};
  const act = actual?.arguments ?? {};
  const keys = Array.from(new Set([...Object.keys(exp), ...Object.keys(act)]));

  return (
    <div className="space-y-1">
      {keys.map((key) => {
        const changed = diffKeys.has(key);
        if (!changed) {
          return <ArgLine key={key} name={key} value={act[key]} muted />;
        }
        return (
          <div
            key={key}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1.5 py-1 font-mono text-[11px] ring-1 ring-inset ring-warning/40"
          >
            <span className="font-semibold text-foreground">{key}</span>
            <span className="text-muted-foreground line-through">
              <ValueRender value={exp[key]} />
            </span>
            <span className="text-muted-foreground">→</span>
            <span className="text-foreground">
              <ValueRender value={act[key]} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ArgLine({
  name,
  value,
  muted,
}: {
  name: string;
  value: unknown;
  muted?: boolean;
}) {
  return (
    <div className="font-mono text-[11px]">
      <span className={muted ? "text-muted-foreground" : "font-semibold text-foreground"}>
        {name}
      </span>
      <span className="text-muted-foreground">: </span>
      <ValueRender value={value} />
    </div>
  );
}

function ValueRender({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "string") {
    return <span className="break-all text-foreground/90">"{value}"</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-foreground/90">{String(value)}</span>;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  if (serialized.length > 2000) {
    serialized = `${serialized.slice(0, 2000)}\n… (${serialized.length - 2000} more chars)`;
  }
  return (
    <pre className="mt-1 whitespace-pre-wrap break-all text-foreground/90">
      {serialized}
    </pre>
  );
}

// ── Tone styling ────────────────────────────────────────────────────────────────

function toneRail(tone: Tone): string {
  switch (tone) {
    case "neutral":
      return "border-border/40";
    case "warn":
      return "border-border/40 border-l-warning/60";
    case "bad":
      return "border-border/40 border-l-destructive/60";
  }
}

function toneLabel(tone: Tone): string {
  switch (tone) {
    case "neutral":
      return "text-muted-foreground/70";
    case "warn":
      return "text-warning";
    case "bad":
      return "text-destructive";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isExpandable(row: PairedRow): boolean {
  if (row.status === "arg-mismatch" || row.status === "name-mismatch") return true;
  const call = row.actual ?? row.expected;
  return Object.keys(call?.arguments ?? {}).length > 0;
}

/** Compact one-line args preview shown on a collapsed row (`id: "redbull"`). */
function inlineSummary(row: PairedRow): string {
  const call = row.actual ?? row.expected;
  const args = call?.arguments ?? {};
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const shown = keys
    .slice(0, 2)
    .map((k) => `${k}: ${previewValue(args[k])}`)
    .join(", ");
  return keys.length > 2 ? `${shown} +${keys.length - 2}` : shown;
}

function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string")
    return value.length > 24 ? `"${value.slice(0, 24)}…"` : `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? `[${value.length}]` : "{…}";
}

interface MatchResultLike {
  passed: boolean;
  missing: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  extra: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  outOfOrder: Array<{ expectedIndex: number; actualIndex: number }>;
  argumentMismatches: Array<{
    toolName: string;
    expectedArgs: Record<string, unknown>;
    actualArgs: Record<string, unknown>;
  }>;
}

/**
 * Build the paired diff rows. We walk expected/actual by index (the typical
 * "ordered" eval shape) and classify each pair. Anything past the shorter
 * array is rendered as missing/extra.
 *
 * Argument-mismatch detection prefers the matcher's `argumentMismatches`
 * list when it covers the expected entry (so we honor partial-args /
 * superset semantics), and falls back to a shallow key-diff for the rows
 * the matcher didn't comment on.
 */
function buildPairedRows(
  expected: TraceViewerEvalToolCall[],
  actual: TraceViewerEvalToolCall[],
  result: MatchResultLike,
): PairedRow[] {
  const rows: PairedRow[] = [];
  const maxLen = Math.max(expected.length, actual.length);

  // Build a quick lookup: which expected tool names had argument mismatches.
  // The matcher returns a flat list; index by tool name + arg signature.
  const argMismatchByKey = new Map<
    string,
    { expectedArgs: Record<string, unknown>; actualArgs: Record<string, unknown> }
  >();
  for (const mm of result.argumentMismatches ?? []) {
    argMismatchByKey.set(stableKey(mm.toolName, mm.expectedArgs), {
      expectedArgs: mm.expectedArgs,
      actualArgs: mm.actualArgs,
    });
  }

  for (let i = 0; i < maxLen; i++) {
    const exp = expected[i] ?? null;
    const act = actual[i] ?? null;

    if (exp && !act) {
      rows.push({ status: "missing", expected: exp, actual: null, diffKeys: new Set() });
      continue;
    }
    if (!exp && act) {
      rows.push({ status: "extra", expected: null, actual: act, diffKeys: new Set() });
      continue;
    }
    if (exp && act) {
      if (exp.toolName !== act.toolName) {
        rows.push({
          status: "name-mismatch",
          expected: exp,
          actual: act,
          diffKeys: new Set(),
        });
        continue;
      }
      const matcherSaysMismatch = argMismatchByKey.has(
        stableKey(exp.toolName, exp.arguments),
      );
      const diffKeys = shallowArgDiff(exp.arguments, act.arguments);
      const isMismatch = matcherSaysMismatch || diffKeys.size > 0;
      rows.push({
        status: isMismatch ? "arg-mismatch" : "match",
        expected: exp,
        actual: act,
        diffKeys,
      });
    }
  }

  return rows;
}

function shallowArgDiff(
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown> | undefined,
): Set<string> {
  const out = new Set<string>();
  const exp = expected ?? {};
  const act = actual ?? {};
  const keys = new Set([...Object.keys(exp), ...Object.keys(act)]);
  for (const k of keys) {
    if (!deepEqual(exp[k], act[k])) out.add(k);
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function stableKey(toolName: string, args: Record<string, unknown> | undefined) {
  try {
    return `${toolName}::${JSON.stringify(args ?? {})}`;
  } catch {
    return `${toolName}::?`;
  }
}

// Optional: export a slot consumers can render as their banner if they
// already have a header above the diff (the diff itself shows the banner
// by default).
export function ToolCallsDiffSummary(): ReactNode {
  return null;
}
