/**
 * Every user-visible string and the step data for the How suites work
 * tutorial. Kept as plain data, apart from the components, so tests and the
 * copy pass can read and edit it in one place.
 */

export type TutorialLayerKey = "suite" | "run" | "testRun" | "iteration";
export type TutorialLayerIcon = "FolderOpen" | "Play" | "ListChecks" | "Repeat";

export interface TutorialLayer {
  key: TutorialLayerKey;
  label: string;
  icon: TutorialLayerIcon;
}

/** How much of the diagram is drawn: 1 suite, 2 + run, 3 + test runs, 4 + iterations. */
export type TutorialDepth = 1 | 2 | 3 | 4;

export interface TutorialStep {
  /** The layer lit on the spine and in the diagram; null lights none. */
  focus: TutorialLayerKey | null;
  depth: TutorialDepth;
  title: string;
  line: string;
  /** Where the layer shows up in the product; absent on the intro and outro. */
  page?: { label: string; trail: [string, string] };
}

export const TUTORIAL_LAYERS: readonly TutorialLayer[] = [
  { key: "suite", label: "Suite", icon: "FolderOpen" },
  { key: "run", label: "Suite run", icon: "Play" },
  { key: "testRun", label: "Test run", icon: "ListChecks" },
  { key: "iteration", label: "Iteration", icon: "Repeat" },
];

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    focus: null,
    depth: 4,
    title: "The whole flow",
    line: "Evals nest four layers deep. Here they are.",
  },
  {
    focus: "suite",
    depth: 1,
    title: "Suite",
    line: "Your test cases, and where they run.",
    page: { label: "Suite page", trail: ["Evaluate", "Excalidraw quickstart"] },
  },
  {
    focus: "run",
    depth: 2,
    title: "Suite run",
    line: "Press Run. Each press makes a new run.",
    page: {
      label: "Suite Run page",
      trail: ["Excalidraw quickstart", "Run #6"],
    },
  },
  {
    focus: "testRun",
    depth: 3,
    title: "Test run",
    line: "One test case inside a run. It passes, fails, or is flaky.",
    page: { label: "Test run page", trail: ["Run #6", "Draw a rectangle"] },
  },
  {
    focus: "iteration",
    depth: 4,
    title: "Iteration",
    line: "One try of a test run. Each try has its own chat and scorecard.",
    page: {
      label: "Iteration page",
      trail: ["Draw a rectangle", "Iteration #2"],
    },
  },
  {
    focus: null,
    depth: 4,
    title: "You're set",
    line: "Build a test case, then press Run.",
  },
];

/** Fixed sample content for the diagram; P = passed iteration, F = failed. */
export const TUTORIAL_SAMPLE = {
  suite: "Excalidraw quickstart",
  run: "Run #6",
  testRuns: [
    { name: "Draw a rectangle", iterations: "PPFP" },
    { name: "Sketch a two-node flow", iterations: "PPPP" },
    { name: "Draw and share a diagram", iterations: "FFPF" },
  ],
} as const;

export const TUTORIAL_COPY = {
  dialogName: "How suites work",
  spineLabel: "The flow",
  dotsLabel: "Tutorial steps",
  trailLabel: "Where you'll see it",
  possumLabel: "MCPJam possum",
  suiteTag: "Suite",
  runTag: "Suite run",
  skip: "Skip",
  back: "Back",
  next: "Next",
  start: "Walk me through it",
  buildCase: "Build a test case",
  done: "Got it",
} as const;

export function stepOfLayer(key: TutorialLayerKey): number {
  return TUTORIAL_STEPS.findIndex((step) => step.focus === key);
}

export function dotLabel(index: number): string {
  return `Step ${index + 1}: ${TUTORIAL_STEPS[index].title}`;
}
