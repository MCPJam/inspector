import { describe, expect, it } from "vitest";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
  assertAllowedHostedTargetUrl,
  createGuardedFetch,
  isBlockedEgressHost,
  type EgressHostResolver,
} from "../hosted-egress-guard.js";

describe("isBlockedEgressHost", () => {
  it("blocks an empty hostname", () => {
    expect(isBlockedEgressHost("", true)).toBe(true);
    expect(isBlockedEgressHost(" ", true)).toBe(true);
    expect(isBlockedEgressHost("\t\n", true)).toBe(true);
  });
});
/** Never consulted — reaching it means the literal check failed to short-circuit. */
const exploding: EgressHostResolver = async () => {
  throw new Error("resolver must not be called for an IP literal");
};

const resolvesTo =
  (...ips: string[]): EgressHostResolver =>
  async () =>
    ips;

async function assertBlocked(url: string, resolver?: EgressHostResolver) {
  await expect(
    assertAllowedHostedTargetUrl(url, "Server URL", {
      hosted: true,
      resolver: resolver ?? exploding,
    })
  ).rejects.toBeInstanceOf(BlockedEgressTargetError);
}

async function assertAllowed(url: string, resolver?: EgressHostResolver) {
  await expect(
    assertAllowedHostedTargetUrl(url, "Server URL", {
      hosted: true,
      resolver: resolver ?? exploding,
    })
  ).resolves.toBeUndefined();
}

describe("assertAllowedHostedTargetUrl — literal hosts", () => {
  it("blocks cloud metadata, link-local and the unspecified address", async () => {
    await assertBlocked("http://169.254.169.254/mcp");
    await assertBlocked("http://169.254.0.1/mcp");
    await assertBlocked("http://metadata.google.internal/mcp", resolvesTo());
    await assertBlocked("http://0.0.0.0/mcp");
    await assertBlocked("http://[::]/mcp");
    await assertBlocked("http://[fe80::1]/mcp");
  });

  it("blocks loopback and `.localhost` when hosted", async () => {
    await assertBlocked("http://127.0.0.1:3000/mcp");
    await assertBlocked("http://127.9.9.9/mcp");
    await assertBlocked("http://[::1]:3000/mcp");
    await assertBlocked("http://localhost:3000/mcp", resolvesTo());
    await assertBlocked("http://my-server.localhost/mcp", resolvesTo());
  });

  it("blocks RFC-1918, CGNAT and IPv6 ULA", async () => {
    await assertBlocked("http://10.0.0.5/mcp");
    await assertBlocked("http://192.168.1.1/mcp");
    await assertBlocked("http://172.16.0.1/mcp");
    await assertBlocked("http://172.31.255.254/mcp");
    await assertBlocked("http://100.64.0.1/mcp");
    await assertBlocked("http://[fc00::1]/mcp");
    await assertBlocked("http://[fd12:3456::1]/mcp");
  });

  it("blocks IPv4-mapped IPv6 spellings of the same addresses", async () => {
    await assertBlocked("http://[::ffff:169.254.169.254]/mcp");
    await assertBlocked("http://[::ffff:127.0.0.1]/mcp");
    await assertBlocked("http://[::ffff:10.0.0.5]/mcp");
  });

  it("blocks the hex spelling `new URL()` rewrites those into", async () => {
    // `new URL("http://[::ffff:169.254.169.254]/").hostname` is
    // `[::ffff:a9fe:a9fe]` — checking only the dotted form left the metadata
    // endpoint reachable through any parsed URL.
    expect(new URL("http://[::ffff:169.254.169.254]/").hostname).toBe(
      "[::ffff:a9fe:a9fe]"
    );
    await assertBlocked("http://[::ffff:a9fe:a9fe]/mcp"); // 169.254.169.254
    await assertBlocked("http://[::ffff:7f00:1]/mcp"); // 127.0.0.1
    await assertBlocked("http://[::ffff:a00:5]/mcp"); // 10.0.0.5
    await assertBlocked("http://[::ffff:c0a8:101]/mcp"); // 192.168.1.1
    // …and the same spelling of a PUBLIC address still goes through.
    await assertAllowed("http://[::ffff:808:808]/mcp"); // 8.8.8.8
  });

  it("allows public IP literals without touching DNS", async () => {
    // `exploding` proves the literal path never resolves.
    await assertAllowed("https://8.8.8.8/mcp");
    await assertAllowed("https://172.32.0.1/mcp");
    await assertAllowed("https://11.0.0.1/mcp");
    await assertAllowed("https://[2606:4700::1111]/mcp");
  });

  it("blocks reserved names spelled with a trailing DNS dot", async () => {
    // `localhost.` and `metadata.google.internal.` resolve identically to the
    // dotless forms, but are different strings to a literal comparison.
    //
    // The resolver deliberately answers with a PUBLIC address: only the
    // name-based check can reject these, so if the dot-strip regresses the
    // target sails through and this test fails. An empty resolver would have
    // blocked them via the unresolvable path and hidden the regression.
    const publicAnswer = resolvesTo("93.184.216.34");
    await assertBlocked("http://localhost./mcp", publicAnswer);
    await assertBlocked("http://metadata.google.internal./mcp", publicAnswer);
    await assertBlocked("http://my-server.localhost./mcp", publicAnswer);
    await assertBlocked("http://metadata.goog./mcp", publicAnswer);
  });

  it("does not mistake a hex-looking hostname for an IPv6 literal", async () => {
    // `deadbeef` has no dots and no colon. Treated as an IP literal, it would
    // skip the DNS pass entirely and be dialed unresolved — the exact
    // rebinding hole the DNS pass exists to close.
    await assertBlocked("http://deadbeef/mcp", resolvesTo("10.0.0.5"));
    await assertBlocked("http://cafe/mcp", resolvesTo("127.0.0.1"));
    await assertAllowed("http://f00d/mcp", resolvesTo("93.184.216.34"));
  });

  it("rejects non-http(s) schemes and unparseable URLs", async () => {
    await assertBlocked("file:///etc/passwd");
    await assertBlocked("gopher://example.com/");
    await assertBlocked("not a url");
  });
});

