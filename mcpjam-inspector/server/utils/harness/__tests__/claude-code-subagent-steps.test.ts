/**
 * Group E, a Claude Code subagent's steps (`claude-code-subagent-steps.ts`).
 *
 * The forwarder under test is lifted out of the INSTALLED, patched bridge, so a
 * patch that compiles but drifts from what ships cannot pass here. Message
 * shapes follow SDK 0.3.245: a subagent's messages carry the `tool_use` id of
 * the Agent call that started it as `parent_tool_use_id`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createHostedClaudeCodeHarness } from "../claude-code-typed-errors.js";
import {
  CLAUDE_CODE_SUBAGENT_STEPS_MARKER,
  extractClaudeCodeSubagentStepHelpers,
  patchClaudeCodeSubagentSteps,
} from "../claude-code-subagent-steps.js";

type Emitted = { type: string; rawValue?: Record<string, unknown> };
type Forward = (
  state: Record<string, unknown>,
  emit: (part: Emitted) => void,
  msg: unknown,
) => void;

const AUTH = {
  AI_GATEWAY_API_KEY: "test",
  AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v1",
};

async function installedBridge(): Promise<string> {
  const bootstrap = await createHostedClaudeCodeHarness({
    auth: AUTH,
  } as any).getBootstrap?.();
  return (
    bootstrap?.files.find((file) => file.path.endsWith("/bridge.mjs"))
      ?.content ?? ""
  );
}

let bridge: string;
let forward: Forward;

beforeAll(async () => {
  bridge = await installedBridge();
  const block = extractClaudeCodeSubagentStepHelpers(bridge);
  if (!block) throw new Error("the installed bridge has no subagent helpers");
  forward = new Function(`${block}\nreturn mcpjamForwardSubagentStep;`)();
});

function run(...messages: unknown[]) {
  const state: Record<string, unknown> = {};
  const emitted: Emitted[] = [];
  for (const msg of messages) forward(state, (part) => emitted.push(part), msg);
  return emitted;
}

const toolUse = (
  parent: string,
  id: string,
  name: string,
  input: unknown = {},
) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (
  parent: string,
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, content: "ok", ...extra },
    ],
  },
});

describe("forwarding a subagent's steps", () => {
  it("a tool call and its result, tied to the Agent call", () => {
    expect(
      run(
        toolUse("toolu_agent", "toolu_read", "Read", {
          file_path: "/work/README.md",
        }),
        toolResult("toolu_agent", "toolu_read"),
      ),
    ).toEqual([
      {
        type: "raw",
        rawValue: {
          mcpjam: "subagent-step",
          kind: "tool-call",
          rootToolUseId: "toolu_agent",
          parentToolUseId: "toolu_agent",
          toolUseId: "toolu_read",
          toolName: "Read",
          input: { file_path: "/work/README.md" },
        },
      },
      {
        type: "raw",
        rawValue: {
          mcpjam: "subagent-step",
          kind: "tool-result",
          rootToolUseId: "toolu_agent",
          parentToolUseId: "toolu_agent",
          toolUseId: "toolu_read",
          isError: false,
        },
      },
    ]);
  });

  it("a nested subagent's step belongs to the outermost Agent call", () => {
    const emitted = run(
      toolUse("toolu_agent", "toolu_nested", "Agent", {
        description: "look closer",
      }),
      toolUse("toolu_nested", "toolu_grep", "Grep", { pattern: "TODO" }),
      toolResult("toolu_nested", "toolu_grep"),
    );
    expect(emitted.map((part) => part.rawValue)).toEqual([
      expect.objectContaining({
        toolUseId: "toolu_nested",
        rootToolUseId: "toolu_agent",
        parentToolUseId: "toolu_agent",
      }),
      expect.objectContaining({
        toolUseId: "toolu_grep",
        rootToolUseId: "toolu_agent",
        parentToolUseId: "toolu_nested",
      }),
      expect.objectContaining({
        kind: "tool-result",
        toolUseId: "toolu_grep",
        rootToolUseId: "toolu_agent",
      }),
    ]);
  });

  it("keeps a label, not a transcript: scalar fields, cut short", () => {
    const [part] = run(
      toolUse("toolu_agent", "toolu_write", "Write", {
        file_path: "/work/plan.md",
        content: "x".repeat(5_000),
        edits: [{ old_string: "a" }],
        options: { deep: true },
        replace_all: false,
      }),
    );
    const input = part!.rawValue!.input as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(["file_path", "content", "replace_all"]);
    expect(String(input.content)).toHaveLength(301);
    expect(String(input.content).endsWith("…")).toBe(true);
  });

  it("a failed step says so, with the start of its error and no output", () => {
    const [part] = run(
      toolResult("toolu_agent", "toolu_read", {
        is_error: true,
        content: [{ type: "text", text: "File does not exist." }],
      }),
    );
    expect(part!.rawValue).toEqual(
      expect.objectContaining({
        kind: "tool-result",
        isError: true,
        error: "File does not exist.",
      }),
    );
    const [ok] = run(toolResult("toolu_agent", "toolu_read"));
    expect(ok!.rawValue).not.toHaveProperty("error");
  });

  it("forwards nothing for text, thinking, partials or the main thread", () => {
    expect(
      run(
        {
          type: "assistant",
          parent_tool_use_id: "toolu_agent",
          message: {
            content: [
              { type: "text", text: "PLAN" },
              { type: "thinking", thinking: "hmm" },
            ],
          },
        },
        { type: "stream_event", parent_tool_use_id: "toolu_agent", event: {} },
        {
          ...toolUse("toolu_agent", "toolu_x", "Read"),
          parent_tool_use_id: null,
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_agent",
          message: { content: "a string" },
        },
      ),
    ).toEqual([]);
  });
});

describe("subagent steps patch", () => {
  it("the installed bridge forwards inside the sub-agent guard, which still returns", () => {
    expect(bridge).toContain(
      "    if (msg.parent_tool_use_id != null) {\n      mcpjamForwardSubagentStep(state, emit, msg);\n      return;\n    }",
    );
    expect(bridge.match(/function mcpjamForwardSubagentStep\(/g)).toHaveLength(
      1,
    );
    // Group B's result fallback still sits after the guard, so a subagent's
    // own result never leaks into the parent's answer.
    expect(
      bridge.indexOf('if (type === "result" && msg.subtype === "success") {'),
    ).toBeGreaterThan(
      bridge.indexOf("mcpjamForwardSubagentStep(state, emit, msg);"),
    );
  });

  it("is idempotent and quotes the vendored bridge", async () => {
    const vendor = await createClaudeCode({ auth: AUTH }).getBootstrap!();
    const source = vendor!.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    )!.content;
    const once = patchClaudeCodeSubagentSteps(source);
    expect(once).toContain(CLAUDE_CODE_SUBAGENT_STEPS_MARKER);
    expect(patchClaudeCodeSubagentSteps(once)).toBe(once);
  });

  it("refuses a guard whose shape moved", async () => {
    const vendor = await createClaudeCode({ auth: AUTH }).getBootstrap!();
    const source = vendor!.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    )!.content;
    expect(() =>
      patchClaudeCodeSubagentSteps(
        source.replace(
          "    if (msg.parent_tool_use_id != null) {\n      return;\n    }",
          "    if (msg.parent_tool_use_id) {\n      return;\n    }",
        ),
      ),
    ).toThrow("sub-agent guard shape changed");
  });
});
