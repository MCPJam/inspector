import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  flag: vi.fn<() => boolean | undefined>(),
  authFetch: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) =>
    key === "server-canvas" ? mocks.flag() : undefined,
}));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/lib/apis/web/context", () => ({
  tryResolveProjectServer: (key: string) =>
    key === "My Server" ? { projectId: "prj_1", serverId: "srv_1" } : null,
}));

import {
  BRIDGE_FLUSH_INTERVAL_MS,
  BRIDGE_RETRY_DELAY_MS,
} from "../apps-bridge-observer";
import {
  BRIDGE_OBSERVATIONS_PATH,
  useAppsBridgeObservations,
} from "../use-apps-bridge-observations";

const EVENT = {
  widgetId: "call-1",
  serverId: "My Server",
  direction: "ui-to-host" as const,
  protocol: "mcp-apps" as const,
  method: "tools/call",
  message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.flag.mockReset();
  mocks.authFetch.mockReset().mockResolvedValue(new Response("{}"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAppsBridgeObservations", () => {
  it("only logs while the server canvas is off", async () => {
    mocks.flag.mockReturnValue(false);
    const addLog = vi.fn();
    const { result } = renderHook(() => useAppsBridgeObservations(addLog));
    result.current(EVENT);
    await vi.advanceTimersByTimeAsync(BRIDGE_FLUSH_INTERVAL_MS);
    expect(addLog).toHaveBeenCalledWith(EVENT);
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });

  it("logs and posts observed bridge features while it is on", async () => {
    mocks.flag.mockReturnValue(true);
    const addLog = vi.fn();
    const { result } = renderHook(() => useAppsBridgeObservations(addLog));
    result.current(EVENT);
    expect(addLog).toHaveBeenCalledWith(EVENT);
    await vi.advanceTimersByTimeAsync(BRIDGE_FLUSH_INTERVAL_MS);
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mocks.authFetch.mock.calls[0];
    expect(path).toBe(BRIDGE_OBSERVATIONS_PATH);
    expect(JSON.parse(init.body)).toMatchObject({
      projectId: "prj_1",
      serverId: "srv_1",
      observations: [{ featureId: "apps.app-tools-call", count: 1 }],
    });
  });

  it("posts what is left with keepalive when the page hides", async () => {
    mocks.flag.mockReturnValue(true);
    const { result } = renderHook(() => useAppsBridgeObservations(vi.fn()));
    result.current(EVENT);
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(BRIDGE_FLUSH_INTERVAL_MS);
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
    expect(mocks.authFetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      keepalive: true,
    });
  });

  it.each([
    { status: 403, posts: 1 },
    { status: 503, posts: 2 },
  ])(
    "sends a batch answered with $status $posts time(s)",
    async ({ status, posts }) => {
      mocks.flag.mockReturnValue(true);
      mocks.authFetch.mockResolvedValue(new Response("{}", { status }));
      const { result } = renderHook(() => useAppsBridgeObservations(vi.fn()));
      result.current(EVENT);
      await vi.advanceTimersByTimeAsync(
        BRIDGE_FLUSH_INTERVAL_MS + BRIDGE_RETRY_DELAY_MS,
      );
      expect(mocks.authFetch).toHaveBeenCalledTimes(posts);
    },
  );
});
