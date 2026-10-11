import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePluginMessage } from "../use-plugin-message";

const intent = () => ({
  instanceToken: "x".repeat(43),
  operationId: crypto.randomUUID(),
  sourceThreadId: "old",
  params: {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Fixture" }],
  },
});
const fixture = () => ({
  scope: "old-scope",
  threadId: "old",
  disabled: false,
  gates: [
    vi.fn(async () => true),
    vi.fn(async () => true),
    vi.fn(async () => true),
  ],
  send: vi.fn(async (_payload: unknown, _isCurrent: () => boolean) => true),
  onSent: vi.fn(),
  prepareNew: vi.fn(
    async (value: ReturnType<typeof intent>, _live: () => boolean) => ({
      ...value,
      preparationToken: "p".repeat(43),
    }),
  ),
});
describe("owned app message dispatch", () => {
  it("never sends on render or replay, and checks the ordinary gates before the active send", async () => {
    const f = fixture();
    const input = intent();
    const view = renderHook((props) => usePluginMessage(props), {
      initialProps: f,
    });
    view.rerender({ ...f });
    expect(f.send).not.toHaveBeenCalled();
    await act(async () =>
      expect(await view.result.current.send(input, () => true)).toBe(true),
    );
    expect(f.gates.every((gate) => gate.mock.calls.length === 1)).toBe(true);
    expect(f.send.mock.calls[0][0]).toEqual(input);
    expect(f.send.mock.calls[0][1]()).toBe(true);
    expect(f.onSent).toHaveBeenCalledOnce();
  });
  it.each(["disabled", "foreign-thread", "source-closed"])(
    "refuses %s before a gate",
    async (state) => {
      const f = fixture();
      f.disabled = state === "disabled";
      const input = intent();
      if (state === "foreign-thread") input.sourceThreadId = "foreign";
      const view = renderHook(() => usePluginMessage(f));
      await act(async () =>
        expect(
          await view.result.current.send(
            input,
            () => state !== "source-closed",
          ),
        ).toBe(false),
      );
      expect(f.gates[0]).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it.each(["cancel", "scope", "disabled"])(
    "fences %s while readiness is pending",
    async (state) => {
      const f = fixture();
      let finish!: (ready: boolean) => void;
      let live = true;
      f.gates[0].mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const view = renderHook((props) => usePluginMessage(props), {
        initialProps: f,
      });
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = view.result.current.send(intent(), () => live);
      });
      if (state === "cancel") live = false;
      view.rerender({
        ...f,
        scope: state === "scope" ? "other" : f.scope,
        disabled: state === "disabled",
      });
      await act(async () => {
        finish(true);
        expect(await pending).toBe(false);
      });
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("keeps entry busy refusal even when ongoing admission excludes own preparation", async () => {
    const f = fixture();
    const view = renderHook(() =>
      usePluginMessage({
        ...f,
        disabled: true,
        liveBlocked: false,
      }),
    );
    await expect(view.result.current.send(intent(), () => true)).resolves.toBe(
      false,
    );
    expect(f.gates[0]).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["own-preparation", "hard-denial", "scope", "source"])(
    "revalidates %s through readiness rerenders without confusing its own busy state",
    async (state) => {
      const f = fixture();
      let finish!: (ready: boolean) => void;
      let sourceLive = true;
      f.gates[0].mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const view = renderHook((props) => usePluginMessage(props), {
        initialProps: { ...f, liveBlocked: false },
      });
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = view.result.current.send(intent(), () => sourceLive);
      });
      // Readiness deliberately flushes the spinner/composer busy state before
      // its await returns; clearing that state may render only after delivery.
      view.rerender({
        ...f,
        disabled: true,
        liveBlocked: state === "hard-denial",
        scope: state === "scope" ? "changed-owner" : f.scope,
      });
      if (state === "source") sourceLive = false;
      await act(async () => {
        finish(true);
        expect(await pending).toBe(state === "own-preparation");
      });
      expect(f.send).toHaveBeenCalledTimes(state === "own-preparation" ? 1 : 0);
      expect(f.onSent).toHaveBeenCalledTimes(
        state === "own-preparation" ? 1 : 0,
      );
    },
  );

  it("awaits a new owned chat and reads its current sender", async () => {
    const f = fixture();
    let finish!: (id: string) => void;
    let sourceLive = true;
    const newChat = {
      ownerScope: "owner",
      threadId: "old",
      begin: vi.fn(
        (_owned: () => boolean) =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const view = renderHook((props) => usePluginMessage(props), {
      initialProps: { ...f, newChat },
    });
    const input = {
      ...intent(),
      params: {
        ...intent().params,
        _meta: { "openai/message": { target: "new" as const } },
      },
    };
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.send(input, () => sourceLive);
    });
    await waitFor(() => expect(newChat.begin).toHaveBeenCalledOnce());
    expect(f.prepareNew).toHaveBeenCalledOnce();
    sourceLive = false; // The admitted transition may dispose its source.
    const send = vi.fn(async () => true);
    view.rerender({
      ...f,
      scope: "new-scope",
      threadId: "new",
      send,
      newChat: { ...newChat, threadId: "new" },
    });
    await act(async () => {
      finish("new");
      expect(await pending).toBe(true);
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
  it("shares one dispatch lock across App sources and prevents concurrent preparation", async () => {
    const f = fixture();
    const lock = { current: false };
    let finish!: (ready: boolean) => void;
    f.gates[0].mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderHook(() => ({
      message: usePluginMessage({ ...f, lock }),
      other: usePluginMessage({ ...f, lock }),
    }));
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.message.send(intent(), () => true);
    });
    await act(async () =>
      expect(await view.result.current.other.send(intent(), () => true)).toBe(
        false,
      ),
    );
    expect(f.gates[0]).toHaveBeenCalledOnce();
    await act(async () => {
      finish(true);
      expect(await pending).toBe(true);
    });
    expect(lock.current).toBe(false);
  });
  it("passes a live cancellation fence through async send preflight, with no retry", async () => {
    const f = fixture();
    let live = true;
    let finish!: () => void;
    f.send.mockImplementation(async (_payload, isCurrent) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return isCurrent();
    });
    const view = renderHook(() => usePluginMessage(f));
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.send(intent(), () => live);
    });
    live = false;
    await act(async () => {
      finish();
      expect(await pending).toBe(false);
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.onSent).not.toHaveBeenCalled();
  });
  it("unmount prevents dispatch after readiness", async () => {
    const f = fixture();
    let finish!: (ready: boolean) => void;
    f.gates[0].mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderHook(() => usePluginMessage(f));
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.send(intent(), () => true);
    });
    view.unmount();
    finish(true);
    expect(await pending).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("refuses draft send:false without sending or beginning a new chat", async () => {
    const f = fixture();
    const view = renderHook(() => usePluginMessage(f));
    const value = {
      ...intent(),
      params: {
        ...intent().params,
        _meta: { "openai/message": { send: false } },
      },
    };
    await expect(
      view.result.current.send(value as never, () => true),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.prepareNew).not.toHaveBeenCalled();
  });
  it("refuses source closure during transfer preparation before changing chats", async () => {
    const f = fixture();
    let live = true;
    f.prepareNew.mockImplementation(async (value) => {
      live = false;
      return { ...value, preparationToken: "p".repeat(43) };
    });
    const begin = vi.fn(async () => "new");
    const view = renderHook(() =>
      usePluginMessage({
        ...f,
        newChat: { ownerScope: "owner", threadId: "old", begin },
      }),
    );
    const value = {
      ...intent(),
      params: {
        ...intent().params,
        _meta: { "openai/message": { target: "new" as const } },
      },
    };
    await act(async () =>
      expect(await view.result.current.send(value, () => live)).toBe(false),
    );
    expect(begin).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
