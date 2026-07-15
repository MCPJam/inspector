import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorCommand } from "@/shared/inspector-command.js";
import { isUiToolName } from "@/shared/client-fulfilled-tools.js";

const { executeInspectorCommandMock, hasInspectorCommandHandlerMock } =
  vi.hoisted(() => ({
    executeInspectorCommandMock: vi.fn(),
    hasInspectorCommandHandlerMock: vi.fn(),
  }));

vi.mock("@/lib/inspector-command-handlers", () => ({
  executeInspectorCommand: executeInspectorCommandMock,
  hasInspectorCommandHandler: hasInspectorCommandHandlerMock,
}));

import { buildUiToolsCatalog } from "../ui-tools-catalog";

function getTool(name: string) {
  const tool = buildUiToolsCatalog().find((t) => t.name === name);
  if (!tool) throw new Error(`catalog is missing ${name}`);
  return tool;
}

function dispatchedCommands(): InspectorCommand[] {
  return executeInspectorCommandMock.mock.calls.map((call) => call[0]);
}

describe("buildUiToolsCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeInspectorCommandMock.mockImplementation(
      async (command: InspectorCommand) => ({
        id: command.id,
        status: "success" as const,
        result: { echoed: command.type },
      }),
    );
    // Playground handlers registered (the /playground surface is mounted).
    hasInspectorCommandHandlerMock.mockReturnValue(true);
  });

  it("every tool satisfies the wire contract (name regex, description cap)", () => {
    const catalog = buildUiToolsCatalog();
    expect(catalog.map((t) => t.name).sort()).toEqual([
      "ui_execute_tool",
      "ui_navigate",
      "ui_open_playground",
      "ui_select_server",
      "ui_select_tool",
      "ui_set_app_context",
      "ui_snapshot_app",
    ]);
    for (const tool of catalog) {
      expect(isUiToolName(tool.name)).toBe(true);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeLessThanOrEqual(512);
      expect(typeof tool.execute).toBe("function");
    }
    expect(getTool("ui_snapshot_app").readOnly).toBe(true);
  });

  it("ui_navigate dispatches valid targets and errors on missing/unknown ones", async () => {
    const navigate = getTool("ui_navigate");

    const ok = await navigate.execute({ target: "playground" });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0].text)).toEqual({
      ok: true,
      data: { echoed: "navigate" },
    });
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "navigate",
      payload: { target: "/playground" },
    });

    executeInspectorCommandMock.mockClear();
    const missing = await navigate.execute({});
    expect(missing.isError).toBe(true);
    const unknown = await navigate.execute({ target: "bogus" });
    expect(unknown.isError).toBe(true);
    expect(executeInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_select_tool dispatches to the playground surface with prefill parameters", async () => {
    const selectTool = getTool("ui_select_tool");
    await selectTool.execute({
      toolName: "echo",
      serverName: "demo",
      parameters: { message: "hi" },
    });

    expect(dispatchedCommands()).toHaveLength(1);
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "selectTool",
      payload: {
        surface: "playground",
        toolName: "echo",
        serverName: "demo",
        parameters: { message: "hi" },
      },
    });
  });

  it("auto-opens the playground first when its command handler is absent", async () => {
    // The gate is handler registration, NOT UI store state — the
    // playground store's isPlaygroundActive tracks the Views-tab preview
    // surface, which never registers the selectTool/executeTool handlers.
    hasInspectorCommandHandlerMock.mockReturnValue(false);
    const executeTool = getTool("ui_execute_tool");

    await executeTool.execute({ toolName: "echo", serverName: "demo" });

    expect(hasInspectorCommandHandlerMock).toHaveBeenCalledWith("executeTool");
    const types = dispatchedCommands().map((c) => c.type);
    expect(types).toEqual(["openPlayground", "executeTool"]);
    expect(dispatchedCommands()[0]).toMatchObject({
      payload: { serverName: "demo" },
    });
  });

  it("surfaces a failed auto-open instead of dispatching the tool command", async () => {
    hasInspectorCommandHandlerMock.mockReturnValue(false);
    executeInspectorCommandMock.mockResolvedValueOnce({
      id: "x",
      status: "error",
      error: { code: "unknown_server", message: 'Unknown server "demo".' },
    });

    const result = await getTool("ui_execute_tool").execute({
      toolName: "echo",
      serverName: "demo",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Could not open the playground");
    expect(dispatchedCommands().map((c) => c.type)).toEqual(["openPlayground"]);
  });

  it("ui_execute_tool surfaces command errors as isError text", async () => {
    executeInspectorCommandMock.mockResolvedValueOnce({
      id: "x",
      status: "error",
      error: { code: "unknown_tool", message: 'Unknown tool "echo".' },
    });
    const result = await getTool("ui_execute_tool").execute({
      toolName: "echo",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown_tool");
  });

  it("ui_set_app_context requires at least one field and forwards typed ones", async () => {
    const setContext = getTool("ui_set_app_context");

    const empty = await setContext.execute({});
    expect(empty.isError).toBe(true);
    expect(executeInspectorCommandMock).not.toHaveBeenCalled();

    await setContext.execute({
      theme: "dark",
      deviceType: "mobile",
      displayMode: "pip",
      locale: "en-US",
      timeZone: "Europe/Paris",
      bogusField: "dropped",
    });
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "setAppContext",
      payload: {
        theme: "dark",
        deviceType: "mobile",
        displayMode: "pip",
        locale: "en-US",
        timeZone: "Europe/Paris",
      },
    });
    expect(
      (dispatchedCommands()[0].payload as Record<string, unknown>).bogusField,
    ).toBeUndefined();
  });

  it("ui_set_app_context accepts 'fill' — the store default is expressible", async () => {
    const setContext = getTool("ui_set_app_context");
    const schema = setContext.inputSchema as {
      properties: { deviceType: { enum: string[] } };
    };
    expect(schema.properties.deviceType.enum).toContain("fill");

    await setContext.execute({ deviceType: "fill" });
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "setAppContext",
      payload: { deviceType: "fill" },
    });
  });

  it("ui_select_tool leads with prefill (do not run); ui_execute_tool says it really runs", () => {
    // Chrome WebMCP guidance: names/descriptions must distinguish
    // initiation from execution.
    expect(getTool("ui_select_tool").description).toMatch(/^Prefill \(do not run\)/);
    expect(getTool("ui_execute_tool").description).toContain("REALLY runs");
  });

  it("ui_snapshot_app dispatches a playground snapshot when the playground is open", async () => {
    await getTool("ui_snapshot_app").execute({});
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "snapshotApp",
      payload: { surface: "playground" },
    });
  });

  it("ui_snapshot_app errors without mutating UI state when the playground is closed (honors readOnly)", async () => {
    // readOnly tools must not auto-open the playground; with the handler
    // absent, snapshot returns an error and dispatches nothing.
    hasInspectorCommandHandlerMock.mockReturnValue(false);
    const result = await getTool("ui_snapshot_app").execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ui_open_playground");
    expect(executeInspectorCommandMock).not.toHaveBeenCalled();
  });
});
