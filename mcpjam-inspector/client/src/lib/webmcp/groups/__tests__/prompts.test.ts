/**
 * The prompts group's own contract: exact tool set, honest (read-only)
 * annotations, dispatch shape, transcript-cap on the returned content, and
 * command errors passing through (the prompt RESOLUTION itself lives in
 * PromptsTab's handler — see PromptsTab.agent.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorCommandResponse } from "@/shared/inspector-command.js";
import { MAX_RESULT_CHARS } from "../shared";

const { dispatchInspectorCommandMock } = vi.hoisted(() => ({
  dispatchInspectorCommandMock: vi.fn(),
}));

vi.mock("../../ui-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui-actions")>();
  return { ...actual, dispatchInspectorCommand: dispatchInspectorCommandMock };
});

import { buildPromptsUiTools } from "../prompts";

function getTool(name: string) {
  const tool = buildPromptsUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`prompts group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildPromptsUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the one render tool", () => {
    expect(buildPromptsUiTools().map((t) => t.name)).toEqual(["ui_get_prompt"]);
  });

  it("annotates the render tool as a side-effect-free open-world read", () => {
    const tool = getTool("ui_get_prompt");
    expect(tool.readOnly).toBe(true);
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("dispatches getPrompt with the prompt (+ optional arguments)", async () => {
    await getTool("ui_get_prompt").execute({ prompt: "summarize" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "getPrompt",
      payload: { prompt: "summarize" },
    });

    await getTool("ui_get_prompt").execute({
      prompt: "summarize",
      arguments: { topic: "MCP" },
    });
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "getPrompt",
      payload: { prompt: "summarize", arguments: { topic: "MCP" } },
    });
  });

  it("rejects a missing prompt and non-string-valued arguments without dispatching", async () => {
    const tool = getTool("ui_get_prompt");
    const missing = await tool.execute({});
    expect(missing.isError).toBe(true);
    const badArgs = await tool.execute({ prompt: "summarize", arguments: { topic: 5 } });
    expect(badArgs.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("caps a huge rendered prompt so the transcript result stays bounded", async () => {
    const huge = "y".repeat(MAX_RESULT_CHARS * 4);
    dispatchInspectorCommandMock.mockResolvedValue(
      success({
        status: "prompt_rendered",
        prompt: "big",
        messages: [{ role: "user", content: { type: "text", text: huge } }],
      }),
    );
    const result = await getTool("ui_get_prompt").execute({ prompt: "big" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 32);
    expect(text).toContain("truncated");
  });

  it("surfaces command errors (invalid_request) as tool errors", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: { code: "invalid_request", message: "No prompt matches." },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_get_prompt").execute({ prompt: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_request");
  });
});
