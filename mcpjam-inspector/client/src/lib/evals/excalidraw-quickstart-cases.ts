import type { CreateEvalTestCaseInput } from "./generate-and-persist-tests";

const DEFAULT_MODELS: CreateEvalTestCaseInput["models"] = [
  { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
];

/**
 * Curated case payloads used by the Evaluate empty-state quickstart against
 * the Excalidraw MCP server. `suiteId` is filled in by the caller.
 *
 * Tool names and argument shapes target the public Excalidraw MCP server at
 * https://mcp.excalidraw.com/mcp. The matcher options are intentionally
 * permissive (default partial / superset semantics) so the first run lights
 * up the diff view even if the model picks slightly different arguments —
 * the goal is to showcase what an eval looks like, not to gate.
 */
export const EXCALIDRAW_QUICKSTART_CASES: Array<
  Omit<CreateEvalTestCaseInput, "suiteId">
> = [
  {
    title: "Draw a rectangle",
    query:
      "Add a single rectangle labeled \"Hello\" near the center of the canvas.",
    models: DEFAULT_MODELS,
    expectedToolCalls: [
      {
        toolName: "create_element",
        arguments: { type: "rectangle" },
      },
    ],
    runs: 1,
    isNegativeTest: false,
    scenario:
      "Smoke test: the agent should reach for the create-element tool and ask for a rectangle.",
  },
  {
    title: "Sketch a two-node flow",
    query:
      "Sketch a tiny flow: a box labeled \"Start\" with an arrow pointing to a box labeled \"End\".",
    models: DEFAULT_MODELS,
    expectedToolCalls: [
      { toolName: "create_element", arguments: { type: "rectangle" } },
      { toolName: "create_element", arguments: { type: "rectangle" } },
      { toolName: "create_element", arguments: { type: "arrow" } },
    ],
    runs: 1,
    isNegativeTest: false,
    scenario:
      "Multi-step composition: two rectangles plus an arrow. Tests that the agent fans out across several tool calls.",
  },
  {
    title: "Read the canvas",
    query: "What's currently on the canvas? Summarize what you see.",
    models: DEFAULT_MODELS,
    expectedToolCalls: [
      { toolName: "read_canvas", arguments: {} },
    ],
    runs: 1,
    isNegativeTest: false,
    scenario:
      "Read-side coverage: the agent should query canvas state before answering, not invent contents.",
  },
];
