import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpjamLeaseClient,
  McpjamLeaseError,
  McpjamModelLeaseScope,
  classifyMcpjamLeaseError,
  getMcpjamLeaseClient,
  releaseMcpjamModelLeases,
  resolveMcpjamBaseUrl,
  resolveMcpjamProject,
  MCPJAM_PLACEHOLDER_API_KEY,
  MCPJAM_PROXY_PLACEHOLDER_ORIGIN,
} from "../src/mcpjam-model-lease.js";
import type { McpjamLeaseClientOptions } from "../src/mcpjam-model-lease.js";

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

// ── refreshed auth, platform headers and auth contexts ─────────────────────

type Call = { url: string; init: RequestInit };

function recordingFetch(
  respond: (url: string, init: RequestInit, index: number) => Response
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {}, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function headerRecord(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** A credential that rotates on every read: tok_1, tok_2, … */
function rotatingAuth() {
  let reads = 0;
  const getAuth = vi.fn(async () => `tok_${++reads}`);
  return { getAuth, reads: () => reads };
}

const isMint = (url: string) => url.endsWith("/model-leases");
const isRevoke = (url: string) => url.endsWith("/model-leases/revoke");

describe("refreshed auth", () => {
  it("reads the credential for every mint, mint retry and revoke", async () => {
    const auth = rotatingAuth();
    let mints = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (isMint(url)) {
        mints += 1;
        // The first attempt is rate limited, so the retry must re-read.
        return mints === 1
          ? json({ code: "RATE_LIMITED", message: "slow down" }, 429, {
              "retry-after": "0",
            })
          : json(leaseBody());
      }
      if (isRevoke(url)) return json({ ok: true, revoked: 1 });
      return json({ ok: true });
    });
    const client = new McpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      getAuth: auth.getAuth,
      project: "p_1",
      model: MODEL,
      fetchImpl,
    });

    await client.getLease();
    await client.revoke();

    const platform = calls.filter(
      (call) => isMint(call.url) || isRevoke(call.url)
    );
    expect(
      platform.map((call) => headerRecord(call.init).authorization)
    ).toEqual(["Bearer tok_1", "Bearer tok_2", "Bearer tok_3"]);
    expect(auth.reads()).toBe(3);
  });

  it("renews with a fresh credential, and shares one mint across waiters", async () => {
    const auth = rotatingAuth();
    let expiresAt = Date.now() + 10_000; // inside the renewal window
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (isMint(url)) {
        const body = leaseBody({ runId: `run_${calls.length}`, expiresAt });
        expiresAt = Date.now() + 30 * 60_000;
        return json(body);
      }
      return json({ ok: true, revoked: 1 });
    });
    const client = new McpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      getAuth: auth.getAuth,
      project: "p_1",
      model: MODEL,
      fetchImpl,
    });

    // Single flight: three concurrent waiters, one mint, one credential read.
    const [a, b, c] = await Promise.all([
      client.getLease(),
      client.getLease(),
      client.getLease(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls.filter((call) => isMint(call.url))).toHaveLength(1);

    // That lease is inside the renewal window: the next call re-mints, and
    // re-reads the credential for it.
    const renewed = await client.getLease();
    expect(renewed).not.toBe(a);
    const mints = calls.filter((call) => isMint(call.url));
    expect(mints).toHaveLength(2);
    expect(headerRecord(mints[1]!.init).authorization).toBe(
      `Bearer tok_${auth.reads()}`
    );
  });

  it("reports a credential that cannot be read as an auth refusal", async () => {
    const { fetchImpl, calls } = recordingFetch(() => json(leaseBody()));
    const client = new McpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      getAuth: async () => {
        throw new Error("login expired; run `mcpjam login`");
      },
      project: "p_1",
      model: MODEL,
      fetchImpl,
    });
    const error = await client.getLease().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpjamLeaseError);
    expect((error as McpjamLeaseError).code).toBe("AUTH_UNAVAILABLE");
    expect((error as McpjamLeaseError).message).toContain("login expired");
    expect(classifyMcpjamLeaseError(error as McpjamLeaseError)).toBe("auth");
    // Nothing was sent without a credential.
    expect(calls).toHaveLength(0);
  });

  it("reports a credential service that could not be reached as unavailable, not refused", async () => {
    const outages: unknown[] = [
      new TypeError("fetch failed"),
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
      // The CLI's wording, with the network failure only in the text.
      new Error(
        "Token refresh failed. Run `mcpjam cloud login` again. Could not reach https://auth.example.com/token: fetch failed"
      ),
      Object.assign(new Error("refresh endpoint down"), { retryable: true }),
      new Error("refresh failed", { cause: new TypeError("fetch failed") }),
    ];
    for (const outage of outages) {
      const { fetchImpl, calls } = recordingFetch(() => json(leaseBody()));
      const client = new McpjamLeaseClient({
        baseUrl: "https://app.mcpjam.com",
        getAuth: async () => {
          throw outage;
        },
        project: "p_1",
        model: MODEL,
        fetchImpl,
      });
      const error = await client.getLease().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(McpjamLeaseError);
      expect((error as McpjamLeaseError).code).toBe("AUTH_SERVICE_UNREACHABLE");
      expect(classifyMcpjamLeaseError(error as McpjamLeaseError)).toBe(
        "unavailable"
      );
      expect(calls).toHaveLength(0);
    }
    // A refusal still reads as one.
    const { fetchImpl } = recordingFetch(() => json(leaseBody()));
    const refused = new McpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      getAuth: async () => {
        throw new Error("Token refresh failed. (invalid_grant)");
      },
      project: "p_1",
      model: MODEL,
      fetchImpl,
    });
    const error = await refused.getLease().catch((thrown: unknown) => thrown);
    expect(classifyMcpjamLeaseError(error as McpjamLeaseError)).toBe("auth");
  });

  it("sends a callback credential only to an https:// or loopback origin, and never through a redirect", async () => {
    const base = { getAuth: async () => "tok_1", project: "p_1", model: MODEL };
    expect(
      () =>
        new McpjamLeaseClient({ ...base, baseUrl: "http://app.example.com" })
    ).toThrow(/https:\/\//);
    expect(
      () => new McpjamLeaseClient({ ...base, baseUrl: "not a url" })
    ).toThrow(/not a URL/);
    for (const baseUrl of [
      "https://app.mcpjam.com",
      "http://localhost:3000",
      "http://127.0.0.1:8080",
    ]) {
      expect(() => new McpjamLeaseClient({ ...base, baseUrl })).not.toThrow();
    }
    // The fixed-key path keeps its historical behaviour.
    expect(
      () =>
        new McpjamLeaseClient({
          baseUrl: "http://app.example.com",
          apiKey: "sk_test_key",
          project: "p_1",
          model: MODEL,
        })
    ).not.toThrow();

    const { fetchImpl, calls } = recordingFetch(() => json(leaseBody()));
    const client = new McpjamLeaseClient({
      ...base,
      baseUrl: "https://app.mcpjam.com",
      fetchImpl,
    });
    await client.getLease();
    await client.revoke();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call.init.redirect).toBe("error");
  });

  it("redacts what a failing callback said before it reaches the public error", async () => {
    const { fetchImpl } = recordingFetch(() => json(leaseBody()));
    const client = new McpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      getAuth: async () => {
        throw new Error(
          "refresh rejected: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"
        );
      },
      project: "p_1",
      model: MODEL,
      fetchImpl,
    });
    const error = await client.getLease().catch((thrown: unknown) => thrown);
    expect((error as McpjamLeaseError).message).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"
    );
  });

  it("refuses an empty token rather than sending `Bearer `", async () => {
    const { fetchImpl, calls } = recordingFetch(() => json(leaseBody()));
    const client = new McpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      getAuth: async () => "  ",
      project: "p_1",
      model: MODEL,
      fetchImpl,
    });
    await expect(client.getLease()).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
    expect(calls).toHaveLength(0);
  });

  it("requires exactly one credential source", () => {
    const base = {
      baseUrl: "https://app.mcpjam.com",
      project: "p_1",
      model: MODEL,
    };
    expect(
      () =>
        new McpjamLeaseClient({
          ...base,
          apiKey: "sk_test_key",
          getAuth: async () => "tok",
        })
    ).toThrow(/both an API key and an auth callback/);
    expect(() => new McpjamLeaseClient(base)).toThrow(
      /need an API key or an auth callback/
    );
  });
});

