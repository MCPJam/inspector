import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { mcpApiPresets } from "@/test/mocks/mcp-api";
import { storePresets } from "@/test/mocks/stores";
import {
  applyClientRuntimePresets,
  clientRuntimeMocks,
} from "@/test/mocks/widget-state-sync";

import { useWidgetStateSync } from "../use-widget-state-sync";
import type { UIMessage } from "ai";

describe("useWidgetStateSync", () => {
  let messages: UIMessage[];
  let setMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    messages = [];
    setMessages = vi.fn((updater) => {
      messages = updater(messages);
    });

    applyClientRuntimePresets({
      mcpApi: mcpApiPresets.allSuccess(),
      appState: storePresets.empty(),
      buildWidgetStateParts: async (toolCallId: string, state: unknown) => [
        {
          type: "text",
          text: `widget ${toolCallId}: ${JSON.stringify(state)}`,
        },
      ],
    });
  });

  describe("enqueueWidgetStateSync", () => {
    it("appends a new widget-state message", async () => {
      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      await act(async () => {
        await result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-1", state: { count: 1 } },
        ]);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("widget-state-tool-1");
      expect(messages[0].role).toBe("user");
      expect(messages[0].parts[0]).toEqual({
        type: "text",
        text: 'widget tool-1: {"count":1}',
      });
    });

    it("updates an existing widget-state message when parts change", async () => {
      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      await act(async () => {
        await result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-1", state: { count: 1 } },
        ]);
      });

      expect(messages).toHaveLength(1);

      await act(async () => {
        await result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-1", state: { count: 2 } },
        ]);
      });

      // Should still be 1 message, updated in-place
      expect(messages).toHaveLength(1);
      expect(messages[0].parts[0]).toEqual({
        type: "text",
        text: 'widget tool-1: {"count":2}',
      });
    });

    it("removes message when state is null", async () => {
      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      await act(async () => {
        await result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-1", state: { count: 1 } },
        ]);
      });

      expect(messages).toHaveLength(1);

      await act(async () => {
        await result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-1", state: null },
        ]);
      });

      expect(messages).toHaveLength(0);
    });

    it("skips update when parts are identical (dedup)", async () => {
      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      await act(async () => {
        await result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-1", state: { same: true } },
        ]);
      });

      const firstCallCount = (setMessages as ReturnType<typeof vi.fn>).mock
        .calls.length;

      await act(async () => {
        await result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-1", state: { same: true } },
        ]);
      });

      // setMessages was called again but the updater should return same array
      const secondUpdater = (setMessages as ReturnType<typeof vi.fn>).mock
        .calls[firstCallCount][0];
      const before = [...messages];
      const after = secondUpdater(before);
      // referential equality — updater returned the same array (no mutation needed)
      expect(after).toBe(before);
    });
  });

  describe("queue flush on status change", () => {
    it("flushes queued updates when status becomes ready", async () => {
      const { result, rerender } = renderHook(
        ({ status }) => useWidgetStateSync({ status, setMessages }),
        { initialProps: { status: "streaming" } },
      );

      // Queue updates while not ready
      act(() => {
        result.current.setWidgetStateQueue((prev) => [
          ...prev,
          { toolCallId: "tool-q1", state: { queued: true } },
        ]);
      });

      expect(messages).toHaveLength(0);

      // Switch to ready — should trigger flush
      await act(async () => {
        rerender({ status: "ready" });
        // Allow the async enqueue to complete
        await result.current.widgetStateSyncRef.current;
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("widget-state-tool-q1");
    });
  });

  describe("setModelContextQueue", () => {
    it("keeps modelContextQueueRef in sync with state", () => {
      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      const item = {
        toolCallId: "tool-mc1",
        context: { content: [{ type: "text" as const, text: "hello" }] },
      };

      act(() => {
        result.current.setModelContextQueue([item]);
      });

      expect(result.current.modelContextQueueRef.current).toEqual([item]);
    });

    it("accepts a function updater", () => {
      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      const item1 = {
        toolCallId: "tool-mc1",
        context: { content: [{ type: "text" as const, text: "first" }] },
      };
      const item2 = {
        toolCallId: "tool-mc2",
        context: { content: [{ type: "text" as const, text: "second" }] },
      };

      act(() => {
        result.current.setModelContextQueue([item1]);
      });

      act(() => {
        result.current.setModelContextQueue((prev) => [...prev, item2]);
      });

      expect(result.current.modelContextQueueRef.current).toEqual([
        item1,
        item2,
      ]);
    });
  });

  describe("resetWidgetSync", () => {
    it("clears model context queue and ref", () => {
      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      act(() => {
        result.current.setModelContextQueue([
          {
            toolCallId: "tool-mc1",
            context: { content: [{ type: "text" as const, text: "data" }] },
          },
        ]);
      });

      expect(result.current.modelContextQueueRef.current).toHaveLength(1);

      act(() => {
        result.current.resetWidgetSync();
      });

      expect(result.current.modelContextQueueRef.current).toHaveLength(0);
    });

    it("cancels in-flight async updates via epoch increment", async () => {
      // Create a deferred promise so resolveSlowParts is assigned immediately
      let resolveSlowParts!: (value: UIMessage["parts"]) => void;
      const slowPromise = new Promise<UIMessage["parts"]>((resolve) => {
        resolveSlowParts = resolve;
      });
      clientRuntimeMocks.buildWidgetStatePartsMock.mockReturnValueOnce(
        slowPromise,
      );

      const { result } = renderHook(() =>
        useWidgetStateSync({ status: "ready", setMessages }),
      );

      // Start an async update
      let enqueuePromise: Promise<void>;
      act(() => {
        enqueuePromise = result.current.enqueueWidgetStateSync([
          { toolCallId: "tool-stale", state: { old: true } },
        ]);
      });

      // Reset before the promise resolves — bumps the epoch
      act(() => {
        result.current.resetWidgetSync();
      });

      // Now resolve the slow parts — should be ignored due to epoch mismatch
      await act(async () => {
        resolveSlowParts([{ type: "text", text: "stale data" }]);
        await enqueuePromise!;
      });

      // No messages should have been added — the epoch was stale
      expect(messages).toHaveLength(0);
    });
  });
});
