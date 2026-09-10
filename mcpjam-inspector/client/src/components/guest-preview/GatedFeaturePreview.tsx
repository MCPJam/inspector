/**
 * What Swarms and User Testing show a visitor who may look but not run
 * (REEV-8, REEV-9).
 *
 * ONE component for both gated audiences, because they see the same thing
 * apart from the way out:
 *
 *   - a signed-out guest gets sign-up buttons;
 *   - a signed-in user whose plan lacks the feature gets the existing billing
 *     upsell and "See plans".
 *
 * That is the whole difference, so it arrives as `children` rather than as a
 * variant prop. A variant would put both audiences' copy in here and invite the
 * next case to be a third branch; a slot keeps this component about the pitch
 * and leaves "what unblocks this reader" to the route that already knows.
 *
 * THE HEADER HAS NO CREATE BUTTON, deliberately. The real tabs lead with
 * "Create new swarm" / "Create new study", and neither audience can create
 * anything — a guest has no account, a plan-locked user has no entitlement. A
 * disabled button reads as broken and a live one that opens a wall reads as a
 * trick, so the title stands alone and the only control on the page is the one
 * that actually helps.
 *
 * The layout is `evals-empty-hero.tsx`'s, on purpose: Evaluate already shows a
 * hero, a divider, and three static example cards on an empty page, so this is
 * an established pattern applied to two more tabs rather than a new invention.
 * The example figures are illustrative and the page says so — see
 * `SAMPLE_DATA_NOTE`.
 */

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { SwarmHeroCharacters } from "@/components/swarms/swarm-hero-characters";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import {
  GATED_FEATURE_COPY,
  SAMPLE_DATA_NOTE,
  type GatedFeatureId,
} from "./feature-highlights";