describe("platform headers", () => {
  it("go to MCPJam's API only, and cannot replace the client's own", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (isMint(url)) return json(leaseBody());
      if (isRevoke(url)) return json({ ok: true, revoked: 1 });
      return json({ ok: true });
    });
    const client = new McpjamLeaseClient({
      baseUrl: "https://app.mcpjam.com",
      getAuth: async () => "tok_login",
      headers: {
        "x-mcpjam-client": "cli/5.12.0",
        Authorization: "Bearer smuggled",
        "Content-Type": "text/plain",
      },
      project: "p_1",
      model: MODEL,
      fetchImpl,
    });

    await client.proxyFetch(...providerRequest());
    await client.revoke();

    for (const call of calls.filter(
      (entry) => isMint(entry.url) || isRevoke(entry.url)
    )) {
      const headers = headerRecord(call.init);
      expect(headers["x-mcpjam-client"]).toBe("cli/5.12.0");
      expect(headers.authorization).toBe("Bearer tok_login");
      expect(headers["content-type"]).toBe("application/json");
    }
    const proxied = calls.find((call) => call.url.startsWith(PROXY));
    expect(proxied).toBeDefined();
    const proxyHeaders = headerRecord(proxied!.init);
    // The proxy sees the lease and the provider's own headers — never the
    // platform bearer, never the placeholder key, never a platform header.
    expect(proxyHeaders["x-mcpjam-harness-lease"]).toBe("lease.jwt.value");
    expect(proxyHeaders.authorization).toBeUndefined();
    expect(proxyHeaders["x-api-key"]).toBeUndefined();
    expect(proxyHeaders["x-mcpjam-client"]).toBeUndefined();
    expect(JSON.stringify(proxied!.init)).not.toContain("tok_login");
  });
});

