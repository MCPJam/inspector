import { FlaskConical, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

const FIRST_SUITE_EMPTY_DESCRIPTION =
  "A suite groups eval cases with the MCP servers they use. Create one, then generate cases or import a chat transcript.";

interface EvalsEmptyHeroProps {
  onCreateSuite: () => void;
  onQuickstart: () => void;
  isQuickstartRunning: boolean;
  showQuickstart: boolean;
}

export function EvalsEmptyHero({
  onCreateSuite,
  onQuickstart,
  isQuickstartRunning,
  showQuickstart,
}: EvalsEmptyHeroProps) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col items-center gap-8 my-auto">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <FlaskConical className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-foreground">
            Create your first suite
          </h3>
          <p className="max-w-md text-pretty text-sm text-muted-foreground">
            {FIRST_SUITE_EMPTY_DESCRIPTION}
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button type="button" onClick={onCreateSuite}>
              Create suite
            </Button>
            {showQuickstart ? (
              <Button
                type="button"
                variant="outline"
                onClick={onQuickstart}
                disabled={isQuickstartRunning}
                className="gap-1.5"
              >
                {isQuickstartRunning ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Try the Excalidraw quickstart
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex w-full items-center gap-3">
          <div className="h-px flex-1 bg-border/50" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            What a suite looks like
          </span>
          <div className="h-px flex-1 bg-border/50" />
        </div>

        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
          <PreviewCard title="Pass-rate trend" subtitle="Suite accuracy over 7 runs">
            <PassRateTrendPreview />
          </PreviewCard>
          <PreviewCard
            title="Expected vs actual"
            subtitle="Per-iteration tool diff"
          >
            <ToolCallDiffPreview />
          </PreviewCard>
          <PreviewCard title="Run trace" subtitle="Steps + latency">
            <RunTracePreview />
          </PreviewCard>
        </div>
      </div>
    </div>
  );
}

function PreviewCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-3 rounded-lg border border-border/50 bg-muted/15 p-4"
    >
      <div className="space-y-0.5">
        <div className="text-xs font-semibold text-foreground">{title}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {subtitle}
        </div>
      </div>
      <div className="min-h-[120px]">{children}</div>
    </div>
  );
}

// ── Pass-rate trend preview ──────────────────────────────────────────────────

const PREVIEW_TREND_PERCENTS = [42, 55, 60, 71, 78, 85, 91];

function PassRateTrendPreview() {
  const latest = PREVIEW_TREND_PERCENTS[PREVIEW_TREND_PERCENTS.length - 1];
  const delta =
    latest - PREVIEW_TREND_PERCENTS[0];
  return (
    <div className="flex h-full flex-col justify-between gap-3">
      <div className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold tabular-nums text-foreground">
          {latest}%
        </div>
        <div className="text-[10px] tabular-nums text-success">
          ▲ {delta}% vs. first run
        </div>
      </div>
      <div className="flex h-12 items-end gap-1">
        {PREVIEW_TREND_PERCENTS.map((value, idx) => (
          <div
            key={idx}
            className={cn(
              "flex-1 rounded-sm",
              value >= 80
                ? "bg-success/50"
                : value >= 50
                  ? "bg-warning/50"
                  : "bg-destructive/50",
            )}
            style={{ height: `${Math.max(15, value)}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] tabular-nums text-muted-foreground">
        <span>run 1</span>
        <span>run 7</span>
      </div>
    </div>
  );
}

// ── Tool-call diff preview ───────────────────────────────────────────────────

function ToolCallDiffPreview() {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1.5 rounded border border-border/50 bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
        <CheckCircle2 className="size-3 text-success" aria-hidden />
        <span>2 of 3 calls matched</span>
      </div>
      <DiffPreviewRow
        toolName="create_element"
        leftArg="rectangle"
        rightArg="rectangle"
        match
      />
      <DiffPreviewRow
        toolName="create_element"
        leftArg='label: "Hi"'
        rightArg='label: "Hello"'
        match={false}
      />
    </div>
  );
}

function DiffPreviewRow({
  toolName,
  leftArg,
  rightArg,
  match,
}: {
  toolName: string;
  leftArg: string;
  rightArg: string;
  match: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-1.5 rounded border bg-background/40 p-1.5",
        match ? "border-border/50" : "border-warning/40",
      )}
    >
      <div className="space-y-0.5">
        <div className="font-mono text-[10px] text-foreground">{toolName}</div>
        <div
          className={cn(
            "rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[9px]",
            match ? "text-muted-foreground" : "text-destructive/80",
          )}
        >
          {leftArg}
        </div>
      </div>
      <div className="space-y-0.5">
        <div className="font-mono text-[10px] text-foreground">{toolName}</div>
        <div
          className={cn(
            "rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[9px]",
            match ? "text-muted-foreground" : "text-success/80",
          )}
        >
          {rightArg}
        </div>
      </div>
    </div>
  );
}

// ── Run trace preview ────────────────────────────────────────────────────────

const TRACE_ROWS = [
  {
    actor: "User",
    detail: "Use the greet tool to say hello",
    latencyMs: 125,
    barClass: "bg-chart-4/60",
    offsetPct: 0,
    widthPct: 45,
  },
  {
    actor: "Agent",
    detail: "Greet tool returned",
    latencyMs: 52,
    barClass: "bg-chart-1/60",
    offsetPct: 18,
    widthPct: 18,
  },
  {
    actor: "Tool",
    detail: "greet",
    latencyMs: 56,
    barClass: "bg-warning/50",
    offsetPct: 38,
    widthPct: 20,
  },
  {
    actor: "Agent",
    detail: 'Called the `greet` tool',
    latencyMs: 93,
    barClass: "bg-chart-1/60",
    offsetPct: 62,
    widthPct: 33,
  },
];

function RunTracePreview() {
  return (
    <div className="flex h-full flex-col gap-1.5">
      {TRACE_ROWS.map((row, idx) => (
        <div
          key={idx}
          className="grid grid-cols-[60px_1fr_38px] items-center gap-2 text-[10px]"
        >
          <span className="truncate text-muted-foreground">{row.actor}</span>
          <div className="relative h-3 rounded bg-muted/30">
            <div
              className={cn("absolute top-0 h-full rounded", row.barClass)}
              style={{
                left: `${row.offsetPct}%`,
                width: `${row.widthPct}%`,
              }}
            />
          </div>
          <span className="text-right tabular-nums text-muted-foreground">
            {row.latencyMs}ms
          </span>
        </div>
      ))}
    </div>
  );
}
