/**
 * The pinned transport adapter, and the one property that makes it safe to use.
 *
 * `server-connection-discovery` decides `terminal` vs `retryable` by
 * `instanceof BlockedEgressTargetError`. An earlier revision of this adapter
 * flattened every `OAuthProxyError` into a plain `Error`, which erased that
 * distinction: an SSRF refusal became indistinguishable from a timeout, so a
 * target we had already refused went straight back onto a retry schedule.
 *
 * THESE TESTS DRIVE THE REAL TRANSPORT. The adapter tells a refusal from a
 * failure by matching the SDK's message, because `OAuthProxyError` carries only
 * a `status` — 400 for both "resolves to a private or reserved address" and
 * "request timeout", which are opposite verdicts. Matching prose across a
 * package boundary is only safe if something notices when the prose changes,
 * and that is what these are: they call `createPinnedFetch` at real reserved
 * addresses and assert the class that comes back, so a reworded SDK message
 * fails here instead of silently downgrading a refusal.
 *
 * `allowPrivateNetwork: false` is passed EXPLICITLY throughout the strict
 * suites below. The option now defaults to `!HOSTED_MODE`, so a bare
 * `createPinnedFetch()` in a test process is a LOCAL inspector and reaches
 * private addresses on purpose — which is the subject of the last describe
 * block, not of these. Naming it here keeps each suite testing one policy.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createPinnedFetch } from "../pinned-fetch.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../hosted-egress-guard.js";

const pinnedFetch = createPinnedFetch({
  allowPrivateNetwork: false,
  timeoutMs: 2_000,
});

describe("refusals keep their class", () => {
  it("refuses a literal loopback address as a blocked target", async () => {
    await expect(pinnedFetch("http://127.0.0.1:9/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses the cloud metadata address", async () => {
    // The address this whole guard exists for.
    await expect(
      pinnedFetch("http://169.254.169.254/latest/meta-data/")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("refuses a private RFC 1918 address", async () => {
    await expect(pinnedFetch("http://10.0.0.1/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses IPv6 loopback", async () => {
    await expect(pinnedFetch("http://[::1]:9/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses a non-http scheme", async () => {
    await expect(pinnedFetch("file:///etc/passwd")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses a URL that carries credentials", async () => {
    await expect(
      pinnedFetch("https://user:pass@example.com/mcp")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("refuses a malformed URL", async () => {
    await expect(pinnedFetch("not-a-url")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });
});

describe("the loopback opt-in is real in both directions", () => {
  // These two are the regression pair for a bug that looked like a nit and was
  // not: `allowLoopback` was declared on the options, documented as a local-dev
  // carve-out, and forwarded to nothing — `OAuthProxyRequest` has no such
  // field. The default therefore permitted `http://127.0.0.1:…` in production
  // (the SDK infers loopback permission from the URL whenever `httpsOnly` is
  // false), while opting in changed nothing at all.

  it("refuses loopback by default", async () => {
    await expect(
      createPinnedFetch({ allowPrivateNetwork: false, timeoutMs: 2_000 })(
        "http://127.0.0.1:9/mcp"
      )
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("dials loopback when the caller opted in", async () => {
    // Reaching the socket layer at all is the proof, so the assertion is that
    // the guard did NOT refuse — not that the connection failed. Port 9 is the
    // discard service and is closed on any normal machine, but if something
    // ever answers there the request simply succeeds, and a test that demanded
    // a connection error would fail for a reason unrelated to what it proves.
    const outcome = await createPinnedFetch({
      allowLoopback: true,
      allowPrivateNetwork: false,
      timeoutMs: 2_000,
    })("http://127.0.0.1:9/mcp").catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("still refuses non-loopback private addresses even with the opt-in", async () => {
    // The carve-out is for loopback ONLY. It never relaxes the guard for LAN,
    // link-local, CGNAT, multicast, documentation, or NAT64-private targets.
    const pinned = createPinnedFetch({
      allowLoopback: true,
      allowPrivateNetwork: false,
      timeoutMs: 2_000,
    });

    await expect(pinned("http://169.254.169.254/")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
    await expect(pinned("http://10.0.0.1/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });
});

describe("outages stay retryable", () => {
  it("never reports an unresolvable host as a blocked target", async () => {
    // `.invalid` is reserved by RFC 2606 and cannot resolve — normally. The
    // hard assertion is the one that holds regardless of the runner's resolver:
    // whatever comes back, it is NOT a refusal. Telling a user their server is
    // forbidden because our DNS hiccuped is the failure this separation exists
    // to prevent, and a captive portal or wildcard resolver answering for
    // `.invalid` must not turn that property into a red test.
    const error = await pinnedFetch(
      "https://mcpjam-nonexistent.invalid/mcp"
    ).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(BlockedEgressTargetError);
    // A wildcard resolver that answers for `.invalid` makes the call SUCCEED,
    // so `error` holds a Response. That is still not a refusal, which is the
    // property under test. Only when neither happened is the specific class
    // asserted — on any behaving resolver, that is the branch taken.
    if (!(error instanceof Response)) {
      expect(error).toBeInstanceOf(EgressResolutionError);
    }
  });
});

describe("every hop's scheme is checked, not just the last one", () => {
  // The adapter follows redirects itself, one `executeOAuthProxy` call per hop,
  // so a chain that dips into plaintext and comes back cannot pass by ending on
  // https. A real server is not needed to prove the property: the initial hop
  // is the same code path every later hop takes.

  it("refuses a plaintext public target outright", async () => {
    await expect(
      pinnedFetch("http://public.example/mcp")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("names the host but never the path, which can carry a token", async () => {
    const error = await pinnedFetch(
      "http://public.example/mcp?access_token=super-secret"
    ).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain("public.example");
    expect(message).not.toContain("super-secret");
  });

  it("keeps the loopback opt-in from becoming a plaintext opt-in", async () => {
    // The carve-out is for reaching `http://127.0.0.1:3000/mcp` in local
    // development. A dev-mode probe that leaves loopback for a public http host
    // is refused exactly like a hosted one would be.
    await expect(
      createPinnedFetch({ allowLoopback: true, timeoutMs: 2_000 })(
        "http://public.example/mcp"
      )
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });
});

describe("the redirect method rewrite is Fetch's, exactly", () => {
  /**
   * This adapter follows redirects ITSELF, one `executeOAuthProxy` call per hop,
   * so the method rewrite the transport would have done is now this loop's job.
   * A rewrite that is merely close is a silently different request than a plain
   * `fetch` would have sent: too broad and a 301 turns a PUT into a GET, so the
   * write never happens and the probe reports success; too narrow and an
   * initialize POST is replayed into a body somewhere the caller never
   * addressed.
   *
   * A real loopback server is the only honest way to observe this — the method
   * that matters is the one that ARRIVES at hop two, which no amount of mocking
   * the transport would exercise. The `allowLoopback` carve-out is what makes it
   * reachable, and the test above proves that carve-out reaches the socket.
   */
  let server: Server;
  let origin: string;
  let status = 302;
  let landed: { method: string; body: string; hasContentType: boolean } | null =
    null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(status, { location: "/end" });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        landed = {
          method: req.method ?? "",
          body: Buffer.concat(chunks).toString(),
          hasContentType: req.headers["content-type"] !== undefined,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  /** Drives one request and returns what the FINAL hop actually received. */
  async function sent(
    path: "/start" | "/end",
    redirectStatus: number,
    method: string,
    body?: string
  ) {
    status = redirectStatus;
    landed = null;
    await createPinnedFetch({ allowLoopback: true, timeoutMs: 5_000 })(
      `${origin}${path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : { body, headers: { "content-type": "application/json" } }),
      }
    );
    return landed;
  }

  const redirected = (redirectStatus: number, method: string, body?: string) =>
    sent("/start", redirectStatus, method, body);

  it.each([301, 302])("rewrites POST to GET on %i", async (redirectStatus) => {
    const hop = await redirected(redirectStatus, "POST", '{"probe":1}');

    expect(hop?.method).toBe("GET");
    expect(hop?.body).toBe("");
    // The body headers have to go with the body, or hop two advertises a
    // content-type for a payload it no longer carries.
    expect(hop?.hasContentType).toBe(false);
  });

  it.each([
    ["PUT", 301],
    ["PUT", 302],
    ["PATCH", 301],
    ["DELETE", 302],
  ])("preserves %s on %i", async (method, redirectStatus) => {
    // The regression: an earlier revision rewrote every non-GET/HEAD method
    // here, so a redirected PUT arrived as a GET and the write silently became
    // a read. Fetch rewrites POST and only POST for 301/302 — which is also
    // exactly what the transport does one layer down, at
    // `updateRequestForRedirect`.
    const hop = await redirected(redirectStatus, method, '{"probe":1}');

    expect(hop?.method).toBe(method);
  });

  it("never carries a non-POST body, at any hop", async () => {
    // Read this before believing the case above proves too little. The
    // transport encodes a body for POST ONLY (`encodeRequestBody` returns
    // undefined for every other method), so a PUT arrives bodiless whether or
    // not a redirect happened — the direct call is the control that shows it.
    // Nothing is being dropped BY THE REDIRECT, which is the property under
    // test; the missing body is a constraint of the layer underneath.
    //
    // It costs this adapter nothing today: its scope is probing MCP servers,
    // which is POST `initialize` and GET. If a body-carrying PUT is ever
    // needed here, the fix belongs in the SDK, and this test is where the
    // constraint is written down.
    const direct = await sent("/end", 302, "PUT", '{"probe":1}');
    expect(direct?.method).toBe("PUT");
    expect(direct?.body).toBe("");

    const viaRedirect = await redirected(302, "PUT", '{"probe":1}');
    expect(viaRedirect?.body).toBe(direct?.body);
  });

  it("rewrites a non-GET/HEAD method to GET on 303", async () => {
    const hop = await redirected(303, "POST", '{"probe":1}');

    expect(hop?.method).toBe("GET");
    expect(hop?.body).toBe("");
  });

  it("leaves HEAD alone on 303", async () => {
    // The other half of the regression. 303 rewrites everything EXCEPT GET and
    // HEAD; turning a HEAD into a GET makes the probe pull a response body the
    // caller deliberately did not ask for.
    const hop = await redirected(303, "HEAD");

    expect(hop?.method).toBe("HEAD");
  });

  it.each([307, 308])(
    "preserves both method and body on %i",
    async (redirectStatus) => {
      const hop = await redirected(redirectStatus, "POST", '{"probe":1}');

      expect(hop?.method).toBe("POST");
      expect(hop?.body).toBe('{"probe":1}');
    }
  );
});

describe("a refusal does not describe the internal network", () => {
  it("names the host that was asked for, never what it resolved to", async () => {
    // The message is reported back to whoever submitted the URL. Echoing the
    // resolved address would turn a refusal into a resolution oracle: submit a
    // hostname, read back what our resolver saw, repeat.
    const error = await pinnedFetch("http://169.254.169.254/latest/").catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(BlockedEgressTargetError);
    const message = (error as Error).message;
    expect(message).toContain("169.254.169.254"); // the host they typed
    expect(message).not.toMatch(/resolves to|resolved/i);
  });
});

describe("null-body statuses come back as responses, not errors", () => {
  // The regression: `new Response("", { status: 204 })` THROWS — an empty
  // string is still a body, and 204/205/304 forbid one. A non-MCP endpoint
  // answering 204 therefore surfaced as a transport error, which discovery
  // classified as retryable and churned on, instead of the terminal "not an
  // MCP server" the actual answer already proved.
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("returns a 204 as a Response", async () => {
    const res = await createPinnedFetch({
      allowLoopback: true,
      timeoutMs: 5_000,
    })(`${origin}/mcp`);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("the caller's AbortSignal actually ends the request", () => {
  // The regression: the adapter accepted a fetch-shaped `init` and ignored
  // `init.signal` entirely, so `withDeadline` in the authorize service — whose
  // comment says aborting the transport "is what actually ends it" — was
  // racing a promise while the request it meant to kill ran to completion. A
  // DCR registration could finish at the provider after the caller had already
  // reported failure.
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer(() => {
      // Never answer. The only way this test finishes fast is the abort.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("aborts in-flight, well before the timeout, as an AbortError", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 50);

    const outcome = await createPinnedFetch({
      allowLoopback: true,
      timeoutMs: 10_000,
    })(`${origin}/hang`, { signal: controller.signal }).catch(
      (e: unknown) => e
    );

    // Well under the 10s transport timeout: the signal did the ending.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect((outcome as Error).name).toBe("AbortError");
    // A cancellation must never look like an outage — `retryable` would put
    // an abandoned attempt back on a schedule.
    expect(outcome).not.toBeInstanceOf(EgressResolutionError);
  });

  it("refuses immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await createPinnedFetch({
      allowLoopback: true,
      timeoutMs: 10_000,
    })(`${origin}/hang`, { signal: controller.signal }).catch(
      (e: unknown) => e
    );

    expect((outcome as Error).name).toBe("AbortError");
  });
});

/**
 * The local inspector's side of the same transport.
 *
 * `allowPrivateNetwork` defaults to `!HOSTED_MODE`, so a bare
 * `createPinnedFetch()` in a local process reaches the developer's own
 * network. These assert the two halves of that: what it now permits, and the
 * floor it still will not cross.
 */
describe("the private-network allowance follows the deployment", () => {
  it("dials a loopback server by default, because that IS the local product", async () => {
    // As above, reaching the socket layer is the proof: assert the guard did
    // not refuse, not that the connection succeeded.
    const outcome = await createPinnedFetch({ timeoutMs: 2_000 })(
      "http://127.0.0.1:9/mcp"
    ).catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("dials a LAN address by default", async () => {
    const outcome = await createPinnedFetch({ timeoutMs: 2_000 })(
      "http://10.0.0.1/mcp"
    ).catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("still refuses cloud metadata, which no local server ever needs", async () => {
    await expect(
      createPinnedFetch({ timeoutMs: 2_000 })(
        "http://169.254.169.254/latest/meta-data/"
      )
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("still refuses a non-http scheme and a credentialed URL", async () => {
    const pinned = createPinnedFetch({ timeoutMs: 2_000 });
    await expect(pinned("file:///etc/passwd")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
    await expect(
      pinned("https://user:pass@example.com/mcp")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("keeps refusing private targets when the caller opts out", async () => {
    await expect(
      createPinnedFetch({ allowPrivateNetwork: false, timeoutMs: 2_000 })(
        "http://10.0.0.1/mcp"
      )
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });
});
