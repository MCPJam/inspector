/**
 * The hosts group's own contract: exact tool set, honest annotations (the
 * destructive set is exactly the delete tool — a host config is high-entropy
 * so there is NO update-config tool; config edits go through the open-editor
 * navigation), dispatch shapes, and command errors passing through as tool
 * errors. The host/server resolution against the live lists lives in HostsTab's
 * handlers (see HostsTab.agent.test.tsx).
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

import { buildHostsUiTools } from "../hosts";

const HOSTS_TOOL_NAMES = [
  "ui_create_host",
  "ui_open_host_editor",
  "ui_set_host_servers",
  "ui_delete_host",
  "ui_duplicate_host",
];

function getTool(name: string) {
  const tool = buildHostsUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`hosts group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildHostsUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the five hosts tools", () => {
    expect(buildHostsUiTools().map((t) => t.name)).toEqual(HOSTS_TOOL_NAMES);
  });

  it("annotates every tool completely and honestly", () => {
    // create: direct low-entropy commit from a template, stays inside MCPJam,
    // creates a new host each time → not idempotent.
    expect(getTool("ui_create_host").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    // open editor: navigates + selects, no data change, same place twice.
    expect(getTool("ui_open_host_editor").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // set servers: reversible set-to-list against existing project servers.
    expect(getTool("ui_set_host_servers").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // delete: irreversible → destructive; deleting a gone host fails cleanly.
    expect(getTool("ui_delete_host").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    // duplicate: creates a new copy each time → not idempotent.
    expect(getTool("ui_duplicate_host").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    for (const tool of buildHostsUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("gates exactly the delete tool behind the destructive approval pill", () => {
    const destructive = buildHostsUiTools()
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual(["ui_delete_host"]);
  });

  it("marks every route-changing tool mayNavigate (delete drops the open host → /servers)", () => {
    const navigating = buildHostsUiTools()
      .filter((tool) => tool.mayNavigate === true)
      .map((tool) => tool.name);
    // set-servers is the only in-place mutation; the rest select/open/delete a
    // host and can commit a route change, so they hand off before navigating.
    expect(navigating).toEqual([
      "ui_create_host",
      "ui_open_host_editor",
      "ui_delete_host",
      "ui_duplicate_host",
    ]);
  });

  it("ships no one-shot host-config commit tool (config edits open the editor)", () => {
    const names = buildHostsUiTools().map((t) => t.name);
    expect(names).not.toContain("ui_update_host");
    // The editor tool never carries config in its schema — only a host ref.
    const editor = getTool("ui_open_host_editor");
    expect(Object.keys(editor.inputSchema?.properties ?? {})).toEqual(["host"]);
  });

  it("keeps the system prompt out of every input schema", () => {
    for (const tool of buildHostsUiTools()) {
      const json = JSON.stringify(tool.inputSchema ?? {}).toLowerCase();
      expect(json).not.toContain("systemprompt");
      expect(json).not.toContain("prompt");
    }
  });

  it("ui_create_host dispatches createHost and requires a name", async () => {
    await getTool("ui_create_host").execute({ name: "My Claude", template: "claude" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "createHost",
      payload: { name: "My Claude", template: "claude" },
    });

    // Template is optional.
    dispatchInspectorCommandMock.mockClear();
    await getTool("ui_create_host").execute({ name: "Bare" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "createHost",
      payload: { name: "Bare" },
    });

    dispatchInspectorCommandMock.mockClear();
    const noName = await getTool("ui_create_host").execute({ template: "claude" });
    expect(noName.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_open_host_editor dispatches openHostEditor and requires a host", async () => {
    await getTool("ui_open_host_editor").execute({ host: "Claude" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "openHostEditor",
      payload: { host: "Claude" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_open_host_editor").execute({ host: "  " });
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_set_host_servers dispatches setHostServers with the server list", async () => {
    await getTool("ui_set_host_servers").execute({
      host: "Claude",
      servers: ["Asana", "GitHub"],
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "setHostServers",
      payload: { host: "Claude", servers: ["Asana", "GitHub"] },
    });

    // Empty array is valid (detach all).
    dispatchInspectorCommandMock.mockClear();
    await getTool("ui_set_host_servers").execute({ host: "Claude", servers: [] });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "setHostServers",
      payload: { host: "Claude", servers: [] },
    });
  });

  it("ui_set_host_servers rejects a non-array or a blank name without dispatching", async () => {
    const notArray = await getTool("ui_set_host_servers").execute({
      host: "Claude",
      servers: "Asana",
    });
    expect(notArray.isError).toBe(true);

    const blank = await getTool("ui_set_host_servers").execute({
      host: "Claude",
      servers: ["Asana", "  "],
    });
    expect(blank.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_delete_host dispatches deleteHost and requires a host", async () => {
    await getTool("ui_delete_host").execute({ host: "host-123" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "deleteHost",
      payload: { host: "host-123" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_delete_host").execute({});
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_duplicate_host dispatches duplicateHost with an optional name", async () => {
    await getTool("ui_duplicate_host").execute({ host: "Claude", name: "Claude copy" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "duplicateHost",
      payload: { host: "Claude", name: "Claude copy" },
    });

    dispatchInspectorCommandMock.mockClear();
    await getTool("ui_duplicate_host").execute({ host: "Claude" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "duplicateHost",
      payload: { host: "Claude" },
    });
  });

  it("surfaces unknown-host command errors (invalid_request) as tool errors", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "invalid_request",
        message: 'No host matches "Nope".',
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_open_host_editor").execute({ host: "Nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_request");
  });
});
