/**
 * Copy and anchors for the Evaluate tour. The tour walks the eval loop in five
 * stops on example data: Setup, Run, Diagnose, Experiment, Monitor. Each stop
 * shows a mock screen (see `tour-screens-*.tsx`); `anchors` name the
 * `data-tour-anchor` elements on that screen the coachmark spotlights and
 * points at.
 */

export type TourStopId =
  "setup" | "run" | "diagnose" | "experiment" | "monitor";

/** The mock screens. `create` is the form the cursor fills in first. */
export type TourScreen = "create" | "setup" | "case" | "diagnose" | "monitor";

export type CoachmarkPlacement = "bottom" | "right" | "top";

export type TourStop = {
  id: TourStopId;
  label: string;
  title: string;
  body: string;
  screen: TourScreen;
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
    screen: "setup",
    anchors: ["setup-sources"],
    placement: "bottom",
    advanceAnchor: "setup-describe",
  },
  {
    id: "run",
    label: "Run",
    title: "Run prompts the same way your users would",
    body: "Write what a user would ask and the outcome you expect. Press Run to see what happens.",
    screen: "case",
    anchors: ["case-outcome"],
    placement: "right",
    advanceAnchor: "case-run",
  },
  {
    id: "diagnose",
    label: "Diagnose",
    title: "See exactly where it broke",
    body: "Each iteration is checked in 6 steps. Open the one that failed to see what to fix in your server.",
    screen: "diagnose",
    anchors: ["diagnose-scorecard"],
    placement: "bottom",
    advanceAnchor: "diagnose-case-crumb",
  },
  {
    id: "experiment",
    label: "Experiment",
    title: "Change one thing, then run again",
    body: "Edit the prompt, the expected outcome or your server, then run again and compare.",
    screen: "case",
    anchors: ["case-prompt", "case-run"],
    placement: "right",
    advanceAnchor: "case-suite-crumb",
  },
  {
    id: "monitor",
    label: "Monitor",
    title: "Once you set up your suite, this is home",
    body: "Every run lands here with key takeaways. After you change your server, check that you're still passing your set threshold.",
    screen: "monitor",
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
