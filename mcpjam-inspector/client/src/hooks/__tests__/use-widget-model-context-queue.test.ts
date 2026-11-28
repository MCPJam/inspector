import { act, renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { useWidgetModelContextQueue } from "../use-widget-model-context-queue";

const entry = (toolCallId: string, text: string) => ({
  toolCallId,
  context: { content: [{ type: "text", text }] },
});

describe("useWidgetModelContextQueue restore", () => {
  it("puts back unsent context and keeps an App's newer update", () => {
    const { result } = renderHook(() => useWidgetModelContextQueue());
    const unsent = [entry("call-1", "old"), entry("call-2", "kept")];
    act(() => result.current[1]([entry("call-1", "new")]));

    act(() => result.current[3](unsent));

    expect(result.current[0]).toEqual([
      entry("call-2", "kept"),
      entry("call-1", "new"),
    ]);
  });

  it("prunes restored context when history removes its App, preserving newer updates", () => {
    const { result } = renderHook(() => useWidgetModelContextQueue());
    const messages: UIMessage[] = [
      {
        id: "assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "counter",
            toolCallId: "live",
            state: "output-available",
            input: {},
            output: {},
          },
        ],
      },
    ];

    act(() => {
      result.current[2]("live", entry("live", "new").context);
      result.current[3]([entry("live", "old"), entry("removed", "unsent")]);
      result.current[4](messages);
    });
    expect(result.current[0]).toEqual([entry("live", "new")]);

    act(() => {
      result.current[4]([]);
      result.current[2]("next", entry("next", "fresh").context);
    });
    expect(result.current[0]).toEqual([entry("next", "fresh")]);
  });

  it("restores only surviving Apps after a send's queue was cleared and history refreshed", () => {
    const { result } = renderHook(() => useWidgetModelContextQueue());
    const unsent = [entry("removed", "old"), entry("live", "unsent")];
    const messages: UIMessage[] = [{
      id: "assistant",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolName: "counter",
        toolCallId: "live",
        state: "output-available",
        input: {},
        output: {},
      }],
    }];
    act(() => {
      result.current[1](unsent);
      result.current[1]([]);
      result.current[4](messages);
      result.current[3](unsent);
    });
    expect(result.current[0]).toEqual([entry("live", "unsent")]);

    act(() => {
      result.current[2]("live", entry("live", "newer").context);
      result.current[3](unsent);
    });
    expect(result.current[0]).toEqual([entry("live", "newer")]);
  });

  it("restores context from a new App accepted after the last history refresh", () => {
    const { result } = renderHook(() => useWidgetModelContextQueue());
    act(() => {
      result.current[4]([]);
      result.current[2]("new-app", entry("new-app", "fresh").context);
    });
    const unsent = result.current[0];
    act(() => {
      result.current[1]([]);
      result.current[3](unsent);
    });
    expect(result.current[0]).toEqual([entry("new-app", "fresh")]);
  });
});
