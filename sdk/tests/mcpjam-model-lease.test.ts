import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpjamLeaseClient,
  McpjamLeaseError,
  getMcpjamLeaseClient,
  releaseMcpjamModelLeases,
  resolveMcpjamBaseUrl,
  resolveMcpjamProject,
  MCPJAM_PLACEHOLDER_API_KEY,
  MCPJAM_PROXY_PLACEHOLDER_ORIGIN,
} from "../src/mcpjam-model-lease.js";

// MCPJam-hosted inference: the lease client, and the `fetch` the AI SDK
// provider is built with. Three properties matter here and nowhere else:
//
//   1. the `sk_` key goes ONLY to MCPJam's own API, and no credential-shaped
//      header reaches the model proxy;
//   2. concurrent iterations share ONE lease, and a near-expiry lease is
//      renewed before a generation can straddle it;
//   3. a refusal is read for WHAT it was: a spent lease is re-minted, a
//      parallelism ceiling is waited out, and an out-of-credits refusal is
//      surfaced rather than retried.

const MODEL = "anthropic/claude-sonnet-4.5";
const PROXY = "https://convex.example.com/web/harness/model-proxy/anthropic";

function leaseBody(overrides: Record<string, unknown> = {}) {
  return {
    lease: "lease.jwt.value",
    protocol: "anthropic",
    proxyBaseUrl: PROXY,
    expiresAt: Date.now() + 30 * 60_000,
    runId: "run_1",
    model: MODEL,
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The request the Anthropic provider would make against the placeholder. */
function providerRequest(): [string, RequestInit] {
  return [
    `${MCPJAM_PROXY_PLACEHOLDER_ORIGIN}/v1/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": MCPJAM_PLACEHOLDER_API_KEY,
        authorization: `Bearer ${MCPJAM_PLACEHOLDER_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, messages: [] }),
    },
  ];
}

function makeClient(fetchImpl: typeof fetch, project = "default") {
  return new McpjamLeaseClient({
    baseUrl: "https://app.mcpjam.com",
    apiKey: "sk_test_key",
    project,
    model: MODEL,
    fetchImpl,
  });
}

