/**
 * The chatboxes group's own contract: exact tool set, honest annotations (the
 * destructive set is exactly generate + delete — generate SPENDS MONEY, delete
 * is irreversible; publish only provisions and is idempotent), dispatch shapes,
 * and command errors (the Swarms-owned dead-end + the generate model gate)
 * passing through as tool errors. The host/chatbox resolution and the
 * money-spending endpoints live in ChatboxesTab's handlers (see
 * ChatboxesTab.agent.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorCommandResponse } from "@/shared/inspector-command.js";

const { dispatchInspectorCommandMock } = vi.hoisted(() => ({
  dispatchInspectorCommandMock: vi.fn(),
}));

vi.mock("../../ui-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui-actions")>();
  return { ...actual, dispatchInspectorCommand: dispatchInspectorCommandMock };
});

import { buildChatboxesUiTools } from "../chatboxes";

const CHATBOX_TOOL_NAMES = [
  "ui_publish_chatbox",
  "ui_generate_chatbox_sessions",
  "ui_delete_chatbox",
];

function getTool(name: string) {
  const tool = buildChatboxesUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`chatboxes group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildChatboxesUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the three chatbox tools", () => {
    expect(buildChatboxesUiTools().map((t) => t.name)).toEqual(
      CHATBOX_TOOL_NAMES,
    );
  });

  it("annotates every tool completely and honestly", () => {
    // publish: provisions (creates) rather than wipes; re-publishing converges
    // → idempotent, not destructive. Stays inside MCPJam.
    expect(getTool("ui_publish_chatbox").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // generate: SPENDS MONEY + real model/MCP traffic → destructive + open-world;
    // a retry starts another run → not idempotent.
    expect(getTool("ui_generate_chatbox_sessions").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    // delete: irreversible → destructive; deleting a gone chatbox fails cleanly.
    expect(getTool("ui_delete_chatbox").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of buildChatboxesUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("gates exactly generate + delete behind the destructive approval pill", () => {
    const destructive = buildChatboxesUiTools()
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual([
      "ui_generate_chatbox_sessions",
      "ui_delete_chatbox",
    ]);
  });

  it("keeps share tokens/secrets out of every input schema", () => {
    for (const tool of buildChatboxesUiTools()) {
      const json = JSON.stringify(tool).toLowerCase();
      expect(json).not.toContain("token");
      expect(json).not.toContain("secret");
      expect(json).not.toContain("transcript");
    }
  });

  it("ui_publish_chatbox dispatches publishChatbox and requires a host", async () => {
    await getTool("ui_publish_chatbox").execute({ host: "Claude" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "publishChatbox",
      payload: { host: "Claude" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_publish_chatbox").execute({ host: "  " });
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_delete_chatbox dispatches deleteChatbox and requires a host", async () => {
    await getTool("ui_delete_chatbox").execute({ host: "host-123" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "deleteChatbox",
      payload: { host: "host-123" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_delete_chatbox").execute({});
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_generate_chatbox_sessions dispatches counts (all optional)", async () => {
    await getTool("ui_generate_chatbox_sessions").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "generateChatboxSessions",
      payload: {},
    });

    dispatchInspectorCommandMock.mockClear();
    await getTool("ui_generate_chatbox_sessions").execute({
      personaCount: 4,
      sessionsPerPersona: 2,
      maxTurns: 8,
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "generateChatboxSessions",
      payload: { personaCount: 4, sessionsPerPersona: 2, maxTurns: 8 },
    });
  });

  it("ui_generate_chatbox_sessions rejects out-of-range counts without dispatching", async () => {
    const tooMany = await getTool("ui_generate_chatbox_sessions").execute({
      personaCount: 99,
    });
    expect(tooMany.isError).toBe(true);

    const badTurns = await getTool("ui_generate_chatbox_sessions").execute({
      maxTurns: 0,
    });
    expect(badTurns.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("surfaces the Swarms-owned dead-end (unsupported_in_mode) as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "unsupported_in_mode",
        message:
          '"Journey bot" belongs to the Swarms surface and has no publish surface.',
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_publish_chatbox").execute({
      host: "Journey bot",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsupported_in_mode");
    expect(result.content[0].text).toContain("no publish surface");
  });

  it("surfaces the generate model gate (execution_failed) as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "execution_failed",
        message: "This client has no model selected — pick one on its Behavior tab.",
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_generate_chatbox_sessions").execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("execution_failed");
    expect(result.content[0].text).toContain("no model selected");
  });

  it("surfaces an unknown-host command error (invalid_request) as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: { code: "invalid_request", message: 'No client matches "Nope".' },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_delete_chatbox").execute({ host: "Nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_request");
  });
});
