import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ArrowRight, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { evaluateToolCalls } from "@/shared/eval-matching";
import type { TraceViewerEvalToolCall } from "./trace-viewer";

/**
 * Side-by-side expected vs actual tool-call diff.
 *
 * Replaces two blob JsonEditor panels with a paired view that:
 *  - calls out the mismatch count up top with a "jump to first" affordance
 *  - pairs expected[i] / actual[i] in a single row
 *  - auto-expands rows that mismatch; collapses rows that match
 *  - highlights specific differing argument keys (red on expected, green on actual)
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

  const mismatchRowIndices = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status !== "match")
    .map(({ i }) => i);
  const mismatchCount = mismatchRowIndices.length;
  const firstMismatchIndex = mismatchRowIndices[0] ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <DiffBanner
            passed={result.passed}
            mismatchCount={mismatchCount}
            expectedCount={expected.length}
            actualCount={actual.length}
            firstMismatchIndex={firstMismatchIndex}
            isLoading={isLoading}
          />
        </div>
        {headerTrailing ? (
          <div className="shrink-0">{headerTrailing}</div>
        ) : null}
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <div>Expected</div>
        <div className="flex items-center gap-1">
          Actual
          {isLoading ? (
            <span
              data-testid="trace-viewer-actual-loading"
              className="inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground/60"
              aria-hidden
            />
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-auto">
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/50 bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
            No expected or actual tool calls.
          </div>
        ) : (
          rows.map((row, idx) => (
            <DiffRow
              key={`pair-${idx}`}
              row={row}
              index={idx}
              anchorId={anchorIdFor(idx)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Banner ────────────────────────────────────────────────────────────────────

function DiffBanner({
  passed,
  mismatchCount,
  expectedCount,
  actualCount,
  firstMismatchIndex,
  isLoading,
}: {
  passed: boolean;
  mismatchCount: number;
  expectedCount: number;
  actualCount: number;
  firstMismatchIndex: number | null;
  isLoading: boolean;
}) {
  if (passed && mismatchCount === 0) {
    return (
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-xs",
          "border-border/50 bg-muted/15 text-muted-foreground",
        )}
      >
        <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
        <span>
          All {expectedCount} expected tool call
          {expectedCount === 1 ? "" : "s"} matched.
        </span>
      </div>
    );
  }

  if (isLoading && mismatchCount === 0) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
        Comparing tool calls…
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs",
        "border-border/60 bg-muted/20 text-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AlertCircle
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0">
          <strong className="font-semibold">
            {mismatchCount} mismatch{mismatchCount === 1 ? "" : "es"}
          </strong>{" "}
          across {expectedCount} expected / {actualCount} actual tool call
          {actualCount === 1 ? "" : "s"}.
        </span>
      </div>
      {firstMismatchIndex !== null ? (
        <a
          href={`#${anchorIdFor(firstMismatchIndex)}`}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-border/50 bg-background/60 px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-background/90"
          onClick={(event) => {
            event.preventDefault();
            const el = document.getElementById(
              anchorIdFor(firstMismatchIndex),
            );
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          Jump to mismatch <ArrowRight className="size-3" aria-hidden />
        </a>
      ) : null}
    </div>
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

function DiffRow({
  row,
  index,
  anchorId,
}: {
  row: PairedRow;
  index: number;
  anchorId: string;
}) {
  // Auto-expand mismatches; collapse matches.
  const [expanded, setExpanded] = useState(row.status !== "match");

  return (
    <div
      id={anchorId}
      className={cn(
        "rounded-md border bg-background/30",
        rowBorderClass(row.status),
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        ) : (
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          #{index + 1}
        </span>
        <StatusPill status={row.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {row.expected?.toolName ?? row.actual?.toolName ?? "—"}
          {row.status === "name-mismatch" && row.actual?.toolName ? (
            <>
              <span className="px-1 text-muted-foreground">→</span>
              <span className="text-foreground">{row.actual.toolName}</span>
            </>
          ) : null}
        </span>
      </button>

      {expanded ? (
        <div className="grid grid-cols-2 gap-2 border-t border-border/40 p-2">
          <PaneCallArgs
            side="expected"
            call={row.expected}
            diffKeys={row.diffKeys}
            rowStatus={row.status}
          />
          <PaneCallArgs
            side="actual"
            call={row.actual}
            diffKeys={row.diffKeys}
            rowStatus={row.status}
          />
        </div>
      ) : null}
    </div>
  );
}

function PaneCallArgs({
  side,
  call,
  diffKeys,
  rowStatus,
}: {
  side: "expected" | "actual";
  call: TraceViewerEvalToolCall | null;
  diffKeys: Set<string>;
  rowStatus: RowStatus;
}) {
  if (!call) {
    const label =
      side === "expected"
        ? rowStatus === "extra"
          ? "(not expected)"
          : "—"
        : rowStatus === "missing"
          ? "(never called)"
          : "—";
    return (
      <div
        className={cn(
          "rounded border border-border/30 bg-background/40 px-2 py-1.5 font-mono text-[11px] italic text-muted-foreground",
        )}
      >
        {label}
      </div>
    );
  }

  const entries = Object.entries(call.arguments || {});
  return (
    <div className="rounded border border-border/40 bg-background/60 p-1.5">
      {entries.length === 0 ? (
        <div className="font-mono text-[11px] italic text-muted-foreground">
          {"{ }"}
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map(([key, value]) => {
            const isDiff = diffKeys.has(key);
            return (
              <div
                key={key}
                className={cn(
                  "rounded px-1.5 py-1 font-mono text-[11px]",
                  isDiff && "bg-muted/35 ring-1 ring-inset ring-border/50",
                )}
              >
                <span className="font-semibold text-foreground">{key}</span>
                <span className="text-muted-foreground">: </span>
                <ValueRender value={value} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ValueRender({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (value === undefined) {
    return <span className="text-muted-foreground">undefined</span>;
  }
  if (typeof value === "string") {
    return <span className="break-all text-foreground">"{value}"</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-foreground">{String(value)}</span>;
  }
  // Object / array: pretty-print with line breaks; collapse very large values.
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

function StatusPill({ status }: { status: RowStatus }) {
  const label = statusLabel(status);
  const klass = statusPillClass(status);
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        klass,
      )}
    >
      {label}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function anchorIdFor(index: number) {
  return `tool-diff-row-${index}`;
}

function statusLabel(status: RowStatus): string {
  switch (status) {
    case "match":
      return "match";
    case "arg-mismatch":
      return "arg diff";
    case "name-mismatch":
      return "name diff";
    case "missing":
      return "missing";
    case "extra":
      return "extra";
  }
}

function statusPillClass(status: RowStatus): string {
  switch (status) {
    case "match":
      return "bg-muted/30 text-muted-foreground";
    case "arg-mismatch":
    case "name-mismatch":
    case "missing":
    case "extra":
      return "bg-muted/45 text-foreground";
  }
}

function rowBorderClass(status: RowStatus): string {
  switch (status) {
    case "match":
      return "border-border/40";
    case "arg-mismatch":
    case "name-mismatch":
    case "missing":
    case "extra":
      return "border-border/60 bg-muted/10";
  }
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
