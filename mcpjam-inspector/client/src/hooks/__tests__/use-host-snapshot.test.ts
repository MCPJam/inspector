import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostSnapshotFromHistoricalConfig,
  useHostSnapshotForHost,
  useHostSnapshotForSession,
} from "../use-host-snapshot";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import type { SessionHistoricalHostConfig } from "../useSharedChatThreads";

const { historicalConfig, hostQuery } = vi.hoisted(() => ({
  historicalConfig: vi.fn(),
  hostQuery: vi.fn(),
}));
vi.mock("../useSharedChatThreads", () => ({
  useSessionHistoricalHostConfig: historicalConfig,
}));
vi.mock("../useClients", async (original) => ({
  ...(await original<typeof import("../useClients")>()),
  useHost: hostQuery,
}));

describe("host snapshot resolution", () => {
  beforeEach(() => {
    historicalConfig.mockReset().mockReturnValue({ config: undefined });
    hostQuery.mockReset().mockReturnValue({ host: null, isLoading: false });
  });

  it("accepts known trimmed styles and rejects missing or unknown identities", () => {
    expect(hostSnapshotFromStyle(" chatgpt ")).toEqual({
      hostStyle: "chatgpt",
    });
    for (const value of [null, undefined, "", "unknown-host"]) {
      expect(hostSnapshotFromStyle(value)).toBeNull();
    }
  });

  it("preserves config overrides, including the distinction between absent and empty", () => {
    const config = {
      hostStyle: "claude",
      hostCapabilitiesOverride: {},
      chatUiOverride: { label: "Support client" },
      mcpProfile: { version: 1 },
    } as SessionHistoricalHostConfig;
    expect(hostSnapshotFromHistoricalConfig(config)).toEqual(config);
    expect(
      hostSnapshotFromHistoricalConfig({
        hostStyle: "claude",
      } as SessionHistoricalHostConfig),
    ).toEqual({
      hostStyle: "claude",
      hostCapabilitiesOverride: undefined,
      chatUiOverride: undefined,
      mcpProfile: undefined,
    });
  });

  it("distinguishes skipped, pending, ready and unavailable session queries", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useHostSnapshotForSession(id),
      { initialProps: { id: null as string | null } },
    );
    expect(result.current.status).toBe("idle");
    rerender({ id: "convex-session-id" });
    expect(historicalConfig).toHaveBeenLastCalledWith({
      sessionId: "convex-session-id",
    });
    expect(result.current.status).toBe("loading");
    historicalConfig.mockReturnValue({ config: { hostStyle: "claude" } });
    rerender({ id: "convex-session-id" });
    expect(result.current).toMatchObject({
      status: "ready",
      snapshot: { hostStyle: "claude" },
    });
    historicalConfig.mockReturnValue({ config: undefined });
    rerender({ id: "another-session-id" });
    expect(result.current).toEqual({ status: "loading" });
    historicalConfig.mockReturnValue({ config: null });
    rerender({ id: "another-session-id" });
    expect(result.current).toEqual({ status: "unavailable" });
  });

  it("resolves catalog slugs without waiting for a host query", () => {
    const { result } = renderHook(() => useHostSnapshotForHost("codex", false));
    expect(result.current).toEqual({
      status: "ready",
      snapshot: { hostStyle: "codex" },
    });
  });

  it("projects a queried host and does not wait forever on skipped authentication", () => {
    const id = "k123456789012345678901234";
    const { result, rerender } = renderHook(() =>
      useHostSnapshotForHost(id, false),
    );
    expect(result.current.status).toBe("unavailable");
    hostQuery.mockReturnValue({ host: null, isLoading: true });
    rerender();
    expect(result.current.status).toBe("loading");
    hostQuery.mockReturnValue({
      host: {
        config: { hostStyle: "chatgpt", chatUiOverride: { label: "Custom" } },
      },
      isLoading: false,
    });
    rerender();
    expect(result.current).toMatchObject({
      status: "ready",
      snapshot: { hostStyle: "chatgpt", chatUiOverride: { label: "Custom" } },
    });
  });
});
