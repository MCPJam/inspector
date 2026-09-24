import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactStableKey,
  fetchArtifact,
  freshestArtifactUrl,
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
