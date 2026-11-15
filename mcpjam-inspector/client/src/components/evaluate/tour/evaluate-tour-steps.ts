/**
 * Copy and anchors for the Evaluate tour. The tour walks the eval loop in four
 * stops on example data: Setup, Experiment, Diagnose, Monitor. Each stop is a
 * mock screen (see `tour-screens-*.tsx`); `anchors` name the
 * `data-tour-anchor` elements on that screen the coachmark spotlights and
 * points at.
 */

export type TourStopId = "setup" | "experiment" | "diagnose" | "monitor";

/** Each stop has its own screen; `create` is the form the cursor fills in. */
export type TourScreen = "create" | TourStopId;

export type CoachmarkPlacement = "bottom" | "right" | "top";

export type TourStop = {
  id: TourStopId;
  label: string;
  title: string;
  body: string;
  /** Spotlighted anchors. The first one is what the coachmark points at. */
  anchors: readonly string[];
  placement: CoachmarkPlacement;
  /** What the ghost cursor clicks to reach the next stop. */
  advanceAnchor?: string;
};

export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: "setup",
    label: "Setup",
    title: "Add the tasks your users expect",
    body: "Describe it in plain words, generate cases from your server's tools, or bring a test file you already have.",
    anchors: ["setup-sources"],
    placement: "bottom",
    advanceAnchor: "setup-describe",
  },
  {
    id: "experiment",
    label: "Experiment",
    title: "Change it, then run again",
    body: "That's the loop: adjust what to evaluate, press Run, and see what changed.",
    anchors: ["experiment-prompt", "experiment-run"],
    placement: "right",
    advanceAnchor: "experiment-run",
  },
  {
    id: "diagnose",
    label: "Diagnose",
    title: "See exactly where it broke",
    body: "Every iteration is checked in 6 standard steps, from reaching your server to the user getting what they asked for. Investigate the steps where a failure occurs, then follow the fix.",
    anchors: ["diagnose-scorecard"],
    placement: "bottom",
    advanceAnchor: "diagnose-suite-crumb",
  },
  {
    id: "monitor",
    label: "Monitor",
    title: "Once you set up your suite, this is home",
    body: "Every run lands here with key takeaways. After you change your server, check that you're still passing your set threshold.",
    anchors: ["monitor-chart"],
    placement: "bottom",
  },
];

/** The name the ghost cursor types into the example create-suite form. */
export const TOUR_EXAMPLE_SUITE_NAME = "Excalidraw quickstart";

export const TOUR_INTRO_COPY = {
  titleBefore: "What does",
  titleEmphasis: "good",
  titleAfter: "look like for your MCP server?",
  body: "We built our evaluations platform to help you answer that question.",
  start: `Take the ${TOUR_STOPS.length} step tour`,
  skip: "Skip",
} as const;

export const TOUR_HANDOFF_COPY = {
  title: "Your turn",
  body: "Pick your server and the client you want to test against. The example data is gone.",
  dismiss: "Got it",
} as const;