describe("auth contexts and lease scopes", () => {
  const options = (overrides: Partial<McpjamLeaseClientOptions> = {}) => ({
    baseUrl: "https://app.mcpjam.com",
    project: "p_1",
    model: MODEL,
    ...overrides,
  });

  it("never collapses two auth callbacks onto one client", () => {
    const scope = new McpjamModelLeaseScope();
    const alice = async () => "tok_alice";
    const bob = async () => "tok_bob";
    const first = scope.getClient(options({ getAuth: alice }));
    expect(scope.getClient(options({ getAuth: alice }))).toBe(first);
    expect(scope.getClient(options({ getAuth: bob }))).not.toBe(first);
    // Nor onto a fixed-key client for the same deployment, project and model.
    expect(scope.getClient(options({ apiKey: "sk_test_key" }))).not.toBe(first);
  });

  it("keys by deployment, project and model within one bound context", () => {
    const getAuth = async () => "tok";
    const scope = new McpjamModelLeaseScope({ auth: { getAuth } });
    const sonnet = scope.getClient(options({ getAuth }));
    expect(scope.getClient(options({ getAuth }))).toBe(sonnet);
    expect(
      scope.getClient(options({ getAuth, model: "openai/gpt-5-mini" }))
    ).not.toBe(sonnet);
    expect(scope.getClient(options({ getAuth, project: "p_2" }))).not.toBe(
      sonnet
    );
  });

  it("a bound scope refuses a different credential", () => {
    const scope = new McpjamModelLeaseScope({
      auth: { getAuth: async () => "tok_alice" },
    });
    expect(() =>
      scope.getClient(options({ getAuth: async () => "tok_bob" }))
    ).toThrow(/bound to a different MCPJam auth context/);
    expect(() => scope.getClient(options({ apiKey: "sk_test_key" }))).toThrow(
      /does not mint with a fixed API key/
    );
  });

  it("releases only its own leases, never the process-global ones", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (isMint(url)) {
        return json(
          leaseBody({
            runId: `run_${calls.filter((c) => isMint(c.url)).length}`,
          })
        );
      }
      return json({ ok: true, revoked: 1 });
    });
    const getAuth = async () => "tok_login";
    const scope = new McpjamModelLeaseScope({ auth: { getAuth } });
    const scoped = scope.getClient(options({ getAuth, fetchImpl }));
    const global = getMcpjamLeaseClient(
      options({ apiKey: "sk_other_user", fetchImpl })
    );
    await scoped.getLease();
    await global.getLease();

    await scope.release();

    const revokes = calls.filter((call) => isRevoke(call.url));
    expect(revokes).toHaveLength(1);
    expect(JSON.parse(revokes[0]!.init.body as string)).toEqual({
      runId: "run_1",
    });
    expect(headerRecord(revokes[0]!.init).authorization).toBe(
      "Bearer tok_login"
    );
    // A released scope forgets its clients: the next request mints afresh.
    expect(scope.getClient(options({ getAuth, fetchImpl }))).not.toBe(scoped);
  });
});