afterEach(async () => {
  await releaseMcpjamModelLeases();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("minting", () => {
  it("asks MCPJam for a lease with the sk_ key, then never sends it again", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return String(url).endsWith("/model-leases")
          ? json({ ok: true, ...leaseBody() })
          : json({ id: "msg_1" });
      }
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.proxyFetch(...providerRequest());

    expect(calls).toHaveLength(2);
    // 1. The mint — the only place the API key appears.
    expect(calls[0]!.url).toBe(
      "https://app.mcpjam.com/api/v1/projects/default/model-leases"
    );
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization
    ).toBe("Bearer sk_test_key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ model: MODEL });

    // 2. The generation — rewritten onto the live proxy, carrying the lease.
    expect(calls[1]!.url).toBe(`${PROXY}/v1/messages`);
    const sent = calls[1]!.init.headers as Headers;
    expect(sent.get("x-mcpjam-harness-lease")).toBe("lease.jwt.value");
    // Neither credential the provider was built with survives, and neither
    // does the MCPJam key.
    expect(sent.get("x-api-key")).toBeNull();
    expect(sent.get("authorization")).toBeNull();
    expect(JSON.stringify([...sent.entries()])).not.toContain("sk_test_key");
  });

  it("mints once for concurrent iterations", async () => {
    // A suite running cases in parallel would otherwise mint a lease per case
    // on its first tick, each one counting against the org's active-lease cap.
    let mints = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        mints += 1;
        await new Promise((r) => setTimeout(r, 5));
        return json({ ok: true, ...leaseBody() });
      }
      return json({ id: "msg_1" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await Promise.all([
      client.proxyFetch(...providerRequest()),
      client.proxyFetch(...providerRequest()),
      client.proxyFetch(...providerRequest()),
    ]);
    expect(mints).toBe(1);
  });

  it("reuses a live lease across sequential calls", async () => {
    let mints = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        mints += 1;
        return json({ ok: true, ...leaseBody() });
      }
      return json({ id: "msg_1" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.proxyFetch(...providerRequest());
    await client.proxyFetch(...providerRequest());
    expect(mints).toBe(1);
  });

  it("renews before expiry rather than at it", async () => {
    // A generation can take a minute; a lease that expires mid-flight would
    // fail a call that was already paid for.
    let mints = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        mints += 1;
        // Only 30s of life left — inside the renewal window.
        return json({
          ok: true,
          ...leaseBody({ expiresAt: Date.now() + 30_000 }),
        });
      }
      return json({ id: "msg_1" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.proxyFetch(...providerRequest());
    await client.proxyFetch(...providerRequest());
    expect(mints).toBe(2);
  });

  it("uses the project it was given", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ ok: true, ...leaseBody() })
    ) as unknown as typeof fetch;
    await makeClient(fetchImpl, "jd7abc").getLease();
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe(
      "https://app.mcpjam.com/api/v1/projects/jd7abc/model-leases"
    );
  });

  it("retries a rate-limited mint once, honoring Retry-After", async () => {
    // The `sk_` key is metered per key, and a sharded CI run can crowd itself
    // on the first tick. One retry; anything past that is a real refusal.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({ code: "RATE_LIMITED", message: "slow down" }, 429, {
          "retry-after": "0",
        })
      )
      .mockResolvedValueOnce(json({ ok: true, ...leaseBody() }));

    const lease = await makeClient(
      fetchImpl as unknown as typeof fetch
    ).getLease();
    expect(lease.lease).toBe("lease.jwt.value");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a refusal with MCPJam's own code and message", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          code: "FORBIDDEN",
          message: "Not authorized to spend for this organization",
        },
        403
      )
    ) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getLease()).rejects.toThrow(
      McpjamLeaseError
    );
    await expect(makeClient(fetchImpl).getLease()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("refuses a lease body it does not recognize", async () => {
    // Fail loudly: a missing field would otherwise surface later as an
    // unauthenticated proxy call, which says nothing about what went wrong.
    const fetchImpl = vi.fn(async () =>
      json({ ok: true, lease: "x" })
    ) as unknown as typeof fetch;
    await expect(makeClient(fetchImpl).getLease()).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("spending a lease", () => {
  it("re-mints once when the lease itself is spent", async () => {
    // `budget_exhausted` is this LEASE's envelope, not the org's — a fresh
    // lease is the right answer, and the org's own spend cap still binds on
    // every generation.
    let mints = 0;
    const generations: string[] = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith("/model-leases")) {
          mints += 1;
          return json({ ok: true, ...leaseBody({ lease: `lease_${mints}` }) });
        }
        if (String(url).endsWith("/revoke")) return json({ ok: true });
        const presented = new Headers(init?.headers).get(
          "x-mcpjam-harness-lease"
        )!;
        generations.push(presented);
        return presented === "lease_1"
          ? json({ ok: false, error: "Lease budget_exhausted" }, 429)
          : json({ id: "msg_ok" });
      }
    ) as unknown as typeof fetch;

    const res = await makeClient(fetchImpl).proxyFetch(...providerRequest());
    expect(res.status).toBe(200);
    expect(mints).toBe(2);
    expect(generations).toEqual(["lease_1", "lease_2"]);
  });

  it("re-mints once when the lease was revoked", async () => {
    let mints = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        mints += 1;
        return json({ ok: true, ...leaseBody({ lease: `lease_${mints}` }) });
      }
      return mints === 1
        ? json({ ok: false, error: "Lease revoked or not installed" }, 403)
        : json({ id: "msg_ok" });
    }) as unknown as typeof fetch;

    const res = await makeClient(fetchImpl).proxyFetch(...providerRequest());
    expect(res.status).toBe(200);
    expect(mints).toBe(2);
  });

  it("gives up after one re-mint", async () => {
    // Otherwise a persistently-refusing proxy becomes a mint loop against the
    // API key's rate limit.
    let mints = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        mints += 1;
        return json({ ok: true, ...leaseBody({ lease: `lease_${mints}` }) });
      }
      return json({ ok: false, error: "Lease revoked or not installed" }, 403);
    }) as unknown as typeof fetch;

    const res = await makeClient(fetchImpl).proxyFetch(...providerRequest());
    expect(res.status).toBe(403);
    expect(mints).toBe(2);
  });

  it("waits out a parallelism ceiling instead of re-minting", async () => {
    // `max_in_flight` clears on its own in milliseconds. Re-minting would
    // spend a lease slot on something that was never a lease problem.
    let mints = 0;
    let attempts = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        mints += 1;
        return json({ ok: true, ...leaseBody() });
      }
      attempts += 1;
      return attempts === 1
        ? json({ ok: false, error: "Lease max_in_flight" }, 429)
        : json({ id: "msg_ok" });
    }) as unknown as typeof fetch;

    const res = await makeClient(fetchImpl).proxyFetch(...providerRequest());
    expect(res.status).toBe(200);
    expect(mints).toBe(1);
    expect(attempts).toBe(2);
  });

  it("surfaces an out-of-credits refusal without retrying", async () => {
    // The load-bearing distinction. Retrying here would burn the rate limit
    // and report "rate limited" for what is actually "add credits".
    let mints = 0;
    let attempts = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        mints += 1;
        return json({ ok: true, ...leaseBody() });
      }
      attempts += 1;
      return json(
        {
          ok: false,
          error: "Spending limit reached; add credits or retry later.",
        },
        429
      );
    }) as unknown as typeof fetch;

    const res = await makeClient(fetchImpl).proxyFetch(...providerRequest());
    expect(res.status).toBe(429);
    expect(mints).toBe(1);
    expect(attempts).toBe(1);
  });

  it("passes an ordinary upstream error straight back", async () => {
    // A 400 from the model is the caller's problem, not the lease's.
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/model-leases")) {
        return json({ ok: true, ...leaseBody() });
      }
      return json({ error: { message: "max_tokens too large" } }, 400);
    }) as unknown as typeof fetch;

    const res = await makeClient(fetchImpl).proxyFetch(...providerRequest());
    expect(res.status).toBe(400);
  });

  it("preserves the query string when rewriting the URL", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return String(url).endsWith("/model-leases")
        ? json({ ok: true, ...leaseBody() })
        : json({ id: "msg_1" });
    }) as unknown as typeof fetch;

    const [, init] = providerRequest();
    await makeClient(fetchImpl).proxyFetch(
      `${MCPJAM_PROXY_PLACEHOLDER_ORIGIN}/v1/messages?beta=true`,
      init
    );
    expect(urls[1]).toBe(`${PROXY}/v1/messages?beta=true`);
  });

  it("does not double the /v1 an OpenAI lease already carries", async () => {
    // Anthropic leases hand back `…/anthropic`, OpenAI leases `…/openai/v1`.
    // The provider's path supplies `/v1` either way.
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return String(url).endsWith("/model-leases")
        ? json({
            ok: true,
            ...leaseBody({
              protocol: "openai",
              proxyBaseUrl:
                "https://convex.example.com/web/harness/model-proxy/openai/v1",
            }),
          })
        : json({ id: "resp_1" });
    }) as unknown as typeof fetch;

    const [, init] = providerRequest();
    await makeClient(fetchImpl).proxyFetch(
      `${MCPJAM_PROXY_PLACEHOLDER_ORIGIN}/v1/responses`,
      init
    );
    expect(urls[1]).toBe(
      "https://convex.example.com/web/harness/model-proxy/openai/v1/responses"
    );
  });
});

