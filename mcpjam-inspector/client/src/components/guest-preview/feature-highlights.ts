/**
 * Every word a signed-out visitor reads on Swarms or User Testing (REEV-11).
 *
 * Copy lives here and layout lives in `GatedFeaturePreview.tsx`, so the words
 * can be rewritten without touching a component. This file is the one product
 * edits.
 *
 * ONE AUDIENCE, since the plan gate came out: signed out. Swarms and User
 * Testing are on every plan and limited by credits rather than entitlement, so
 * there is no plan-locked reader to write for and no upsell to phrase.
 *
 * Rules this file is held to:
 *
 *  - **No em dashes.** Standing instruction from Vig, on the grounds that
 *    generated copy is full of them and it is our job to catch it.
 *  - **Nothing invented, and nothing promised.** Every headline traces to a
 *    real source, named below. Earlier drafts carried lines I wrote myself and
 *    a "run your first swarm on us, no card needed" promise, which was a claim
 *    about pricing that nobody had made. Both are gone. If a line here has no
 *    source, it should not be here.
 *  - **Sample data is traced from screenshots of the running product**, not
 *    designed here. The first draft drew a wave chart and a session funnel,
 *    neither of which exists anywhere in the app.
 */

/** The two surfaces a signed-out visitor can land on. */
export type GatedFeatureId = "swarms" | "user-testing";

/** A persona row on the Findings tab, with how its sessions ended. */
export interface SampleFindingPersona {
  readonly name: string;
  /** Drives `PersonaPixelAvatar`'s procedural detail, as on the real tab. */
  readonly seed: string;
  readonly shapeIndex: number;
  readonly paletteIndex: number;
  readonly sentiment: "satisfied" | "uneasy";
}

/** One band in a column. `share` is a fraction of the whole population. */
export interface SampleFlowNode {
  readonly label: string;
  readonly share: number;
}

/**
 * A ribbon from one node in this stage to one in the next.
 *
 * THIS IS THE WHOLE POINT OF THE CARD, and the first version did not have it.
 * That version drew a band from segment `j` to segment `j`, which is four
 * parallel rails: nothing splits, nothing crosses, and the picture claims the
 * population moves in lockstep. A study is worth running precisely because it
 * does not. Ozi caught it.
 */
export interface SampleFlowLink {
  /** Index into this stage's `nodes`. */
  readonly from: number;
  /** Index into the NEXT stage's `nodes`. */
  readonly to: number;
  readonly share: number;
}

/** One column of the Session flow, which reads GOAL to SENTIMENT. */
export interface SampleFlowStage {
  readonly label: string;
  /** Segments top to bottom. */
  readonly nodes: readonly SampleFlowNode[];
  /**
   * Where this column's population goes next. Omitted on the last stage.
   *
   * Shares are conserved: every node's `share` equals the sum of the links
   * arriving at it, and of those leaving it. `SampleFlow` does not repair a
   * set that does not add up, it just draws it wrong, so the arithmetic is
   * pinned by a test.
   */
  readonly links?: readonly SampleFlowLink[];
}

/**
 * The single example card.
 *
 * Two shapes because the two products lead with different screens. Swarms
 * opens its Findings tab on personas and how their sessions ended; a study
 * leads with the session flow, which is also the visual mcpjam.com uses for
 * user acceptance testing. A shared abstraction would flatten one into the
 * other, which is how the first draft ended up drawing charts that do not
 * exist.
 */
export type GatedFeatureSample =
  | {
      readonly kind: "findings";
      readonly title: string;
      readonly subtitle: string;
      /** The one-line verdict the real Findings tab leads with. */
      readonly summary: string;
      readonly personas: readonly SampleFindingPersona[];
    }
  | {
      readonly kind: "flow";
      readonly title: string;
      readonly subtitle: string;
      readonly stages: readonly SampleFlowStage[];
    };

export interface GatedFeatureCopy {
  /** Sidebar and tab wording. Swarms' own h1 is the singular "Swarm". */
  readonly navLabel: string;
  /**
   * NO HEADLINE OR BODY LIVE HERE ANY MORE.
   *
   * They used to, and they drifted from the product inside a single
   * iteration: the User Testing body became a paraphrase that changed three
   * words, and the Swarms body vanished without failing a test. The preview
   * now renders `SwarmsEmptyHero` and `UserTestingEmptyState` directly, so a
   * signed-out visitor and a signed-in member read the same graphic, heading
   * and sentence by construction. Change that copy where it ships, in those
   * two components.
   */
  /** Divider label above the sample. */
  readonly sampleLabel: string;
  readonly sample: GatedFeatureSample;
  /** PostHog `location` tag for every event fired from this surface. */
  readonly analyticsLocation: string;
  readonly nudge: {
    readonly title: string;
    readonly body: string;
  };
}

