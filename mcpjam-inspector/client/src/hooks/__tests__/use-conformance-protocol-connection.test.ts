import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectedServer,
  createHttpServerConfig,
} from "@/test/factories";
import type { ProtocolVersionPin } from "../conformance-suite-state";
import type { ConformanceConnectionResult } from "@/shared/conformance-connection";
import { useConformanceProtocolConnection } from "../use-conformance-protocol-connection";

const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/lib/apis/conformance-connection-api", () => ({
  checkConformanceConnection: check,
}));

function pendingCheck() {
  let resolve: (value: ConformanceConnectionResult) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<ConformanceConnectionResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const server = createConnectedServer({
  name: "bart",
  config: createHttpServerConfig("https://bart.test/mcp"),
});

beforeEach(() => {
  check.mockReset();
});

describe("conformance protocol connection", () => {
  it("resolves Auto before allowing a run, and leaves stdio alone", async () => {
    check.mockResolvedValue({ status: "ready", protocolVersion: "2025-06-18" });
    const { result, rerender } = renderHook(
      ({ target, version }) =>
        useConformanceProtocolConnection(target, version),
      {
        initialProps: { target: server, version: "auto" as ProtocolVersionPin },
      },
    );
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(check).toHaveBeenCalledWith("bart", "auto");
    expect(result.current.result).toEqual({
      status: "ready",
      protocolVersion: "2025-06-18",
    });
    rerender({ target: createConnectedServer(), version: "2026-07-28" });
    expect(result.current.ready).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks the initial pin and each change, including switching back", async () => {
    check.mockResolvedValue({ status: "ready", protocolVersion: "2026-07-28" });
    const { result, rerender } = renderHook(
      ({ version }) => useConformanceProtocolConnection(server, version),
      {
        initialProps: { version: "2025-06-18" as ProtocolVersionPin },
      },
    );
    expect(result.current.checking).toBe(true);
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    check.mockResolvedValueOnce({
      status: "unsupported",
      protocolVersion: "2026-07-28",
      supportedVersions: ["2025-06-18"],
    });
    rerender({ version: "2026-07-28" });
    expect(result.current.ready).toBe(false);
    await waitFor(() =>
      expect(result.current.result?.status).toBe("unsupported"),
    );
    rerender({ version: "2025-06-18" });
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(check.mock.calls.map((call) => call[1])).toEqual([
      "2025-06-18",
      "2026-07-28",
      "2025-06-18",
    ]);
  });

  it("ignores older replies and replies after closing setup", async () => {
    const old = pendingCheck();
    const current = pendingCheck();
    check.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { result, rerender, unmount } = renderHook(
      ({ version }) => useConformanceProtocolConnection(server, version),
      {
        initialProps: { version: "2025-06-18" as ProtocolVersionPin },
      },
    );
    rerender({ version: "2026-07-28" });
    await act(async () =>
      old.resolve({ status: "ready", protocolVersion: "2026-07-28" }),
    );
    expect(result.current.ready).toBe(false);
    expect(result.current.checking).toBe(true);
    unmount();
    await act(async () =>
      current.resolve({ status: "ready", protocolVersion: "2026-07-28" }),
    );
    expect(result.current.ready).toBe(false);
  });

  it("invalidates readiness on server, connection, config, and login changes", async () => {
    check.mockResolvedValue({ status: "ready", protocolVersion: "2026-07-28" });
    const { result, rerender } = renderHook(
      ({ target }) => useConformanceProtocolConnection(target, "2026-07-28"),
      {
        initialProps: { target: server },
      },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ target: { ...server, connectionStatus: "disconnected" } });
    expect(result.current.ready).toBe(false);
    rerender({ target: server });
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.ready).toBe(true));
    const renamed = { ...server, name: "other" };
    rerender({ target: renamed });
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({
      target: {
        ...renamed,
        config: createHttpServerConfig("https://other.test/mcp"),
      },
    });
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({
      target: {
        ...renamed,
        oauthTokens: { access_token: "new-token", token_type: "Bearer" },
      },
    });
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(check).toHaveBeenCalledTimes(5);
  });

  it("keeps failures blocked and allows retry", async () => {
    check
      .mockRejectedValueOnce(new Error("Connection timed out"))
      .mockResolvedValueOnce({
        status: "ready",
        protocolVersion: "2026-07-28",
      });
    const { result } = renderHook(() =>
      useConformanceProtocolConnection(server, "2026-07-28"),
    );
    await waitFor(() =>
      expect(result.current.result).toEqual({
        status: "failed",
        message: "Connection timed out",
      }),
    );
    expect(result.current.ready).toBe(false);
    act(() => result.current.retry());
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});
