/**
 * The decision call, against a stubbed backend: what it sends, and what each
 * answer the broker can give becomes. Only a lost lease throws; everything
 * else is an answer the run carries on with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryDecisionItem } from "@mcpjam/sdk";

import {
  ReadinessLeaseLostError,
  requestReadinessDecisions,
} from "../backend-client.js";

const LEASE = { runId: "run_1", jobId: "job_1" };

const ITEMS: DirectoryDecisionItem[] = [
  {
    questionId: "claude.decision.cross-tool-direction",
    candidate: {
      key: "archive_order description",
      field: "description",
      text: "Call lookup_order first to check its state.",
      tool: "archive_order",
      references: ["lookup_order"],
    },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers only when its request is aborted. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      }),
  );
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("requestReadinessDecisions", () => {
  it("asks once, on the run's lease, with the selected items", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, status: "completed", decisions: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await requestReadinessDecisions(LEASE, ITEMS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(
      "https://backend.test/internal/v1/claude-readiness/decisions",
    );
    expect(init.headers["x-inspector-service-token"]).toBe("service-token");
    expect(JSON.parse(String(init.body))).toEqual({ ...LEASE, items: ITEMS });
  });

  it("returns the verdicts, picked to the fields the grade reads", async () => {
    const verdict = {
      questionId: "claude.decision.cross-tool-direction",
      candidateKey: "archive_order description",
      verdict: "direction",
      quote: "Call lookup_order first",
      confidence: 0.9,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          status: "completed",
          decisions: [
            { ...verdict, note: "kept out of the report" },
            { ...verdict, confidence: "high" },
            null,
          ],
          undecided: [],
          promptVersion: "1",
        }),
      ),
    );
    expect(await requestReadinessDecisions(LEASE, ITEMS)).toEqual({
      status: "answered",
      answers: [verdict],
    });
  });

  it.each(["decisions_disabled", "decisions_not_requested"])(
    "reads a 403 %s as the scan being off for the run",
    async (error) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ ok: false, error }, 403)),
      );
      expect(await requestReadinessDecisions(LEASE, ITEMS)).toEqual({
        status: "off",
        detail: error,
      });
    },
  );

  it.each([
    [
      "a lost lease",
      () => jsonResponse({ ok: false, error: "lease_lost" }, 409),
    ],
    ["a 409 it cannot read", () => new Response("conflict", { status: 409 })],
  ])("throws on %s, the node's signal to stop", async (_label, responder) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responder()),
    );
    await expect(
      requestReadinessDecisions(LEASE, ITEMS),
    ).rejects.toBeInstanceOf(ReadinessLeaseLostError);
  });

  it.each([
    [
      "a malformed request",
      () => jsonResponse({ ok: false, error: "too_many_questions" }, 400),
      /400 too_many_questions/,
    ],
    [
      "an unknown run",
      () => jsonResponse({ ok: false, error: "not_found" }, 404),
      /404 not_found/,
    ],
    [
      "an oversized body",
      () => jsonResponse({ ok: false, error: "body_too_large" }, 413),
      /413 body_too_large/,
    ],
    [
      "a refused service token",
      () => jsonResponse({ ok: false, error: "Unauthorized" }, 401),
      /401/,
    ],
    ["a backend error", () => new Response("boom", { status: 500 }), /500/],
    [
      "a pass with no verdicts",
      () =>
        jsonResponse({
          ok: true,
          status: "billing-blocked",
          reason: "platform_cap_reached",
          decisions: [],
          undecided: [],
        }),
      /billing-blocked/,
    ],
    [
      "an unreadable body",
      () => new Response("not json", { status: 200 }),
      /no verdicts/,
    ],
    [
      "an unreachable broker",
      () => Promise.reject(new Error("ECONNRESET")),
      /ECONNRESET/,
    ],
  ])("leaves the checks unjudged on %s", async (_label, responder, detail) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responder()),
    );
    const answer = await requestReadinessDecisions(LEASE, ITEMS);
    expect(answer.status).toBe("unanswered");
    expect(answer).toMatchObject({ detail: expect.stringMatching(detail) });
  });

  it("waits out a worst-case pass, then gives up", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const answer = requestReadinessDecisions(LEASE, ITEMS);
    let settled = false;
    void answer.then(() => {
      settled = true;
    });

    // Six rounds of four questions at 30 seconds each.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await answer).toEqual({
      status: "unanswered",
      detail: "no answer within 4 minutes",
    });
  });

  it("stops waiting when the run is cancelled", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const run = new AbortController();
    const answer = requestReadinessDecisions(LEASE, ITEMS, run.signal);
    run.abort(new Error("cancelled by the requester"));
    expect(await answer).toEqual({ status: "unanswered", detail: "cancelled" });
  });
});

describe("a pass already running for the run", () => {
  const inProgress = () =>
    jsonResponse({ ok: false, error: "decisions_in_progress" }, 409);
  const replay = {
    ok: true,
    status: "completed",
    replayed: true,
    decisions: [
      {
        questionId: "claude.decision.cross-tool-direction",
        candidateKey: "archive_order description",
        verdict: "reference",
        quote: "lookup_order",
        confidence: 0.7,
      },
    ],
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("is waited for, and its stored answers are the run's", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => inProgress())
      .mockImplementationOnce(async () => inProgress())
      .mockImplementation(async () => jsonResponse(replay));
    vi.stubGlobal("fetch", fetchMock);
    const answer = requestReadinessDecisions(LEASE, ITEMS);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await answer).toEqual({
      status: "answered",
      answers: replay.decisions,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is given up on after a worst-case pass, leaving the checks unjudged", async () => {
    const fetchMock = vi.fn(async () => inProgress());
    vi.stubGlobal("fetch", fetchMock);
    const answer = requestReadinessDecisions(LEASE, ITEMS);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(await answer).toEqual({
      status: "unanswered",
      detail:
        "another decision pass for this run was still running after 3 minutes",
    });
    // The first request and six retries, 30 seconds apart.
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("stops waiting for it when the run is cancelled", async () => {
    const fetchMock = vi.fn(async () => inProgress());
    vi.stubGlobal("fetch", fetchMock);
    const run = new AbortController();
    const answer = requestReadinessDecisions(LEASE, ITEMS, run.signal);

    await vi.advanceTimersByTimeAsync(10_000);
    run.abort();
    expect(await answer).toEqual({ status: "unanswered", detail: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
