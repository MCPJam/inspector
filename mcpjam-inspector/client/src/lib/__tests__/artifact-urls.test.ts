import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactStableKey,
  fetchArtifact,
  freshestArtifactUrl,
  handleArtifactMediaError,
  isSignedArtifactUrl,
  registerArtifactUrls,
  requestArtifactUrlRefresh,
  resetArtifactUrlsForTests,
  useArtifactQuery,
  useArtifactUrlEpoch,
  useFreshArtifactUrl,
} from "@/lib/artifact-urls";

const { mockUseQuery } = vi.hoisted(() => ({ mockUseQuery: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const SITE = "https://test-deployment.convex.site";

function base64Url(value: string): string {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** A link shaped like the backend's; the signature is opaque to the client. */
function artifactUrl(
  storageId: string,
  expiresAtSeconds: number,
  kind = "json",
  site = SITE,
) {
  const body = base64Url(
    JSON.stringify({ v: 1, s: storageId, k: kind, e: expiresAtSeconds }),
  );
  return `${site}/web/artifact?t=${body}.${base64Url(
    `sig-${expiresAtSeconds}`,
  )}`;
}

const T0 = 1_800_000_000;

beforeEach(() => {
  resetArtifactUrlsForTests();
  mockUseQuery.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("artifact link anatomy", () => {
  it("recognizes signed artifact links and nothing else", () => {
    expect(isSignedArtifactUrl(artifactUrl("kg1", T0))).toBe(true);
    expect(
      isSignedArtifactUrl("https://x.convex.cloud/api/storage/0000-1111"),
    ).toBe(false);
    expect(isSignedArtifactUrl(`${SITE}/web/artifact`)).toBe(false);
    expect(isSignedArtifactUrl("not a url")).toBe(false);
    expect(isSignedArtifactUrl(null)).toBe(false);
    // Only web links: an opaque scheme can still end in the artifact path.
    const token = new URL(artifactUrl("kg1", T0)).searchParams.get("t");
    expect(
      isSignedArtifactUrl(`javascript:void(0)//web/artifact?t=${token}`),
    ).toBe(false);
  });

  it("keys a link by the object it points at, not by its expiry", () => {
    const early = artifactUrl("kg1", T0);
    const late = artifactUrl("kg1", T0 + 3600);
    expect(early).not.toBe(late);
    expect(artifactStableKey(early)).toBe(artifactStableKey(late));
    expect(artifactStableKey(artifactUrl("kg2", T0))).not.toBe(
      artifactStableKey(early),
    );
    expect(artifactStableKey(artifactUrl("kg1", T0, "html"))).not.toBe(
      artifactStableKey(early),
    );
    const other = "https://example.com/report.json";
    expect(artifactStableKey(other)).toBe(other);
    // Same claims on another origin are another object.
    expect(
      artifactStableKey(artifactUrl("kg1", T0, "json", "https://evil.example")),
    ).not.toBe(artifactStableKey(early));
  });
});

describe("the freshest-link registry", () => {
  it("finds links anywhere in a result and keeps the freshest per object", () => {
    const stale = artifactUrl("kg1", T0);
    const fresh = artifactUrl("kg1", T0 + 3600);
    registerArtifactUrls({
      session: { messagesBlobUrl: fresh },
      widgetSnapshots: [{ widgetHtmlUrl: artifactUrl("kg2", T0, "html") }],
      notALink: "https://example.com/web/other",
    });
    expect(freshestArtifactUrl(stale)).toBe(fresh);

    // An older link seen later never replaces a fresher one.
    registerArtifactUrls([stale]);
    expect(freshestArtifactUrl(stale)).toBe(fresh);
    expect(freshestArtifactUrl(fresh)).toBe(fresh);
    expect(freshestArtifactUrl("https://example.com/x")).toBe(
      "https://example.com/x",
    );
  });

  it("never lets a look-alike link on another origin stand in for the backend's", async () => {
    const legit = artifactUrl("kg1", T0);
    // The client cannot check signatures, so a string planted in a result
    // (a title, a preview) can claim any object and any expiry. It must not
    // redirect a fetch or an image to its own host.
    const planted = artifactUrl(
      "kg1",
      T0 + 86_400,
      "json",
      "https://evil.example",
    );
    registerArtifactUrls({ title: planted });
    expect(freshestArtifactUrl(legit)).toBe(legit);

    const { result } = renderHook(() => useFreshArtifactUrl(legit));
    expect(result.current).toBe(legit);

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchArtifact(legit);
    expect(fetchMock).toHaveBeenCalledWith(legit);

    // A genuinely fresher link from the backend's origin still wins.
    const fresh = artifactUrl("kg1", T0 + 3600);
    registerArtifactUrls({ messagesBlobUrl: fresh });
    expect(freshestArtifactUrl(legit)).toBe(fresh);
  });

  it("re-renders a src with the fresher link once one is registered", () => {
    const stale = artifactUrl("kg-img", T0, "image");
    const { result } = renderHook(() => useFreshArtifactUrl(stale));
    expect(result.current).toBe(stale);
    const fresh = artifactUrl("kg-img", T0 + 3600, "image");
    act(() => registerArtifactUrls({ screenshotUrl: fresh }));
    expect(result.current).toBe(fresh);
  });
});

describe("refresh requests", () => {
  it("are throttled and move the epoch forward", () => {
    const { result } = renderHook(() => useArtifactUrlEpoch());
    expect(result.current).toBeUndefined();

    let accepted = false;
    act(() => {
      accepted = requestArtifactUrlRefresh(1_000_000);
    });
    expect(accepted).toBe(true);
    const first = result.current;
    expect(first).toEqual(expect.any(Number));

    expect(requestArtifactUrlRefresh(1_000_000 + 5_000)).toBe(false);
    act(() => {
      accepted = requestArtifactUrlRefresh(1_000_000 + 31_000);
    });
    expect(accepted).toBe(true);
    expect(result.current).toBeGreaterThan(first!);
  });
});

describe("fetchArtifact", () => {
  it("passes non-artifact URLs straight through", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchArtifact("https://example.com/report.json");
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/report.json");
  });

  it("reads the freshest known link for the object", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const stale = artifactUrl("kg1", T0);
    const fresh = artifactUrl("kg1", T0 + 3600);
    registerArtifactUrls([fresh]);
    await fetchArtifact(stale);
    expect(fetchMock).toHaveBeenCalledWith(fresh);
  });

  it("on 401 requests a refresh and retries once with the re-minted link", async () => {
    const stale = artifactUrl("kg1", T0);
    const fresh = artifactUrl("kg1", T0 + 3600);
    const fetchMock = vi.fn(async (url: string) =>
      url === fresh
        ? new Response('{"ok":true}', { status: 200 })
        : new Response('{"code":"ARTIFACT_LINK_EXPIRED"}', { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArtifactUrlEpoch());

    const pending = fetchArtifact(stale);
    // The refresh re-runs the queries, which register the new link.
    await vi.waitFor(() => expect(result.current).toEqual(expect.any(Number)));
    registerArtifactUrls({ messagesBlobUrl: fresh });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([stale, fresh]);
  });

  it("returns the 403 unchanged when no fresher link arrives in time", async () => {
    vi.useFakeTimers();
    const stale = artifactUrl("kg1", T0);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchArtifact(stale);
    await vi.advanceTimersByTimeAsync(16_000);
    const res = await pending;
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a refresh on other failures", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArtifactUrlEpoch());
    const res = await fetchArtifact(artifactUrl("kg1", T0));
    expect(res.status).toBe(500);
    expect(result.current).toBeUndefined();
  });
});

describe("fetchArtifact on a missing answer (MJ-005)", () => {
  /** A clock the refresh throttle reads; moved past it between phases. */
  function controlClock(start = 5_000_000_000) {
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    return {
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([404, 410])(
    "on %i renews once, then answers without renewing again for that object",
    async (status) => {
      const clock = controlClock();
      const stale = artifactUrl("kg-gone", T0);
      const fresh = artifactUrl("kg-gone", T0 + 3600);
      const fetchMock = vi.fn(async () => new Response("{}", { status }));
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useArtifactUrlEpoch());

      const pending = fetchArtifact(stale);
      await vi.waitFor(() =>
        expect(result.current).toEqual(expect.any(Number)),
      );
      const epoch = result.current;
      registerArtifactUrls({ screenshotUrl: fresh });
      expect((await pending).status).toBe(status);
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        stale,
        fresh,
      ]);

      // Well past the refresh throttle: only the per-object limit is left to
      // stop another renewal, and the answer comes back at once.
      clock.advance(60_000);
      const again = await fetchArtifact(fresh);
      expect(again.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.current).toBe(epoch);
    },
  );

  it("renews a missing object again once it has been read successfully", async () => {
    const clock = controlClock();
    const stale = artifactUrl("kg-moved", T0);
    const fresh = artifactUrl("kg-moved", T0 + 3600);
    const fresher = artifactUrl("kg-moved", T0 + 7200);
    const statusOf = new Map<string, number>([
      [stale, 404],
      [fresh, 200],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response("{}", { status: statusOf.get(url) ?? 500 }),
      ),
    );
    const { result } = renderHook(() => useArtifactUrlEpoch());

    const first = fetchArtifact(stale);
    await vi.waitFor(() => expect(result.current).toEqual(expect.any(Number)));
    const firstEpoch = result.current!;
    registerArtifactUrls({ screenshotUrl: fresh });
    expect((await first).status).toBe(200);

    clock.advance(60_000);
    statusOf.set(fresh, 410);
    statusOf.set(fresher, 200);
    const second = fetchArtifact(fresh);
    await vi.waitFor(() => expect(result.current).toBeGreaterThan(firstEpoch));
    registerArtifactUrls({ screenshotUrl: fresher });
    expect((await second).status).toBe(200);
  });

  it("does not limit renewals of an expired link the same way", async () => {
    const clock = controlClock();
    const stale = artifactUrl("kg-exp", T0);
    const fresh = artifactUrl("kg-exp", T0 + 3600);
    const fresher = artifactUrl("kg-exp", T0 + 7200);
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response("{}", { status: url === fresher ? 200 : 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArtifactUrlEpoch());

    const first = fetchArtifact(stale);
    await vi.waitFor(() => expect(result.current).toEqual(expect.any(Number)));
    const firstEpoch = result.current!;
    registerArtifactUrls({ screenshotUrl: fresh });
    expect((await first).status).toBe(401);

    clock.advance(60_000);
    const second = fetchArtifact(fresh);
    await vi.waitFor(() => expect(result.current).toBeGreaterThan(firstEpoch));
    registerArtifactUrls({ screenshotUrl: fresher });
    expect((await second).status).toBe(200);
  });
});

describe("handleArtifactMediaError", () => {
  it("renews a link at or past its expiry every time it fails", () => {
    const { result } = renderHook(() => useArtifactUrlEpoch());
    const expiredAt = (T0 + 60) * 1000;

    act(() =>
      handleArtifactMediaError(artifactUrl("kg-rec", T0, "video"), expiredAt),
    );
    const first = result.current;
    expect(first).toEqual(expect.any(Number));

    act(() =>
      handleArtifactMediaError(
        artifactUrl("kg-rec", T0 + 30, "video"),
        expiredAt + 60_000,
      ),
    );
    expect(result.current).toBeGreaterThan(first!);
  });

  it("gives a failure on a link that has not expired one renewal per object", () => {
    const { result } = renderHook(() => useArtifactUrlEpoch());
    const validFor = (T0 - 3600) * 1000;

    act(() =>
      handleArtifactMediaError(artifactUrl("kg-rec", T0, "video"), validFor),
    );
    const first = result.current;
    expect(first).toEqual(expect.any(Number));

    // The re-minted link for the same recording fails too: no further
    // renewal, however long after the first.
    act(() =>
      handleArtifactMediaError(
        artifactUrl("kg-rec", T0 + 3600, "video"),
        validFor + 60_000,
      ),
    );
    expect(result.current).toBe(first);

    // Another object still has its own.
    act(() =>
      handleArtifactMediaError(
        artifactUrl("kg-other", T0, "image"),
        validFor + 120_000,
      ),
    );
    expect(result.current).toBeGreaterThan(first!);
  });

  it("ignores anything that is not a signed link", () => {
    const { result } = renderHook(() => useArtifactUrlEpoch());
    act(() => handleArtifactMediaError("https://example.com/replay.webm"));
    act(() => handleArtifactMediaError(null));
    expect(result.current).toBeUndefined();
  });
});

describe("useArtifactQuery", () => {
  it("leaves the arguments alone until a link has expired", () => {
    renderHook(() =>
      useArtifactQuery("chatSessions:getSession", { sessionId: "s1" }),
    );
    expect(mockUseQuery).toHaveBeenLastCalledWith("chatSessions:getSession", {
      sessionId: "s1",
    });
  });

  it("re-subscribes with a urlEpoch after a refresh, keeping the previous result meanwhile", () => {
    const first = { messagesBlobUrl: artifactUrl("kg1", T0) };
    mockUseQuery.mockImplementation((_name: string, args: unknown) =>
      args && typeof args === "object" && "urlEpoch" in args
        ? undefined
        : first,
    );
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useArtifactQuery<typeof first>("chatSessions:getSession", {
          sessionId,
        }),
      { initialProps: { sessionId: "s1" } },
    );
    expect(result.current).toBe(first);

    act(() => {
      requestArtifactUrlRefresh(2_000_000);
    });
    const lastArgs = mockUseQuery.mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(lastArgs).toMatchObject({ sessionId: "s1" });
    expect(lastArgs.urlEpoch).toEqual(expect.any(Number));
    // The re-subscription is still loading: the previous result stays.
    expect(result.current).toBe(first);

    // Different arguments never inherit another query's result.
    rerender({ sessionId: "s2" });
    expect(result.current).toBeUndefined();
  });

  it("registers the links in each result", () => {
    const fresh = artifactUrl("kg9", T0 + 3600, "html");
    mockUseQuery.mockReturnValue([{ widgetHtmlUrl: fresh }]);
    renderHook(() =>
      useArtifactQuery("directChatHistory:getCurrentSessionWidgetSnapshots", {
        sessionId: "s1",
      }),
    );
    expect(freshestArtifactUrl(artifactUrl("kg9", T0, "html"))).toBe(fresh);
  });

  it("skips like useQuery", () => {
    const { result } = renderHook(() =>
      useArtifactQuery("chatSessions:getSession", "skip"),
    );
    expect(result.current).toBeUndefined();
    expect(mockUseQuery).toHaveBeenLastCalledWith(
      "chatSessions:getSession",
      "skip",
    );
  });
});
