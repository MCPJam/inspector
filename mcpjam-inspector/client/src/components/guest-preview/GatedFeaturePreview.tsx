/**
 * What Swarms and User Testing show a visitor who is not signed in
 * (REEV-8, REEV-9).
 *
 * ONE audience. An earlier pass had a second component for a plan-locked
 * reader, with a plan pill and an upsell; that whole branch is gone. Both
 * features are on every plan and bounded by credits rather than entitlement,
 * so "signed in" is the only question and there is nobody to sell a plan to.
 *
 * THE HEADER HAS NO CREATE BUTTON. The real tab leads with "Create new swarm"
 * or "Create new study", and this reader cannot create anything. A disabled
 * control reads as broken and a live one that opens a wall reads as a trick,
 * so the only control on the page is the one that helps.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { SwarmHeroCharacters } from "@/components/swarms/swarm-hero-characters";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import {
  GATED_FEATURE_COPY,
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
        {copy.heroBody ? (
          <p className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">
            {copy.heroBody}
          </p>
        ) : null}
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
      {sample.kind === "findings" ? (
        <SampleFindings sample={sample} />
      ) : (
        <SampleFlow sample={sample} />
      )}
    </div>
  );
}

function SampleFindings({
  sample,
}: {
  sample: Extract<GatedFeatureSample, { kind: "findings" }>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-semibold text-balance text-foreground">
        {sample.summary}
      </div>
      <div className="flex flex-col gap-2">
        {sample.personas.map((persona) => (
          <div key={persona.seed} className="flex items-center gap-2.5">
            {/* The real avatar, not a stand-in. The Findings tab shows these
                same golems, so a visitor who signs up meets the characters
                they were shown. */}
            <PersonaPixelAvatar
              seed={persona.seed}
              shapeIndex={persona.shapeIndex}
              paletteIndex={persona.paletteIndex}
              size="sm"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {persona.name}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wide",
                persona.sentiment === "satisfied"
                  ? "border-success/40 bg-success/15 text-success"
                  : "border-warning/40 bg-warning/15 text-warning",
              )}
            >
              {persona.sentiment}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The four-column session flow: a real Sankey, not four parallel rails.
 *
 * WHAT THE FIRST VERSION GOT WRONG. It drew a band from segment `j` to segment
 * `j`, so every column had to have the same number of segments and nothing
 * could ever split, merge or cross. That is a picture of a population moving
 * in lockstep, which is the one thing a user study reliably shows is false.
 * Ozi's note was that it "does not show diverging paths enough"; it could not
 * show them at all.
 *
 * So the ribbons come from `stage.links` and are laid out properly: each is
 * stacked within its source node in link order and within its target node in
 * source order, which is what makes a crossing read as a crossing rather than
 * as a rendering artifact.
 *
 * Two liberties, both deliberate at 100x56. Columns are scaled independently,
 * so a ribbon tapers slightly when its two columns have different segment
 * counts and therefore different gap totals — at this size that reads as
 * perspective, and the alternative is unequal gaps, which reads as a bug.
 * And labels stay out of the SVG: four columns of legible text does not fit a
 * card, so the column headings carry the axis and the ribbons carry the shape.
 */
function SampleFlow({
  sample,
}: {
  sample: Extract<GatedFeatureSample, { kind: "flow" }>;
}) {
  const COLUMN_TONES = [
    "fill-success/60",
    "fill-chart-1/60",
    "fill-primary/60",
    "fill-warning/60",
  ];
  const width = 100;
  const height = 56;
  const barW = 4;
  const nodeGap = 3;
  const colGap = (width - barW) / (sample.stages.length - 1);

  // Each column is stacked independently: its gaps come out of the height
  // first, then the remainder is shared by share. A column with more segments
  // spends more on gaps, which is why ribbons taper.
  const columns = sample.stages.map((stage) => {
    const usable = height - nodeGap * (stage.nodes.length - 1);
    let y = 0;
    return stage.nodes.map((node) => {
      const h = node.share * usable;
      const top = y;
      y += h + nodeGap;
      return { top, h, usable, label: node.label };
    });
  });

  // Ribbons, with an offset kept per endpoint so two links into the same node
  // stack instead of overlapping.
  const ribbons = sample.stages.flatMap((stage, i) => {
    if (!stage.links) return [];
    const from = columns[i];
    const to = columns[i + 1];
    if (!to) return [];

    const outUsed = from.map(() => 0);
    const inUsed = to.map(() => 0);

    // Target order is by SOURCE index, so ribbons arrive in the order their
    // origins sit in the previous column. Sorting by anything else is what
    // turns a legible crossing into a tangle.
    const ordered = [...stage.links].sort((a, b) =>
      a.to === b.to ? a.from - b.from : a.to - b.to,
    );

    return ordered.flatMap((link) => {
      const src = from[link.from];
      const dst = to[link.to];
      if (!src || !dst) return [];

      const srcH = link.share * src.usable;
      const dstH = link.share * dst.usable;
      const y1 = src.top + outUsed[link.from];
      const y2 = dst.top + inUsed[link.to];
      outUsed[link.from] += srcH;
      inUsed[link.to] += dstH;

      const x1 = i * colGap + barW;
      const x2 = (i + 1) * colGap;
      const mid = (x1 + x2) / 2;

      return [
        {
          key: `${i}-${link.from}-${link.to}`,
          tone: COLUMN_TONES[i % COLUMN_TONES.length],
          d:
            `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2} ` +
            `L${x2},${y2 + dstH} C${mid},${y2 + dstH} ${mid},${y1 + srcH} ${x1},${y1 + srcH} Z`,
        },
      ];
    });
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-[8px] uppercase tracking-wide text-muted-foreground">
        {sample.stages.map((stage) => (
          <span key={stage.label}>{stage.label}</span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-20 w-full"
        preserveAspectRatio="none"
      >
        {ribbons.map((r) => (
          <path key={r.key} d={r.d} className={cn(r.tone, "opacity-30")} />
        ))}
        {columns.map((col, i) =>
          col.map((seg, j) => (
            <rect
              key={`bar-${i}-${j}`}
              x={i * colGap}
              y={seg.top}
              width={barW}
              height={seg.h}
              rx={1.5}
              className={COLUMN_TONES[i % COLUMN_TONES.length]}
            />
          )),
        )}
      </svg>
    </div>
  );
}

