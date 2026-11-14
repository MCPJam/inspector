import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getAppDraftInteractivity } from "../use-chat-stop-controls";
import { useChatThreadTransition } from "../use-chat-thread-transition";
import { usePluginMessage } from "../use-plugin-message";
import type { PluginMessageIntent } from "@/shared/plugin-message";

const draftIntent = (
  target: "active" | "new" = "active",
  content: unknown[] = [{ type: "text", text: "Draft" }],
) =>
  ({
    instanceToken: "x".repeat(43),
    operationId: crypto.randomUUID(),
    sourceThreadId: "old",
    params: {
      role: "user",
      content,
      _meta: { "openai/message": { target, send: false } },
    },
  }) as PluginMessageIntent;

const fixture = () => ({
  scope: "old-scope",
  threadId: "old",
  // Sending is unavailable (out of credits, harness down): a draft must not care.
  disabled: true,
  liveBlocked: true,
  draftBlocked: false,
  newDraftBlocked: false,
  gates: [vi.fn(async () => true)],
  send: vi.fn(async () => true),
  onSent: vi.fn(),
  prepareNew: vi.fn(async (value: PluginMessageIntent) => value),
  draft: vi.fn(
    async (_payload: PluginMessageIntent, _isCurrent: () => boolean) => true,
  ),
  newChat: {
    ownerScope: "owner",
    threadId: "old",
    begin: vi.fn(async () => "new" as string | null),
  },
});

describe("draft readiness", () => {
  it("waits on ownership, read-only and transitions, never on send readiness", () => {
    const ready = {
      readOnly: false,
      transitioning: false,
      sendInFlight: false,
      isStreamingActive: false,
    };
    expect(getAppDraftInteractivity(ready)).toEqual({
      draftBlocked: false,
      newDraftBlocked: false,
    });
    expect(
      getAppDraftInteractivity({ ...ready, isStreamingActive: true }),
    ).toEqual({ draftBlocked: false, newDraftBlocked: true });
    for (const state of ["readOnly", "transitioning", "sendInFlight"] as const)
      expect(getAppDraftInteractivity({ ...ready, [state]: true })).toEqual({
        draftBlocked: true,
        newDraftBlocked: true,
      });
  });
});

describe("owned App draft dispatch", () => {
  it("places an active draft while sending is unavailable, with no gate, preparation or send", async () => {
    const f = fixture();
    const view = renderHook(() => usePluginMessage(f));
    const input = draftIntent();
    await act(async () =>
      expect(await view.result.current.send(input, () => true)).toBe(true),
    );
    expect(f.draft).toHaveBeenCalledOnce();
    expect(f.draft.mock.calls[0][0]).toEqual(input);
    expect(f.gates[0]).not.toHaveBeenCalled();
    expect(f.prepareNew).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.onSent).not.toHaveBeenCalled();
  });

  it.each(["view-only", "restoring a target"])(
    "refuses a draft while %s",
    async () => {
      const f = { ...fixture(), draftBlocked: true };
      const view = renderHook(() => usePluginMessage(f));
      await act(async () =>
        expect(await view.result.current.send(draftIntent(), () => true)).toBe(
          false,
        ),
      );
      expect(f.draft).not.toHaveBeenCalled();
    },
  );

  it("refuses a draft in a new chat while a turn streams, but not in the active chat", async () => {
    const f = { ...fixture(), newDraftBlocked: true };
    const view = renderHook(() => usePluginMessage(f));
    await act(async () =>
      expect(
        await view.result.current.send(draftIntent("new"), () => true),
      ).toBe(false),
    );
    expect(f.newChat.begin).not.toHaveBeenCalled();
    await act(async () =>
      expect(await view.result.current.send(draftIntent(), () => true)).toBe(
        true,
      ),
    );
  });

  it("rejects an invalid draft before the chat changes", async () => {
    const f = fixture();
    const view = renderHook(() => usePluginMessage(f));
    const input = draftIntent("new", [
      { type: "text", text: "kept?" },
      { type: "audio", mimeType: "audio/wav", data: "AQID" },
    ]);
    await act(async () => {
      await expect(
        view.result.current.send(input, () => true),
      ).rejects.toThrow();
    });
    expect(f.newChat.begin).not.toHaveBeenCalled();
    expect(f.draft).not.toHaveBeenCalled();
  });

  it("lets one App's draft through at a time", async () => {
    const f = fixture();
    let place!: (placed: boolean) => void;
    f.draft.mockReturnValueOnce(
      new Promise((resolve) => {
        place = resolve;
      }),
    );
    const view = renderHook(() => usePluginMessage(f));
    let first!: Promise<boolean>;
    await act(async () => {
      first = view.result.current.send(draftIntent(), () => true);
    });
    await act(async () =>
      expect(await view.result.current.send(draftIntent(), () => true)).toBe(
        false,
      ),
    );
    await act(async () => place(true));
    await expect(first).resolves.toBe(true);
    expect(f.draft).toHaveBeenCalledOnce();
  });
});

describe("a draft in a new chat", () => {
  function transitionFixture(reset: () => Promise<boolean>) {
    const draft = vi.fn(
      async (_p: PluginMessageIntent, isCurrent: () => boolean) => isCurrent(),
    );
    const view = renderHook(
      (props: { threadId: string; ownerScope: string; timeoutMs?: number }) => {
        const transition = useChatThreadTransition({ ...props, begin: reset });
        return usePluginMessage({
          threadId: props.threadId,
          scope: `${props.ownerScope}:${props.threadId}`,
          disabled: true,
          liveBlocked: true,
          draftBlocked: false,
          gates: [],
          send: vi.fn(async () => true),
          draft,
          newChat: {
            ownerScope: props.ownerScope,
            threadId: props.threadId,
            begin: transition.begin,
          },
        });
      },
      { initialProps: { threadId: "old", ownerScope: "owner" } },
    );
    return { view, draft };
  }

  it.each(["ready", "owner-changed"])(
    "survives the source App closing and fences a project or client switch (%s)",
    async (outcome) => {
      const reset = vi.fn(async () => true);
      const { view, draft } = transitionFixture(reset);
      let sourceLive = true;
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = view.result.current.send(
          draftIntent("new"),
          () => sourceLive,
        );
      });
      await waitFor(() => expect(reset).toHaveBeenCalledOnce());
      sourceLive = false; // The new-chat reset disposes the source App.
      await act(async () => {
        view.rerender({
          threadId: "new",
          ownerScope: outcome === "ready" ? "owner" : "other-project",
        });
      });
      await expect(pending).resolves.toBe(outcome === "ready");
      expect(draft).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
    },
  );

  it("places nothing when the person cancels the discard-draft dialog", async () => {
    const { view, draft } = transitionFixture(vi.fn(async () => false));
    await act(async () =>
      expect(
        await view.result.current.send(draftIntent("new"), () => true),
      ).toBe(false),
    );
    expect(draft).not.toHaveBeenCalled();
  });

  it("waits out a discard-draft dialog left open past the transition bound", async () => {
    vi.useFakeTimers();
    try {
      let decide!: (discard: boolean) => void;
      const reset = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            decide = resolve;
          }),
      );
      const { view, draft } = transitionFixture(reset);
      view.rerender({ threadId: "old", ownerScope: "owner", timeoutMs: 50 });
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = view.result.current.send(draftIntent("new"), () => true);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await act(async () => decide(true));
      await act(async () => {
        view.rerender({ threadId: "new", ownerScope: "owner", timeoutMs: 50 });
      });
      await expect(pending).resolves.toBe(true);
      expect(draft).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