describe("refusal detail and classification", () => {
  async function refusal(body: unknown, status: number) {
    // `retry-after: 0` so the one 429 retry does not sleep a second per test.
    const { fetchImpl } = recordingFetch(() =>
      json(body, status, status === 429 ? { "retry-after": "0" } : undefined)
    );
    return (await makeClient(fetchImpl)
      .getLease()
      .catch((error: unknown) => error)) as McpjamLeaseError;
  }

  it("keeps a direct billing code and classifies it as billing", async () => {
    const error = await refusal(
      { code: "spend_budget_reached", message: "Spend budget reached" },
      429
    );
    expect(error.code).toBe("spend_budget_reached");
    expect(classifyMcpjamLeaseError(error)).toBe("billing");
  });

  it("finds billing nested under an auth-shaped envelope", async () => {
    // The v1 envelope files a free-tier model restriction as FORBIDDEN; only
    // the nested code says it is about credits, not about the key.
    const error = await refusal(
      {
        code: "FORBIDDEN",
        message: "This model is not included in the free daily allowance.",
        details: { code: "free_tier_model_restricted" },
      },
      403
    );
    expect(error.status).toBe(403);
    expect(error.details).toEqual({ code: "free_tier_model_restricted" });
    expect(classifyMcpjamLeaseError(error)).toBe("billing");
  });

  it("reads a broker-shaped body's own words and code", async () => {
    const error = await refusal(
      {
        ok: false,
        code: "wallet_locked",
        error: "Credit spending is unavailable.",
      },
      429
    );
    expect(error.message).toBe("Credit spending is unavailable.");
    expect(classifyMcpjamLeaseError(error)).toBe("billing");
  });

  it("does not call every 403 bad credentials — only one with no billing detail", async () => {
    expect(
      classifyMcpjamLeaseError(
        await refusal({ code: "FORBIDDEN", message: "Not a member" }, 403)
      )
    ).toBe("auth");
    expect(
      classifyMcpjamLeaseError(
        await refusal({ code: "UNAUTHORIZED", message: "Bad key" }, 401)
      )
    ).toBe("auth");
  });

  it("tells a throttle and an outage apart from both", async () => {
    expect(
      classifyMcpjamLeaseError(
        await refusal({ code: "RATE_LIMITED", message: "slow" }, 429)
      )
    ).toBe("rateLimited");
    expect(
      classifyMcpjamLeaseError(
        await refusal({ code: "SERVER_UNREACHABLE", message: "down" }, 502)
      )
    ).toBe("unavailable");
    expect(
      classifyMcpjamLeaseError(
        await refusal({ code: "VALIDATION_ERROR", message: "bad model" }, 400)
      )
    ).toBe("other");
  });
});
