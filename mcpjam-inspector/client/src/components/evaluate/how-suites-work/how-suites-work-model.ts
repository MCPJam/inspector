/**
 * Content and trigger rules for the "How suites work" tutorial: six steps
 * that walk the four eval layers (Suite, Suite run, Test run, Iteration).
 * It opens by itself once per browser, on the first visit to Evaluate or on
 * the first suite created, and from the Evaluate ⋮ menu at any time.
 */

export type HowSuitesWorkLayer = "suite" | "suiteRun" | "testRun" | "iteration";

export interface HowSuitesWorkStep {
  /** The layer lit in the spine and the diagram; null lights them all. */
  focus: HowSuitesWorkLayer | null;
  /** How many layers deep the diagram is drawn, 1 to 4. */
  depth: 1 | 2 | 3 | 4;
  title: string;
  body: string;
  /** Where in the product the layer lives, with a sample breadcrumb. */
  page?: { label: string; trail: readonly string[] };
}

export const HOW_SUITES_WORK_LAYERS: ReadonlyArray<{
  key: HowSuitesWorkLayer;
  label: string;
}> = [
  { key: "suite", label: "Suite" },
  { key: "suiteRun", label: "Suite run" },
  { key: "testRun", label: "Test run" },
  { key: "iteration", label: "Iteration" },
];

export const HOW_SUITES_WORK_STEPS: readonly HowSuitesWorkStep[] = [
  {
    focus: null,
    depth: 4,
    title: "The whole flow",
    body: "Evals nest four layers deep. Here they are.",
  },
  {
    focus: "suite",
    depth: 1,
    title: "Suite",
    body: "Your test cases, and where they run.",
    page: { label: "Suite page", trail: ["Evaluate", "Excalidraw quickstart"] },
  },
  {
    focus: "suiteRun",
    depth: 2,
    title: "Suite run",
    body: "Press Run. Each press makes a new run.",
    page: {
      label: "Suite run page",
      trail: ["Excalidraw quickstart", "Run #6"],
    },
  },
  {
    focus: "testRun",
    depth: 3,
    title: "Test run",
    body: "One test case inside a run. It passes, fails, or is flaky.",
    page: { label: "Test run page", trail: ["Run #6", "Draw a rectangle"] },
  },
  {
    focus: "iteration",
    depth: 4,
    title: "Iteration",
    body: "One try of a test run. Each try has its own chat and scorecard.",
    page: {
      label: "Iteration page",
      trail: ["Draw a rectangle", "Iteration #2"],
    },
  },
  {
    focus: null,
    depth: 4,
    title: "You're set",
    body: "Build a test case, then press Run.",
  },
];

export const HOW_SUITES_WORK_LAST_STEP = HOW_SUITES_WORK_STEPS.length - 1;

export function stepOfLayer(layer: HowSuitesWorkLayer): number {
  return HOW_SUITES_WORK_STEPS.findIndex((step) => step.focus === layer);
}

/** A layer is drawn as reached when the step lights it or one after it. */
export function isLayerReached(step: number, layer: HowSuitesWorkLayer) {
  const focus = HOW_SUITES_WORK_STEPS[step]?.focus ?? null;
  if (focus === null) return true;
  const order = HOW_SUITES_WORK_LAYERS.map((entry) => entry.key);
  return order.indexOf(layer) <= order.indexOf(focus);
}

export function clampStep(step: number): number {
  return Math.min(HOW_SUITES_WORK_LAST_STEP, Math.max(0, step));
}

export type HowSuitesWorkTrigger = "first_visit" | "first_suite" | "menu";
export type HowSuitesWorkAutoTrigger = Exclude<HowSuitesWorkTrigger, "menu">;

export const HOW_SUITES_WORK_SEEN_KEY = "mcpjam:evals-how-suites-work-seen";

export function hasSeenHowSuitesWork(): boolean {
  try {
    return localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY) === "1";
  } catch {
    // Blocked storage reads as seen so the tutorial never reopens on every visit.
    return true;
  }
}

export function markHowSuitesWorkSeen(): void {
  try {
    localStorage.setItem(HOW_SUITES_WORK_SEEN_KEY, "1");
  } catch {
    // Blocked storage only means the seen mark is not kept; the ⋮ menu still opens it.
  }
}

export type HowSuitesWorkEventName =
  | "eval_tutorial_shown"
  | "eval_tutorial_completed"
  | "eval_tutorial_dismissed";

export interface HowSuitesWorkEventProps {
  trigger: HowSuitesWorkTrigger;
  /** The step on screen, counted from 1. */
  step: number;
}

export type HowSuitesWorkEventReporter = (
  event: HowSuitesWorkEventName,
  props: HowSuitesWorkEventProps,
) => void;

/** Closing on the last step counts as finishing; closing earlier is a dismissal. */
export function closeEventName(step: number): HowSuitesWorkEventName {
  return step >= HOW_SUITES_WORK_LAST_STEP
    ? "eval_tutorial_completed"
    : "eval_tutorial_dismissed";
}
