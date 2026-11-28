/**
 * Example data the tour's mock screens show. It is never written anywhere:
 * the tour is a walkthrough, and the handoff tells the user it is gone.
 */
import { TOUR_EXAMPLE_SUITE_NAME } from "./evaluate-tour-steps";

export const EXAMPLE_SUITE = {
  name: TOUR_EXAMPLE_SUITE_NAME,
  server: "Excalidraw",
  client: "ChatGPT",
  model: "GPT-5 nano",
} as const;

export const EXAMPLE_CASE = {
  title: "Draw and share a diagram",
  prompt:
    'Draw a quick two-step flow ("Idea" → "Ship") and give me a shareable excalidraw.com link.',
  assertions: [
    { kind: "tool", label: "Tool was called with:", value: "read_me" },
    { kind: "tool", label: "Tool was called with:", value: "create_view" },
    {
      kind: "tool",
      label: "Tool was called with:",
      value: "export_to_excalidraw",
    },
    { kind: "response", label: "Response contains:", value: "excalidraw.com" },
  ],
  interaction: { action: "click share-link", view: "create_view" },
  expectedOutcome:
    "A two-step Idea to Ship diagram, and a working excalidraw.com link to share it.",
} as const;

export type ExampleStageStatus = "passed" | "failed" | "skipped";

export const EXAMPLE_ITERATION = {
  runNumber: 6,
  iteration: 2,
  runId: "mtk2nv0s",
  model: "Claude Haiku 4.5",
  ago: "2 min ago",
  tabs: ["Scorecard", "Chat", "Tool Calls", "Trace", "Steps", "Replay", "Raw"],
  stages: [
    { id: "01", label: "Connection", status: "passed" },
    { id: "02", label: "Discovery", status: "passed" },
    { id: "03", label: "Selection", status: "failed" },
    { id: "04", label: "Tool call", status: "passed" },
    { id: "05", label: "Response", status: "passed" },
    { id: "06", label: "User value", status: "skipped" },
  ] satisfies { id: string; label: string; status: ExampleStageStatus }[],
  failure: {
    stage: "Selection",
    question: "Did the model choose the right tool for the request?",
    check: "Reach read_me, create_view",
    expected: "Reach read_me, create_view",
    actual: "read_me was never called.",
    fix: {
      tool: "create_view",
      before: "The",
      after:
        "description doesn't say to call read_me first. Add that line, so clients load the element format before they draw.",
    },
  },
} as const;

export type ExampleRun = {
  number: number;
  client: string;
  model: string;
  passed: number;
  total: number;
  date: string;
  time: string;
  latency: string;
};

/** Oldest first; the chart reads left to right, the table newest first. */
export const EXAMPLE_RUNS: readonly ExampleRun[] = [
  run(1, "GPT-5 Mini", 5, "Oct 14", "9:40 AM", "13.1s"),
  run(2, "GPT-5 Mini", 9, "Oct 16", "4:18 PM", "12.9s"),
  run(3, "Claude Haiku 4.5", 11, "Oct 20", "10:05 AM", "9.71s"),
  run(4, "GPT-5 Mini", 10, "Oct 22", "3:27 PM", "12.6s"),
  run(5, "Claude Haiku 4.5", 11, "Oct 24", "11:03 AM", "9.12s"),
  run(6, "Claude Haiku 4.5", 8, "Oct 27", "2:12 PM", "9.84s"),
];

function run(
  number: number,
  model: string,
  passed: number,
  date: string,
  time: string,
  latency: string,
): ExampleRun {
  return {
    number,
    client: "MCPJam",
    model,
    passed,
    total: 12,
    date,
    time,
    latency,
  };
}

/** The pass threshold the example suite holds runs to. */
export const EXAMPLE_THRESHOLD = 70;

export function passRate(run: ExampleRun): number {
  return Math.round((run.passed / run.total) * 100);
}

export function averagePassRate(runs: readonly ExampleRun[]): number {
  if (runs.length === 0) return 0;
  const sum = runs.reduce(
    (total, entry) => total + entry.passed / entry.total,
    0,
  );
  return Math.round((sum / runs.length) * 100);
}
