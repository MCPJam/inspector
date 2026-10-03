import { swarmsCreatePath, userTestingCreatePath } from "@/lib/app-navigation";

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
  /** The single button on the preview that opens the nudge. */
  readonly ctaLabel: string;
  /** Where sign-in/up returns to: the creation flow the visitor asked for. */
  readonly createPath: string;
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
    ctaLabel: "Create new swarm",
    createPath: swarmsCreatePath,
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
      title: "Create an account to run your first swarm",
      // Sells what the run teaches, not why we need the account. Still no
      // claim about what it costs, and no free-run offer.
      body: "Test your MCP server with agent personas pursuing different user goals. See where they succeed, where they get stuck, and what to improve.",
    },
  },
  "user-testing": {
    navLabel: "User Testing",
    ctaLabel: "Create new study",
    createPath: userTestingCreatePath,
    sampleLabel: "What a study looks like",
    sample: {
      kind: "flow",
      title: "Where sessions went",
      subtitle: "Session flow",
      // Traced from the Session flow on mcpjam.com's user-acceptance-testing
      // panel, which Ozi handed over as the sample to match. Its taxonomy, in
      // its order: two goals, three behaviors, three outcomes, four sentiments.
      //
      // THE NODE COUNTS ARE DOING THE WORK. The previous version had 2/3/2/2
      // and read as a solid block, because two nodes in a column means two fat
      // bars with one gap between them and nowhere for a ribbon to separate.
      // The reference spreads 2/3/3/4 over the same height, so every ribbon
      // gets its own lane. That is why this is wider taxonomy rather than just
      // more padding.
      //
      // Healthy but honest, per Ozi's earlier note: 68% reach the goal and 58%
      // come away satisfied. The band worth finding is `Goal reached ->
      // Neutral` at 10%, sessions that succeeded and felt nothing, which is the
      // kind of thing only a study surfaces.
      stages: [
        {
          label: "Goal",
          nodes: [
            { label: "Refund duplicate", share: 0.44 },
            { label: "Reconcile payout", share: 0.56 },
          ],
          links: [
            { from: 0, to: 0, share: 0.16 },
            { from: 0, to: 1, share: 0.08 },
            { from: 0, to: 2, share: 0.2 },
            { from: 1, to: 0, share: 0.1 },
            { from: 1, to: 1, share: 0.08 },
            { from: 1, to: 2, share: 0.38 },
          ],
        },
        {
          label: "Behavior",
          nodes: [
            { label: "Repeated calls", share: 0.26 },
            { label: "Guessed ID", share: 0.16 },
            { label: "Clean path", share: 0.58 },
          ],
          links: [
            { from: 0, to: 0, share: 0.14 },
            { from: 0, to: 1, share: 0.09 },
            { from: 0, to: 2, share: 0.03 },
            { from: 1, to: 0, share: 0.04 },
            { from: 1, to: 1, share: 0.04 },
            { from: 1, to: 2, share: 0.08 },
            { from: 2, to: 0, share: 0.5 },
            { from: 2, to: 1, share: 0.08 },
          ],
        },
        {
          label: "Outcome",
          nodes: [
            { label: "Goal reached", share: 0.68 },
            { label: "Unresolved", share: 0.21 },
            { label: "Wrong action", share: 0.11 },
          ],
          links: [
            { from: 0, to: 0, share: 0.58 },
            // Reached the goal and felt nothing. The band this card is for.
            { from: 0, to: 1, share: 0.1 },
            { from: 1, to: 1, share: 0.07 },
            { from: 1, to: 2, share: 0.1 },
            { from: 1, to: 3, share: 0.04 },
            { from: 2, to: 2, share: 0.05 },
            { from: 2, to: 3, share: 0.06 },
          ],
        },
        {
          label: "Sentiment",
          nodes: [
            { label: "Satisfied", share: 0.58 },
            { label: "Neutral", share: 0.17 },
            { label: "Frustrated", share: 0.15 },
            { label: "Gave up", share: 0.1 },
          ],
        },
      ],
    },
    analyticsLocation: "user_testing_guest_preview",
    nudge: {
      title: "Create an account to run your first study",
      body: "See how real users interact with your MCP server. Find out where they succeed, where they get stuck, and what to improve.",
    },
  },
};
