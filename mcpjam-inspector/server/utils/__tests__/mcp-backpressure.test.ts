import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableTransientError } from "@mcpjam/sdk";
import {
  createMcpBackpressureFetch,
  type McpAdmissionCoordinator,
} from "../mcp-backpressure.js";

const url = "https://fixture.example/mcp";
const post = { method: "POST", body: JSON.stringify({ method: "tools/call" }) };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function coordinator(): McpAdmissionCoordinator {
  return {
    admit: vi.fn(async () => ({
      allowed: true,
      retryAfterMs: 0,
      reason: "ready",
    })),
    report: vi.fn(async () => undefined),
  };
}

describe("MCP request admission", () => {
  it("coordinates two independent fetch wrappers after a throttle without replaying the failed call", async () => {
    let blockedUntil = 0;
    const shared: McpAdmissionCoordinator = {
      admit: vi.fn(async () => ({
        allowed: Date.now() >= blockedUntil,
        retryAfterMs: Math.max(0, blockedUntil - Date.now()),
        reason: "cooldown",
      })),
      report: vi.fn(async ({ retryAfterMs }) => {
        blockedUntil = Date.now() + retryAfterMs!;
      }),
    };
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "Retry-After": "3" } }),
      )
      .mockResolvedValue(new Response("ok"));
    const a = createMcpBackpressureFetch({
      key: "shared",
      fetch: upstream,
      coordinator: shared,
      jitter: () => 0,
    });
    const b = createMcpBackpressureFetch({
      key: "shared",
      fetch: upstream,
      coordinator: shared,
      jitter: () => 0,
    });
    expect((await a(url, post)).status).toBe(429);
    const next = b(url, post);
    await vi.advanceTimersByTimeAsync(2999);
    expect(upstream).toHaveBeenCalledTimes(1);
    const unrelated = createMcpBackpressureFetch({
      key: "other",
      fetch: upstream,
      coordinator: coordinator(),
    });
    await unrelated(url, post);
    await vi.advanceTimersByTimeAsync(1);
    expect((await next).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(shared.report).toHaveBeenCalledTimes(1);
  });

  it("paces discovery and initialization but lets listen, teardown and cancellation through", async () => {
    const c = coordinator();
    const upstream = vi.fn(async () => new Response("ok"));
    const fetch = createMcpBackpressureFetch({
      key: "protocol",
      fetch: upstream,
      coordinator: c,
    });
    for (const method of [
      "initialize",
      "tools/list",
      "resources/list",
      "notifications/cancelled",
    ]) {
      await fetch(url, { method: "POST", body: JSON.stringify({ method }) });
    }
    await fetch(url, { method: "GET" });
    await fetch(url, { method: "DELETE" });
    expect(c.admit).toHaveBeenCalledTimes(3);
    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("cancels while waiting and releases the local queue slot", async () => {
    const c = coordinator();
    vi.mocked(c.admit).mockResolvedValue({
      allowed: false,
      retryAfterMs: 1000,
      reason: "pacing",
    });
    const upstream = vi.fn(async () => new Response("ok"));
    const fetch = createMcpBackpressureFetch({
      key: "cancel",
      fetch: upstream,
      coordinator: c,
      maxPending: 1,
      jitter: () => 0,
    });
    const abort = new AbortController();
    const pending = fetch(url, { ...post, signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(fetch(url, post)).rejects.toMatchObject({
      code: "mcp_admission_queue_full",
    });
    abort.abort();
    await rejected;
    expect(upstream).not.toHaveBeenCalled();
    vi.mocked(c.admit).mockResolvedValue({
      allowed: true,
      retryAfterMs: 0,
      reason: "ready",
    });
    await fetch(url, post);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("never shortens a cooldown to fit the wait budget", async () => {
    const c = coordinator();
    vi.mocked(c.admit).mockResolvedValue({
      allowed: false,
      retryAfterMs: 120_000,
      reason: "cooldown",
    });
    const upstream = vi.fn(async () => new Response("ok"));
    const fetch = createMcpBackpressureFetch({
      key: "budget",
      fetch: upstream,
      coordinator: c,
    });
    const error = await fetch(url, post).catch((e) => e);
    expect(error.code).toBe("mcp_admission_wait_exhausted");
    expect(isRetryableTransientError(error)).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed on coordinator errors without inheriting a retryable network error", async () => {
    const c = coordinator();
    vi.mocked(c.admit).mockRejectedValue(new TypeError("fetch failed"));
    const upstream = vi.fn(async () => new Response("ok"));
    const fetch = createMcpBackpressureFetch({
      key: "outage",
      fetch: upstream,
      coordinator: c,
    });
    const error = await fetch(url, post).catch((e) => e);
    expect(error.code).toBe("mcp_admission_unavailable");
    expect(isRetryableTransientError(error)).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [429, "30", 30_000, true],
    [429, "Mon, 21 Sep 2026 12:00:45 GMT", 45_000, true],
    [429, "nonsense", undefined, true],
    [503, "30", 30_000, true],
    [503, "nonsense", undefined, false],
  ])(
    "reports HTTP %s Retry-After %j without replay",
    async (status, header, wait, report) => {
      const c = coordinator();
      const response = new Response("busy", {
        status,
        headers: { "Retry-After": header },
      });
      const upstream = vi.fn(async () => response);
      const fetch = createMcpBackpressureFetch({
        key: `header-${status}-${header}`,
        fetch: upstream,
        coordinator: c,
      });
      expect(await fetch(url, post)).toBe(response);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(c.report).toHaveBeenCalledTimes(report ? 1 : 0);
      if (report)
        expect(c.report).toHaveBeenCalledWith({
          status,
          ...(wait !== undefined ? { retryAfterMs: wait } : {}),
        });
    },
  );

  it("stops this wrapper after feedback cannot be persisted", async () => {
    const c = coordinator();
    vi.mocked(c.report).mockRejectedValue(new Error("offline"));
    const upstream = vi.fn(async () => new Response("busy", { status: 429 }));
    const fetch = createMcpBackpressureFetch({
      key: "feedback",
      fetch: upstream,
      coordinator: c,
    });
    await expect(fetch(url, post)).rejects.toMatchObject({
      code: "mcp_admission_unavailable",
    });
    await expect(fetch(url, post)).rejects.toMatchObject({
      code: "mcp_admission_unavailable",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch if cancellation arrives during the admission check", async () => {
    const abort = new AbortController();
    const c = coordinator();
    vi.mocked(c.admit).mockImplementation(async () => {
      abort.abort();
      return { allowed: true, retryAfterMs: 0, reason: "ready" };
    });
    const upstream = vi.fn(async () => new Response("ok"));
    const fetch = createMcpBackpressureFetch({
      key: "race",
      fetch: upstream,
      coordinator: c,
    });
    await expect(
      fetch(url, { ...post, signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("leaves unenrolled traffic unchanged", async () => {
    const c = coordinator();
    const upstream = vi.fn(async () => new Response("ok"));
    const fetch = createMcpBackpressureFetch({
      key: "off",
      fetch: upstream,
      coordinator: c,
      enabled: () => false,
    });
    await fetch(url, post);
    expect(c.admit).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
