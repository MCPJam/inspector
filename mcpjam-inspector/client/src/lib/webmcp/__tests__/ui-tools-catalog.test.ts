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
      "ui_add_server",
      "ui_connect_server",
      "ui_disconnect_server",
      "ui_execute_tool",
      "ui_navigate",
      "ui_open_playground",
      "ui_open_server_form",
      "ui_remove_server",
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

  it("every tool annotates readOnly/destructive/openWorld explicitly", () => {
    // An absent `destructiveHint` reads as DESTRUCTIVE, so an unannotated
    // tool would gate on every call rather than execute silently — safe, but
    // wrong. Curated entries state their policy instead of inheriting it.
    for (const tool of buildUiToolsCatalog()) {
      const annotations = tool.annotations;
      expect(annotations, `${tool.name} must annotate`).toBeDefined();
      expect(typeof annotations?.readOnlyHint).toBe("boolean");
      expect(typeof annotations?.destructiveHint).toBe("boolean");
      expect(typeof annotations?.openWorldHint).toBe("boolean");
      // The wire carries both; the validator 400s if they disagree.
      expect(annotations?.readOnlyHint).toBe(tool.readOnly);
    }
  });

  it("gates exactly the irreversible tools as destructive", () => {
    // These confirm even with the approval toggle off. Everything else is
    // additive or reversible: the user watches it happen in their own app,
    // and a confirmation buys nothing.
    //   - ui_execute_tool runs an arbitrary third-party MCP tool.
    //   - ui_remove_server deletes configuration chat can't reconstruct.
    const destructive = buildUiToolsCatalog()
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual(["ui_execute_tool", "ui_remove_server"]);
  });

  it("marks exactly the tools whose effects escape the browser as open-world", () => {
    const openWorld = buildUiToolsCatalog()
      .filter((t) => t.annotations?.openWorldHint === true)
      .map((t) => t.name)
      .sort();
    expect(openWorld).toEqual([
      "ui_connect_server",
      "ui_disconnect_server",
      "ui_execute_tool",
    ]);
  });

  it("ui_add_server is additive, not destructive", () => {
    // It refuses to overwrite an existing server (the handler rejects a
    // duplicate name), which is what keeps it non-destructive.
    const addServer = getTool("ui_add_server");
    expect(addServer.annotations?.destructiveHint).toBe(false);
    expect(addServer.description).toContain("already exists");
  });

  it("ui_add_server dispatches a draft without connecting", async () => {
    await getTool("ui_add_server").execute({
      name: "Excalidraw",
      url: "https://example.com/mcp",
    });
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "addServer",
      payload: { draft: { name: "Excalidraw", url: "https://example.com/mcp" } },
    });
    // Adding never connects: connecting is a separate, visible step that can
    // report authorization_required.
    expect(dispatchedCommands().some((c) => c.type === "connectServer")).toBe(
      false,
    );
  });

  it("ui_add_server requires a name", async () => {
    const result = await getTool("ui_add_server").execute({});
    expect(result.isError).toBe(true);
    expect(executeInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_add_server passes stdio args through as a list", async () => {
    // Pre-separated, because the form's parser splits on whitespace with no
    // quote handling.
    await getTool("ui_add_server").execute({
      name: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "pkg", "--flag", "a b"],
    });
    expect(dispatchedCommands()[0]).toMatchObject({
      payload: { draft: { args: ["-y", "pkg", "--flag", "a b"] } },
    });
  });

  it("ui_open_server_form navigates to Connect first when its handler is absent", async () => {
    // The command only exists while Connect is mounted — its modal state and
    // billing gate are that screen's own.
    hasInspectorCommandHandlerMock.mockReturnValue(false);
    await getTool("ui_open_server_form").execute({ name: "X" });
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "navigate",
      payload: { target: "/servers" },
    });
    expect(dispatchedCommands()[1]).toMatchObject({ type: "openServerForm" });
  });

  it("connect/disconnect/remove require a server name and dispatch it", async () => {
    for (const [tool, type] of [
      ["ui_connect_server", "connectServer"],
      ["ui_disconnect_server", "disconnectServer"],
      ["ui_remove_server", "removeServer"],
    ] as const) {
      vi.clearAllMocks();
      hasInspectorCommandHandlerMock.mockReturnValue(true);
      executeInspectorCommandMock.mockResolvedValue({
        id: "c",
        status: "success",
        result: { ok: true },
      });

      const missing = await getTool(tool).execute({});
      expect(missing.isError, tool).toBe(true);
      expect(executeInspectorCommandMock).not.toHaveBeenCalled();

      await getTool(tool).execute({ serverName: "everything" });
      expect(dispatchedCommands()[0], tool).toMatchObject({
        type,
        payload: { serverName: "everything" },
      });
    }
  });

  it("flags only ui_execute_tool's output as untrusted for native agents", () => {
    // Its result comes from a third-party MCP server. `openWorldHint` (MCP)
    // doesn't convey that to a WebMCP agent; `nativeUntrustedContentHint`
    // (projected to WebMCP's untrustedContentHint) does.
    const untrusted = buildUiToolsCatalog()
      .filter((t) => t.nativeUntrustedContentHint === true)
      .map((t) => t.name);
    expect(untrusted).toEqual(["ui_execute_tool"]);
  });

  it("does not advertise ui_navigate as idempotent (navigation adds history)", () => {
    expect(getTool("ui_navigate").annotations?.idempotentHint).toBe(false);
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

  it("ui_snapshot_app asks for the whole app by default", async () => {
    await getTool("ui_snapshot_app").execute({});
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "snapshotApp",
      payload: {},
    });
    // No hardcoded surface: the app-level handler decides what's readable.
    expect((dispatchedCommands()[0] as any).payload.surface).toBeUndefined();
  });

  it("ui_snapshot_app forwards an explicit surface", async () => {
    await getTool("ui_snapshot_app").execute({ surface: "playground" });
    expect(dispatchedCommands()[0]).toMatchObject({
      type: "snapshotApp",
      payload: { surface: "playground" },
    });
  });

  it("ui_snapshot_app works with the playground closed (no gate, no auto-open)", async () => {
    // It reads whatever IS open. It must still never mount a surface to
    // observe it — that's what keeps `readOnlyHint` (and its approval
    // exemption) honest.
    hasInspectorCommandHandlerMock.mockReturnValue(false);
    executeInspectorCommandMock.mockResolvedValue({
      id: "c1",
      status: "success",
      result: { activeTab: "servers", surfaces: {} },
    });

    const result = await getTool("ui_snapshot_app").execute({});

    expect(result.isError).toBeFalsy();
    expect(dispatchedCommands()[0]).toMatchObject({ type: "snapshotApp" });
    // Never an open/navigate command.
    expect(
      dispatchedCommands().some((c) => c.type === "openPlayground"),
    ).toBe(false);
  });
});
