/**
 * Phase 1 — synthetic-session "readiness" UI.
 *
 * All three surfaces render from the server-denormalized `chatSessions.readiness`
 * fields (open decision: insight-bar source is server-denormalized readiness;
 * client-side trace parsing is fallback/test-only). Nothing here re-parses the
 * trace.
 *
 *   - `SessionReadinessBadge` — compact verdict pill for synthetic session rows
 *   - `SessionInsightBar`      — findings strip atop a synthetic session detail
 *   - `SessionReadinessStrip`  — chatbox-level rollup above the session list
 */

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { useQuery } from "convex/react";

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
  { label: string; pill: string; Icon: typeof ShieldCheck }
> = {
  ready: {
    label: "Ready",
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    Icon: ShieldCheck,
  },
  needs_attention: {
    label: "Needs attention",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    Icon: AlertTriangle,
  },
  not_ready: {
    label: "Not ready",
    pill: "bg-red-500/10 text-red-700 dark:text-red-400",
    Icon: ShieldAlert,
  },
};

function coveragePct(ratio: number | null | undefined): string | null {
  if (typeof ratio !== "number") return null;
  return `${Math.round(ratio * 100)}%`;
}

/** Host-response latency (server work time, excludes persona-driver time). */
function formatLatency(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || ms <= 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
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
      <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Loader2 className="size-2.5 animate-spin" />
        Analyzing
      </span>
    );
  }
  if (readiness.status === "failed") {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        <XCircle className="size-2.5" />
        Readiness failed
      </span>
    );
  }

  const verdict = readiness.verdict ?? "ready";
  const meta = VERDICT_META[verdict];
  const { Icon } = meta;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${meta.pill}`}
      title={
        readiness.status === "partial"
          ? "Partial readiness — tool inventory was unavailable"
          : undefined
      }
    >
      <Icon className="size-2.5" />
      {meta.label}
      {readiness.issueCount > 0 ? ` · ${readiness.issueCount}` : ""}
      {readiness.status === "partial" ? " · partial" : ""}
    </span>
  );
}

// ── insight bar (session detail) ──────────────────────────────────────────────

const ISSUE_ICON: Record<
  SessionReadinessIssue["severity"],
  typeof AlertTriangle
> = {
  error: XCircle,
  warning: AlertTriangle,
  info: CheckCircle2,
};

const ISSUE_TONE: Record<SessionReadinessIssue["severity"], string> = {
  error: "text-red-600 dark:text-red-400",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-muted-foreground",
};

export function SessionInsightBar({
  readiness,
}: {
  readiness: SessionReadiness | undefined;
}) {
  if (!readiness) return null;

  if (readiness.status === "pending") {
    return (
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Readiness analysis in progress…
      </div>
    );
  }
  if (readiness.status === "failed") {
    return (
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        <XCircle className="size-3.5" />
        Readiness analysis failed
        {readiness.errorMessage ? `: ${readiness.errorMessage}` : ""}
      </div>
    );
  }

  const verdict = readiness.verdict ?? "ready";
  const meta = VERDICT_META[verdict];
  const { Icon } = meta;
  const coverage = coveragePct(readiness.coverageRatio);
  const issues = readiness.issues ?? [];

  return (
    <div className="border-b bg-muted/20 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${meta.pill}`}
        >
          <Icon className="size-3" />
          {meta.label}
        </span>
        {typeof readiness.toolCallCount === "number" ? (
          <span className="text-muted-foreground">
            {readiness.toolErrorCount ?? 0}/{readiness.toolCallCount} tool calls
            failed
          </span>
        ) : null}
        {coverage ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground">
              {coverage} tool coverage
            </span>
          </>
        ) : null}
        {readiness.status === "partial" ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground/80">
              tool inventory unavailable
            </span>
          </>
        ) : null}
        {(readiness.hallucinatedTools?.length ?? 0) > 0 ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-red-600 dark:text-red-400">
              {readiness.hallucinatedTools!.length} undeclared tool
              {readiness.hallucinatedTools!.length === 1 ? "" : "s"}
            </span>
          </>
        ) : null}
        {formatLatency(readiness.hostLatencyMs) ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span
              className="text-muted-foreground"
              title="Host-response latency (server work time across turns; excludes the persona driver's own LLM time)"
            >
              {formatLatency(readiness.hostLatencyMs)} host latency
            </span>
          </>
        ) : null}
      </div>
      {issues.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {issues.map((issue, i) => {
            const IssueIcon = ISSUE_ICON[issue.severity];
            return (
              <li
                key={`${issue.code}-${i}`}
                className={`flex items-start gap-1.5 text-xs ${
                  ISSUE_TONE[issue.severity]
                }`}
              >
                <IssueIcon className="mt-0.5 size-3 shrink-0" />
                <span>{issue.message}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ── rollup strip (above the session list) ─────────────────────────────────────

export function useChatboxReadinessRollup(chatboxId: string | null) {
  return useQuery(
    "chatSessions:getChatboxReadinessRollup" as any,
    chatboxId ? ({ chatboxId } as any) : "skip"
  ) as SessionReadinessRollup | null | undefined;
}

function RollupStat({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`text-sm font-semibold tabular-nums ${tone}`}>
        {count}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </span>
  );
}

/**
 * Chatbox-level readiness rollup over synthetic sessions. Renders nothing until
 * at least one synthetic session has been analyzed, so non-synthetic chatboxes
 * never show an empty strip.
 */
export function SessionReadinessStrip({
  chatboxId,
}: {
  chatboxId: string | null;
}) {
  const rollup = useChatboxReadinessRollup(chatboxId);
  if (!rollup || rollup.analyzed === 0) return null;

  const coverage = coveragePct(rollup.avgCoverageRatio);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/20 px-3 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Readiness
      </span>
      <RollupStat
        count={rollup.byVerdict.ready}
        label="ready"
        tone="text-emerald-600 dark:text-emerald-400"
      />
      <RollupStat
        count={rollup.byVerdict.needs_attention}
        label="needs attention"
        tone="text-amber-600 dark:text-amber-400"
      />
      <RollupStat
        count={rollup.byVerdict.not_ready}
        label="not ready"
        tone="text-red-600 dark:text-red-400"
      />
      <span className="text-muted-foreground/30">·</span>
      <RollupStat
        count={rollup.totalIssues}
        label="issues"
        tone="text-foreground"
      />
      {coverage ? (
        <span className="text-[11px] text-muted-foreground">
          avg coverage {coverage}
        </span>
      ) : null}
      {rollup.topFailingTools.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1">
          {rollup.topFailingTools.slice(0, 3).map((t) => (
            <span
              key={t.toolName}
              className="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-400"
              title={`${t.errorCount} failure${t.errorCount === 1 ? "" : "s"}`}
            >
              <Wrench className="size-2.5" />
              {t.toolName}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
