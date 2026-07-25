/**
 * The computer group's own contract: exact tool set, honest annotations (the
 * destructive set is start + reset + delete; start is billed+capped (spend →
 * destructive), empty input schemas, dispatch shapes, and command errors
 * passing through as tool errors. The availability + daily-cap gating lives in
 * ComputerView's handlers (see ComputerView.agent.test.tsx).
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

import { buildComputerUiTools } from "../computer";

const COMPUTER_TOOL_NAMES = [
  "ui_start_computer",
  "ui_hibernate_computer",
  "ui_reset_computer",
  "ui_delete_computer",
];

function getTool(name: string) {
  const tool = buildComputerUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`computer group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildComputerUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the four computer tools", () => {
    expect(buildComputerUiTools().map((t) => t.name)).toEqual(
      COMPUTER_TOOL_NAMES,
    );
  });

  it("does NOT ship a terminal-opening tool (terminal is human-only)", () => {
    const names = buildComputerUiTools().map((t) => t.name);
    expect(names).not.toContain("ui_open_terminal");
    for (const tool of buildComputerUiTools()) {
      const json = JSON.stringify(tool).toLowerCase();
      // No token/credential vocabulary anywhere in a tool definition.
      expect(json).not.toContain("token");
    }
  });

  it("annotates every tool completely and honestly", () => {
    // start: billed + daily-cap-gated → open-world AND destructive (spend →
    // confirmation pill); a retry can consume another start → not idempotent.
    expect(getTool("ui_start_computer").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    // hibernate: reversible pause, converges.
    expect(getTool("ui_hibernate_computer").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // reset: wipes files → destructive; resetting to the same image converges.
    expect(getTool("ui_reset_computer").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    // delete: irreversible teardown → destructive; deleting a gone computer
    // fails cleanly.
    expect(getTool("ui_delete_computer").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of buildComputerUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("gates exactly start + reset + delete behind the destructive approval pill", () => {
    const destructive = buildComputerUiTools()
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual([
      "ui_start_computer",
      "ui_reset_computer",
      "ui_delete_computer",
    ]);
  });

  it("every tool takes an empty, closed input schema (no target, no secrets)", () => {
    for (const tool of buildComputerUiTools()) {
      // toEqual, not toMatchObject: `{ properties: {} }` is vacuously satisfied
      // by ANY properties object, so it wouldn't catch a field creeping in.
      expect(tool.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toHaveLength(0);
    }
  });

  it("each tool dispatches its command with no payload", async () => {
    await getTool("ui_start_computer").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "startComputer",
    });

    dispatchInspectorCommandMock.mockClear();
    await getTool("ui_hibernate_computer").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "hibernateComputer",
    });

    dispatchInspectorCommandMock.mockClear();
    await getTool("ui_reset_computer").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "resetComputer",
    });

    dispatchInspectorCommandMock.mockClear();
    await getTool("ui_delete_computer").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "deleteComputer",
    });
  });

  it("surfaces a daily-cap rejection (execution_failed) from start as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "execution_failed",
        message: "Daily computer limit reached (5). Resets Jul 19, 3:00 PM.",
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_start_computer").execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("execution_failed");
    expect(result.content[0].text).toContain("Daily computer limit reached");
  });

  it("surfaces an unavailable (unsupported_in_mode) rejection as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "unsupported_in_mode",
        message: "Computers aren't available in this deployment.",
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_delete_computer").execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsupported_in_mode");
  });
});
