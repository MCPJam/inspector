/**
 * The org-registry derive limiter.
 *
 * It is not what stands between a stranger and our egress — the route
 * authorizes against the backend first. It bounds how much egress ONE member
 * can spend, so what is worth pinning is the shape of the ceiling: where it
 * bites, where it deliberately does not, and that a full map fails closed
 * rather than handing a churner a way to reset their own bucket.
 *
 * `HOSTED_MODE` is read at module load, so it is stubbed before the import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  HOSTED_MODE: true,
}));

const {
  REGISTRY_DERIVE_RATE_LIMIT,
  registryDeriveRateLimitMiddleware,
  resetRegistryDeriveRateLimitForTests,
} = await import("../registry-derive-rate-limit.js");

function call(
  ip: string | undefined,
  method: "POST" | "GET" = "POST"
): Promise<Response | void> {
  const next = vi.fn(async () => {});
  const c = {
    req: {
      method,
      header: (name: string) =>
        name.toLowerCase() === "x-real-ip" ? ip : undefined,
      raw: new Request("https://inspector.test/api/web/registry/derive"),
    },
    json: (body: unknown, status?: number, headers?: Record<string, string>) =>
      new Response(JSON.stringify(body), { status, headers }),
    // The limiter never reads these, but `getClientIp` walks the context.
    env: {},
  } as never;
  return registryDeriveRateLimitMiddleware(c, next as never);
}

beforeEach(() => {
  resetRegistryDeriveRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registryDeriveRateLimitMiddleware", () => {
  it("passes the last request inside the window and refuses the next", async () => {
    for (let i = 0; i < REGISTRY_DERIVE_RATE_LIMIT; i++) {
      expect(await call("198.51.100.7")).toBeUndefined();
    }

    const refused = (await call("198.51.100.7")) as Response;
    expect(refused.status).toBe(429);
    // A 429 with no Retry-After tells a client to guess.
    expect(refused.headers.get("Retry-After")).toBeTruthy();
  });

  it("meters each address separately", async () => {
    for (let i = 0; i < REGISTRY_DERIVE_RATE_LIMIT; i++) {
      await call("198.51.100.7");
    }

    expect(await call("203.0.113.9")).toBeUndefined();
  });

  it("starts a fresh window after ten minutes", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < REGISTRY_DERIVE_RATE_LIMIT; i++) {
      await call("198.51.100.7");
    }
    expect((await call("198.51.100.7")) as Response).toBeInstanceOf(Response);

    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(await call("198.51.100.7")).toBeUndefined();
  });

  it("fails closed when the bounded address map is full", async () => {
    for (let i = 0; i < 10_000; i++) {
      await call(`198.51.${Math.floor(i / 256)}.${i % 256}`);
    }

    const refused = (await call("203.0.113.9")) as Response;
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
  });

  it("does not charge a request that was never going to reach the handler", async () => {
    for (let i = 0; i < REGISTRY_DERIVE_RATE_LIMIT + 5; i++) {
      expect(await call("198.51.100.7", "GET")).toBeUndefined();
    }

    // Otherwise a cross-site page could spend somebody's whole budget on
    // requests the route would have ignored — turning a limiter meant to
    // protect the flow into a way to deny it.
    expect(await call("198.51.100.7")).toBeUndefined();
  });

  it("lets a request with no attributable address through", async () => {
    for (let i = 0; i < REGISTRY_DERIVE_RATE_LIMIT + 5; i++) {
      expect(await call(undefined)).toBeUndefined();
    }
  });
});
