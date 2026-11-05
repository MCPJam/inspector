/**
 * "How suites work" tutorial: steps, trigger rules and the seen flag.
 *
 * The tutorial opens on its own once per browser (first Evaluate visit or
 * first suite created) and always from the Evaluate ⋮ menu.
 */

export type HowSuitesWorkTrigger = "first_visit" | "first_suite" | "menu";

export type HowSuitesWorkLayer = "suite" | "suiteRun" | "testRun" | "iteration";

export interface HowSuitesWorkStep {
  /** The layer this step lights up; null for the overview and closing steps. */
  focus: HowSuitesWorkLayer | null;
  title: string;
  say: string;
  /** Where the layer lives in the app, shown as a sample breadcrumb. */
  page?: { name: string; trail: readonly string[] };
}

export const HOW_SUITES_WORK_LAYERS: readonly {
  key: HowSuitesWorkLayer;
  label: string;
}[] = [
  { key: "suite", label: "Suite" },
  { key: "suiteRun", label: "Suite run" },
  { key: "testRun", label: "Test run" },
  { key: "iteration", label: "Iteration" },
];

export const HOW_SUITES_WORK_STEPS: readonly HowSuitesWorkStep[] = [
  {
    focus: null,
    title: "The whole flow",
    say: "Evals nest four layers deep. Here they are.",
  },
  {
    focus: "suite",
    title: "Suite",
    say: "Your test cases, and where they run.",
    page: { name: "Suite page", trail: ["Evaluate", "Excalidraw quickstart"] },
  },
  {
    focus: "suiteRun",
    title: "Suite run",
    say: "Press Run. Each press makes a new run.",
    page: {
      name: "Suite run page",
      trail: ["Excalidraw quickstart", "Run #6"],
    },
  },
  {
    focus: "testRun",
    title: "Test run",
    say: "One test case inside a run. It passes, fails, or is flaky.",
    page: { name: "Test run page", trail: ["Run #6", "Draw a rectangle"] },
  },
  {
    focus: "iteration",
    title: "Iteration",
    say: "One try of a test run. Each try has its own chat and scorecard.",
    page: {
      name: "Iteration page",
      trail: ["Draw a rectangle", "Iteration #2"],
    },
  },
  {
    focus: null,
    title: "You're set",
    say: "Build a test case, then press Run.",
  },
];

export const HOW_SUITES_WORK_LAST_STEP = HOW_SUITES_WORK_STEPS.length - 1;

export function clampStep(step: number): number {
  return Math.min(HOW_SUITES_WORK_LAST_STEP, Math.max(0, step));
}

/** Menu opens always show; automatic triggers show only until seen. */
export function shouldShowHowSuitesWork(
  trigger: HowSuitesWorkTrigger,
  seen: boolean,
): boolean {
  return trigger === "menu" || !seen;
}

export const HOW_SUITES_WORK_SEEN_KEY = "mcpjam:eval-tutorial-seen:v1";

/** Reads the seen flag; unreadable storage counts as not seen. */
export function readHowSuitesWorkSeen(): boolean {
  try {
    return window.localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY) === "1";
  } catch {
    // Storage disabled or blocked: treat as unseen so the tutorial can show.
    return false;
  }
}

export function markHowSuitesWorkSeen(): void {
  try {
    window.localStorage.setItem(HOW_SUITES_WORK_SEEN_KEY, "1");
  } catch {
    // Storage disabled or full: the tutorial may show again next visit.
  }
}
