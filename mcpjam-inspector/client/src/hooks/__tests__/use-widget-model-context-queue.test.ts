import { act, renderHook } from "@testing-library/react";
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
});
