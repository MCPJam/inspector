import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatThreadTransition } from "../use-chat-thread-transition";
import { usePluginMessage } from "../use-plugin-message";
import type { PluginMessageIntent } from "@/shared/plugin-message";

describe("normal chat identity transition", () => {
  it("waits for the rendered destination after normal reset accepts", async () => {
    const reset = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      (props) => useChatThreadTransition({ ...props, begin: reset }),
      { initialProps: { threadId: "old", ownerScope: "owner" } },
    );
    let pending!: Promise<string | null>;
    await act(async () => {
      pending = result.current.begin(() => true);
    });
    rerender({ threadId: "new", ownerScope: "owner" });
    expect(await pending).toBe("new");
    expect(reset).toHaveBeenCalledTimes(1);
  });
  it("refuses stale sources and normal discard cancellation", async () => {
    const reset = vi.fn(async () => false);
    const { result } = renderHook(() =>
      useChatThreadTransition({
        threadId: "old",
        ownerScope: "owner",
        begin: reset,
      }),
    );
    expect(await result.current.begin(() => false)).toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(await result.current.begin(() => true)).toBeNull();
  });
  it("does not reset after source revocation before dispatch", async () => {
    let live = true;
    const reset = vi.fn(async () => true);
    const { result } = renderHook(() =>
      useChatThreadTransition({
        threadId: "old",
        ownerScope: "owner",
        begin: reset,
      }),
    );
    const pending = result.current.begin(() => live);
    live = false;
    expect(await pending).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });
  it("never transfers across an owner change", async () => {
    const { result, rerender } = renderHook(
      (props) => useChatThreadTransition({ ...props, begin: async () => true }),
      { initialProps: { threadId: "old", ownerScope: "owner" } },
    );
    const pending = result.current.begin(() => true);
    rerender({ threadId: "new", ownerScope: "other" });
    expect(await pending).toBeNull();
  });
  it("releases pending transitions on unmount and excludes concurrency", async () => {
    const { result, unmount } = renderHook(() =>
      useChatThreadTransition({
        threadId: "old",
        ownerScope: "owner",
        begin: async () => true,
      }),
    );
    const pending = result.current.begin(() => true);
    expect(await result.current.begin(() => true)).toBeNull();
    unmount();
    expect(await pending).toBeNull();
  });
  it("bounds a reset that never publishes a new identity", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useChatThreadTransition({
          threadId: "old",
          ownerScope: "owner",
          begin: async () => true,
          timeoutMs: 50,
        }),
      );
      const pending = result.current.begin(() => true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("prepared App message destination readiness", () => {
  it("does not redirect a prepared message to a replacement thread while waiting", async () => {
    const view = renderHook(
      (props) => useChatThreadTransition({ ...props, begin: async () => true }),
      {
        initialProps: {
          threadId: "old",
          ownerScope: "owner",
          destinationReady: true,
        },
      },
    );
    let pending!: Promise<string | null>;
    await act(async () => {
      pending = view.result.current.begin(() => true);
    });
    view.rerender({
      threadId: "new",
      ownerScope: "owner",
      destinationReady: false,
    });
    view.rerender({
      threadId: "user-selected-other",
      ownerScope: "owner",
      destinationReady: true,
    });
    await expect(pending).resolves.toBeNull();
  });
  it("refuses an owner change even while the destination is unready", async () => {
    const reset = vi.fn(async () => true);
    const view = renderHook(
      (props) => useChatThreadTransition({ ...props, begin: reset }),
      {
        initialProps: {
          threadId: "old",
          ownerScope: "owner",
          destinationReady: true,
        },
      },
    );
    let pending!: Promise<string | null>;
    await act(async () => {
      pending = view.result.current.begin(() => true);
    });
    view.rerender({
      threadId: "new",
      ownerScope: "other",
      destinationReady: false,
    });
    await expect(pending).resolves.toBeNull();
  });
  it("keeps the original deadline when the destination never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const view = renderHook(
        (props) =>
          useChatThreadTransition({
            ...props,
            begin: async () => true,
            timeoutMs: 50,
          }),
        {
          initialProps: {
            threadId: "old",
            ownerScope: "owner",
            destinationReady: true,
          },
        },
      );
      let pending!: Promise<string | null>;
      await act(async () => {
        pending = view.result.current.begin(() => true);
      });
      view.rerender({
        threadId: "new",
        ownerScope: "owner",
        destinationReady: false,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["ready", "owner-changed", "hard-denied"])(
    "waits for destination readiness and fences %s without repeating preparation",
    async (outcome) => {
      const reset = vi.fn(async () => true);
      const prepareNew = vi.fn(async (payload: PluginMessageIntent) => ({
        ...payload,
        preparationToken: "p".repeat(43),
      }));
      const send = vi.fn(async (_payload: unknown, isCurrent: () => boolean) =>
        isCurrent(),
      );
      const view = renderHook(
        (props) => {
          const transition = useChatThreadTransition({
            ...props,
            begin: reset,
          });
          return usePluginMessage({
            threadId: props.threadId,
            scope: `${props.ownerScope}:${props.threadId}`,
            disabled: !props.destinationReady || props.denied,
            liveBlocked: !props.destinationReady || props.denied,
            gates: [async () => true],
            prepareNew,
            send,
            newChat: {
              ownerScope: props.ownerScope,
              threadId: props.threadId,
              begin: transition.begin,
            },
          });
        },
        {
          initialProps: {
            threadId: "old",
            ownerScope: "actor:project:host",
            destinationReady: true,
            denied: false,
          },
        },
      );
      let sourceLive = true;
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = view.result.current.send(
          {
            instanceToken: "x".repeat(43),
            operationId: crypto.randomUUID(),
            sourceThreadId: "old",
            params: {
              role: "user",
              content: [{ type: "text", text: "Fixture" }],
              _meta: { "openai/message": { target: "new" } },
            },
          },
          () => sourceLive,
        );
      });
      await waitFor(() => expect(reset).toHaveBeenCalledOnce());
      sourceLive = false; // Normal reset closes the already-prepared source.
      // Production publishes its new identity before target bootstrap/restoration
      // is ready. It must not send or permanently refuse in this render.
      view.rerender({
        threadId: "new",
        ownerScope: "actor:project:host",
        destinationReady: false,
        denied: false,
      });
      expect(send).not.toHaveBeenCalled();
      await act(async () => {
        view.rerender({
          threadId: "new",
          ownerScope:
            outcome === "owner-changed" ? "other-owner" : "actor:project:host",
          destinationReady: true,
          denied: outcome === "hard-denied",
        });
      });
      await expect(pending).resolves.toBe(outcome === "ready");
      expect(send).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
      expect(prepareNew).toHaveBeenCalledOnce();
      expect(reset).toHaveBeenCalledOnce();
    },
  );
});
