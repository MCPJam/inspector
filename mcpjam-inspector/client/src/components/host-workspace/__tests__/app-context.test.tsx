import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appContextBlock, useAppContext } from "../use-app-context";
import { pluginContextAttachments } from "@/shared/plugin-model-context";
import {
  ThreadAppError,
  type ThreadAppHandle,
  type ThreadAppScope,
} from "../thread-app-api";
const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../thread-app-api", async (original) => ({
  ...(await original<typeof import("../thread-app-api")>()),
  createThreadAppApi: () => ({ context }),
}));
// Retry an unknown removal without waiting.
vi.mock("../context-remove-all", async (original) => {
  const actual = await original<typeof import("../context-remove-all")>();
  return {
    ...actual,
    removeAllAppContext: (
      send: Parameters<typeof actual.removeAllAppContext>[0],
      signal: AbortSignal,
    ) => actual.removeAllAppContext(send, signal, [0, 0]),
  };
});
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
const view = (text: string, updateId = "u1") => ({
  updateId,
  content: [{ type: "text", text }],
});
const removed = (revision: number, cursor = 1) => ({
  outcome: "applied",
  snapshot: {
    revision,
    sequence: 1,
    state: null,
    held: true,
    cursor,
    removedAt: cursor,
  },
});
const opened = (state: unknown, extra: Record<string, unknown> = {}) =>
  ({
    ...handle,
    contextSnapshot: { revision: 1, sequence: 1, state, ...extra },
  }) as ThreadAppHandle;
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
    context.mockReset().mockResolvedValueOnce({
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
    // Rows are removed as a group, never one by one.
    expect(result.current.attachments[0]?.remove).toBeUndefined();
    expect(result.current.snapshot.state).toEqual(state);
    const attachments = result.current.attachments;
    rerender();
    expect(result.current.attachments).toBe(attachments);
    context.mockResolvedValueOnce(removed(2));
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(result.current.detached).toBe(false));
    expect(result.current.attachments).toEqual([]);
    expect(result.current.snapshot.state).toBeNull();
    const update = result.current.update;
    unmount();
    await Promise.resolve();
    await expect(update({ content: [] })).rejects.toThrow();
    expect(context).toHaveBeenCalledTimes(2);
  });
  it("presents each block by type and removes all of an App's context in one request", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const state = {
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
    context.mockReset().mockResolvedValue(removed(5, 3));
    const { result } = renderHook(() =>
      useAppContext(scope, opened(state, { cursor: 2, attachedAt: 2 }), "", {
        serverName: "Bits & Bolts",
        icons: { logo: chipLogo },
        serverIcons: chipServerIcons,
      }),
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
    await vi.waitFor(() => expect(result.current.detached).toBe(false));
    expect(result.current.attachments).toEqual([]);
    // One request, based on what the person saw; the server clears the
    // hidden block too.
    expect(context).toHaveBeenCalledOnce();
    expect(context).toHaveBeenCalledWith(
      "token",
      "remove-all",
      { operationId: expect.any(String), basis: 2 },
      expect.any(AbortSignal),
    );
  });

  it.each([
    "PLUGIN_CONTEXT_TOO_LARGE",
    "PLUGIN_CONTEXT_MEMORY_LIMIT",
    "INSTANCE_CONTEXT_RATE_LIMITED",
    "INSTANCE_CONTEXT_TOO_LARGE",
    "INVALID_INSTANCE_CONTEXT",
    "RATE_LIMITED",
  ])(
    "answers a %s refusal with -32000 and sends the next update at once",
    async (code) => {
      context
        .mockReset()
        .mockRejectedValueOnce(new ThreadAppError(code))
        .mockResolvedValueOnce({
          _meta: { "openai/modelContext": { updateId: "u2" } },
          snapshot: { revision: 2, sequence: 2, state: view("Smaller", "u2") },
        });
      const { result } = renderHook(() =>
        useAppContext(scope, opened(view("Selected view"))),
      );
      let refused: unknown;
      await act(async () => {
        refused = await result.current
          .update({ content: [{ type: "text", text: "Larger" }] })
          .catch((error: unknown) => error);
      });
      expect(refused).toMatchObject({
        code: -32000,
        message: "The host could not persist the model context update",
      });
      // The composer keeps the last acknowledged context.
      expect(result.current.snapshot.state).toEqual(view("Selected view"));
      await act(async () => {
        await result.current.update({
          content: [{ type: "text", text: "Smaller" }],
        });
      });
      expect(result.current.snapshot.state).toEqual(view("Smaller", "u2"));
    },
  );

  it("removes all after an earlier change failed, without a separate read", async () => {
    // An App update whose outcome is unknown refuses later updates, but a
    // remove-all settles it.
    const state = {
      ...view("Selected view"),
      structuredContent: { part: "t" },
    };
    context.mockReset().mockImplementation(async (_token, action: string) => {
      if (action === "update") throw new Error("network");
      if (action === "remove-all") return removed(2);
      throw new Error(action);
    });
    const { result } = renderHook(() => useAppContext(scope, opened(state)));
    await act(async () => {
      await result.current.update({ content: [] }).catch(() => {});
    });
    expect(result.current.attachments).toHaveLength(2);
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(result.current.detached).toBe(false));
    expect(result.current.attachments).toEqual([]);
    // The App is told nothing is attached.
    expect(result.current.snapshot.state).toBeNull();
    expect(result.current.error).toBeUndefined();
  });

  it("tells the App null exactly once when a removal is applied", async () => {
    let finish!: (value: unknown) => void;
    context
      .mockReset()
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const seen: unknown[] = [];
    const { result } = renderHook(() => {
      const value = useAppContext(scope, opened(view("Selected view")));
      if (seen.at(-1) !== value.snapshot.state) seen.push(value.snapshot.state);
      return value;
    });
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    // In flight: no turn carries it, and the App already sees null.
    expect(result.current.detached).toBe(true);
    expect(result.current.snapshot.state).toBeNull();
    await act(async () => finish(removed(2)));
    await vi.waitFor(() => expect(result.current.detached).toBe(false));
    expect(result.current.snapshot.state).toBeNull();
    expect(seen.filter((state) => state === null)).toHaveLength(1);
  });

  it("keeps a lost acknowledgement out of turns until the same operation is confirmed", async () => {
    let confirm!: (value: unknown) => void;
    context
      .mockReset()
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (confirm = resolve)),
      );
    const { result } = renderHook(() =>
      useAppContext(scope, opened(view("Selected view"))),
    );
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(context).toHaveBeenCalledTimes(2));
    // The first answer was lost and the retry hasn't answered: still out.
    expect(result.current.detached).toBe(true);
    expect(result.current.snapshot.state).toBeNull();
    await act(async () => confirm(removed(2)));
    await vi.waitFor(() => expect(result.current.detached).toBe(false));
    // The retry re-sent the same operation and basis.
    expect(context.mock.calls[1]![2]).toEqual(context.mock.calls[0]![2]);
    expect(result.current.attachments).toEqual([]);
  });

  it("keeps the person's newer context when they attached again before the removal was confirmed", async () => {
    const newer = view("New view", "u2");
    context
      .mockReset()
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce({
        outcome: "superseded",
        snapshot: {
          revision: 3,
          sequence: 2,
          state: newer,
          cursor: 2,
          removedAt: 1,
          attachedAt: 2,
        },
      });
    const { result } = renderHook(() =>
      useAppContext(scope, opened(view("Selected view"))),
    );
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(result.current.detached).toBe(false));
    expect(result.current.snapshot.state).toEqual(newer);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.error).toBeUndefined();
  });

  it("shows a stale removal's current context but keeps it out of turns until the App replaces it", async () => {
    const newer = view("New view", "u2");
    context.mockReset().mockResolvedValueOnce({
      outcome: "stale",
      snapshot: {
        revision: 2,
        sequence: 2,
        state: newer,
        cursor: 1,
        attachedAt: 1,
      },
    });
    const { result } = renderHook(() =>
      useAppContext(scope, opened(view("Selected view"))),
    );
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() =>
      expect(result.current.error).toMatch(/changed before it was removed/),
    );
    // Visible so the person can review it and remove it again, yet no turn
    // carries it.
    expect(result.current.detached).toBe(true);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.snapshot.state).toEqual(newer);
    // The App replaces its context (a later revision): attached again.
    context.mockResolvedValueOnce({
      revision: 3,
      sequence: 3,
      state: view("Latest", "u3"),
      cursor: 2,
      attachedAt: 2,
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.detached).toBe(false);
  });

  it("keeps an unconfirmed removal out of turns and offers it again once retries run out", async () => {
    let fail!: (error: Error) => void;
    context
      .mockReset()
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => (fail = reject)),
      )
      .mockRejectedValue(new Error("unavailable"));
    const { result } = renderHook(() =>
      useAppContext(scope, opened(view("Selected view"))),
    );
    expect(result.current.detached).toBe(false);
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    // While it is in flight, nothing of it is shown, sent or reported to the
    // App.
    expect(result.current.detached).toBe(true);
    expect(result.current.attachments).toEqual([]);
    expect(result.current.snapshot.state).toBeNull();
    await act(async () => fail(new Error("unavailable")));
    await vi.waitFor(() =>
      expect(result.current.error).toMatch(/Couldn't confirm/),
    );
    expect(context).toHaveBeenCalledTimes(3);
    // Still out of turns, even past later revisions; shown so the person
    // can remove it again.
    expect(result.current.detached).toBe(true);
    expect(result.current.attachments).toHaveLength(1);
    context.mockReset().mockResolvedValueOnce(removed(2));
    await act(async () => {
      result.current.attachments[0]!.group!.removeAll!();
    });
    await vi.waitFor(() => expect(result.current.detached).toBe(false));
    expect(result.current.attachments).toEqual([]);
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
