/**
 * Phase 1 — synthetic-session "readiness" UI.
 *
 * All three surfaces render from the server-denormalized `chatSessions.readiness`
 * fields (open decision: insight-bar source is server-denormalized readiness;
 * client-side trace parsing is fallback/test-only). Nothing here re-parses the
 * trace.
 *
 *   - `SessionReadinessBadge` — compact verdict dot for synthetic session rows
 *   - `SessionInsightBar`      — findings strip atop a synthetic session detail
 */

import type { ReactNode } from "react";
import { Info, Loader2, XCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

// ── types (mirror convex/lib/sessionReadiness.ts) ─────────────────────────────

export type ReadinessStatus = "pending" | "completed" | "partial" | "failed";
export type ReadinessVerdict = "ready" | "needs_attention" | "not_ready";

export interface SessionReadinessIssue {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  toolName?: string;
}

export interface ReadinessToolError {
  toolName: string;
  errorCount: number;
}

/**
 * Full readiness record (from `getSession`) — the list query returns only the
 * `status`/`verdict`/`issueCount` subset, so the denormalized fields are
 * optional here and consumers degrade gracefully when they're absent.
 */
export interface SessionReadiness {
  status: ReadinessStatus;
  verdict?: ReadinessVerdict;
  issueCount: number;
  issues?: SessionReadinessIssue[];
  toolCallCount?: number;
  toolErrorCount?: number;
  usedToolCount?: number;
  advertisedToolCount?: number;
  advertisedToolsKnown?: boolean;
  coverageRatio?: number;
  hallucinatedTools?: string[];
  failingTools?: ReadinessToolError[];
  topFailingTool?: ReadinessToolError;
  /** Host turns observed (per-turn trace samples). */
  turnCount?: number;
  /** Sum of per-turn host-response latencies (excludes persona-driver time). */
  hostLatencyMs?: number;
  /** Slowest single host turn. */
  maxTurnLatencyMs?: number;
  analyzerVersion?: number;
  generatedAt?: number;
  errorMessage?: string;
}

export interface SessionReadinessRollup {
  total: number;
  analyzed: number;
  byStatus: Record<ReadinessStatus, number>;
  byVerdict: Record<ReadinessVerdict, number>;
  totalIssues: number;
  sessionsWithIssues: number;
  totalToolCalls: number;
  totalToolErrors: number;
  topFailingTools: ReadinessToolError[];
  avgCoverageRatio: number | null;
}

// ── shared verdict styling ────────────────────────────────────────────────────

const VERDICT_META: Record<
  ReadinessVerdict,
  { label: string; dot: string; text: string }
> = {
  ready: {
    label: "Ready",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  needs_attention: {
    label: "Needs attention",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  not_ready: {
    label: "Not ready",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
  },
};

function coveragePct(ratio: number | null | undefined): string | null {
  if (typeof ratio !== "number") return null;
  return `${Math.round(ratio * 100)}%`;
}

function formatLatency(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || ms <= 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const LOW_COVERAGE_THRESHOLD = 0.5;

/** When the server omits `issues[]`, derive human explanations from denormalized fields. */
export function explainReadinessIssues(
  readiness: SessionReadiness,
): SessionReadinessIssue[] {
  if ((readiness.issues?.length ?? 0) > 0) {
    return readiness.issues!;
  }

  const fallbacks: SessionReadinessIssue[] = [];

  if (
    typeof readiness.coverageRatio === "number" &&
    readiness.advertisedToolsKnown !== false &&
    readiness.coverageRatio < LOW_COVERAGE_THRESHOLD
  ) {
    fallbacks.push({
      code: "low_coverage",
      severity: readiness.coverageRatio < 0.25 ? "error" : "warning",
      message: `Only ${Math.round(readiness.coverageRatio * 100)}% of advertised tools were used — synthetic sessions should exercise more of your tool surface.`,
    });
  }

  if ((readiness.toolErrorCount ?? 0) > 0) {
    fallbacks.push({
      code: "tool_errors",
      severity: "warning",
      message: `${readiness.toolErrorCount} of ${readiness.toolCallCount} tool call${readiness.toolCallCount === 1 ? "" : "s"} failed.`,
    });
  }

  for (const tool of readiness.hallucinatedTools ?? []) {
    fallbacks.push({
      code: "hallucinated_tool",
      severity: "error",
      message: `Called "${tool}", which is not an advertised tool.`,
      toolName: tool,
    });
  }

  if (
    readiness.status === "partial" &&
    readiness.advertisedToolsKnown === false
  ) {
    fallbacks.push({
      code: "partial_inventory",
      severity: "warning",
      message:
        "Tool inventory was unavailable when this session was analyzed, so coverage could not be fully verified.",
    });
  }

  if (
    typeof readiness.usedToolCount === "number" &&
    typeof readiness.advertisedToolCount === "number" &&
    readiness.advertisedToolCount > 0 &&
    readiness.usedToolCount === 0 &&
    (readiness.toolCallCount ?? 0) === 0
  ) {
    fallbacks.push({
      code: "no_tools_used",
      severity: "warning",
      message: `No tools were called, but ${readiness.advertisedToolCount} tool${readiness.advertisedToolCount === 1 ? "" : "s"} ${readiness.advertisedToolCount === 1 ? "is" : "are"} advertised on this swarm.`,
    });
  }

  const latency = readiness.hostLatencyMs;
  if (typeof latency === "number" && latency > 10_000) {
    fallbacks.push({
      code: "high_latency",
      severity: "warning",
      message: `Client response latency was ${formatLatency(latency)} across turns.`,
    });
  }

  const verdict = readiness.verdict ?? "ready";
  if (verdict !== "ready" && fallbacks.length === 0 && readiness.issueCount > 0) {
    fallbacks.push({
      code: "unknown",
      severity: "warning",
      message: `Readiness flagged ${readiness.issueCount} issue${readiness.issueCount === 1 ? "" : "s"} — open the Trace tab for details.`,
    });
  }

  return fallbacks;
}

/** Tooltip copy for list-row dots and the detail-bar info trigger. */
export function buildReadinessDetailLines(
  readiness: SessionReadiness,
): string[] {
  const verdict = readiness.verdict ?? "ready";
  const meta = VERDICT_META[verdict];
  const lines = [meta.label];

  if (readiness.issueCount > 0) {
    lines.push(
      `${readiness.issueCount} issue${readiness.issueCount === 1 ? "" : "s"}`,
    );
  }
  if (readiness.status === "partial") {
    lines.push("Partial analysis — tool inventory was unavailable");
  }
  if (typeof readiness.toolCallCount === "number") {
    lines.push(
      `${readiness.toolErrorCount ?? 0}/${readiness.toolCallCount} tool calls failed`,
    );
  }
  const coverage = coveragePct(readiness.coverageRatio);
  if (coverage) {
    lines.push(`${coverage} tool coverage`);
  }
  if ((readiness.hallucinatedTools?.length ?? 0) > 0) {
    lines.push(
      `${readiness.hallucinatedTools!.length} undeclared tool${readiness.hallucinatedTools!.length === 1 ? "" : "s"}`,
    );
  }
  const latency = formatLatency(readiness.hostLatencyMs);
  if (latency) {
    lines.push(`${latency} client latency`);
  }

  for (const issue of explainReadinessIssues(readiness)) {
    if (!lines.includes(issue.message)) {
      lines.push(issue.message);
    }
  }

  if (readiness.status === "failed" && readiness.errorMessage) {
    lines.push(readiness.errorMessage);
  }

  return lines;
}

function ReadinessDetailTooltip({
  readiness,
  children,
}: {
  readiness: SessionReadiness;
  children: ReactNode;
}) {
  const lines = buildReadinessDetailLines(readiness);
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        variant="muted"
        side="bottom"
        align="start"
        className="max-w-xs space-y-1 px-3 py-2"
      >
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

// ── badge (session row) ───────────────────────────────────────────────────────

export function SessionReadinessBadge({
  readiness,
}: {
  readiness: SessionReadiness | undefined;
}) {
  if (!readiness) return null;

  if (readiness.status === "pending") {
    return (
      <ReadinessDetailTooltip readiness={readiness}>
        <span
          className="inline-flex shrink-0 items-center text-muted-foreground"
          aria-label="Analyzing readiness"
        >
          <Loader2 className="size-2.5 animate-spin" />
        </span>
      </ReadinessDetailTooltip>
    );
  }
  if (readiness.status === "failed") {
    return (
      <ReadinessDetailTooltip readiness={readiness}>
        <span
          className="inline-flex shrink-0 items-center text-muted-foreground"
          aria-label="Readiness analysis failed"
        >
          <XCircle className="size-2.5" />
        </span>
      </ReadinessDetailTooltip>
    );
  }

  const verdict = readiness.verdict ?? "ready";
  if (verdict === "ready" && readiness.status !== "partial") {
    return null;
  }

  const meta = VERDICT_META[verdict];
  const label =
    readiness.issueCount > 0
      ? `${meta.label}, ${readiness.issueCount} issue${readiness.issueCount === 1 ? "" : "s"}`
      : meta.label;

  return (
    <ReadinessDetailTooltip readiness={readiness}>
      <span
        className={`inline-block size-1.5 shrink-0 rounded-full ${meta.dot}`}
        aria-label={label}
        role="img"
      />
    </ReadinessDetailTooltip>
  );
}

// ── insight bar (session detail) ──────────────────────────────────────────────

export function SessionInsightBar({
  readiness,
}: {
  readiness: SessionReadiness | undefined;
}) {
  if (!readiness) return null;

  if (readiness.status === "pending") {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Analyzing readiness…
      </div>
    );
  }
  if (readiness.status === "failed") {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <XCircle className="size-3 shrink-0" />
        <span className="truncate">
          Readiness unavailable
          {readiness.errorMessage ? `: ${readiness.errorMessage}` : ""}
        </span>
      </div>
    );
  }

  const verdict = readiness.verdict ?? "ready";
  if (verdict === "ready" && readiness.status !== "partial") {
    return null;
  }

  const meta = VERDICT_META[verdict];
  const issues = explainReadinessIssues(readiness);
  const primaryIssue =
    issues[0]?.message ??
    (readiness.status === "partial"
      ? "Tool inventory was unavailable — coverage could not be fully verified."
      : meta.label);
  const detailLines = buildReadinessDetailLines(readiness);
  const hasExtraDetail = detailLines.length > 1;

  return (
    <div
      className="flex items-start gap-2.5 border-b px-4 py-2"
      data-testid="session-insight-bar"
    >
      <span
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${meta.dot}`}
        aria-hidden
      />
      <p className={`min-w-0 flex-1 text-xs leading-snug ${meta.text}`}>
        {primaryIssue}
      </p>
      {hasExtraDetail ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              aria-label="Readiness details"
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            variant="muted"
            side="bottom"
            align="end"
            className="max-w-xs space-y-1 px-3 py-2"
          >
            {detailLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
