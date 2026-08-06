import { Users } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

const FIRST_PERSONA_EMPTY_DESCRIPTION =
  "Personas simulate how product managers and developers pursue real goals across your clients. Run journeys to learn common use cases, spot friction, and promote winning sessions into evals for CI.";

interface SwarmsEmptyHeroProps {
  onCreatePersona: () => void;
}

export function SwarmsEmptyHero({ onCreatePersona }: SwarmsEmptyHeroProps) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10"
      data-testid="swarms-empty-hero"
    >
      <div className="my-auto flex w-full max-w-3xl flex-col items-center gap-8">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Users className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-foreground">
            Create your first persona
          </h3>
          <p className="max-w-md text-pretty text-sm text-muted-foreground">
            {FIRST_PERSONA_EMPTY_DESCRIPTION}
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button type="button" onClick={onCreatePersona}>
              Create persona
            </Button>
          </div>
        </div>

        <div className="flex w-full items-center gap-3">
          <div className="h-px flex-1 bg-border/50" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            What swarms looks like
          </span>
          <div className="h-px flex-1 bg-border/50" />
        </div>

        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
          <PreviewCard title="Journey trend" subtitle="Outcomes across runs">
            <JourneyTrendPreview />
          </PreviewCard>
          <PreviewCard title="Client matrix" subtitle="Per-client session results">
            <ClientMatrixPreview />
          </PreviewCard>
          <PreviewCard title="Session trace" subtitle="Steps + latency">
            <SessionTracePreview />
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

const PREVIEW_JOURNEY_PERCENTS = [38, 52, 61, 68, 74, 81, 88];

function JourneyTrendPreview() {
  const latest = PREVIEW_JOURNEY_PERCENTS[PREVIEW_JOURNEY_PERCENTS.length - 1];
  const delta = latest - PREVIEW_JOURNEY_PERCENTS[0];
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
        {PREVIEW_JOURNEY_PERCENTS.map((value, idx) => (
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

const PREVIEW_CLIENT_ROWS = [
  { label: "Claude Code", ok: 0, total: 2, tone: "fail" as const },
  { label: "Copilot", ok: 2, total: 2, tone: "pass" as const },
];

function ClientMatrixPreview() {
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      {PREVIEW_CLIENT_ROWS.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5"
        >
          <span className="truncate text-[11px] font-medium text-foreground/90">
            {row.label}
          </span>
          <span className="inline-flex items-center gap-1.5 shrink-0">
            <span
              className={cn(
                "size-1.5 rounded-full",
                row.tone === "pass" ? "bg-success" : "bg-destructive",
              )}
            />
            <span
              className={cn(
                "text-[11px] font-semibold tabular-nums",
                row.tone === "pass" ? "text-success" : "text-destructive",
              )}
            >
              {row.ok}/{row.total} ok
            </span>
          </span>
        </div>
      ))}
      <div className="mt-1 flex h-4 items-stretch gap-[2px]">
        {[0, 1, 0, 1, 1, 1, 1].map((pass, idx) => (
          <div
            key={idx}
            className={cn(
              "min-w-[4px] flex-1 rounded-[2px]",
              pass ? "bg-success/70" : "bg-destructive/70",
            )}
          />
        ))}
      </div>
    </div>
  );
}

const TRACE_ROWS = [
  {
    actor: "Persona",
    latencyMs: 118,
    barClass: "bg-chart-4/60",
    offsetPct: 0,
    widthPct: 42,
  },
  {
    actor: "Agent",
    latencyMs: 64,
    barClass: "bg-chart-1/60",
    offsetPct: 20,
    widthPct: 22,
  },
  {
    actor: "Tool",
    latencyMs: 51,
    barClass: "bg-warning/50",
    offsetPct: 44,
    widthPct: 18,
  },
  {
    actor: "Agent",
    latencyMs: 88,
    barClass: "bg-chart-1/60",
    offsetPct: 66,
    widthPct: 30,
  },
];

function SessionTracePreview() {
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
