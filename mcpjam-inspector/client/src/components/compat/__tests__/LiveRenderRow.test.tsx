import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, act } from "@testing-library/react";
import type {
  ServerRequirements,
  HostCompatReport,
} from "@/lib/host-compat/types";

const mockRenderWidget = vi.fn();
const hosted = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/apis/mcp-widget-render-api", () => ({
  renderWidget: (...args: unknown[]) => mockRenderWidget(...args),
}));
vi.mock("@/lib/apis/mode-client", () => ({
  isHostedMode: () => hosted.value,
}));
vi.mock("@/lib/client-styles/registry", () => ({
  // Only chatgpt injects the OpenAI shim in this fixture.
  getCompatRuntimeForStyle: (id: string) => ({ injected: id === "chatgpt" }),
}));

import {
  LiveRenderRow,
  useLiveRenders,
} from "@/components/compat/LiveRenderRow";

const reqs = (
  widgets: Partial<ServerRequirements["widgets"]> = {},
): ServerRequirements => {
  const w = { mcpAppsOnly: [], openaiAppsOnly: [], dual: [], ...widgets };
  return {
    widgets: w,
    appOnlyWidgets: [],
    hasWidgets:
      w.mcpAppsOnly.length + w.dual.length + w.openaiAppsOnly.length > 0,
    unknownDimensions: [],
  };
};

const report = (hostId: string): HostCompatReport =>
  ({ hostId }) as HostCompatReport;

beforeEach(() => {
  vi.clearAllMocks();
  hosted.value = false;
});

describe("LiveRenderRow", () => {
  it("shows an observed 'rendered' result", () => {
    render(
      <LiveRenderRow outcome={{ result: { status: "rendered", elapsedMs: 12 } }} />,
    );
    expect(screen.getByText(/Live: Rendered/)).toBeInTheDocument();
    expect(screen.getByText(/observed/)).toBeInTheDocument();
  });

  it("shows a failed render status", () => {
    render(
      <LiveRenderRow
        outcome={{ result: { status: "bridge_timeout", elapsedMs: 9 } }}
      />,
    );
    expect(screen.getByText(/Bridge timed out/)).toBeInTheDocument();
  });

  it("shows a request error", () => {
    render(<LiveRenderRow outcome={{ error: "boom" }} />);
    expect(screen.getByText(/Live render failed: boom/)).toBeInTheDocument();
  });

  it("renders the screenshot when present", () => {
    render(
      <LiveRenderRow
        outcome={{
          result: { status: "rendered", elapsedMs: 1, screenshotBase64: "AAAA" },
        }}
      />,
    );
    const img = screen.getByAltText("Live render screenshot") as HTMLImageElement;
    expect(img.src).toContain("data:image/png;base64,AAAA");
  });
});

