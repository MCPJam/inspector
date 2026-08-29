/**
 * The browser-session store client fails CLOSED: an unreachable control
 * plane, a non-2xx, or a row missing any load-bearing field all come back as
 * "no reusable session" — never a throw, never a partially-read row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lookupBrowserSession,
  recordBrowserSession,
  touchBrowserSession,
} from "../browser-sessions-client";

const SESSION = {
  sessionId: "session-1",
  computerId: "computer-1",
  bootId: "boot-1",
  browserdToken: "token-1",
  browserdPort: 8791,
  publicOrigin: "https://origin.example",
  streamUrl: "https://stream.example/vnc.html",
  streamPassword: "pw-1",
  bundleHash: "hash-1",
  contextMode: "persistent",
};

function stubFetch(status: number, body: unknown) {
  const impl = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", impl);
  return impl;
}

describe("browser-sessions-client", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("parses a full row and passes the staleness verdict through", async () => {
    stubFetch(200, { session: SESSION, stale: undefined });
    const result = await lookupBrowserSession({
      computerId: "computer-1",
      expectedBundleHash: "hash-1",
    });
    expect(result.reachable).toBe(true);
    expect(result.session).toMatchObject(SESSION);

    stubFetch(200, { session: null, stale: "bundle_changed" });
    const stale = await lookupBrowserSession({
      computerId: "computer-1",
      expectedBundleHash: "hash-2",
    });
    expect(stale).toEqual({
      reachable: true,
      session: null,
      stale: "bundle_changed",
    });
  });

  it("presents the service token and posts to the lookup route", async () => {
    const impl = stubFetch(200, { session: null });
    await lookupBrowserSession({
      computerId: "computer-1",
      expectedBundleHash: "hash-1",
    });
    const [url, init] = impl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("https://convex.example/browser-runtime/session/lookup");
    expect(init.headers["x-inspector-service-token"]).toBe("service-token");
  });

  it.each([
    ["browserdToken", { ...SESSION, browserdToken: "" }],
    ["streamPassword", { ...SESSION, streamPassword: "" }],
    ["streamUrl", { ...SESSION, streamUrl: undefined }],
    ["browserdPort", { ...SESSION, browserdPort: 0 }],
    ["bootId", { ...SESSION, bootId: "" }],
    ["contextMode", { ...SESSION, contextMode: "shared" }],
  ])(
    "refuses a row with a broken %s — every field is load-bearing",
    async (_field, row) => {
      stubFetch(200, { session: row });
      const result = await lookupBrowserSession({
        computerId: "computer-1",
        expectedBundleHash: "hash-1",
      });
      expect(result.reachable).toBe(true);
      expect(result.session).toBeNull();
    },
  );

  it("reports unreachable (not a throw) on non-2xx, transport failure, or missing config", async () => {
    stubFetch(503, {});
    expect(
      await lookupBrowserSession({
        computerId: "c",
        expectedBundleHash: "h",
      }),
    ).toEqual({ reachable: false, session: null });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(
      await lookupBrowserSession({
        computerId: "c",
        expectedBundleHash: "h",
      }),
    ).toEqual({ reachable: false, session: null });

    vi.stubEnv("CONVEX_HTTP_URL", "");
    expect(
      await lookupBrowserSession({
        computerId: "c",
        expectedBundleHash: "h",
      }),
    ).toEqual({ reachable: false, session: null });
  });

  it("record returns the sessionId, or null when it did not land", async () => {
    stubFetch(200, { sessionId: "session-9" });
    expect(
      await recordBrowserSession({
        computerId: "computer-1",
        bootId: "boot-1",
        browserdToken: "token-1",
        browserdPort: 8791,
        publicOrigin: "https://origin.example",
        streamUrl: "https://stream.example/vnc.html",
        streamPassword: "pw-1",
        bundleHash: "hash-1",
        contextMode: "persistent",
      }),
    ).toBe("session-9");

    stubFetch(400, { error: "Malformed browser session record" });
    expect(
      await recordBrowserSession({
        computerId: "computer-1",
        bootId: "boot-1",
        browserdToken: "token-1",
        browserdPort: 8791,
        publicOrigin: "https://origin.example",
        streamUrl: "https://stream.example/vnc.html",
        streamPassword: "pw-1",
        bundleHash: "hash-1",
        contextMode: "persistent",
      }),
    ).toBeNull();
  });

  it("touch surfaces `counted`, and an unreachable touch counts as not counted", async () => {
    stubFetch(200, { ok: true, counted: true });
    expect(
      await touchBrowserSession({ sessionId: "s", kind: "panel" }),
    ).toEqual({ counted: true });

    stubFetch(200, { ok: true, counted: false });
    expect(
      await touchBrowserSession({ sessionId: "s", kind: "panel" }),
    ).toEqual({ counted: false });

    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    expect(
      await touchBrowserSession({ sessionId: "s", kind: "command" }),
    ).toEqual({ counted: false });
  });
});
