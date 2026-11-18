import { beforeEach, describe, expect, it, vi } from "vitest";
import type { openLocalMrtrStream } from "@/lib/mrtr/local-stream";

const mocks = vi.hoisted(() => ({ open: vi.fn<typeof openLocalMrtrStream>() }));
vi.mock("@/lib/mrtr/local-stream", () => ({ openLocalMrtrStream: mocks.open }));
import { useMrtrElicitationStore } from "../mrtr-elicitation-store";

const round = {
  opId: "op",
  roundKey: "op:1",
  round: 1,
  requests: [],
  timestamp: "now",
};
const close = vi.fn();
const respond = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  useMrtrElicitationStore.getState().__reset();
  vi.clearAllMocks();
  respond.mockResolvedValue(undefined);
  mocks.open.mockReturnValue({ close, respond });
});

describe("local MRTR stream lifetime", () => {
  it("shares one socket across hosts and releases only after the last host", () => {
    const first = useMrtrElicitationStore.getState().connect();
    const second = useMrtrElicitationStore.getState().connect();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    first();
    expect(close).not.toHaveBeenCalled();
    second();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not let repeated StrictMode cleanup close a replacement socket", () => {
    const first = useMrtrElicitationStore.getState().connect();
    first();
    const replacementClose = vi.fn();
    mocks.open.mockReturnValue({ close: replacementClose, respond });
    const second = useMrtrElicitationStore.getState().connect();
    first();
    expect(replacementClose).not.toHaveBeenCalled();
    second();
    expect(replacementClose).toHaveBeenCalledTimes(1);
  });

  it("preserves the same round draft and clears one absent from the authoritative snapshot", () => {
    const release = useMrtrElicitationStore.getState().connect();
    const callbacks = mocks.open.mock.calls[0][0];
    callbacks.onSnapshot([round]);
    useMrtrElicitationStore.getState().setCollection("op:1", 1, {
      q: { action: "accept", content: { text: "draft" } },
    });
    callbacks.onSnapshot([round]);
    expect(
      useMrtrElicitationStore.getState().collection?.answers.q.content,
    ).toEqual({ text: "draft" });
    callbacks.onSnapshot([]);
    expect(useMrtrElicitationStore.getState().rounds).toEqual([]);
    expect(useMrtrElicitationStore.getState().collection).toBeNull();
    release();
  });

  it("keeps a later round when an earlier answer acknowledgement arrives", async () => {
    const release = useMrtrElicitationStore.getState().connect();
    const callbacks = mocks.open.mock.calls[0][0];
    callbacks.onSnapshot([round]);
    respond.mockImplementationOnce(async () =>
      callbacks.onEvent({
        ...round,
        type: "mrtr_input_request",
        round: 2,
        roundKey: "op:2",
      }),
    );
    await useMrtrElicitationStore
      .getState()
      .respond("op", { q: { action: "accept", content: {} } });
    expect(respond).toHaveBeenCalledWith("op", "op:1", {
      q: { action: "accept", content: {} },
    });
    expect(useMrtrElicitationStore.getState().rounds[0].roundKey).toBe("op:2");
    release();
  });

  it("keeps form and draft after an unacknowledged answer", async () => {
    const release = useMrtrElicitationStore.getState().connect();
    mocks.open.mock.calls[0][0].onSnapshot([round]);
    useMrtrElicitationStore
      .getState()
      .setCollection("op:1", 0, { q: { action: "accept" } });
    respond.mockRejectedValueOnce(new Error("Unknown outcome"));
    await expect(
      useMrtrElicitationStore
        .getState()
        .respond("op", { q: { action: "cancel" } }),
    ).rejects.toThrow("Unknown outcome");
    expect(useMrtrElicitationStore.getState().rounds).toHaveLength(1);
    expect(useMrtrElicitationStore.getState().collection?.roundKey).toBe(
      "op:1",
    );
    expect(useMrtrElicitationStore.getState().responding).toBe(false);
    expect(respond).toHaveBeenCalledWith("op", "op:1", {
      q: { action: "cancel" },
    });
    expect(respond).toHaveBeenCalledTimes(1);
    release();
  });
});
