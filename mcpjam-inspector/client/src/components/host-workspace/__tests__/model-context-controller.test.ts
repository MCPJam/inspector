import { describe, expect, it, vi } from "vitest";
import {
  createModelContextController,
  PluginContextHeld,
  PluginContextNotPersisted,
  PluginContextUpdateRejected,
} from "../model-context-controller";
const result = (id: string) => ({
  _meta: { "openai/modelContext": { updateId: id } },
});
describe("context refused before it was stored", () => {
  it("lets the next, smaller update go at once", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new PluginContextNotPersisted("INSTANCE_CONTEXT_RATE_LIMITED"),
      )
      .mockResolvedValueOnce(result("second"));
    const update = createModelContextController({
      requireLive: () => {},
      send,
    });
    const refused = await update({ content: [] }).catch((error) => error);
    expect(refused).toBeInstanceOf(PluginContextUpdateRejected);
    expect(refused).toMatchObject({
      code: -32000,
      message: "The host could not persist the model context update",
    });
    await expect(update({ content: [] })).resolves.toEqual(result("second"));
    // The refused update never advanced the sequence.
    expect(send.mock.calls.map(([request]) => request.sequence)).toEqual([
      1, 1,
    ]);
  });

  it("refuses an update over the byte budget without sending it", async () => {
    const send = vi.fn().mockResolvedValue(result("small"));
    const onRefused = vi.fn();
    const update = createModelContextController({
      requireLive: () => {},
      send,
      onRefused,
    });
    const text = "x".repeat(300_000);
    expect(() => update({ content: [{ type: "text", text }] })).toThrow(
      PluginContextNotPersisted,
    );
    expect(send).not.toHaveBeenCalled();
    expect(onRefused.mock.calls[0][0]).toMatchObject({
      code: -32000,
      reason: "PLUGIN_CONTEXT_TOO_LARGE",
      excess: { budget: "updateMaxBytes", allowed: 256 * 1024 },
    });
    expect(onRefused.mock.calls[0][0].excess.actual).toBeGreaterThan(300_000);
    await expect(update({ content: [] })).resolves.toEqual(result("small"));
  });

  it("still holds updates whose outcome is unknown", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network"));
    const update = createModelContextController({
      requireLive: () => {},
      send,
    });
    await expect(update({ content: [] })).rejects.toThrow("network");
    await expect(update({ content: [] })).rejects.toThrow("outcome unknown");
  });
});

