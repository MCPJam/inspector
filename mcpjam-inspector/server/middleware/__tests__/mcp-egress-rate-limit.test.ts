import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("../../config.js", () => ({ HOSTED_MODE: true }));
import {
  createServerCheckMiddleware,
  type CheckCoordinator,
  type CheckDecision,
} from "../mcp-egress-rate-limit.js";
import {
  serverCheckScope,
  withServerCheckSignal,
} from "../../utils/server-check-scope.js";

const active = (): CheckDecision => ({
  state: "active",
  expiresAt: Date.now() + 30_000,
  active: 10,
  waiting: 0,
});
function app(
  coordinator: CheckCoordinator,
  handler = async () => new Response("ok"),
) {
  const app = new Hono();
  app.use(
    "*",
    createServerCheckMiddleware(() => coordinator),
  );
  app.post("/check", handler);
  return app;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shared server check admission", () => {
  it("uses one verified user identity for web sessions and different API keys", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "fixture-service");
    const requests: Array<{ principal: string; requestId: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json(active());
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const key of [undefined, "key-one", "key-two"]) {
        const route = new Hono();
        route.use("*", async (c, next) => {
          c.set("workosUserId", "user-one");
          if (key) c.set("workosApiKeyId", key);
          await next();
        });
        route.use("*", createServerCheckMiddleware());
        route.post("/validate", (c) => c.json({ ok: true }));
        expect(
          (
            await route.request("/validate", {
              method: "POST",
              headers: { authorization: "Bearer fixture" },
            })
          ).status,
        ).toBe(200);
      }
      expect(new Set(requests.map((r) => r.principal))).toEqual(
        new Set(["user:user-one"]),
      );
      expect(new Set(requests.map((r) => r.requestId)).size).toBe(3);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("waits for admission and releases only after the handler finishes", async () => {
    let admit = false;
    let finish!: () => void;
    const calls: string[] = [];
    const coordinator: CheckCoordinator = async (operation) => {
      calls.push(operation);
      return operation === "admit" || (operation === "poll" && !admit)
        ? { ...active(), state: "waiting" }
        : active();
    };
    const handler = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(new Response("ok"));
        }),
    );
    const result = app(coordinator, handler).request("/check", {
      method: "POST",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).not.toHaveBeenCalled();
    admit = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledOnce();
    expect(calls).not.toContain("release");
    finish();
    expect((await result).status).toBe(200);
    expect(calls.at(-1)).toBe("release");
  });
  it.each(["full", "waiting"] as const)(
    "returns a retryable queue error for %s",
    async (state) => {
      const coordinator = vi.fn(async () => ({ ...active(), state }));
      const handler = vi.fn(async () => new Response("ok"));
      const result = app(coordinator, handler).request("/check", {
        method: "POST",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await result;
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("2");
      expect(await response.json()).toMatchObject({
        details: {
          reason:
            state === "full"
              ? "SERVER_CHECK_QUEUE_FULL"
              : "SERVER_CHECK_QUEUE_TIMEOUT",
        },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(coordinator).toHaveBeenLastCalledWith("release");
    },
  );
  it("aborts running network work when renewal fails and fails closed", async () => {
    const coordinator = vi.fn(async (operation: string) => {
      if (operation === "renew") throw new Error("offline");
      return active();
    });
    let aborted = false;
    const handler = async () => {
      const signal = serverCheckScope.getStore()!;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return new Response("ok");
    };
    const result = app(coordinator, handler).request("/check", {
      method: "POST",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).status).toBe(503);
    expect(aborted).toBe(true);
    expect(coordinator).toHaveBeenLastCalledWith("release");
  });
  it("does not run checks if the coordinator is unavailable", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const response = await app(async () => {
      throw new Error("offline");
    }, handler).request("/check", { method: "POST" });
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
  it("propagates cancellation through the outbound fetch and leaves other work alone", async () => {
    const base = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false);
      return new Response("ok");
    });
    expect(withServerCheckSignal(base)).toBe(base);
    const controller = new AbortController();
    const wrapped = serverCheckScope.run(controller.signal, () =>
      withServerCheckSignal(base),
    );
    await wrapped("https://server.example");
    controller.abort();
    expect(() => wrapped("https://server.example")).toThrow();
    expect(base).toHaveBeenCalledOnce();
  });
});