describe("assertAllowedHostedTargetUrl — DNS rebinding", () => {
  it("blocks a public hostname that resolves to a private address", async () => {
    await assertBlocked(
      "https://rebind.example.com/mcp",
      resolvesTo("127.0.0.1")
    );
    await assertBlocked(
      "https://rebind.example.com/mcp",
      resolvesTo("169.254.169.254")
    );
    await assertBlocked("https://rebind.example.com/mcp", resolvesTo("::1"));
  });

  it("blocks when ANY resolved address is private, not just the first", async () => {
    await assertBlocked(
      "https://mixed.example.com/mcp",
      resolvesTo("93.184.216.34", "10.0.0.5")
    );
  });

  it("fails closed on an unresolvable hostname", async () => {
    await expect(
      assertAllowedHostedTargetUrl(
        "https://nope.example.test/mcp",
        "Server URL",
        {
          hosted: true,
          resolver: resolvesTo(),
        }
      )
    ).rejects.toThrow(/could not be resolved/);
  });

  it("reports a resolver failure as a lookup problem, not a verdict", async () => {
    // A DNS blip must not read as "your server is blocked". The TYPE is what
    // separates them: a blocked target is the caller's problem and permanent,
    // a resolver outage is ours and retryable.
    await expect(
      assertAllowedHostedTargetUrl(
        "https://flaky.example.com/mcp",
        "Server URL",
        {
          hosted: true,
          resolver: async () => {
            throw new Error("ESERVFAIL");
          },
        }
      )
    ).rejects.toBeInstanceOf(EgressResolutionError);
    await expect(
      assertAllowedHostedTargetUrl(
        "https://flaky.example.com/mcp",
        "Server URL",
        {
          hosted: true,
          resolver: async () => {
            throw new Error("ESERVFAIL");
          },
        }
      )
    ).rejects.toThrow(/Could not check .* for a safe address: ESERVFAIL/);
  });

  it("allows a hostname that resolves entirely to public addresses", async () => {
    await assertAllowed(
      "https://mcp.example.com/mcp",
      resolvesTo("93.184.216.34", "2606:2800:220:1::1")
    );
  });

  it("allows a tunnel-backed server URL", async () => {
    // Tunnels ride public `*.tunnels.mcpjam.com` hostnames, so they clear the
    // guard like any other public target.
    await assertAllowed(
      "https://abc123.tunnels.mcpjam.com/mcp",
      resolvesTo("104.18.0.1")
    );
  });
});

