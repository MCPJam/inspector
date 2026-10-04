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
vi.mock("@ai-sdk/harness-codex", async (original) => {
  const actual = await original<typeof import("@ai-sdk/harness-codex")>();
  return { ...actual, createCodex: vi.fn(actual.createCodex) };
});
vi.mock("../codex-appserver/index.js", async (original) => {
  const actual = await original<typeof import("../codex-appserver/index.js")>();
  return {
    ...actual,
    createCodexAppServer: vi.fn(actual.createCodexAppServer),
  };
});

import { createCodex } from "@ai-sdk/harness-codex";
import { createClaudeCodeHarness } from "../claude-code-bootstrap.js";
import { createCodexAppServer } from "../codex-appserver/index.js";
import { getHarnessAdapter } from "../registry";

const FLAG = "MCPJAM_CODEX_APPSERVER_TRANSPORT";

afterEach(() => {
  delete process.env[FLAG];
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
  it("exec passes reasoningEffort to createCodex, and nothing without one", () => {
    const adapter = getHarnessAdapter("codex");
    expect(adapter.transport).toBe("exec");
    adapter.createHarness({ modelId: "openai/gpt-5", auth: {} });
    expect(
      "reasoningEffort" in vi.mocked(createCodex).mock.calls.at(-1)![0]!,
    ).toBe(false);
    adapter.createHarness({
      modelId: "openai/gpt-5",
      auth: {},
      reasoningEffort: "xhigh",
    });
    expect(vi.mocked(createCodex).mock.calls.at(-1)![0]).toMatchObject({
      reasoningEffort: "xhigh",
    });
  });

  it("app-server passes reasoningEffort in its settings (sent as turn/start effort)", () => {
    process.env[FLAG] = "true";
    const adapter = getHarnessAdapter("codex");
    expect(adapter.transport).toBe("app-server");
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

  it("both transports declare the SDK's Codex levels", () => {
    expect(getHarnessAdapter("codex").supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    process.env[FLAG] = "true";
    expect(getHarnessAdapter("codex").supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