export function GatedFeaturePreview({
  feature,
  children,
}: {
  feature: GatedFeatureId;
  /**
   * The way out for THIS reader: sign-up buttons for a guest, the billing
   * upsell for a plan-locked user. Rendered directly under the hero copy,
   * where the primary action belongs.
   */
  children: ReactNode;
}) {
  const copy = GATED_FEATURE_COPY[feature];

  // One impression per mount, not per render. The ref (rather than an empty
  // dep array alone) is what survives StrictMode's deliberate double-invoke in
  // development — same guard InviteTeamSignUpDialog uses for its opening.
  const impressionSent = useRef(false);
  useEffect(() => {
    if (impressionSent.current) return;
    impressionSent.current = true;
    track("guest_feature_preview_shown", {
      location: copy.analyticsLocation,
      feature,
    });
  }, [copy.analyticsLocation, feature]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid={`gated-feature-preview-${feature}`}
    >
      {/* Title-only chrome. Matches the real tab's header box so the page
          reads as that tab, minus the control neither audience can use. */}
      <div className="shrink-0 border-b border-border/40 px-6 py-5 sm:px-8">
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          {copy.navLabel}
        </h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8">
          <div className="flex flex-col items-center text-center">
            <FeatureHero feature={feature} />
            <h2 className="mt-4 text-lg font-semibold text-balance text-foreground">
              {copy.heroTitle}
            </h2>
            <p className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">
              {copy.heroBody}
            </p>
            <div className="mt-5 flex flex-col items-center gap-2">
              {children}
            </div>
          </div>

          <div className="flex w-full items-center gap-3">
            <div className="h-px flex-1 bg-border/50" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {copy.cardsLabel}
            </span>
            <div className="h-px flex-1 bg-border/50" />
          </div>

          <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
            {copy.cards.map((card, index) => (
              <PreviewCard
                key={card.title}
                title={card.title}
                subtitle={card.subtitle}
              >
                {PREVIEW_GRAPHICS[feature][index]()}
              </PreviewCard>
            ))}
          </div>

          <p className="max-w-2xl text-pretty text-center text-xs text-muted-foreground">
            {SAMPLE_DATA_NOTE}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Swarms reuses the empty state's jumping golems — they ARE the personas a
 * swarm invents, so the graphic previews the product rather than decorating
 * the page. User Testing reuses its own empty-state illustration for the same
 * reason: a visitor who signs up should recognise the screen they land on.
 */
function FeatureHero({ feature }: { feature: GatedFeatureId }) {
  if (feature === "swarms") {
    return <SwarmHeroCharacters />;
  }
  return (
    <img
      src="/user-testing-empty.png"
      alt=""
      width={196}
      height={250}
      aria-hidden
      className="h-24 w-auto max-w-full object-contain"
    />
  );
}

function PreviewCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div
      // `aria-hidden`, like the Evaluate hero's cards: these are a picture of
      // the product, and reading three panels of invented figures aloud would
      // tell a screen-reader user nothing true. The hero copy above carries
      // the same message in words.
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

// ── Example graphics ─────────────────────────────────────────────────────────
//
// Static and token-only. Every colour is a role class (`bg-success/50`,
// `bg-chart-1/60`) rather than a literal — DESIGN.md forbids a hex or oklch()
// in a component and `npm run design:sync`/`design:lint` gate it. Positioned in
// the same order as `cards` in the copy module, so a card and its graphic are
// matched by index.

const PREVIEW_GRAPHICS: Record<GatedFeatureId, readonly (() => ReactNode)[]> = {
  swarms: [
    () => <GoalCompletionGraphic />,
    () => <ClientBreakdownGraphic />,
    () => <SessionTraceGraphic />,
  ],
  "user-testing": [
    () => <TestersGraphic />,
    () => <SessionFunnelGraphic />,
    () => <ExitQuotesGraphic />,
  ],
};

const GOAL_COMPLETION_WAVES = [38, 51, 57, 66, 74, 81, 88];

function GoalCompletionGraphic() {
  const latest = GOAL_COMPLETION_WAVES[GOAL_COMPLETION_WAVES.length - 1];
  const delta = latest - GOAL_COMPLETION_WAVES[0];
  return (
    <div className="flex h-full flex-col justify-between gap-3">
      <div className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold tabular-nums text-foreground">
          {latest}%
        </div>
        <div className="text-[10px] tabular-nums text-success">
          ▲ {delta} pts since wave 1
        </div>
      </div>
      <div className="flex h-12 items-end gap-1">
        {GOAL_COMPLETION_WAVES.map((value, idx) => (
          <div
            key={idx}
            className={cn(
              "flex-1 rounded-sm",
              value >= 75
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
        <span>wave 1</span>
        <span>wave 7</span>
      </div>
    </div>
  );
}

const BREAKDOWN_CLIENTS = ["Claude", "GPT", "Cursor", "Code"];
const BREAKDOWN_ROWS: readonly {
  goal: string;
  results: readonly ("pass" | "partial" | "fail")[];
}[] = [
  { goal: "Onboard", results: ["pass", "pass", "partial", "pass"] },
  { goal: "Search", results: ["pass", "partial", "pass", "fail"] },
  { goal: "Export", results: ["pass", "pass", "pass", "pass"] },
];

function ClientBreakdownGraphic() {
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <div className="grid grid-cols-[46px_repeat(4,1fr)] items-center gap-1">
        <span />
        {BREAKDOWN_CLIENTS.map((client) => (
          <span
            key={client}
            className="truncate text-center text-[8px] text-muted-foreground"
          >
            {client}
          </span>
        ))}
        {BREAKDOWN_ROWS.map((row) => (
          <Fragment key={row.goal}>
            <span className="truncate text-[9px] text-muted-foreground">
              {row.goal}
            </span>
            {row.results.map((result, idx) => (
              <span
                key={idx}
                className={cn(
                  "h-4 rounded-sm border",
                  result === "pass"
                    ? "border-success/40 bg-success/20"
                    : result === "partial"
                      ? "border-warning/40 bg-warning/20"
                      : "border-destructive/40 bg-destructive/20",
                )}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground">
        <span>pass</span>
        <span>partial</span>
        <span>failed</span>
      </div>
    </div>
  );
}

const TRACE_ROWS = [
  { actor: "User", offsetPct: 0, widthPct: 40, latencyMs: 210, tool: false },
  { actor: "Agent", offsetPct: 14, widthPct: 20, latencyMs: 64, tool: false },
  { actor: "Tool", offsetPct: 36, widthPct: 22, latencyMs: 71, tool: true },
  { actor: "Agent", offsetPct: 60, widthPct: 34, latencyMs: 118, tool: false },
];

function SessionTraceGraphic() {
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <div className="flex flex-col gap-1.5">
        {TRACE_ROWS.map((row, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[40px_1fr_34px] items-center gap-2 text-[9px]"
          >
            <span className="truncate text-muted-foreground">{row.actor}</span>
            <div className="relative h-2.5 rounded bg-muted/40">
              <div
                className={cn(
                  "absolute top-0 h-full rounded",
                  row.tool ? "bg-warning/50" : "bg-chart-1/60",
                )}
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
      <QuoteLine
        quote="Couldn't find the export — tried three tools first."
        attribution="Priya · product manager persona"
      />
    </div>
  );
}

const TESTERS = [
  { name: "Mara", state: "finished" as const },
  { name: "Jonah", state: "finished" as const },
  { name: "Lee", state: "in session" as const },
  { name: "Sam", state: "invited" as const },
];

function TestersGraphic() {
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <div className="flex flex-col gap-1.5">
        {TESTERS.map((tester) => (
          <div
            key={tester.name}
            className="flex items-center gap-2 text-[10px] text-foreground"
          >
            <span className="size-4 shrink-0 rounded-full border border-border/60 bg-muted/50" />
            <span className="truncate">{tester.name}</span>
            <span
              className={cn(
                "ml-auto shrink-0 rounded-full border px-1.5 py-px text-[8px]",
                tester.state === "finished"
                  ? "border-success/40 bg-success/15 text-success"
                  : tester.state === "in session"
                    ? "border-chart-1/40 bg-chart-1/15 text-chart-1"
                    : "border-border/60 bg-muted/40 text-muted-foreground",
              )}
            >
              {tester.state}
            </span>
          </div>
        ))}
      </div>
      <div className="truncate text-[9px] text-muted-foreground">
        study.mcpjam.com/s/8k2
      </div>
    </div>
  );
}

const FUNNEL_STEPS = [
  { label: "Opened", widthPct: 100, count: 12 },
  { label: "Connected", widthPct: 92, count: 11 },
  { label: "First tool", widthPct: 75, count: 9 },
  { label: "Goal met", widthPct: 58, count: 7 },
];

function SessionFunnelGraphic() {
  return (
    <div className="flex h-full flex-col justify-between gap-3">
      <div>
        <div className="text-2xl font-semibold tabular-nums text-foreground">
          58%
        </div>
        <div className="text-[10px] text-success">reached the goal</div>
      </div>
      <div className="flex flex-col gap-1">
        {FUNNEL_STEPS.map((step) => (
          <div
            key={step.label}
            className="grid grid-cols-[54px_1fr_18px] items-center gap-2 text-[9px]"
          >
            <span className="truncate text-muted-foreground">{step.label}</span>
            <div className="h-2.5 overflow-hidden rounded bg-muted/40">
              <div
                className="h-full rounded bg-chart-1/60"
                style={{ width: `${step.widthPct}%` }}
              />
            </div>
            <span className="text-right tabular-nums text-muted-foreground">
              {step.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExitQuotesGraphic() {
  return (
    <div className="flex h-full flex-col justify-center gap-2.5">
      <QuoteLine
        quote="I expected search to take a date range. It only took a word."
        attribution="Jonah · 6 min · 2 retries"
      />
      <QuoteLine
        quote="Fast once I found the right tool."
        attribution="Mara · 3 min"
      />
    </div>
  );
}

function QuoteLine({
  quote,
  attribution,
}: {
  quote: string;
  attribution: string;
}) {
  return (
    <div className="border-l-2 border-primary/60 pl-2">
      <div className="text-[10px] leading-snug text-foreground">
        &ldquo;{quote}&rdquo;
      </div>
      <div className="mt-0.5 text-[9px] text-muted-foreground">
        {attribution}
      </div>
    </div>
  );
}
