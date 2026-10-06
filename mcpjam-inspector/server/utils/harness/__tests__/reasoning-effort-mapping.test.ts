/**
 * How each adapter hands a reasoning effort to its own runtime option, and that
 * a turn with no effort builds the runtime exactly as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../claude-code-bootstrap.js", async (original) => {
  const actual = await original<typeof import("../claude-code-bootstrap.js")>();
  return {
    ...actual,
    createClaudeCodeHarness: vi.fn(actual.createClaudeCodeHarness),
  };
});
vi.mock("../codex-appserver/index.js", async (original) => {
  const actual = await original<typeof import("../codex-appserver/index.js")>();
  return {
    ...actual,
    createCodexAppServer: vi.fn(actual.createCodexAppServer),
  };
});

import { createClaudeCodeHarness } from "../claude-code-bootstrap.js";
import { createCodexAppServer } from "../codex-appserver/index.js";
import { getHarnessAdapter } from "../registry";

afterEach(() => {
  vi.clearAllMocks();
});

const mcpJson = { mcpServers: {} };

describe("Claude Code effort mapping", () => {
  const adapter = () => getHarnessAdapter("claude-code");

  it("a turn with no effort keeps thinking disabled and the effort env unset", () => {
    adapter().createHarness({
      modelId: "anthropic/claude-sonnet-4-6",
      auth: {},
      mcpJson,
    });
    const args = vi.mocked(createClaudeCodeHarness).mock.calls.at(-1)![0]!;
    expect(args.thinking).toEqual({ type: "disabled" });
    expect(args.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "unset" });
    expect("effort" in args).toBe(false);
  });

  it("an effort sets the option, adaptive thinking and the env level", () => {
    adapter().createHarness({
      modelId: "anthropic/claude-sonnet-4-6",
      auth: {},
      mcpJson,
      reasoningEffort: "high",
    });
    const args = vi.mocked(createClaudeCodeHarness).mock.calls.at(-1)![0]!;
    expect(args.effort).toBe("high");
    expect(args.thinking).toEqual({ type: "adaptive" });
    expect(args.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "high" });
  });
});

describe("Codex effort mapping", () => {
  it("passes reasoningEffort in its settings (sent as turn/start effort)", () => {
    const adapter = getHarnessAdapter("codex");
    adapter.createHarness({
      modelId: "openai/gpt-5",
      auth: {},
      reasoningEffort: "low",
    });
    expect(vi.mocked(createCodexAppServer).mock.calls.at(-1)![0]).toMatchObject(
      { reasoningEffort: "low" },
    );
    adapter.createHarness({ modelId: "openai/gpt-5", auth: {} });
    expect(
      "reasoningEffort" in
        vi.mocked(createCodexAppServer).mock.calls.at(-1)![0]!,
    ).toBe(false);
  });

  it("declares the SDK's Codex levels", () => {
    expect(getHarnessAdapter("codex").supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
