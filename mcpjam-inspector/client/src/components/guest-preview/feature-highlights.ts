/**
 * Every word a gated visitor reads on Swarms or User Testing (REEV-11).
 *
 * Copy lives here and layout lives in `GatedFeaturePreview.tsx`, so the words
 * can be rewritten without touching a component. This file is the one product
 * edits.
 *
 * Two rules this file is held to, both from #coreuxsquad:
 *
 *  - **No em dashes, anywhere.** Standing instruction from Vig, on the grounds
 *    that generated copy is full of them and it is our job to catch it.
 *  - **Nothing invented.** The Swarms headline is the line from the design
 *    file. The User Testing headline is Sophie's, replacing wording she
 *    flagged as making us sound like an observability platform. The sample is
 *    traced from screenshots of the running product, not designed here.
 *
 * The two audiences that reach this copy, a signed-out visitor and a signed-in
 * one whose plan lacks the feature, read the same body line. Only the way out
 * differs, and that lives with the component that renders it.
 */

/** The two surfaces a gated visitor can land on. */
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
 * would have to flatten one of them into the other's frame, which is how the
 * first draft ended up drawing charts that do not exist.
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
  readonly heroTitle: string;
  /** Read by BOTH gated screens, so it must make sense with either call to action. */
  readonly heroBody: string;
  /** Divider label above the sample. */
  readonly sampleLabel: string;
  readonly sample: GatedFeatureSample;
  /**
   * What the upsell says this plan cannot run. Sophie's wording, and
   * deliberately not `navLabel`: "run user testing swarms" reads as a thing
   * you do, where "run Swarms" reads as a tab you open.
   */
  readonly upsellNoun: string;
  /** PostHog `location` tag for every event fired from this surface. */
  readonly analyticsLocation: string;
  readonly nudge: {
    readonly title: string;
    readonly body: string;
    readonly bullets: readonly string[];
  };
}

/**
 * Shown under the sample on the signed-out screen.
 *
 * BB-120 removed faked charts from the Swarm empty state because numbers on a
 * page invite the reader to interpret them. The sample brings that risk back
 * deliberately, so the page says out loud that the figures are not theirs. A
 * member never sees the sample at all, and neither does a plan-locked reader,
 * who already knows what the product is.
 */
export const SAMPLE_DATA_NOTE =
  "A sample of what this tab looks like once it has data. The figures are illustrative, not your project's.";

export const GATED_FEATURE_COPY: Record<GatedFeatureId, GatedFeatureCopy> = {
  swarms: {
    navLabel: "Swarms",
    heroTitle: "See how your server holds up under a crowd",
    // Vig, #coreuxsquad, Sep 9: the headline from the design file, which had
    // gone missing from the tab. Not written here.
    heroBody:
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
    upsellNoun: "user testing swarms",
    analyticsLocation: "swarms_guest_preview",
    nudge: {
      title: "Create a free account to run swarms",
      body: "Swarms run on our infrastructure and spend real model credits, so they need an account behind them.",
      bullets: [
        "Run your first swarm on us, no card needed",
        "Keep every run, persona and scorecard in a project",
        "Invite teammates to read the results",
      ],
    },
  },
  "user-testing": {
    navLabel: "User Testing",
    // Sophie, in thread: the previous line made us sound like an o11y platform.
    heroTitle: "Share your server with QA teams for user testing",
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
    upsellNoun: "user testing studies",
    analyticsLocation: "user_testing_guest_preview",
    nudge: {
      title: "Create a free account to run a study",
      body: "Studies hand out live sandboxes to your testers, so they need an account to attach the sessions to.",
      bullets: [
        "Share a study link in minutes",
        "Every tester session recorded and searchable",
        "Findings roll up into one report",
      ],
    },
  },
};
