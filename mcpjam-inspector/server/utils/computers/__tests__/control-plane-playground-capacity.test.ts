import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provisionPlaygroundSandbox } from "../control-plane-client.js";

/**
 * `provisionPlaygroundSandbox`'s capacity loop, pinned at the FUNCTION
 * boundary.
 *
 * The loop body moved to `run-supervisor/capacity-retry.ts`, shared with the
 * swarm sandbox path and (from PR 2) the eval one. The three policies are NOT
 * equivalent, so the extraction is only safe if this surface's own observable
 * behaviour is unchanged: which results are retried, which are handed straight
 * back, and — the part a caller actually branches on — which of the three
 * terminal shapes a give-up produces.
 *
 * Timing is asserted through the deadline rather than by waiting: every test
 * passes a `timeoutMs` small enough that the first 30-second wait cannot fit,
 * so the loop reaches its terminal in real time.
 */
describe("provisionPlaygroundSandbox — capacity", () => {
  const realFetch = global.fetch;
  let previousConvexHttpUrl: string | undefined;
  let requests: number;
  let respond: () => Response;

  beforeEach(() => {
    previousConvexHttpUrl = process.env.CONVEX_HTTP_URL;
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    requests = 0;
    respond = () => new Response("{}", { status: 200 });
    global.fetch = vi.fn(async () => {
      requests += 1;
      return respond();
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (previousConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = previousConvexHttpUrl;
    }
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const args = {
    bearer: "token",
    projectId: "p1",
    chatSessionId: "cs1",
  };

  function capacityResponse(body: Record<string, unknown> = {}): Response {
    return new Response(
      JSON.stringify({ error: "full", code: "at_capacity", ...body }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  it("returns a successful provision on the first attempt", async () => {
    respond = () =>
      new Response(
        JSON.stringify({ sandboxRowId: "s1", status: "provisioning" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await provisionPlaygroundSandbox(args);
    expect(result).toEqual({
      ok: true,
      value: { sandboxRowId: "s1", status: "provisioning" },
    });
    expect(requests).toBe(1);
  });

  it("hands back a non-capacity refusal immediately, without retrying", async () => {
    // A 403 is an ANSWER. The loop has never retried one, and must not start.
    respond = () =>
      new Response(
        JSON.stringify({ error: "nope", code: "FEATURE_UNAVAILABLE" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    const result = await provisionPlaygroundSandbox(args);
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: "FEATURE_UNAVAILABLE",
    });
    expect(requests).toBe(1);
  });

  it("hands back a 503 that is NOT at_capacity without retrying", async () => {
    // The predicate is `503 && at_capacity`, not `503`. Widening it to the
    // swarm's `503 || status 0` would change this surface silently.
    respond = () =>
      new Response(JSON.stringify({ error: "upstream down" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const result = await provisionPlaygroundSandbox(args);
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(requests).toBe(1);
  });

  it("hands back a network error without retrying", async () => {
    // `postJson` turns a thrown fetch into `{ok:false, status:0}`. The swarm
    // retries that; the Playground never has.
    global.fetch = vi.fn(async () => {
      requests += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await provisionPlaygroundSandbox(args);
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(requests).toBe(1);
  });

  it("gives up on a full pool with the capacity terminal, naming the next wait", async () => {
    // The `budget_before_delay` shape: one attempt is made, the 30s wait does
    // not fit a 1s ceiling, and the caller is told what the wait would be plus
    // WHICH budget was full.
    respond = () => capacityResponse({ resource: "desktop" });
    const result = await provisionPlaygroundSandbox({
      ...args,
      timeoutMs: 1_000,
    });

    expect(requests).toBe(1);
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "Playground browser capacity did not become available in time",
      code: "at_capacity",
      resource: "desktop",
      retryAfterMs: 30_000,
    });
  });

  it("omits `resource` when the control plane did not name one", async () => {
    respond = () => capacityResponse();
    const result = await provisionPlaygroundSandbox({
      ...args,
      timeoutMs: 1_000,
    });
    expect(result).not.toHaveProperty("resource");
    expect(result).toMatchObject({ code: "at_capacity", retryAfterMs: 30_000 });
  });

  it("floors a short server-sent Retry-After at 30s", async () => {
    // `min(5min, max(30s, Retry-After))` — a control plane cannot talk this
    // loop into re-polling a full pool on the second.
    respond = () => capacityResponse({}); // header carries the hint
    global.fetch = vi.fn(async () => {
      requests += 1;
      return new Response(
        JSON.stringify({ error: "full", code: "at_capacity" }),
        {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "2" },
        },
      );
    }) as unknown as typeof fetch;

    const result = await provisionPlaygroundSandbox({
      ...args,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ retryAfterMs: 30_000 });
  });

  it("gives up without attempting anything when handed no time at all", async () => {
    // The `budget_exhausted` shape: no attempt, so no `resource` and no
    // `retryAfterMs` — a different terminal from the one above, and the
    // difference is why the shared loop reports a reason rather than a result.
    const result = await provisionPlaygroundSandbox({ ...args, timeoutMs: 0 });
    expect(requests).toBe(0);
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "Playground browser capacity did not become available in time",
      code: "at_capacity",
    });
  });

  it("reports a cancel as 499, not as a capacity refusal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await provisionPlaygroundSandbox({
      ...args,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    expect(result).toEqual({ ok: false, status: 499, error: "cancelled" });
  });

  it("waits out a full pool and succeeds on the next attempt", async () => {
    // The whole point of the loop, end to end: notify, wait 30s, try again,
    // return the box. Fake timers so the wait is asserted rather than endured.
    vi.useFakeTimers();
    try {
      respond = () =>
        requests === 1
          ? capacityResponse({ resource: "org" })
          : new Response(
              JSON.stringify({ sandboxRowId: "s1", status: "provisioning" }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      const waits: Array<{ delayMs: number; resource?: string }> = [];
      const promise = provisionPlaygroundSandbox({
        ...args,
        onWait: (info) => waits.push(info),
      });

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(promise).resolves.toEqual({
        ok: true,
        value: { sandboxRowId: "s1", status: "provisioning" },
      });
      expect(waits).toEqual([{ delayMs: 30_000, resource: "org" }]);
      expect(requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
