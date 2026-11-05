/**
 * The "How suites work" tutorial content: the four layers an eval result nests
 * through, and the six steps that walk them. Pure data so the dialog, the
 * spine and the diagram all read the same source.
 */

export type HowSuitesWorkLayer = "suite" | "run" | "testRun" | "iteration";

export interface HowSuitesWorkStep {
  /** The layer that is lit; null lights none. */
  focus: HowSuitesWorkLayer | null;
  /** How deep the diagram is drawn: suite, run, test runs, iteration dots. */
  show: 1 | 2 | 3 | 4;
  title: string;
  say: string;
  /** The page this layer has, on layer steps only. */
  page?: string;
  trail?: readonly [string, string];
}

export const HOW_SUITES_WORK_LAYERS: readonly {
  key: HowSuitesWorkLayer;
  label: string;
}[] = [
  { key: "suite", label: "Suite" },
  { key: "run", label: "Suite run" },
  { key: "testRun", label: "Test run" },
  { key: "iteration", label: "Iteration" },
];

export const HOW_SUITES_WORK_STEPS: readonly HowSuitesWorkStep[] = [
  {
    focus: null,
    show: 4,
    title: "The whole flow",
    say: "Evals nest four layers deep. Here they are.",
  },
  {
    focus: "suite",
    show: 1,
    title: "Suite",
    say: "Your test cases, and where they run.",
    page: "Suite page",
    trail: ["Evaluate", "Excalidraw quickstart"],
  },
  {
    focus: "run",
    show: 2,
    title: "Suite run",
    say: "Press Run. Each press makes a new run.",
    page: "Suite Run page",
    trail: ["Excalidraw quickstart", "Run #6"],
  },
  {
    focus: "testRun",
    show: 3,
    title: "Test run",
    say: "One test case inside a run. It passes, fails, or is flaky.",
    page: "Test run page",
    trail: ["Run #6", "Draw a rectangle"],
  },
  {
    focus: "iteration",
    show: 4,
    title: "Iteration",
    say: "One try of a test run. Each try has its own chat and scorecard.",
    page: "Iteration page",
    trail: ["Draw a rectangle", "Iteration #2"],
  },
  {
    focus: null,
    show: 4,
    title: "You're set",
    say: "Build a test case, then press Run.",
  },
];

/** The 0-based step that explains `layer`. */
export function stepOfLayer(layer: HowSuitesWorkLayer): number {
  return HOW_SUITES_WORK_STEPS.findIndex((step) => step.focus === layer);
}

/**
 * The CSS transition for one step change, or "none" when the user asked for
 * reduced motion. Every animated property shares the tutorial's easing.
 */
export function stepTransition(
  properties: readonly string[],
  reducedMotion: boolean,
  delayMs = 0,
): string {
  if (reducedMotion) return "none";
  return properties
    .map(
      (property) => `${property} 320ms cubic-bezier(.2,.8,.2,1) ${delayMs}ms`,
    )
    .join(", ");
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