describe("context replace queue", () => {
  it("settles an unknown remove-all only by re-sending the same operation", async () => {
    const onSnapshot = vi.fn();
    const removed = {
      outcome: "applied",
      snapshot: {
        revision: 2,
        sequence: 1,
        state: null,
        held: true,
        cursor: 1,
        removedAt: 1,
        attachedAt: 0,
      },
    };
    const sendRemoveAll = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce(removed);
    const send = vi.fn().mockResolvedValue({
      ...result("next"),
      snapshot: {
        revision: 3,
        sequence: 2,
        state: { updateId: "next", content: [{ type: "text", text: "next" }] },
        cursor: 2,
        removedAt: 1,
        attachedAt: 2,
      },
    });
    let using = false;
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoveAll,
      onSnapshot,
      userAttaching: () => using,
    });
    update.restore({
      revision: 1,
      sequence: 1,
      state: { updateId: "first", content: [{ type: "text", text: "first" }] },
    });
    const operation = { operationId: "op", basis: 0 };
    await expect(update.removeAll(operation)).rejects.toThrow(
      "lost acknowledgement",
    );
    // Nothing may change while the outcome is unknown.
    await expect(update({})).rejects.toThrow("outcome unknown");
    expect(await update.removeAll(operation)).toBe("applied");
    expect(sendRemoveAll.mock.calls).toEqual([[operation], [operation]]);
    // The server's hold now refuses the App's own update without a request.
    await expect(update({})).rejects.toBeInstanceOf(PluginContextHeld);
    using = true;
    await update({ content: [{ type: "text", text: "next" }] });
    expect(send.mock.calls[0][0]).toMatchObject({
      sequence: 2,
      attach: "user",
    });
    expect(
      onSnapshot.mock.calls.map(([snapshot]) => snapshot.revision),
    ).toEqual([1, 2, 3]);
  });
  it("rejects contradictory or invalid restored cursors before publishing them", () => {
    const onSnapshot = vi.fn();
    const update = createModelContextController({
      requireLive: () => {},
      send: vi.fn(),
      onSnapshot,
    });
    expect(() =>
      update.restore({ revision: 0, sequence: 1, state: null }),
    ).toThrow();
    update.restore({ revision: 1, sequence: 1, state: null });
    expect(() =>
      update.restore({
        revision: 1,
        sequence: 1,
        state: { updateId: "forged", content: [] },
      }),
    ).toThrow("revision");
    expect(onSnapshot).toHaveBeenCalledOnce();
  });
  it("serializes remove-all with replacements and ignores older snapshots", async () => {
    const snapshots = vi.fn();
    const state = (id: string, text: string) => ({
      updateId: id,
      content: [{ type: "text", text }],
    });
    const send = vi.fn(async (request) => ({
      ...result("new"),
      snapshot: {
        revision: 5,
        sequence: request.sequence,
        state: state("new", "replacement"),
        cursor: 2,
        removedAt: 1,
        attachedAt: 2,
      },
    }));
    let finish!: (value: unknown) => void;
    const sendRemoveAll = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoveAll,
      onSnapshot: snapshots,
      // The replacement comes from the person using the App, so it may
      // follow their removal.
      userAttaching: () => true,
    });
    update.restore({ revision: 3, sequence: 2, state: state("old", "first") });
    const removing = update.removeAll({ operationId: "op", basis: 0 });
    const replacing = update({
      content: [{ type: "text", text: "replacement" }],
    });
    await vi.waitFor(() => expect(sendRemoveAll).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
    finish({
      outcome: "applied",
      snapshot: {
        revision: 4,
        sequence: 2,
        state: null,
        held: true,
        cursor: 1,
        removedAt: 1,
      },
    });
    await Promise.all([removing, replacing]);
    expect(send.mock.calls[0][0]).toMatchObject({
      sequence: 3,
      attach: "user",
    });
    expect(snapshots.mock.lastCall![0]).toMatchObject({
      revision: 5,
      sequence: 3,
      state: { updateId: "new" },
    });
    update.restore({ revision: 4, sequence: 2, state: null });
    expect(snapshots.mock.lastCall![0].revision).toBe(5);
  });
  it("does not retry an unknown remove-all on its own or change presentation optimistically", async () => {
    const snapshots = vi.fn();
    const send = vi.fn();
    const sendRemoveAll = vi.fn().mockRejectedValue(new Error("lost response"));
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoveAll,
      onSnapshot: snapshots,
    });
    update.restore({
      revision: 1,
      sequence: 1,
      state: { updateId: "old", content: [{ type: "text", text: "kept" }] },
    });
    await expect(
      update.removeAll({ operationId: "op", basis: 0 }),
    ).rejects.toThrow("lost response");
    await expect(update({})).rejects.toThrow("outcome unknown");
    expect(snapshots).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(sendRemoveAll).toHaveBeenCalledOnce();
  });
  it("leaves the App unheld when the person's newer context was kept", async () => {
    const send = vi.fn(async (request) => result(`u${request.sequence}`));
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoveAll: vi.fn(async () => ({
        outcome: "stale",
        snapshot: {
          revision: 3,
          sequence: 2,
          state: { updateId: "u2", content: [{ type: "text", text: "new" }] },
          cursor: 1,
          attachedAt: 1,
        },
      })),
      userAttaching: () => false,
    });
    expect(await update.removeAll({ operationId: "op", basis: 0 })).toBe(
      "stale",
    );
    await update({ content: [{ type: "text", text: "own" }] });
    expect(send).toHaveBeenCalledOnce();
  });
  it("snapshots queued params and does not dispatch the second update before the first settles", async () => {
    let finish!: (value: unknown) => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(result("second"));
    const update = createModelContextController({
      requireLive: () => {},
      send,
    });
    const params = { content: [{ type: "text", text: "first" }] };
    const first = update(params);
    const second = update({ structuredContent: { second: true } });
    params.content[0].text = "changed";
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0].params.content[0].text).toBe("first");
    finish(result("first"));
    await Promise.all([first, second]);
    expect(send.mock.calls.map(([request]) => request.sequence)).toEqual([
      1, 2,
    ]);
  });
  it("allows a known precommit denial but fences uncertain delivery without retry", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new PluginContextUpdateRejected("unsupported"))
      .mockResolvedValueOnce(result("accepted"))
      .mockRejectedValueOnce(new Error("lost response"));
    const update = createModelContextController({
      requireLive: () => {},
      send,
    });
    await expect(update({})).rejects.toThrow("unsupported");
    await update({});
    await expect(update({})).rejects.toThrow("lost response");
    await expect(update({})).rejects.toThrow("outcome unknown");
    expect(send.mock.calls.map(([request]) => request.sequence)).toEqual([
      1, 1, 2,
    ]);
  });
  it("rejects invalid content before transport and checks lifetime again after delivery", async () => {
    let alive = true;
    const send = vi.fn(async () => {
      alive = false;
      return result("late");
    });
    const update = createModelContextController({
      requireLive: () => {
        if (!alive) throw new Error("closed");
      },
      send,
    });
    expect(() =>
      update({
        content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      }),
    ).toThrow("UNSUPPORTED");
    expect(send).not.toHaveBeenCalled();
    await expect(update({})).rejects.toThrow("closed");
  });
  it("keeps a removal removed until the person uses the App again", async () => {
    let using = false;
    const onHeld = vi.fn();
    const send = vi.fn(async (request) => ({
      ...result(`u${request.sequence}`),
      snapshot: {
        revision: request.sequence + 1,
        sequence: request.sequence,
        state: {
          updateId: `u${request.sequence}`,
          content: [{ type: "text", text: "view" }],
        },
      },
    }));
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoveAll: vi.fn(async () => ({
        outcome: "applied",
        snapshot: {
          revision: 2,
          sequence: 1,
          state: null,
          held: true,
          cursor: 1,
          removedAt: 1,
        },
      })),
      onSnapshot: () => {},
      userAttaching: () => using,
      onHeld,
    });
    update.restore({
      revision: 1,
      sequence: 1,
      state: { updateId: "u1", content: [{ type: "text", text: "view" }] },
    });
    await update.removeAll({ operationId: "op", basis: 0 });
    // The App re-sends its view on its own (Bits & Bolts redraws): refused
    // here, without a request, and not an unknown outcome.
    const view = { content: [{ type: "text", text: "view" }] };
    await expect(update(view)).rejects.toBeInstanceOf(PluginContextHeld);
    expect(send).not.toHaveBeenCalled();
    expect(onHeld).toHaveBeenCalledOnce();
    // The person clicks into the App and attaches again.
    using = true;
    await update(view);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 2, attach: "user" }),
    );
    // Attached again, the App's own updates flow as before.
    using = false;
    await update(view);
    expect(send.mock.lastCall![0]).not.toHaveProperty("attach");
  });
  it("learns a hold from the server after a remount", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new PluginContextHeld("held"))
      .mockResolvedValueOnce(result("u2"));
    const update = createModelContextController({
      requireLive: () => {},
      send,
      userAttaching: () => false,
    });
    await expect(update({})).rejects.toBeInstanceOf(PluginContextHeld);
    await expect(update({})).rejects.toBeInstanceOf(PluginContextHeld);
    expect(send).toHaveBeenCalledOnce();
  });
});
