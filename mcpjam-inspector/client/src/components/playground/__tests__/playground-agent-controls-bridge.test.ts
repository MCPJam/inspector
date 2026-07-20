import { describe, expect, it } from "vitest";
import {
  getPlaygroundAgentControls,
  resolvePlaygroundModelIdentifier,
  usePlaygroundAgentControlsBridgeStore,
  type PlaygroundAgentControls,
} from "../playground-agent-controls-bridge";

const MODELS = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "gpt-4.1", name: "GPT-4.1" },
];

describe("resolvePlaygroundModelIdentifier", () => {
  it("matches by exact id first", () => {
    expect(resolvePlaygroundModelIdentifier("gpt-4.1", MODELS)).toBe(MODELS[1]);
  });

  it("falls back to a case-insensitive display-name match", () => {
    expect(resolvePlaygroundModelIdentifier("claude sonnet 5", MODELS)).toBe(
      MODELS[0],
    );
  });

  it("returns undefined for an unknown or empty identifier", () => {
    expect(resolvePlaygroundModelIdentifier("nope", MODELS)).toBeUndefined();
    expect(resolvePlaygroundModelIdentifier("   ", MODELS)).toBeUndefined();
  });
});

describe("playground agent-controls bridge store", () => {
  it("publishes and clears the live controls", () => {
    expect(getPlaygroundAgentControls()).toBeNull();

    const controls: PlaygroundAgentControls = {
      selectedModel: { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      systemPrompt: { present: false, length: 0 },
      history: { messageCount: 0, lastRole: null },
      isGenerating: false,
      selectModel: () => ({ ok: false, error: "n/a" }),
      setSystemPrompt: () => {},
      resetChat: () => {},
      stopGeneration: () => ({ stopped: false }),
    };

    usePlaygroundAgentControlsBridgeStore.getState().setControls(controls);
    expect(getPlaygroundAgentControls()).toBe(controls);

    usePlaygroundAgentControlsBridgeStore.getState().setControls(null);
    expect(getPlaygroundAgentControls()).toBeNull();
  });
});
