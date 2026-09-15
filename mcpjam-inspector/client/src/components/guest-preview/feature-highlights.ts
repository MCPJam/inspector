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

/** One column of the Session flow, which reads GOAL to SENTIMENT. */
export interface SampleFlowStage {
  readonly label: string;
  /** Segments top to bottom. `share` is a fraction of the column. */
  readonly nodes: readonly { readonly label: string; readonly share: number }[];
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
  /** The headline. Sourced, never written here. */
  readonly heroTitle: string;
  /**
   * Optional supporting line, and optional on purpose: Swarms has none,
   * because its sourced headline already says the whole thing and padding it
   * out would mean inventing a second sentence.
   */
  readonly heroBody?: string;
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
    // Vig, #coreuxsquad, Sep 9: the headline from the design file, which had
    // gone missing from the tab. It replaced a line I had written, and it
    // carries the whole pitch on its own, so there is no body line under it.
    heroTitle:
      "No recruiting, no scheduling, no setup. Agents find what breaks in every client.",
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
    // Sophie, in thread: the previous line made us sound like an observability
    // platform.
    heroTitle: "Share your server with QA teams for user testing",
    // The real empty-state copy from `UserTestingOverviewPanel.tsx`.
    heroBody:
      "A study starts with a link you send. Testers open it, use your server inside the client they already know, and every session is recorded here.",
    sampleLabel: "What a study looks like",
    sample: {
      kind: "flow",
      title: "Where sessions went",
      subtitle: "Session flow",
      // The four columns the real Session flow carries, and the same visual
      // mcpjam.com already leads with for user acceptance testing. Shares are
      // illustrative but consistent across the columns, so the bands read as
      // one population moving left to right rather than four unrelated charts.
      stages: [
        {
          label: "Goal",
          nodes: [
            { label: "Export a diagram", share: 0.55 },
            { label: "Restore a save", share: 0.45 },
          ],
        },
        {
          label: "Behavior",
          nodes: [
            { label: "Clean path", share: 0.58 },
            { label: "Repeated calls", share: 0.42 },
          ],
        },
        {
          label: "Outcome",
          nodes: [
            { label: "Goal reached", share: 0.62 },
            { label: "Unresolved", share: 0.38 },
          ],
        },
        {
          label: "Sentiment",
          nodes: [
            { label: "Satisfied", share: 0.62 },
            { label: "Neutral", share: 0.38 },
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
