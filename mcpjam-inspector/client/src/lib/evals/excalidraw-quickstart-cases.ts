import type { CreateEvalTestCaseInput } from "./generate-and-persist-tests";

const DEFAULT_MODELS: CreateEvalTestCaseInput["models"] = [
  { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
];

/**
 * Curated case payloads used by the Evaluate empty-state quickstart against
 * the Excalidraw MCP server (https://mcp.excalidraw.com/mcp). The server
 * exposes `read_me`, `create_view`, `export_to_excalidraw`, plus checkpoint
 * helpers; drawing flows through a single `create_view` call that accepts an
 * elements array. Matchers only check tool names — arguments are left empty
 * so the first run lights up the diff view without gating on shape choices.
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
      { toolName: "read_me", arguments: {} },
      { toolName: "create_view", arguments: {} },
    ],
    runs: 1,
    isNegativeTest: false,
    scenario:
      "Smoke test: consult read_me on first use, then render with create_view.",
  },
  {
    title: "Sketch a two-node flow",
    query:
      "Sketch a tiny flow: a box labeled \"Start\" with an arrow pointing to a box labeled \"End\".",
    models: DEFAULT_MODELS,
    expectedToolCalls: [
      { toolName: "read_me", arguments: {} },
      { toolName: "create_view", arguments: {} },
    ],
    runs: 1,
    isNegativeTest: false,
    scenario:
      "Composition: multiple elements (two boxes + arrow) in a single create_view call.",
  },
  {
    title: "Draw and share a diagram",
    query:
      "Draw a quick two-step flow (\"Idea\" → \"Ship\") and give me a shareable excalidraw.com link.",
    models: DEFAULT_MODELS,
    expectedToolCalls: [
      { toolName: "read_me", arguments: {} },
      { toolName: "create_view", arguments: {} },
      { toolName: "export_to_excalidraw", arguments: {} },
    ],
    runs: 1,
    isNegativeTest: false,
    scenario:
      "Multi-tool composition: render with create_view, then publish via export_to_excalidraw.",
  },
];
