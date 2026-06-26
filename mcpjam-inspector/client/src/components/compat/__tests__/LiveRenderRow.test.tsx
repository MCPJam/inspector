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
): ServerRequirements => ({
  widgets: { mcpAppsOnly: [], openaiAppsOnly: [], dual: [], ...widgets },
  appOnlyWidgets: [],
  hasWidgets: true,
  unknownDimensions: [],
});

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
});
