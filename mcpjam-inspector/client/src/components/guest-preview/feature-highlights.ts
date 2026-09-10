/**
 * Every word a gated visitor reads on Swarms or User Testing (REEV-11).
 *
 * Copy lives here and layout lives in `GatedFeaturePreview.tsx`, so the words
 * can be rewritten without touching a component — this file is the one product
 * edits. The card entries are titles only: the little graphic under each one is
 * static and belongs to the layout, because it is a shape, not a sentence.
 *
 * The nudge copy sits here too rather than inside the dialog, so a reader
 * comparing what the preview promises with what the sign-up sheet claims sees
 * both at once. Two files would let them drift.
 *
 * The two audiences that reach this copy — a signed-out guest and a signed-in
 * user whose plan lacks the feature — read the SAME hero and cards. Only the
 * call to action differs, and that is passed into the component rather than
 * stored here. So nothing in this file may assume the reader lacks an account.
 */

/** The two surfaces a gated visitor can land on. Evaluate is deliberately not
 *  one of them: it is reachable by everyone and has no gated state. */
export type GatedFeatureId = "swarms" | "user-testing";

export interface GatedFeatureHighlightCard {
  /** Card heading — what the panel would show on a real project. */
  readonly title: string;
  /** The small uppercase line under it: units, scope, or scale. */
  readonly subtitle: string;
}

export interface GatedFeatureCopy {
  /** Sidebar/tab wording. Note Swarms' own h1 is the singular "Swarm". */
  readonly navLabel: string;
  readonly heroTitle: string;
  readonly heroBody: string;
  /** Divider label above the example cards. */
  readonly cardsLabel: string;
  /** Exactly three — the grid is a three-column layout at every breakpoint
   *  that fits it, and a fourth would wrap alone onto a second row. */
  readonly cards: readonly [
    GatedFeatureHighlightCard,
    GatedFeatureHighlightCard,
    GatedFeatureHighlightCard,
  ];
  /** PostHog `location` tag for every event fired from this surface. */
  readonly analyticsLocation: string;
  readonly nudge: {
    readonly title: string;
    readonly body: string;
    readonly bullets: readonly string[];
  };
}

/**
 * Shown under the example cards on every gated screen.
 *
 * BB-120 removed faked charts from the Swarm empty state because numbers on a
 * page invite the reader to interpret them. These cards bring that risk back
 * deliberately — a visitor with no data needs to see what the feature produces
 * — so the page says out loud that the figures are illustrative. A member never
 * sees these cards or this line; they get the real empty state.
 */
export const SAMPLE_DATA_NOTE =
  "Sample of what this tab looks like once it has data. Illustrative figures — not your project's, and not exactly this layout.";

export const GATED_FEATURE_COPY: Record<GatedFeatureId, GatedFeatureCopy> = {
  swarms: {
    navLabel: "Swarms",
    heroTitle: "See how your server holds up under a crowd",
    // Extends `FIRST_SWARM_EMPTY_DESCRIPTION` in swarms-empty-hero.tsx — same
    // claim, with the clients named, because a visitor who has never run one
    // does not yet know what "the clients your users actually use" means.
    heroBody:
      "A swarm is dozens of synthetic users with different goals, run against your MCP server across Claude, ChatGPT, Cursor and more. You get a scorecard, not a log.",
    cardsLabel: "What a swarm looks like",
    cards: [
      { title: "Goal completion", subtitle: "40 personas · 7 waves" },
      { title: "Where it breaks, by client", subtitle: "Goal × host" },
      { title: "One persona's session", subtitle: "Steps + latency" },
    ],
    analyticsLocation: "swarms_guest_preview",
    nudge: {
      title: "Create a free account to run swarms",
      body: "Swarms run on our infrastructure and spend real model credits, so they need an account behind them.",
      bullets: [
        "Run your first swarm on us — no card needed",
        "Keep every run, persona and scorecard in a project",
        "Invite teammates to read the results",
      ],
    },
  },
  "user-testing": {
    navLabel: "User Testing",
    heroTitle: "Watch real people use your server",
    heroBody:
      "Share one link. Testers chat with your server in a hosted sandbox; you get every session, where they got stuck, and what they said about it.",
    cardsLabel: "What a study looks like",
    cards: [
      { title: "Testers", subtitle: "1 link · 12 sessions" },
      { title: "Where they got stuck", subtitle: "Session funnel" },
      { title: "What they said", subtitle: "Exit question" },
    ],
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
