import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ mode: "local" as "local" | "hosted" }));
const mockAuthFetch = vi.fn();

vi.mock("@/lib/apis/mode-client", () => ({
  runByMode: <T,>(h: { local: () => T; hosted: () => T }) =>
    state.mode === "local" ? h.local() : h.hosted(),
}));
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { renderWidget } from "@/lib/apis/mcp-widget-render-api";

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = "local";
});

describe("renderWidget", () => {
  it("POSTs to the local widget-render route with the render request", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "rendered", elapsedMs: 12 }),
    });
    const result = await renderWidget({
      serverId: "srv",
      toolName: "show_cart",
      injectOpenAiCompat: true,
    });
    expect(result.status).toBe("rendered");
    const [path, init] = mockAuthFetch.mock.calls[0];
    expect(path).toBe("/api/mcp/widget-render");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      serverId: "srv",
      toolName: "show_cart",
      injectOpenAiCompat: true,
    });
  });

  it("defaults injectOpenAiCompat to false", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "rendered", elapsedMs: 1 }),
    });
    await renderWidget({ serverId: "srv", toolName: "t" });
    const [, init] = mockAuthFetch.mock.calls[0];
    expect(
      JSON.parse((init as RequestInit).body as string).injectOpenAiCompat,
    ).toBe(false);
  });

  it("throws the server error message on a non-ok response", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "harness exploded" }),
    });
    await expect(
      renderWidget({ serverId: "srv", toolName: "t" }),
    ).rejects.toThrow("harness exploded");
  });

  it("throws in hosted mode (route is local-only)", async () => {
    state.mode = "hosted";
    await expect(
      renderWidget({ serverId: "srv", toolName: "t" }),
    ).rejects.toThrow(/local inspector/);
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });
});
