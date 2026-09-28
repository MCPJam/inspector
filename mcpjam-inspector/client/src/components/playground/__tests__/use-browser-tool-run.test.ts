import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBrowserToolRun } from "../use-browser-tool-run";
import { useAgentToolPromptBridge } from "@/stores/agent-tool-prompt-bridge";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";

const TOOLS: SerializedModelRequestTool[] = [
  {
    name: "browser_navigate",
    description: "Open a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

const PAGE_OK = {
  ok: true as const,
  url: "https://webmcp.dev/",
  webmcpSupported: true,
  tools: [
    {
      name: "bookSlot",
      description: "Reserve a slot",
      origin: "https://webmcp.dev",
      isMainFrame: true,
      frameId: "frame-main",
      inputSchema: {
        type: "object",
        properties: { when: { type: "string" } },
      },
    },
  ],
};

describe("useBrowserToolRun", () => {
  beforeEach(() => useAgentToolPromptBridge.setState({ pending: null }));
  afterEach(() => useAgentToolPromptBridge.setState({ pending: null }));

  it("selecting a browser tool generates its parameter form", () => {
    const { result } = renderHook(() => useBrowserToolRun(TOOLS, PAGE_OK));
    act(() => result.current.select("browser:browser_navigate"));
    expect(result.current.selected?.callName).toBe("browser_navigate");
    expect(result.current.fields.map((f) => f.name)).toContain("url");
  });

  it("Run on a page tool invokes it directly, and does not ask the agent", async () => {
    const invokePage = vi.fn(async () => ({
      ok: true as const,
      output: { booked: true },
    }));
    const { result } = renderHook(() =>
      useBrowserToolRun(TOOLS, PAGE_OK, invokePage),
    );
    const pageKey = result.current.catalog.find((t) => t.kind === "page")?.key;
    expect(pageKey).toBeDefined();
    act(() => result.current.select(pageKey!));
    act(() => result.current.onFieldChange("when", "tomorrow"));
    await act(async () => {
      await result.current.run();
    });

    expect(invokePage).toHaveBeenCalledWith({
      rawName: "bookSlot",
      frameId: "frame-main",
      input: { when: "tomorrow" },
    });
    expect(result.current.result).toEqual({
      ok: true,
      text: JSON.stringify({ booked: true }, null, 2),
    });
    expect(useAgentToolPromptBridge.getState().pending).toBeNull();
  });

  it("Run on a browser verb still asks the agent", async () => {
    const invokePage = vi.fn(async () => ({ ok: true as const, output: {} }));
    const { result } = renderHook(() =>
      useBrowserToolRun(TOOLS, PAGE_OK, invokePage),
    );
    act(() => result.current.select("browser:browser_navigate"));
    act(() => result.current.onFieldChange("url", "https://example.com"));
    await act(async () => {
      await result.current.run();
    });

    expect(invokePage).not.toHaveBeenCalled();
    const pending = useAgentToolPromptBridge.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending!.prompt).toContain("Use the browser_navigate tool");
  });

  it("falls back to asking the agent for a page tool when invoke is unavailable", async () => {
    const { result } = renderHook(() => useBrowserToolRun(TOOLS, PAGE_OK));
    const pageKey = result.current.catalog.find((t) => t.kind === "page")!.key;
    act(() => result.current.select(pageKey));
    await act(async () => {
      await result.current.run();
    });

    const pending = useAgentToolPromptBridge.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending!.prompt).toContain("Use the webmcp_bookSlot tool");
    expect(pending!.prompt).not.toContain("Use the bookSlot tool");
  });

  it("clears a page-tool selection when the page no longer offers it", () => {
    const { result, rerender } = renderHook(
      ({ page }) => useBrowserToolRun(TOOLS, page),
      { initialProps: { page: PAGE_OK as typeof PAGE_OK | null } },
    );
    const pageKey = result.current.catalog.find((t) => t.kind === "page")!.key;
    act(() => result.current.select(pageKey));
    rerender({ page: { ...PAGE_OK, tools: [] } });
    expect(result.current.selected).toBeNull();
  });
});
