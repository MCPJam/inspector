/**
 * What Swarms and User Testing show a visitor who may look but not run
 * (REEV-8, REEV-9).
 *
 * TWO components, not one with a variant. The first draft shared a single
 * component because the two audiences differed only in the middle. After the
 * first review they no longer do: a signed-out visitor gets a hero, a sample
 * card and sign-up, while a plan-locked reader gets their plan, one line about
 * it, and a way to pay. Forcing those through one component would mean three
 * booleans deciding what renders, so they split, and share only the shell they
 * genuinely have in common.
 *
 * THE HEADER HAS NO CREATE BUTTON on either. The real tabs lead with "Create
 * new swarm" or "Create new study", and neither audience can create anything.
 * A disabled control reads as broken and a live one that opens a wall reads as
 * a trick, so the only control on the page is the one that helps.
 *
 * THE SAMPLE IS SIGNED-OUT ONLY. A plan-locked reader has seen the product;
 * showing them a picture of it answers a question they did not ask, where what
 * they need is their plan and the upgrade.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { SwarmHeroCharacters } from "@/components/swarms/swarm-hero-characters";
import { track } from "@/lib/analytics";
import {
  GATED_FEATURE_COPY,
  SAMPLE_DATA_NOTE,
  type GatedFeatureId,
  type GatedFeatureSample,
} from "./feature-highlights";

/**
 * Title-only chrome plus a centred column. Mirrors the real tab's header box
 * so the page still reads as that tab, minus the control neither audience can
 * use.
 */
function GatedFeatureShell({
  feature,
  children,
}: {
  feature: GatedFeatureId;
  children: ReactNode;
}) {
  const copy = GATED_FEATURE_COPY[feature];
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid={`gated-feature-${feature}`}
    >
      <div className="shrink-0 border-b border-border/40 px-6 py-5 sm:px-8">
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          {copy.navLabel}
        </h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-8">
        <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-6">
          {children}
        </div>
      </div>
    </div>
  );
}

/** One impression per mount. The ref survives StrictMode's double-invoke. */
function useImpression(event: "guest_feature_preview_shown", feature: GatedFeatureId) {
  const sent = useRef(false);
  const location = GATED_FEATURE_COPY[feature].analyticsLocation;
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    track(event, { location, feature });
  }, [event, location, feature]);
}

export function GuestFeaturePreview({
  feature,
  children,
}: {
  feature: GatedFeatureId;
  /** The sign-up call to action. Supplied by the route, which owns auth. */
  children: ReactNode;
}) {
  const copy = GATED_FEATURE_COPY[feature];
  useImpression("guest_feature_preview_shown", feature);

  return (
    <GatedFeatureShell feature={feature}>
      <div className="flex flex-col items-center text-center">
        <FeatureHero feature={feature} />
        <h2 className="mt-4 text-lg font-semibold text-balance text-foreground">
          {copy.heroTitle}
        </h2>
        <p className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">
          {copy.heroBody}
        </p>
        <div className="mt-5 flex flex-col items-center gap-2">{children}</div>
      </div>

      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-border/50" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {copy.sampleLabel}
        </span>
        <div className="h-px flex-1 bg-border/50" />
      </div>

      <SampleCard sample={copy.sample} />

      <p className="max-w-lg text-pretty text-center text-xs text-muted-foreground">
        {SAMPLE_DATA_NOTE}
      </p>
    </GatedFeatureShell>
  );
}

/**
 * The plan-locked screen. Leads with the plan, because "which plan am I on"
 * is the question a reader asks before "what does it cost to fix that", and
 * the answer was previously buried in a sentence.
 */
export function PlanLockedFeatureNotice({
  feature,
  children,
}: {
  feature: GatedFeatureId;
  /** The billing upsell. Supplied by the route, which owns entitlements. */
  children: ReactNode;
}) {
  const copy = GATED_FEATURE_COPY[feature];
  return (
    <GatedFeatureShell feature={feature}>
      <div className="flex flex-col items-center text-center">
        {children}
        <p className="mt-3 max-w-md text-pretty text-sm text-muted-foreground">
          {copy.heroBody}
        </p>
      </div>
    </GatedFeatureShell>
  );
}

/**
 * Swarms reuses the empty state's jumping golems: they ARE the personas a
 * swarm invents, so the graphic previews the product rather than decorating
 * the page. User Testing reuses its own empty-state illustration, so a visitor
 * who signs up recognises the screen they land on.
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

// ── The sample ───────────────────────────────────────────────────────────────
//
// Both shapes are traced from screenshots of the running product. The pair
// these replaced showed a seven-wave bar chart and an
// opened/connected/first-tool/goal-met funnel, neither of which exists
// anywhere in the app. That is BB-120's objection in a worse form: not faked
// numbers but a faked feature, and a visitor who signs up off one goes looking
// for a screen that was never there.
//
// Token-only, like every other component here: DESIGN.md forbids a literal hex
// or oklch() and `npm run design:lint` gates it.

function SampleCard({ sample }: { sample: GatedFeatureSample }) {
  return (
    <div
      // `aria-hidden`, like the Evaluate hero's cards: a panel of invented
      // figures tells a screen-reader user nothing true, and the hero copy
      // above already carries the message in words.
      aria-hidden
      className="flex w-full flex-col gap-3 rounded-lg border border-border/50 bg-muted/15 p-4"
      data-testid="gated-feature-sample"
    >
      <div className="space-y-0.5">
        <div className="text-xs font-semibold text-foreground">
          {sample.title}
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {sample.subtitle}
        </div>
      </div>
      {sample.kind === "runs" ? (
        <SampleRuns sample={sample} />
      ) : (
        <SampleMetrics sample={sample} />
      )}
    </div>
  );
}

function SampleRuns({
  sample,
}: {
  sample: Extract<GatedFeatureSample, { kind: "runs" }>;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {sample.runs.map((run) => (
        <div key={run.name} className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-foreground">
              {run.name}
              {/* One outcome badge. Drawn the way Vig has asked the row to
                  become, not the way it renders today: no status dot, no red
                  FAILED, so the preview and that cleanup land on one design. */}
              <span className="rounded-full border border-success/40 bg-success/15 px-1.5 py-px text-[9px] uppercase tracking-wide text-success">
                Completed
              </span>
              <span className="text-[10px] font-normal text-muted-foreground">
                {run.when}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {run.meta}
            </div>
          </div>
          <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {run.model}
          </div>
        </div>
      ))}
    </div>
  );
}

function SampleMetrics({
  sample,
}: {
  sample: Extract<GatedFeatureSample, { kind: "metrics" }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border/50 bg-border/50">
      {sample.tiles.map((tile) => (
        <div key={tile.label} className="bg-card p-2.5">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
            {tile.label}
          </div>
          <div className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
            {tile.value}
          </div>
          <div className="text-[9px] text-muted-foreground">{tile.unit}</div>
        </div>
      ))}
    </div>
  );
}
