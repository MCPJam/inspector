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
import { SwarmsEmptyHero } from "@/components/swarms/swarms-empty-hero";
import { UserTestingEmptyState } from "@/components/scenarios/UserTestingOverviewPanel";
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
      {/* THE REAL EMPTY STATE, not a restatement of it (Ozi).
          Graphic, heading and body are identical for a signed-out visitor and
          a signed-in member, because both are looking at the same empty tab.
          Only the control differs, which is the `action` slot. */}
      <FeatureHero feature={feature}>
        <div className="flex flex-col items-center gap-2">{children}</div>
      </FeatureHero>

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
 * The feature's own empty state, rendered with the sign-up CTA in place of
 * its create button.
 *
 * WHY THE COMPONENT AND NOT THE WORDS. The previous version kept a `heroTitle`
 * and `heroBody` in `feature-highlights.ts`, and they drifted from the product
 * inside one iteration: the User Testing body came out as a paraphrase that
 * silently changed three words, and the Swarms body went missing entirely
 * without failing a test. Importing the component makes both impossible —
 * there is only one copy of each sentence, and it is the one that ships to
 * members.
 */
function FeatureHero({
  feature,
  children,
}: {
  feature: GatedFeatureId;
  children: ReactNode;
}) {
  if (feature === "swarms") {
    // `onNewSwarm` is required by the props but unreachable: `action` replaces
    // the button that would call it.
    return <SwarmsEmptyHero onNewSwarm={() => {}} action={children} />;
  }
  return <UserTestingEmptyState action={children} />;
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
  // One hue per column, and they have to be TELLABLE APART or the gaps between
  // them read as one block. Two attempts got this wrong on the way here, both
  // worth recording because the failure is invisible in the source:
  //
  //  1. `chart-1` then `primary` — both salmon in the shipped theme, so
  //     BEHAVIOR and OUTCOME merged into one pink field.
  //  2. `chart-3`, picked from `design-system/src/index.css` where it is a
  //     strong blue. The ACTIVE theme overrides it to `oklch(0.8816 0.0276
  //     93.128)`, a near-white cream, and the column disappeared against the
  //     card.
  //
  // So: `chart-N` is a per-theme palette slot and says nothing about the hue
  // you will get. The semantic tokens do — `success`, `info` and `warning` are
  // green, blue and amber in every preset because that is what they mean.
  // Nothing here is claiming a column is a success or a warning; they are the
  // tokens with a guaranteed hue, which is the property this needs.
  const COLUMN_TONES = [
    "fill-success/60",
    "fill-chart-1/60",
    "fill-info/60",
    "fill-warning/60",
  ];
  // Geometry tuned against the rendered card, not in the abstract. The SVG is
  // stretched to the card's width (`preserveAspectRatio="none"`), so a viewBox
  // unit is about 5x wider than it is tall: at the first draft's 100x56 in an
  // `h-20` box the bezier S-curves flattened into straight bars and only the
  // first gap read as a split. Taller box, taller viewBox relative to width,
  // and a narrower bar so the ribbons get the space instead.
  // SEPARATION IS THE POINT, so the gaps are generous rather than tidy. At
  // `nodeGap` 3.5 the bands butted against each other and the card read as one
  // block; the reference on mcpjam.com spends roughly a third of its height on
  // whitespace between nodes, and that is what gives each ribbon its own lane.
  const width = 100;
  const height = 120;
  const barW = 2;
  const nodeGap = 11;
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
      {/* Each label sits over its own bar. `justify-between` put BEHAVIOR and
          OUTCOME at even thirds while their bars are at 34% and 66%, which
          reads as a misalignment rather than as a label row. */}
      <div className="relative h-3 text-[8px] uppercase tracking-wide text-muted-foreground">
        {sample.stages.map((stage, i) => (
          <span
            key={stage.label}
            className={cn(
              "absolute top-0 whitespace-nowrap",
              i === 0 && "left-0",
              i === sample.stages.length - 1 && "right-0",
            )}
            style={
              i === 0 || i === sample.stages.length - 1
                ? undefined
                : {
                    left: `${i * ((100 - barW) / (sample.stages.length - 1))}%`,
                    transform: "translateX(-50%)",
                  }
            }
          >
            {stage.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-48 w-full"
        preserveAspectRatio="none"
      >
        {ribbons.map((r) => (
          <path key={r.key} d={r.d} className={cn(r.tone, "opacity-40")} />
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