describe("useLiveRenders", () => {
  it("is unavailable in hosted mode", () => {
    hosted.value = true;
    const { result } = renderHook(() =>
      useLiveRenders("srv", reqs({ mcpAppsOnly: ["w"] })),
    );
    expect(result.current.available).toBe(false);
  });

  it("is unavailable when the server has no widget", () => {
    const { result } = renderHook(() => useLiveRenders("srv", reqs()));
    expect(result.current.available).toBe(false);
  });

  it("renders the first widget tool with the host's compat flag", async () => {
    mockRenderWidget.mockResolvedValue({ status: "rendered", elapsedMs: 5 });
    const { result } = renderHook(() =>
      useLiveRenders("srv", reqs({ mcpAppsOnly: ["w1"], dual: ["w2"] })),
    );
    expect(result.current.available).toBe(true);

    await act(async () => {
      await result.current.run(report("chatgpt"));
    });

    expect(mockRenderWidget).toHaveBeenCalledWith({
      serverId: "srv",
      toolName: "w1",
      injectOpenAiCompat: true,
    });
    expect(result.current.results.chatgpt).toEqual({
      result: { status: "rendered", elapsedMs: 5 },
    });
  });

  it("captures a request error per host", async () => {
    mockRenderWidget.mockRejectedValue(new Error("no chromium"));
    const { result } = renderHook(() =>
      useLiveRenders("srv", reqs({ mcpAppsOnly: ["w1"] })),
    );
    await act(async () => {
      await result.current.run(report("claude"));
    });
    expect(result.current.results.claude).toEqual({ error: "no chromium" });
  });

  it("offers no widget tool for OpenAI-only widgets (route renders MCP Apps only)", () => {
    const { result } = renderHook(() =>
      useLiveRenders("srv", reqs({ openaiAppsOnly: ["o1"] })),
    );
    // The local render route renders `_meta.ui.resourceUri` only — an
    // OpenAI-only widget would deterministically return no_ui_resource, so it's
    // never offered for live render (even on a shim host).
    expect(result.current.widgetTool).toBeUndefined();
  });

  it("picks an MCP Apps / dual tool, skipping OpenAI-only", () => {
    const { result } = renderHook(() =>
      useLiveRenders("srv", reqs({ openaiAppsOnly: ["o1"], dual: ["d1"] })),
    );
    expect(result.current.widgetTool).toBe("d1");
  });

  it("ignores a second run while one is in flight (no parallel Chromium jobs)", async () => {
    let resolveRender!: (v: unknown) => void;
    mockRenderWidget.mockReturnValueOnce(
      new Promise((r) => {
        resolveRender = r;
      }),
    );
    const { result } = renderHook(() =>
      useLiveRenders("srv", reqs({ mcpAppsOnly: ["w1"] })),
    );
    act(() => {
      void result.current.run(report("claude"));
    });
    // A fast second click before the first resolves must be a no-op.
    act(() => {
      void result.current.run(report("cursor"));
    });
    expect(mockRenderWidget).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRender({ status: "rendered", elapsedMs: 1 });
    });
  });

  it("clears results when the rendered tool changes (tools reloaded)", async () => {
    mockRenderWidget.mockResolvedValue({ status: "rendered", elapsedMs: 1 });
    const { result, rerender } = renderHook(
      ({ r }: { r: ServerRequirements }) => useLiveRenders("srv", r),
      { initialProps: { r: reqs({ mcpAppsOnly: ["w1"] }) } },
    );
    await act(async () => {
      await result.current.run(report("claude"));
    });
    expect(result.current.results.claude).toBeDefined();

    // Tools reload → a different representative widget tool → stale clears.
    rerender({ r: reqs({ mcpAppsOnly: ["w2"] }) });
    expect(result.current.results.claude).toBeUndefined();
  });

  it("keeps only the most recent render's screenshot", async () => {
    mockRenderWidget
      .mockResolvedValueOnce({
        status: "rendered",
        elapsedMs: 1,
        screenshotBase64: "AAA",
      })
      .mockResolvedValueOnce({
        status: "rendered",
        elapsedMs: 2,
        screenshotBase64: "BBB",
      });
    const { result } = renderHook(() =>
      useLiveRenders("srv", reqs({ mcpAppsOnly: ["w1"] })),
    );
    await act(async () => {
      await result.current.run(report("claude"));
    });
    expect(result.current.results.claude.result?.screenshotBase64).toBe("AAA");

    await act(async () => {
      await result.current.run(report("cursor"));
    });
    // Newest keeps its screenshot; the older one is trimmed but keeps status.
    expect(result.current.results.cursor.result?.screenshotBase64).toBe("BBB");
    expect(
      result.current.results.claude.result?.screenshotBase64,
    ).toBeUndefined();
    expect(result.current.results.claude.result?.status).toBe("rendered");
  });

  it("drops an in-flight render's result after the server switches", async () => {
    let resolveRender!: (v: unknown) => void;
    mockRenderWidget.mockReturnValueOnce(
      new Promise((r) => {
        resolveRender = r;
      }),
    );
    const { result, rerender } = renderHook(
      ({ s }: { s: string }) => useLiveRenders(s, reqs({ mcpAppsOnly: ["w1"] })),
      { initialProps: { s: "A" } },
    );

    let runPromise: Promise<void>;
    act(() => {
      runPromise = result.current.run(report("claude"));
    });

    // Switch server while server A's render is still in flight.
    rerender({ s: "B" });

    // Now let the stale (server A) render resolve.
    await act(async () => {
      resolveRender({ status: "rendered", elapsedMs: 1, screenshotBase64: "STALE" });
      await runPromise;
    });

    // The generation guard drops the stale write — no server-A result lingers.
    expect(result.current.results.claude).toBeUndefined();
  });
});
