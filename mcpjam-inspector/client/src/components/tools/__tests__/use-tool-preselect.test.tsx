import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const location = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("@/lib/app-navigation", () => ({
  useCurrentLocationState: () => location.state,
}));

import { readPreselectTool, useToolPreselect } from "../use-tool-preselect";

describe("useToolPreselect", () => {
  beforeEach(() => {
    location.state = undefined;
  });

  it("selects the named tool once the list contains it", () => {
    location.state = { preselectTool: "get_issue" };
    const onSelectTool = vi.fn();
    const { rerender } = renderHook(
      ({ tools }) =>
        useToolPreselect({ tools, selectedTool: "", onSelectTool }),
      { initialProps: { tools: {} as Record<string, unknown> } },
    );
    expect(onSelectTool).not.toHaveBeenCalled();

    rerender({ tools: { get_issue: {} } });
    expect(onSelectTool).toHaveBeenCalledWith("get_issue");

    rerender({ tools: { get_issue: {}, search: {} } });
    expect(onSelectTool).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a preselect in the navigation state", () => {
    const onSelectTool = vi.fn();
    renderHook(() =>
      useToolPreselect({
        tools: { get_issue: {} },
        selectedTool: "",
        onSelectTool,
      }),
    );
    expect(onSelectTool).not.toHaveBeenCalled();
  });

  it("ignores state that is not a preselect", () => {
    expect(readPreselectTool({ preselectTool: 3 })).toBeNull();
    expect(readPreselectTool("get_issue")).toBeNull();
    expect(readPreselectTool({ preselectTool: "x" })).toBe("x");
  });
});