export const GATED_FEATURE_COPY: Record<GatedFeatureId, GatedFeatureCopy> = {
  swarms: {
    navLabel: "Swarms",
    sampleLabel: "What a swarm looks like",
    sample: {
      kind: "findings",
      title: "Who struggled, and where",
      subtitle: "Findings",
      // The real Findings tab leads with exactly this: a one-line verdict over
      // the run, then the personas underneath with how their sessions ended.
      //
      // Not every persona is satisfied, on purpose. A swarm where everyone
      // sailed through has found nothing, and finding something is the product.
      // The staging run this is traced from read "14 of 14 goals showed
      // friction", which is the same screen having a bad day.
      summary: "12 of 14 goals completed. One persona got stuck.",
      personas: [
        {
          name: "MCP Tool Contract Tester",
          seed: "sample-contract-tester",
          shapeIndex: 0,
          paletteIndex: 1,
          sentiment: "satisfied",
        },
        {
          name: "One-off Explainer Doodler",
          seed: "sample-explainer-doodler",
          shapeIndex: 1,
          paletteIndex: 5,
          sentiment: "satisfied",
        },
        {
          name: "RFE Author Sketching a Flow",
          seed: "sample-rfe-author",
          shapeIndex: 4,
          paletteIndex: 2,
          sentiment: "uneasy",
        },
      ],
    },
    analyticsLocation: "swarms_guest_preview",
    nudge: {
      title: "Create an account to run swarms",
      // What is true and checkable: swarms run on our infrastructure and spend
      // model credits, which is why they need an account. No claim about what
      // that costs, and no free-run offer.
      body: "Swarms run on our infrastructure and spend model credits, so they need an account behind them.",
    },
  },
  "user-testing": {
    navLabel: "User Testing",
    sampleLabel: "What a study looks like",
    sample: {
      kind: "flow",
      title: "Where sessions went",
      subtitle: "Session flow",
      // The four columns the real Session flow carries, and the same visual
      // mcpjam.com already leads with for user acceptance testing.
      //
      // THE SHAPE IS THE MESSAGE. One goal splits three ways at BEHAVIOR, and
      // the two goals land in different proportions, so the picture says what
      // a study is for: the same task is not one path, and the branch that
      // matters is usually the small one. A card where everything runs
      // straight across would be advertising a report nobody needs to read.
      //
      // The ribbon worth finding is `O0 -> S1` (0.05): sessions that REACHED
      // the goal and were still frustrated. It is the smallest band on the
      // card and the one a researcher would click first, which is the honest
      // pitch for the product.
      //
      // Healthy but not fictional, per Ozi's earlier note: 71% reach the goal,
      // 66% come away satisfied. A study with no failures would mean the
      // method found nothing.
      stages: [
        {
          label: "Goal",
          nodes: [
            { label: "Export a diagram", share: 0.55 },
            { label: "Restore a save", share: 0.45 },
          ],
          links: [
            { from: 0, to: 0, share: 0.38 },
            { from: 0, to: 1, share: 0.13 },
            { from: 0, to: 2, share: 0.04 },
            { from: 1, to: 0, share: 0.14 },
            { from: 1, to: 1, share: 0.17 },
            { from: 1, to: 2, share: 0.14 },
          ],
        },
        {
          label: "Behavior",
          nodes: [
            { label: "Found the tool", share: 0.52 },
            { label: "Retried the same call", share: 0.3 },
            { label: "Never found it", share: 0.18 },
          ],
          links: [
            { from: 0, to: 0, share: 0.52 },
            { from: 1, to: 0, share: 0.19 },
            { from: 1, to: 1, share: 0.11 },
            { from: 2, to: 1, share: 0.18 },
          ],
        },
        {
          label: "Outcome",
          nodes: [
            { label: "Goal reached", share: 0.71 },
            { label: "Unresolved", share: 0.29 },
          ],
          links: [
            { from: 0, to: 0, share: 0.66 },
            // Reached the goal, still unhappy. The band this card exists for.
            { from: 0, to: 1, share: 0.05 },
            { from: 1, to: 1, share: 0.29 },
          ],
        },
        {
          label: "Sentiment",
          nodes: [
            { label: "Satisfied", share: 0.66 },
            { label: "Frustrated", share: 0.34 },
          ],
        },
      ],
    },
    analyticsLocation: "user_testing_guest_preview",
    nudge: {
      title: "Create an account to run a study",
      body: "Studies hand out live sandboxes to your testers, so they need an account to attach the sessions to.",
    },
  },
};
