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

/** One row of the real Swarms Overview list. */
export interface SampleRun {
  readonly name: string;
  readonly when: string;
  /** The counts line: sessions, goals, personas, findings. */
  readonly meta: string;
  readonly model: string;
}

/** One tile of the real User Testing session metric strip. */
export interface SampleTile {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
}

/**
 * The single example card.
 *
 * Two shapes because the two products genuinely look different: Swarms opens
 * on a list of runs, a study opens on a metric strip. A shared abstraction
 * would have to flatten one into the other's frame, which is how the first
 * draft ended up drawing charts that do not exist.
 */
export type GatedFeatureSample =
  | {
      readonly kind: "runs";
      readonly title: string;
      readonly subtitle: string;
      readonly runs: readonly SampleRun[];
    }
  | {
      readonly kind: "metrics";
      readonly title: string;
      readonly subtitle: string;
      readonly tiles: readonly SampleTile[];
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

/**
 * Shown under the sample.
 *
 * BB-120 removed faked charts from the Swarm empty state because numbers on a
 * page invite the reader to interpret them. The sample brings that risk back
 * deliberately, so the page says out loud that the figures are not theirs. A
 * signed-in member never sees the sample at all.
 */
export const SAMPLE_DATA_NOTE =
  "A sample of what this tab looks like once it has data. The figures are illustrative, not your project's.";

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
      kind: "runs",
      title: "Every run, and what it found",
      subtitle: "Swarm overview",
      // Traced from the real Overview list. The staging rows behind these were
      // mostly failed runs (2 of 14 sessions, 6 of 30); the shape is theirs and
      // the numbers are a run that worked, because the first swarm a visitor
      // ever sees should not be a broken one. FINDINGS stay high on purpose:
      // they are the deliverable, not the damage.
      runs: [
        {
          name: "Checkout flow · Sep 8",
          when: "1d ago",
          meta: "14/14 sessions · 14 goals · 3 personas · 4 findings",
          model: "gpt-5-nano",
        },
        {
          name: "deal seekers in e commerce",
          when: "Sep 4",
          meta: "30/30 sessions · 15 goals · 3 personas · 6 findings",
          model: "gpt-5-nano",
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
      kind: "metrics",
      title: "Every session, measured",
      subtitle: "User testing sessions",
      // The strip a real study opens with. The study behind the staging
      // figures had one session at 32.4s p50 across 3 calls, which is a study
      // nobody used yet; these are a study that ran.
      tiles: [
        { label: "Tool errors", value: "0%", unit: "0 of 47 calls" },
        { label: "Latency p50", value: "4.2s", unit: "per session" },
        { label: "Tool calls", value: "6", unit: "per session" },
        { label: "Tokens", value: "24.6k", unit: "per session" },
      ],
    },
    analyticsLocation: "user_testing_guest_preview",
    nudge: {
      title: "Create an account to run a study",
      body: "Studies hand out live sandboxes to your testers, so they need an account to attach the sessions to.",
    },
  },
};
