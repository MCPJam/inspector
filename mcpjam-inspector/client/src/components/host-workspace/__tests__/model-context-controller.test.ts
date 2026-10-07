import { describe, expect, it, vi } from "vitest";
import {
  createModelContextController,
  PluginContextUpdateRejected,
} from "../model-context-controller";
const result = (id: string) => ({
  _meta: { "openai/modelContext": { updateId: id } },
});
describe("context replace queue", () => {
  it("reconciles an uncertain removal only through an explicit fresh read and never repeats the effect", async () => {
    const onSnapshot = vi.fn();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce({ revision: 2, sequence: 1, state: null });
    const remove = vi.fn().mockRejectedValue(new Error("lost acknowledgement"));
    const send = vi.fn().mockResolvedValue({
      ...result("next"),
      snapshot: {
        revision: 3,
        sequence: 2,
        state: {
          updateId: "next",
          content: [{ type: "text", text: "next" }],
        },
      },
    });
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoval: remove,
      read,
      onSnapshot,
    });
    update.restore({
      revision: 1,
      sequence: 1,
      state: { updateId: "first", content: [{ type: "text", text: "first" }] },
    });
    await expect(update.remove("first", 0)).rejects.toThrow(
      "lost acknowledgement",
    );
    expect(read).not.toHaveBeenCalled();
    await expect(update.refresh()).rejects.toThrow("read failed");
    await expect(update({})).rejects.toThrow("outcome unknown");
    await update.refresh();
    await update({ content: [{ type: "text", text: "next" }] });
    expect(read).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].sequence).toBe(2);
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
  it("restores the server cursor, serializes removal with replacements and ignores older snapshots", async () => {
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
      },
    }));
    let finish!: (value: unknown) => void;
    const remove = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoval: remove,
      onSnapshot: snapshots,
    });
    update.restore({ revision: 3, sequence: 2, state: state("old", "first") });
    const removing = update.remove("old", 0);
    const replacing = update({
      content: [{ type: "text", text: "replacement" }],
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
    finish({ revision: 4, sequence: 2, state: null });
    await Promise.all([removing, replacing]);
    expect(send.mock.calls[0][0].sequence).toBe(3);
    expect(snapshots.mock.lastCall![0]).toMatchObject({
      revision: 5,
      sequence: 3,
      state: { updateId: "new" },
    });
    update.restore({ revision: 4, sequence: 2, state: null });
    expect(snapshots.mock.lastCall![0].revision).toBe(5);
    await expect(update.remove("old", 0)).rejects.toThrow("changed");
    expect(remove).toHaveBeenCalledOnce();
  });
  it("does not retry an uncertain removal or mutate presentation optimistically", async () => {
    const snapshots = vi.fn();
    const send = vi.fn();
    const remove = vi.fn().mockRejectedValue(new Error("lost response"));
    const update = createModelContextController({
      requireLive: () => {},
      send,
      sendRemoval: remove,
      onSnapshot: snapshots,
    });
    update.restore({
      revision: 1,
      sequence: 1,
      state: { updateId: "old", content: [{ type: "text", text: "kept" }] },
    });
    await expect(update.remove("old", 0)).rejects.toThrow("lost response");
    await expect(update({})).rejects.toThrow("outcome unknown");
    expect(snapshots).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
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
});