describe("assertAllowedHostedTargetUrl — local mode", () => {
  it("is a no-op outside hosted mode, localhost very much included", async () => {
    // Testing a server on localhost is the inspector's whole job locally.
    for (const url of [
      "http://localhost:3000/mcp",
      "http://127.0.0.1:3000/mcp",
      "http://192.168.1.50/mcp",
      "http://169.254.169.254/mcp",
    ]) {
      await expect(
        assertAllowedHostedTargetUrl(url, "Server URL", {
          hosted: false,
          resolver: exploding,
        })
      ).resolves.toBeUndefined();
    }
  });
});

describe("assertAllowedHostedTargetUrl — error text", () => {
  it("names the field that was refused", async () => {
    await expect(
      assertAllowedHostedTargetUrl(
        "http://10.0.0.5/mcp",
        "OAuth profile server URL",
        { hosted: true, resolver: exploding }
      )
    ).rejects.toThrow(/OAuth profile server URL/);
  });
});

describe("createGuardedFetch", () => {
  /** A fetch that replays a scripted sequence and records what it was asked for. */
  function scriptedFetch(responses: Array<() => Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let index = 0;
    const fn = (async (input: any, init: any) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next();
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  const redirectTo = (location: string, status = 302) => () =>
    new Response(null, { status, headers: { location } });
  const ok = (body = "ok") => () => new Response(body, { status: 200 });

  /**
   * The hole this exists to close: the caller names a host that passes every
   * check, and that host points us at the metadata endpoint. Nothing about the
   * request the caller made was refusable.
   */
  it("refuses a redirect into cloud metadata", async () => {
    const { fn, calls } = scriptedFetch([
      redirectTo("http://169.254.169.254/latest/meta-data/iam/"),
      ok("IAM CREDENTIALS"),
    ]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    await expect(
      guarded("https://redirector.example.com/go")
    ).rejects.toThrow(BlockedEgressTargetError);
    // The second hop was never dialed.
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect into the private network", async () => {
    const { fn } = scriptedFetch([redirectTo("http://10.0.0.5/admin"), ok()]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    await expect(guarded("https://redirector.example.com/go")).rejects.toThrow(
      /private or internal/
    );
  });

  it("follows an ordinary redirect and returns the final response", async () => {
    const { fn, calls } = scriptedFetch([
      redirectTo("https://elsewhere.example.com/mcp"),
      ok("final"),
    ]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    const response = await guarded("https://start.example.com/mcp");
    expect(await response.text()).toBe("final");
    expect(calls.map((c) => c.url)).toEqual([
      "https://start.example.com/mcp",
      "https://elsewhere.example.com/mcp",
    ]);
  });

  it("resolves a relative Location against the hop that sent it", async () => {
    const { fn, calls } = scriptedFetch([redirectTo("/moved"), ok()]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    await guarded("https://start.example.com/deep/path");
    expect(calls[1].url).toBe("https://start.example.com/moved");
  });

  it("hands a 3xx straight back when the caller asked for manual redirects", async () => {
    // The OAuth suite grades redirects; following one for it would destroy the
    // evidence it is trying to collect.
    const { fn, calls } = scriptedFetch([
      redirectTo("http://169.254.169.254/"),
      ok(),
    ]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    const response = await guarded("https://as.example.com/authorize", {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://169.254.169.254/");
    expect(calls).toHaveLength(1);
  });

  it("turns a redirected POST into a GET without a body, per the Fetch standard", async () => {
    const { fn, calls } = scriptedFetch([redirectTo("https://b.example.com/"), ok()]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    await guarded("https://a.example.com/", {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      headers: { "content-type": "application/json" },
    });
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].init.body).toBeUndefined();
  });

  it("preserves method and body across a 307", async () => {
    const { fn, calls } = scriptedFetch([
      redirectTo("https://b.example.com/", 307),
      ok(),
    ]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    await guarded("https://a.example.com/", {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
    });
    expect(calls[1].init.method).toBe("POST");
    expect(calls[1].init.body).toBe('{"jsonrpc":"2.0"}');
  });

  it("stops a redirect loop rather than spinning", async () => {
    const { fn } = scriptedFetch([redirectTo("https://loop.example.com/")]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: resolvesTo("93.184.216.34"),
    });

    await expect(guarded("https://loop.example.com/")).rejects.toThrow(
      /Too many redirects/
    );
  });

  it("is the untouched fetch outside hosted mode", () => {
    const { fn } = scriptedFetch([ok()]);
    expect(createGuardedFetch({ hosted: false, baseFetch: fn })).toBe(fn);
  });
});

describe("createGuardedFetch — credentials across a redirect", () => {
  function scriptedFetch(responses: Array<() => Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let index = 0;
    const fn = (async (input: any, init: any) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next();
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  const redirectTo = (location: string, status = 302) => () =>
    new Response(null, { status, headers: { location } });
  const ok = () => () => new Response("ok", { status: 200 });
  const publicResolver: EgressHostResolver = async () => ["93.184.216.34"];

  const headerOf = (init: RequestInit, name: string) =>
    new Headers((init.headers as HeadersInit | undefined) ?? {}).get(name);

  /**
   * A server under test can harvest its caller's credentials by redirecting to
   * a host it controls. `fetch` strips them on a cross-origin hop; following
   * redirects by hand means inheriting that duty.
   */
  it("does not carry Authorization to a different origin", async () => {
    const { fn, calls } = scriptedFetch([
      redirectTo("https://attacker.example.com/collect"),
      ok(),
    ]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: publicResolver,
    });

    await guarded("https://mcp.example.com/mcp", {
      headers: { authorization: "Bearer at_live", cookie: "sid=abc" },
    });

    expect(headerOf(calls[0].init, "authorization")).toBe("Bearer at_live");
    expect(headerOf(calls[1].init, "authorization")).toBeNull();
    expect(headerOf(calls[1].init, "cookie")).toBeNull();
  });

  it("keeps Authorization on a same-origin redirect", async () => {
    // Same origin is the ordinary `/mcp` → `/mcp/` case; dropping the token
    // there would break authenticated servers for no security gain.
    const { fn, calls } = scriptedFetch([redirectTo("/mcp/v2"), ok()]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: publicResolver,
    });

    await guarded("https://mcp.example.com/mcp", {
      headers: { authorization: "Bearer at_live" },
    });

    expect(headerOf(calls[1].init, "authorization")).toBe("Bearer at_live");
  });

  it("leaves a redirected HEAD as HEAD", async () => {
    const { fn, calls } = scriptedFetch([redirectTo("https://b.example.com/", 303), ok()]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: publicResolver,
    });

    await guarded("https://a.example.com/", { method: "HEAD" });
    expect(calls[1].init.method).toBe("HEAD");
  });

  it("honors redirect: \"error\" instead of following", async () => {
    const { fn, calls } = scriptedFetch([
      redirectTo("https://b.example.com/"),
      ok(),
    ]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: publicResolver,
    });

    await expect(
      guarded(new Request("https://a.example.com/", { redirect: "error" }))
    ).rejects.toThrow(/refused redirects/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a body-bearing Request rather than sending it empty", async () => {
    // Copying every other field and dropping the body would send an empty POST
    // and report the server's answer to THAT as its behavior.
    const { fn, calls } = scriptedFetch([ok()]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: publicResolver,
    });

    await expect(
      guarded(
        new Request("https://a.example.com/", {
          method: "POST",
          body: '{"jsonrpc":"2.0"}',
        })
      )
    ).rejects.toThrow(/cannot be dialed through the egress guard/);
    expect(calls).toHaveLength(0);
  });

  it("preserves a Request object's method and headers", async () => {
    const { fn, calls } = scriptedFetch([ok()]);
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: fn,
      resolver: publicResolver,
    });

    await guarded(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "x-custom": "kept" },
      })
    );

    expect(calls[0].init.method).toBe("POST");
    expect(headerOf(calls[0].init, "x-custom")).toBe("kept");
  });
});
