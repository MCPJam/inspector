/**
 * The hosted browser's data plane, as the pane uses it.
 *
 * Two things here have real logic rather than shape: the token cache, which is
 * what keeps a drag from opening a Convex round trip per pointer move, and the
 * single retry that makes a token expiring mid-view invisible instead of
 * fatal. The rest is checked for the one thing worth checking — that it asks
 * the right URL with the right method.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actOnHostedBrowserLease,
  createBrowserTokenCache,
  fetchHostedBrowserSession,
  HostedBrowserError,
  isSecureBrowserOrigin,
  sendHostedBrowserInput,
} from "../client";

/** A mint whose answers a test controls, counting how often it was asked. */
function minter(lifetimeMs = 60_000) {
  let issued = 0;
  return {
    get calls() {
      return issued;
    },
    mint: vi.fn(async () => {
      issued += 1;
      return { token: `tok-${issued}`, expiresAt: Date.now() + lifetimeMs };
    }),
  };
}

/** Record every request and answer with the queued responses. */
function stubFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let next = 0;
  const impl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      // FAILS on an unexpected extra call rather than repeating the last
      // answer. Repeating hid exactly the thing worth catching here: a client
      // that retries when it should not.
      const response = responses[next++];
      if (!response) {
        throw new Error(`unexpected request ${calls.length} to ${String(url)}`);
      }
      return response.clone();
    },
  );
  vi.stubGlobal("fetch", impl);
  return { calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the token cache", () => {
  it("mints once and reuses it", async () => {
    // The whole reason it exists: input arrives twenty times a second while
    // somebody drags, and each mint is a Convex action round trip.
    const m = minter();
    const cache = createBrowserTokenCache(m.mint);
    expect(await cache.get()).toBe("tok-1");
    expect(await cache.get()).toBe("tok-1");
    expect(await cache.get()).toBe("tok-1");
    expect(m.calls).toBe(1);
  });

  it("shares ONE mint across a burst rather than opening several", async () => {
    const m = minter();
    const cache = createBrowserTokenCache(m.mint);
    const all = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(all).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(m.calls).toBe(1);
  });

  it("re-mints before the token actually expires", async () => {
    // Renewing AT the expiry means every renewal races a token already dead in
    // flight; the margin covers a slow round trip and a clock a second out.
    vi.useFakeTimers();
    const m = minter(60_000);
    const cache = createBrowserTokenCache(m.mint);
    expect(await cache.get()).toBe("tok-1");
    vi.setSystemTime(Date.now() + 50_000); // 10s of life left
    expect(await cache.get()).toBe("tok-2");
  });

  it("forgets a token on demand", async () => {
    // The escape hatch an expiry alone cannot provide: a client clock that
    // disagrees with the server's would otherwise keep presenting a token the
    // server rejects, forever, with nothing to invalidate it.
    const m = minter();
    const cache = createBrowserTokenCache(m.mint);
    expect(await cache.get()).toBe("tok-1");
    cache.invalidate();
    expect(await cache.get()).toBe("tok-2");
  });
});

describe("an authorized call", () => {
  it("presents the token and reads the session", async () => {
    const { calls } = stubFetch(
      json(200, {
        ok: true,
        bootId: "boot-1",
        contextMode: "persistent",
        lease: { state: "free" },
        yours: false,
      }),
    );
    const cache = createBrowserTokenCache(minter().mint);
    expect(
      await fetchHostedBrowserSession(cache, { ensure: true }),
    ).toMatchObject({ bootId: "boot-1", yours: false });
    expect(calls[0]!.url).toBe("/api/web/computers/browser/session?ensure=1");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer tok-1",
    );
  });

  it("RETRIES ONCE with a fresh token when the old one expired", async () => {
    // A token lasts about a minute, so the call that notices is an ordinary
    // part of a long view. Without this the pane reports "unauthorized"
    // whenever a minute rolls over.
    const m = minter();
    const { calls } = stubFetch(
      json(401, { error: "Invalid or expired browser token." }),
      json(200, { ok: true, counted: true }),
    );
    const cache = createBrowserTokenCache(m.mint);
    await sendHostedBrowserInput(cache, {
      events: [{ type: "text", text: "a" }],
    });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer tok-1",
    );
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe(
      "Bearer tok-2",
    );
  });

  it("gives up after that one retry rather than spinning", async () => {
    // A token rejected for some OTHER reason answers 401 every time; retrying
    // it in a loop would mint tokens against the same answer forever.
    const m = minter();
    // TWO refusals queued, because the retry is the point: the stub now fails
    // on an unexpected extra call, so this also pins that there is no third.
    const { calls } = stubFetch(
      json(401, { error: "nope" }),
      json(401, { error: "nope" }),
    );
    const cache = createBrowserTokenCache(m.mint);
    await expect(fetchHostedBrowserSession(cache)).rejects.toBeInstanceOf(
      HostedBrowserError,
    );
    expect(calls).toHaveLength(2);
  });

  it("reports a refusal with its status, so a caller can tell them apart", async () => {
    stubFetch(json(423, { error: "lease_held" }));
    const cache = createBrowserTokenCache(minter().mint);
    await expect(
      sendHostedBrowserInput(cache, { events: [] }),
    ).rejects.toMatchObject({ status: 423, code: "lease_held" });
  });
});

describe("what the origin has to be", () => {
  it("refuses to send the token over a plaintext hop to another machine", () => {
    // The token is a bearer capability and the socket carries a live picture
    // of a signed-in browser. The local pane's opener refuses the same way.
    expect(
      isSecureBrowserOrigin({ protocol: "https:", hostname: "app.example" }),
    ).toBe(true);
    expect(
      isSecureBrowserOrigin({ protocol: "http:", hostname: "localhost" }),
    ).toBe(true);
    expect(
      isSecureBrowserOrigin({ protocol: "http:", hostname: "192.168.1.20" }),
    ).toBe(false);
  });
});

describe("changing who holds the browser", () => {
  it("reports a refused acquire as an ANSWER, not a failure", async () => {
    // Somebody else having the browser is a fact about who is driving. A
    // thrown error would put a red banner over a browser that is fine.
    stubFetch(
      json(409, {
        ok: false,
        lease: { state: "held", holderKind: "human" },
        yours: false,
      }),
    );
    const cache = createBrowserTokenCache(minter().mint);
    expect(await actOnHostedBrowserLease(cache, { action: "acquire" })).toEqual(
      {
        took: false,
        lease: { state: "held", holderKind: "human" },
        yours: false,
      },
    );
  });

  it("tells a browser that STOPPED from a browser somebody else has", async () => {
    // The same 409 carries both. Reported as a holder refusal, the second sets
    // the pane waiting for a hand-back from a browser that is gone.
    stubFetch(json(409, { ok: false, error: "no_browser_session" }));
    const cache = createBrowserTokenCache(minter().mint);
    await expect(
      actOnHostedBrowserLease(cache, { action: "acquire" }),
    ).rejects.toMatchObject({ code: "no_browser_session" });
  });

  it("carries the server's verdict on whether the lease is theirs", async () => {
    const { calls } = stubFetch(
      json(200, { ok: true, lease: { state: "held" }, yours: true }),
    );
    const cache = createBrowserTokenCache(minter().mint);
    expect(
      await actOnHostedBrowserLease(cache, { action: "acquire" }),
    ).toMatchObject({ took: true, yours: true });
    expect(calls[0]!.url).toBe("/api/web/computers/browser/lease");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      action: "acquire",
    });
  });
});
