/**
 * The registry group's own contract: exact tool set, honest annotations,
 * dispatch shapes, and the OAuth outcome passing through as data (the
 * authorization decision itself lives in RegistryTab's handler — see
 * RegistryTab.test.tsx).
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

import { buildRegistryUiTools } from "../registry";

function getTool(name: string) {
  const tool = buildRegistryUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`registry group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildRegistryUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the four registry tools", () => {
    expect(buildRegistryUiTools().map((t) => t.name)).toEqual([
      "ui_connect_registry_server",
      "ui_disconnect_registry_server",
      "ui_toggle_registry_star",
      "ui_search_registry_directory",
    ]);
  });

  it("connect disambiguates itself from ui_connect_server (already-added path)", () => {
    const description = getTool("ui_connect_registry_server").description;
    expect(description).toContain("Catalog");
    expect(description).toContain("connector directory");
    expect(description).toContain("ui_connect_server");
  });

  it("annotates every tool completely and honestly", () => {
    // connect: installs + opens a session to an external server, and the
    // quick-connect flow is not a safe blind retry.
    expect(getTool("ui_connect_registry_server").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    // disconnect: reversible (the catalog entry survives), still open-world.
    expect(getTool("ui_disconnect_registry_server").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    // star: set-to-state, so idempotent; pure MCPJam state.
    expect(getTool("ui_toggle_registry_star").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // directory search: drives a search box. No write, nothing external.
    expect(getTool("ui_search_registry_directory").annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of buildRegistryUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("ui_connect_registry_server dispatches connectRegistryServer with name (+ optional variant)", async () => {
    await getTool("ui_connect_registry_server").execute({
      serverName: "Asana",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "connectRegistryServer",
      payload: { serverName: "Asana" },
    });

    await getTool("ui_connect_registry_server").execute({
      serverName: "Asana",
      variant: "app",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "connectRegistryServer",
      payload: { serverName: "Asana", variant: "app" },
    });
  });

  it("connect rejects a missing serverName and a bad variant without dispatching", async () => {
    const tool = getTool("ui_connect_registry_server");
    const missing = await tool.execute({});
    expect(missing.isError).toBe(true);
    const badVariant = await tool.execute({
      serverName: "Asana",
      variant: "desktop",
    });
    expect(badVariant.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("connect passes an authorization_required outcome through as a non-error result", async () => {
    dispatchInspectorCommandMock.mockResolvedValue(
      success({
        status: "authorization_required",
        serverName: "Asana",
        message: "Ask the user to click Connect on its card.",
      })
    );
    const result = await getTool("ui_connect_registry_server").execute({
      serverName: "Asana",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("authorization_required");
  });

  it("connect surfaces command errors (unknown_server) as tool errors", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: { code: "unknown_server", message: "No registry server matches." },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_connect_registry_server").execute({
      serverName: "Nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown_server");
  });

  it("ui_disconnect_registry_server dispatches disconnectRegistryServer", async () => {
    await getTool("ui_disconnect_registry_server").execute({
      serverName: "Asana",
      variant: "text",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "disconnectRegistryServer",
      payload: { serverName: "Asana", variant: "text" },
    });
  });

  it("ui_toggle_registry_star dispatches the explicit target state", async () => {
    await getTool("ui_toggle_registry_star").execute({
      serverName: "Asana",
      starred: true,
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "toggleRegistryStar",
      payload: { serverName: "Asana", starred: true },
    });

    await getTool("ui_toggle_registry_star").execute({
      serverName: "Asana",
      starred: false,
    });
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "toggleRegistryStar",
      payload: { serverName: "Asana", starred: false },
    });
  });

  it("star requires a boolean 'starred' and does not dispatch without one", async () => {
    const tool = getTool("ui_toggle_registry_star");
    const missing = await tool.execute({ serverName: "Asana" });
    expect(missing.isError).toBe(true);
    const stringly = await tool.execute({
      serverName: "Asana",
      starred: "true",
    });
    expect(stringly.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });
});

describe("ui_search_registry_directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("dispatches searchRegistryDirectory with the query and tier", async () => {
    await getTool("ui_search_registry_directory").execute({
      query: "linear",
      tier: "partner",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "searchRegistryDirectory",
      payload: { query: "linear", tier: "partner" },
    });
  });

  it("omits an absent query — browsing is a real request, not an error", async () => {
    await getTool("ui_search_registry_directory").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "searchRegistryDirectory",
      payload: {},
    });
  });

  it("treats a blank query the same as an absent one", async () => {
    await getTool("ui_search_registry_directory").execute({ query: "   " });
    const [dispatched] = dispatchInspectorCommandMock.mock.calls[0];
    expect(dispatched.payload.query ?? "").toBe("");
  });

  it("refuses a non-string tier instead of dispatching it", async () => {
    const result = await getTool("ui_search_registry_directory").execute({
      tier: 7,
    });
    expect(result.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("dispatches the source when the model picks a directory", async () => {
    await getTool("ui_search_registry_directory").execute({
      query: "linear",
      source: "chatgpt-directory",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "searchRegistryDirectory",
      payload: { query: "linear", source: "chatgpt-directory" },
    });
  });

  it("omits an absent source — the user's current view is the default", async () => {
    // A model that does not know there are two directories must not silently
    // switch the one the person is looking at.
    await getTool("ui_search_registry_directory").execute({ query: "linear" });
    const [dispatched] = dispatchInspectorCommandMock.mock.calls[0];
    expect(dispatched.payload.source).toBeUndefined();
  });

  it("refuses a non-string source instead of dispatching it", async () => {
    const result = await getTool("ui_search_registry_directory").execute({
      source: 7,
    });
    expect(result.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("names both directories, so the model knows there is a choice", () => {
    const schema = getTool("ui_search_registry_directory").inputSchema as {
      properties: { source: { enum: string[] } };
    };
    expect(schema.properties.source.enum).toEqual([
      "anthropic-directory",
      "chatgpt-directory",
    ]);
  });

  it("tells the model where the results actually appear", () => {
    const description = getTool("ui_search_registry_directory").description;
    expect(description).toContain("ui_snapshot_app");
    expect(description).toContain("ui_connect_registry_server");
  });
});
