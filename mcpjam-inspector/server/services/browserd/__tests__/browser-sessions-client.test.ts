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
    // Every field, in each of the three ways a row can be broken: missing,
    // empty, and (where meaningful) an out-of-contract value.
    ["sessionId missing", { ...SESSION, sessionId: undefined }],
    ["computerId missing", { ...SESSION, computerId: undefined }],
    ["computerId empty", { ...SESSION, computerId: "" }],
    ["bootId missing", { ...SESSION, bootId: undefined }],
    ["bootId empty", { ...SESSION, bootId: "" }],
    ["browserdToken missing", { ...SESSION, browserdToken: undefined }],
    ["browserdToken empty", { ...SESSION, browserdToken: "" }],
    ["browserdPort missing", { ...SESSION, browserdPort: undefined }],
    ["browserdPort zero", { ...SESSION, browserdPort: 0 }],
    ["browserdPort out of range", { ...SESSION, browserdPort: 70000 }],
    ["browserdPort non-integer", { ...SESSION, browserdPort: 87.5 }],
    ["publicOrigin missing", { ...SESSION, publicOrigin: undefined }],
    ["publicOrigin empty", { ...SESSION, publicOrigin: "" }],
    ["streamUrl missing", { ...SESSION, streamUrl: undefined }],
    ["streamUrl empty", { ...SESSION, streamUrl: "" }],
    ["streamPassword missing", { ...SESSION, streamPassword: undefined }],
    ["streamPassword empty", { ...SESSION, streamPassword: "" }],
    ["bundleHash missing", { ...SESSION, bundleHash: undefined }],
    ["contextMode missing", { ...SESSION, contextMode: undefined }],
    ["contextMode out of contract", { ...SESSION, contextMode: "shared" }],
    ["session is not an object", "nope"],
  ])(
    "refuses a row with a broken %s — every field is load-bearing",
    async (_case, row) => {
      stubFetch(200, { session: row });
      const result = await lookupBrowserSession({
        computerId: "computer-1",
        expectedBundleHash: "hash-1",
      });
      expect(result.reachable).toBe(true);
      expect(result.session).toBeNull();
    },
  );

  it("passes the requested contextMode and surfaces its staleness verdict", async () => {
    const impl = stubFetch(200, {
      session: null,
      stale: "context_mode_changed",
      observedSessionId: "session-1",
    });
    const result = await lookupBrowserSession({
      computerId: "computer-1",
      expectedBundleHash: "hash-1",
      expectedContextMode: "ephemeral",
    });
    const [, init] = impl.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body).expectedContextMode).toBe("ephemeral");
    expect(result).toEqual({
      reachable: true,
      session: null,
      stale: "context_mode_changed",
      // The observed row id rides back even on a stale answer: it is what
      // makes the follow-up record a compare-and-swap.
      observedSessionId: "session-1",
    });
  });

  it("refuses to send credentials over a non-HTTPS control plane, but allows loopback", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "http://convex.example");
    const impl = stubFetch(200, { session: SESSION });
    expect(
      await lookupBrowserSession({
        computerId: "c",
        expectedBundleHash: "h",
      }),
    ).toEqual({ reachable: false, session: null });
    expect(impl).not.toHaveBeenCalled();

    // Local dev runs the backend on plain-HTTP loopback, where there is no
    // network hop to intercept.
    vi.stubEnv("CONVEX_HTTP_URL", "http://127.0.0.1:3210");
    const local = stubFetch(200, { session: SESSION });
    expect(
      (
        await lookupBrowserSession({
          computerId: "c",
          expectedBundleHash: "h",
        })
      ).reachable,
    ).toBe(true);
    expect(local).toHaveBeenCalled();
  });

  it("never follows a redirect — the custom auth header would ride along", async () => {
    const impl = stubFetch(200, { session: SESSION });
    await lookupBrowserSession({ computerId: "c", expectedBundleHash: "h" });
    const [, init] = impl.mock.calls[0] as unknown as [
      string,
      { redirect: string },
    ];
    expect(init.redirect).toBe("error");
  });

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

  it("record reports recorded / conflict / failed distinctly", async () => {
    const RECORD = {
      computerId: "computer-1",
      bootId: "boot-1",
      browserdToken: "token-1",
      browserdPort: 8791,
      publicOrigin: "https://origin.example",
      streamUrl: "https://stream.example/vnc.html",
      streamPassword: "pw-1",
      bundleHash: "hash-1",
      contextMode: "persistent" as const,
    };

    const impl = stubFetch(200, { sessionId: "session-9" });
    expect(
      await recordBrowserSession({ ...RECORD, replacesSessionId: "session-8" }),
    ).toEqual({ status: "recorded", sessionId: "session-9" });
    const [, init] = impl.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body).replacesSessionId).toBe("session-8");

    // A lost compare-and-swap is a NORMAL answer the caller acts on, not a
    // transport failure — it must be distinguishable from `failed`.
    stubFetch(409, { error: "session_record_conflict" });
    expect(await recordBrowserSession(RECORD)).toEqual({ status: "conflict" });

    stubFetch(400, { error: "Malformed browser session record" });
    expect(await recordBrowserSession(RECORD)).toEqual({ status: "failed" });

    stubFetch(200, { notASessionId: true });
    expect(await recordBrowserSession(RECORD)).toEqual({ status: "failed" });
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
