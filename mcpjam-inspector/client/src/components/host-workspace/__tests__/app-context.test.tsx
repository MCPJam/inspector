import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appContextBlock, useAppContext } from "../use-app-context";
import { pluginContextAttachments } from "@/shared/plugin-model-context";
import type { ThreadAppHandle, ThreadAppScope } from "../thread-app-api";
const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../thread-app-api", () => ({
  createThreadAppApi: () => ({ context }),
}));
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { workspaceId: "workspace" },
} as ThreadAppScope;
const handle = {
  instanceId: "instance",
  instanceToken: "token",
  generation: 1,
  contextEnabled: true,
  toolTitle: "Parts",
} as ThreadAppHandle;
const chipLogo = {
  url: "https://cdn.example.invalid/logo.png",
  contentType: "image/png",
};
const chipServerIcons = [{ src: "https://cdn.example.invalid/server.png" }];
describe("retained App composer context", () => {
  it("survives StrictMode, renders shared attachment data and confirms removal before updating host state", async () => {
    const state = {
      updateId: "update",
      content: [
        {
          type: "text",
          text: "Selected triangle",
          _meta: { "openai/title": "Triangle" },
        },
      ],
    };
    context.mockResolvedValueOnce({
      _meta: { "openai/modelContext": { updateId: "update" } },
      snapshot: { revision: 1, sequence: 1, state },
    });
    const { result, unmount, rerender } = renderHook(
      () => useAppContext(scope, handle),
      {
        wrapper: StrictMode,
      },
    );
    await act(async () => {
      await result.current.update({ content: state.content });
    });
    expect(result.current.attachments[0]?.title).toBe("Triangle");
    expect(result.current.snapshot.state).toEqual(state);
    const attachments = result.current.attachments;
    rerender();
    expect(result.current.attachments).toBe(attachments);
    context.mockResolvedValueOnce({ revision: 2, sequence: 1, state: null });
    await act(async () => {
      result.current.attachments[0]!.remove();
    });
    expect(result.current.attachments).toEqual([]);
    expect(result.current.snapshot.state).toBeNull();
    const update = result.current.update;
    unmount();
    await Promise.resolve();
    await expect(update({ content: [] })).rejects.toThrow();
    expect(context).toHaveBeenCalledTimes(2);
  });
  it("presents each block by type and removes all of an App's context one block at a time", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    let state: { updateId: string; content: unknown[] } | null = {
      updateId: "u0",
      content: [
        {
          type: "text",
          text: "Inspecting the cap in mm.",
          _meta: { "openai/title": "Current view" },
        },
        {
          type: "resource_link",
          uri: "mcp://parts/joystick",
          name: "joystick",
          title: "Joystick cap reference",
        },
        {
          type: "resource",
          resource: {
            uri: "mcp://parts/joystick.json",
            mimeType: "application/json",
            text: "{}",
          },
        },
        { type: "image", mimeType: "image/png", data: png },
        { type: "text", text: '{"view":"iso"}' },
        {
          type: "text",
          text: "hidden",
          annotations: { audience: ["assistant"] },
        },
      ],
    };
    let revision = 1;
    context.mockReset().mockImplementation(
      async (_token: string, action: string, request: { index: number }) => {
        if (action !== "remove") throw new Error(action);
        state = {
          updateId: `u${revision}`,
          content: state!.content.filter((_, i) => i !== request.index),
        };
        revision++;
        return { revision, sequence: 1, state };
      },
    );
    const { result } = renderHook(() =>
      useAppContext(
        scope,
        {
          ...handle,
          contextSnapshot: { revision: 1, sequence: 1, state },
        } as ThreadAppHandle,
        "",
        {
          serverName: "Bits & Bolts",
          icons: { logo: chipLogo },
          serverIcons: chipServerIcons,
        },
      ),
    );
    const rows = result.current.attachments;
    expect(
      rows.map((row) => [row.title, row.block?.kind, row.block?.detail]),
    ).toEqual([
      ["Current view", "text", "Inspecting the cap in mm."],
      ["Joystick cap reference", "resource_link", "mcp://parts/joystick"],
      ["Data", "resource", "mcp://parts/joystick.json"],
      ["Image", "image", undefined],
      // Untitled JSON text gets a plain label and no raw JSON.
      ["Structured data", "text", undefined],
    ]);
    expect(rows[3]?.block).toMatchObject({
      format: "PNG",
      thumbnail: `data:image/png;base64,${png}`,
    });
    expect(new Set(rows.map((row) => row.group?.id))).toEqual(
      new Set(["instance"]),
    );
    // The Context chip names the App's plugin with its icons.
    expect(rows[0]?.group).toMatchObject({
      title: "Parts",
      serverName: "Bits & Bolts",
      icons: { logo: chipLogo },
      serverIcons: chipServerIcons,
    });
    await act(async () => {
      rows[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(result.current.attachments).toEqual([]));
    // Each visible block was removed explicitly; the hidden one stays.
    expect(context).toHaveBeenCalledTimes(5);
    expect(state!.content).toHaveLength(1);
  });

  it("removes all after an earlier change failed, reading the current state once", async () => {
    // An App update whose outcome is unknown used to leave every later
    // removal refused ("outcome unknown"), so "Remove all" kept the chip.
    const two = {
      updateId: "u1",
      content: [{ type: "text", text: "Selected view" }],
      structuredContent: { part: "triangle" },
    };
    let server: typeof two | null = two;
    context.mockReset().mockImplementation(
      async (_token: string, action: string, request: { index?: number }) => {
        if (action === "update") throw new Error("network");
        if (action === "read") return { revision: 1, sequence: 1, state: server };
        server =
          request.index === 1
            ? { ...server!, updateId: "u2", structuredContent: undefined as never }
            : null;
        return {
          revision: server ? 2 : 3,
          sequence: 1,
          state: server
            ? { updateId: server.updateId, content: server.content }
            : null,
        };
      },
    );
    const { result } = renderHook(() =>
      useAppContext(scope, {
        ...handle,
        contextSnapshot: { revision: 1, sequence: 1, state: two },
      } as ThreadAppHandle),
    );
    await act(async () => {
      await result.current.update({ content: [] }).catch(() => {});
    });
    expect(result.current.attachments).toHaveLength(2);
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(result.current.attachments).toEqual([]));
    // The App is told nothing is attached.
    expect(result.current.snapshot.state).toBeNull();
    expect(result.current.error).toBeUndefined();
    expect(server).toBeNull();
  });

  it("clears the chip and the App's view when the server can't confirm Remove all", async () => {
    const state = {
      updateId: "u1",
      content: [{ type: "text", text: "Selected view" }],
    };
    context.mockReset().mockRejectedValue(new Error("unavailable"));
    const { result } = renderHook(() =>
      useAppContext(scope, {
        ...handle,
        contextSnapshot: { revision: 1, sequence: 1, state },
      } as ThreadAppHandle),
    );
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(result.current.attachments).toEqual([]));
    // Nothing of it is shown, sent or reported to the App, and the user is
    // told the server didn't confirm.
    expect(result.current.snapshot.state).toBeNull();
    expect(result.current.error).toMatch(/Couldn't remove App context/);
  });

  it("labels untitled plain text with a short label", () => {
    const [item] = pluginContextAttachments({
      revision: 1,
      sequence: 1,
      state: {
        updateId: "u",
        content: [{ type: "text", text: "Selected: M6 hex bolt" }],
      },
    });
    expect(appContextBlock(item!)).toEqual({
      title: "Text",
      block: { kind: "text", detail: "Selected: M6 hex bolt", thumbnail: undefined },
    });
  });
});