describe("teardown", () => {
  it("revokes what it holds, and clears the registry", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/revoke")
        ? json({ ok: true, revoked: 1 })
        : json({ ok: true, ...leaseBody() })
    ) as unknown as typeof fetch;

    const client = getMcpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      apiKey: "sk_test_key",
      project: "default",
      model: MODEL,
      fetchImpl,
    });
    await client.getLease();
    await releaseMcpjamModelLeases();

    const revoke = vi
      .mocked(fetchImpl)
      .mock.calls.find(([url]) => String(url).endsWith("/revoke"))!;
    expect(String(revoke[0])).toBe(
      "https://app.mcpjam.com/api/v1/projects/default/model-leases/revoke"
    );
    expect(JSON.parse((revoke[1] as RequestInit).body as string)).toEqual({
      runId: "run_1",
    });

    // Cleared, so the next run starts fresh rather than reusing a revoked
    // lease from a cached client.
    const again = getMcpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      apiKey: "sk_test_key",
      project: "default",
      model: MODEL,
      fetchImpl,
    });
    expect(again).not.toBe(client);
  });

  it("never fails a run that already produced results", async () => {
    // Revocation is hygiene; a lease expires on its own. A network failure at
    // teardown must not turn a passing suite into a failing one.
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/revoke")) throw new Error("network down");
      return json({ ok: true, ...leaseBody() });
    }) as unknown as typeof fetch;

    const client = getMcpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      apiKey: "sk_test_key",
      project: "default",
      model: MODEL,
      fetchImpl,
    });
    await client.getLease();
    await expect(releaseMcpjamModelLeases()).resolves.toBeUndefined();
  });

  it("is a no-op when nothing was minted", async () => {
    await expect(releaseMcpjamModelLeases()).resolves.toBeUndefined();
  });
});

describe("the client registry", () => {
  it("shares one client per (deployment, project, model, key)", async () => {
    const opts = {
      baseUrl: "https://app.mcpjam.com",
      apiKey: "sk_test_key",
      project: "default",
      model: MODEL,
    };
    expect(getMcpjamLeaseClient(opts)).toBe(getMcpjamLeaseClient(opts));
    // A different model is a different lease scope, so a different client.
    expect(
      getMcpjamLeaseClient({ ...opts, model: "openai/gpt-5-mini" })
    ).not.toBe(getMcpjamLeaseClient(opts));
    expect(getMcpjamLeaseClient({ ...opts, project: "jd7abc" })).not.toBe(
      getMcpjamLeaseClient(opts)
    );
    expect(getMcpjamLeaseClient({ ...opts, apiKey: "sk_other_key" })).not.toBe(
      getMcpjamLeaseClient(opts)
    );
  });
});

