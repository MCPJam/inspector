import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_CHECKS_SERVICE_BASE,
  SERVICE_ROUTE_TIMEOUT_MS,
  githubChecksServiceEnv,
  postServiceRoute,
} from "../service-route";

// The transport every plan call goes through, and the one boundary in this flow
// where a mistake is INVISIBLE to the layer above: `check-plan.ts` classifies on
// `{status, body}` alone, so anything this function gets wrong arrives there
// wearing the shape of a legitimate answer. Three behaviours carry that weight:
//
//   1. A MALFORMED BODY IS TOLERATED — the status carries the signal.
//   2. A BODY READ THAT HIT THE DEADLINE IS NOT. It must surface as a TIMEOUT,
//      never as `body: null`, which would be indistinguishable from (1) and
//      would let a stalled backend read as one that answered.
//   3. The deadline covers the BODY READ, not just the headers.

const ORIGINAL_ENV = {
  convexUrl: process.env.CONVEX_HTTP_URL,
  serviceToken: process.env.INSPECTOR_SERVICE_TOKEN,
};

/** A `Response` shaped just enough for what the transport actually touches. */
function response(status: number, json: () => Promise<any>) {
  return { status, json } as unknown as Response;
}

function jsonBody(value: unknown) {
  return () => Promise.resolve(value);
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (ORIGINAL_ENV.convexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = ORIGINAL_ENV.convexUrl;
  if (ORIGINAL_ENV.serviceToken === undefined) {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
  } else {
    process.env.INSPECTOR_SERVICE_TOKEN = ORIGINAL_ENV.serviceToken;
  }
});

describe("postServiceRoute", () => {
  it("posts JSON to the configured Convex host with the service token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(200, jsonBody({ ok: true, planId: "p1" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postServiceRoute(
      `${GITHUB_CHECKS_SERVICE_BASE}/plan/begin`,
      { triggerId: "trig-1" }
    );

    expect(result).toEqual({ status: 200, body: { ok: true, planId: "p1" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://convex.test/internal/v1/github-checks/plan/begin");
    expect(init.method).toBe("POST");
    // The token is what makes this route reachable at all; a dropped header is
    // a 401 that would classify as a PROTOCOL error, not as "misconfigured".
    expect(init.headers["x-inspector-service-token"]).toBe("svc-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ triggerId: "trig-1" });
  });

  it("TOLERATES a malformed body — the status carries the signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(500, () => Promise.reject(new SyntaxError("Unexpected token")))
      )
    );

    // 500 + `null` is exactly what the caller classifies as unreachable; the
    // parse failure must not escape as its own error class.
    await expect(postServiceRoute("/x", {})).resolves.toEqual({
      status: 500,
      body: null,
    });
  });

  it("keeps the deadline armed through the BODY read", async () => {
    vi.useFakeTimers();
    // A response whose headers arrive and whose body then stalls past the cap.
    // Left unguarded this hangs the poll loop for as long as the socket lives.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(200, async () => {
          await vi.advanceTimersByTimeAsync(SERVICE_ROUTE_TIMEOUT_MS + 1);
          throw new Error("aborted");
        })
      )
    );

    const call = postServiceRoute("/slow", {});
    // A TIMEOUT, not `body: null`: a stalled read must never be reported as a
    // backend that answered without a body.
    await expect(call).rejects.toThrow(/timed out after 15000ms/);
    await expect(call).rejects.toThrow(/\/slow/);
  });

  it("propagates an aborted fetch rather than inventing a status", async () => {
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));

    // The caller replays a transport throw exactly once; swallowing it into a
    // synthetic status would spend that replay on nothing.
    await expect(postServiceRoute("/x", {})).rejects.toThrow(/aborted/);
  });

  it("disarms the deadline once the call returns", async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        captured = init.signal ?? undefined;
        return Promise.resolve(response(200, jsonBody({ ok: true })));
      })
    );

    await postServiceRoute("/x", {});
    // A timer left armed would abort a controller nobody is using — harmless
    // here, but it also keeps the event loop alive in a process that polls.
    await vi.advanceTimersByTimeAsync(SERVICE_ROUTE_TIMEOUT_MS * 2);
    expect(captured?.aborted).toBe(false);
  });

  it("refuses to call at all when the service env is missing", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(postServiceRoute("/x", {})).rejects.toThrow(
      /CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN/
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(githubChecksServiceEnv()).toBeNull();
  });
});
