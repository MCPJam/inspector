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
    expect(args.env).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-sonnet-4-6",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_EFFORT_LEVEL: "unset",
    });
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
    expect(args.env).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-sonnet-4-6",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
    });
  });

  describe("the models Claude Code picks for itself", () => {
    // Plan mode switches to the `sonnet` alias, background work and the
    // Explore subagent use `haiku`; the lease admits only the turn's model.
    const envFor = (modelId: string) => {
      adapter().createHarness({ modelId, auth: {}, mcpJson });
      return vi.mocked(createClaudeCodeHarness).mock.calls.at(-1)![0]!.env!;
    };
    const pins = (env: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(env).filter(([key]) =>
          key.startsWith("ANTHROPIC_DEFAULT_"),
        ),
      );

    it("a Haiku turn pins sonnet and opus to itself, and leaves its own alias alone", () => {
      expect(pins(envFor("anthropic/claude-haiku-4.5"))).toEqual({
        ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-haiku-4.5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-haiku-4.5",
      });
    });

    it("a Sonnet turn pins haiku and opus", () => {
      expect(pins(envFor("anthropic/claude-sonnet-4.6"))).toEqual({
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-sonnet-4.6",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-sonnet-4.6",
      });
    });

    it("an Opus turn pins haiku and sonnet", () => {
      expect(pins(envFor("anthropic/claude-opus-4.1"))).toEqual({
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-opus-4.1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-opus-4.1",
      });
    });

    it("a model outside the three families pins all three", () => {
      expect(pins(envFor("anthropic/claude-fable-5"))).toEqual({
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-fable-5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-fable-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-fable-5",
      });
    });
  });

  it("runs background tasks on allow-all turns, with or without an effort", () => {
    // The bridge's background drain holds the turn open until a background
    // agent reports back, as stock Claude Code would.
    for (const reasoningEffort of [undefined, "low"] as const) {
      adapter().createHarness({
        modelId: "anthropic/claude-sonnet-4-6",
        auth: {},
        mcpJson,
        permissionMode: "allow-all",
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      const args = vi.mocked(createClaudeCodeHarness).mock.calls.at(-1)![0]!;
      expect(args.env).not.toHaveProperty(
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
      );
      expect(args.env).toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
    }
  });

  it("turns background tasks off under any other mode, or none", () => {
    // Under allow-reads the main thread pauses for approval on any edit, and
    // the drain stops background work at every pause.
    for (const permissionMode of [
      "allow-reads",
      "allow-edits",
      undefined,
    ] as const) {
      adapter().createHarness({
        modelId: "anthropic/claude-sonnet-4-6",
        auth: {},
        mcpJson,
        ...(permissionMode ? { permissionMode } : {}),
      });
      const args = vi.mocked(createClaudeCodeHarness).mock.calls.at(-1)![0]!;
      expect(args.env).toMatchObject({
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      });
    }
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
