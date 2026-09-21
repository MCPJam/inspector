/**
 * `PlatformApiClient.listEvalSuiteStageAnalytics` — the wire it actually makes.
 *
 * The platform client is a TOLERANT reader by design: it does not validate
 * response bodies, so what is worth pinning here is everything it DOES own —
 * the path it builds, which query parameters it serializes and which it drops,
 * and that the shared timeout/abort/error plumbing reaches this method too.
 * Contract validation belongs at the two ends (the route before the boundary,
 * the client-side wrapper after it) and is asserted there.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  PlatformApiError,
} from "../../src/platform/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(
  fetchMock: FetchMock,
  options: Partial<ConstructorParameters<typeof PlatformApiClient>[0]> = {}
): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test_token",
    fetch: fetchMock as unknown as typeof fetch,
    ...options,
  });
}

function urlOf(fetchMock: FetchMock): URL {
  return new URL(String(fetchMock.mock.calls[0]![0]));
}

describe("listEvalSuiteStageAnalytics", () => {
  it("builds the suite-scoped path with encoded ids", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    await makeClient(fetchMock).listEvalSuiteStageAnalytics({
      projectId: "proj/1",
      suiteId: "suite 1",
    });

    const url = urlOf(fetchMock);
    expect(url.pathname).toBe(
      "/api/v1/projects/proj%2F1/eval-suites/suite%201/stage-analytics"
    );
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
  });

  it("serializes every filter, with epoch ms as plain integers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    await makeClient(fetchMock).listEvalSuiteStageAnalytics({
      projectId: "p1",
      suiteId: "s1",
      from: 1700000000000,
      to: 1700000100000,
      runGroupId: "grp_1",
      cursor: "c1",
      limit: 25,
    });

    const params = urlOf(fetchMock).searchParams;
    // Epoch MILLISECONDS, not an ISO string and not exponential notation —
    // the backend indexes on this numerically.
    expect(params.get("from")).toBe("1700000000000");
    expect(params.get("to")).toBe("1700000100000");
    expect(params.get("runGroupId")).toBe("grp_1");
    expect(params.get("cursor")).toBe("c1");
    expect(params.get("limit")).toBe("25");
  });

  it("drops the parameters the caller did not supply", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    await makeClient(fetchMock).listEvalSuiteStageAnalytics({
      projectId: "p1",
      suiteId: "s1",
      limit: 10,
    });

    const params = urlOf(fetchMock).searchParams;
    // Absent, not empty: `?from=` would reach the route as a string that fails
    // coercion, turning an unfiltered read into a 400.
    expect(params.has("from")).toBe(false);
    expect(params.has("to")).toBe(false);
    expect(params.has("runGroupId")).toBe(false);
    expect(params.has("cursor")).toBe(false);
    expect(params.get("limit")).toBe("10");
  });

  it("returns the page envelope through unchanged", async () => {
    const page = { items: [{ runId: "run_1" }], nextCursor: "c2" };
    const fetchMock = vi.fn(async () => jsonResponse(page));
    const result = await makeClient(fetchMock).listEvalSuiteStageAnalytics({
      projectId: "p1",
      suiteId: "s1",
    });
    expect(result).toEqual(page);
  });

  it("forwards a caller AbortSignal", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () =>
            reject(new DOMException("caller aborted", "AbortError"));
          // The abort can land BEFORE fetch is reached — the client awaits its
          // auth resolution first — so an already-aborted signal has to be
          // handled, not just listened for.
          if (init?.signal?.aborted) {
            fail();
            return;
          }
          init?.signal?.addEventListener("abort", fail);
        })
    );
    const controller = new AbortController();

    const pending = makeClient(fetchMock, { timeoutMs: 60_000 })
      .listEvalSuiteStageAnalytics(
        { projectId: "p1", suiteId: "s1" },
        { signal: controller.signal }
      )
      .catch((caught: unknown) => caught);
    controller.abort();

    const error = await pending;
    // A caller's own abort stays an AbortError — it is not the client's
    // deadline and must not be relabelled as one.
    expect((error as { name?: string }).name).toBe("AbortError");
  });

  it("synthesizes TIMEOUT when the client deadline expires", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );

    const error = await makeClient(fetchMock, { timeoutMs: 10 })
      .listEvalSuiteStageAnalytics({ projectId: "p1", suiteId: "s1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("TIMEOUT");
  });

  it("maps a v1 error body onto the typed error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: "NOT_FOUND", message: "Eval suite not found" }, 404)
    );

    const error = await makeClient(fetchMock)
      .listEvalSuiteStageAnalytics({ projectId: "p1", suiteId: "s1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).status).toBe(404);
    expect((error as PlatformApiError).code).toBe("NOT_FOUND");
  });

  it("surfaces the 502 a failed contract validation produces", async () => {
    // The route answers a malformed upstream payload with a service error
    // rather than a 200. A caller must be able to tell that apart from an
    // empty page — it is the difference between "nothing measured" and
    // "something is broken".
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          code: "SERVER_UNREACHABLE",
          message: "Stage analytics payload failed validation",
        },
        502
      )
    );

    const error = await makeClient(fetchMock)
      .listEvalSuiteStageAnalytics({ projectId: "p1", suiteId: "s1" })
      .catch((caught: unknown) => caught);

    expect((error as PlatformApiError).status).toBe(502);
    expect((error as PlatformApiError).code).toBe("SERVER_UNREACHABLE");
  });
});