describe("configuration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the public app, and honors MCPJAM_BASE_URL", () => {
    expect(resolveMcpjamBaseUrl()).toBe("https://app.mcpjam.com");
    vi.stubEnv("MCPJAM_BASE_URL", "https://staging.mcpjam.com/");
    // Trailing slash trimmed so URL joining cannot double it.
    expect(resolveMcpjamBaseUrl()).toBe("https://staging.mcpjam.com");
    // An explicit value always wins over the environment.
    expect(resolveMcpjamBaseUrl("https://other.test")).toBe(
      "https://other.test"
    );
  });

  it("trims only trailing slashes, including long slash runs", () => {
    const slashes = "/".repeat(100_000);
    const base = `https://example.test/${slashes}path`;
    expect(resolveMcpjamBaseUrl(`${base}${slashes}`)).toBe(base);
    expect(resolveMcpjamBaseUrl(base)).toBe(base);
    expect(resolveMcpjamBaseUrl(slashes)).toBe("");
    expect(resolveMcpjamBaseUrl("")).toBe("");
  });

  it("defaults the project to the `default` sentinel", () => {
    // Resolved server-side to the key org's Default project — the same
    // resolution eval reporting uses, so inference and results land together
    // with no configuration at all.
    expect(resolveMcpjamProject()).toBe("default");
    vi.stubEnv("MCPJAM_PROJECT_ID", "jd7abc");
    expect(resolveMcpjamProject()).toBe("jd7abc");
    expect(resolveMcpjamProject("explicit")).toBe("explicit");
  });
});

describe("lease lifecycle regressions", () => {
  function transport() {
    let count = 0;
    const revoked: string[] = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith("/revoke")) {
          revoked.push(JSON.parse(init!.body as string).runId);
          return json({ ok: true });
        }
        if (String(url).endsWith("/model-leases")) {
          count++;
          return json(
            leaseBody({ lease: `lease_${count}`, runId: `run_${count}` })
          );
        }
        return json({ ok: true });
      }
    );
    return { fetchImpl, revoked, count: () => count };
  }

  it("retires replacements and revokes every remaining lease at teardown", async () => {
    const t = transport();
    const client = makeClient(t.fetchImpl);
    await client.getLease();
    client.invalidate();
    await client.proxyFetch(...providerRequest());
    expect(t.revoked).toEqual(["run_1"]);
    await client.revoke();
    expect(t.revoked).toEqual(["run_1", "run_2"]);
  });

  it("does not let a delayed refusal invalidate the replacement", async () => {
    const t = transport();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const client = makeClient(async (url, init) => {
      if (
        new Headers(init?.headers).get("x-mcpjam-harness-lease") === "lease_1"
      ) {
        if (++attempts === 2) await delayed;
        return json({ error: "Lease budget_exhausted" }, 429);
      }
      return t.fetchImpl(url, init);
    });
    await client.getLease();
    const first = client.proxyFetch(...providerRequest());
    const second = client.proxyFetch(...providerRequest());
    await first;
    // The old request still uses the old lease.
    expect(t.revoked).toEqual([]);
    release();
    await second;
    expect(t.count()).toBe(2);
    expect(t.revoked).toEqual(["run_1"]);
    await client.revoke();
  });

  it("cancels one waiter without cancelling another waiter's shared mint", async () => {
    const t = transport();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = makeClient(async (url, init) => {
      await gate;
      return t.fetchImpl(url, init);
    });
    const controller = new AbortController();
    const [, init] = providerRequest();
    const cancelled = client.proxyFetch(providerRequest()[0], {
      ...init,
      signal: controller.signal,
    });
    const other = client.getLease();
    const rejection = expect(cancelled).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejection;
    release();
    expect((await other).lease).toBe("lease_1");
    expect(t.count()).toBe(1);
    await client.revoke();
  });

  it("bounds a stalled mint, including a stalled response body", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const client = makeClient(async (_url, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream({ start() {} }));
    });
    const pending = expect(client.getLease()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(signal?.aborted).toBe(true);
  });

  it("bounds teardown even when fetch never settles", async () => {
    vi.useFakeTimers();
    const t = transport();
    const client = makeClient(async (url, init) =>
      String(url).endsWith("/revoke")
        ? new Promise<Response>(() => {})
        : t.fetchImpl(url, init)
    );
    await client.getLease();
    const pending = client.revoke();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it("includes a pending mint in teardown", async () => {
    const t = transport();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = makeClient(async (url, init) => {
      await gate;
      return t.fetchImpl(url, init);
    });
    const mint = client.getLease();
    const cleanup = client.revoke();
    release();
    await mint;
    await cleanup;
    expect(t.revoked).toEqual(["run_1"]);
  });
});
