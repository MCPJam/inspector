/**
 * The mint client, and the one rule that matters most about it: there is no
 * fallback.
 *
 * A turn that quietly lost half its tools is worse to debug than one that
 * stopped, and a turn that quietly lost its EVIDENCE is worse still — it would
 * run to completion recording nothing and read afterwards as a run that simply
 * made no tool calls. So every failure here stays a typed failure, and asking
 * for an eval scope that the control plane refuses must never silently become
 * a claimless mint.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchHarnessProxyTokens } from "../harness-proxy-token-client";

const CONVEX_HTTP_URL = "https://convex.test";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = CONVEX_HTTP_URL;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete process.env.CONVEX_HTTP_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const baseArgs = {
  projectId: "proj_1",
  serverIds: ["server-1"],
  bearer: "token-abc",
};

function lastRequestBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("claimless mints", () => {
  test("send no iteration and report no evidence decision", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, tokens: { "server-1": "tok" } }),
    );

    const result = await fetchHarnessProxyTokens(baseArgs);

    expect(result).toEqual({ ok: true, tokens: { "server-1": "tok" } });
    expect(lastRequestBody()).toEqual({
      projectId: "proj_1",
      serverIds: ["server-1"],
    });
  });

  test("ignore an evidence decision a claimless response should not carry", async () => {
    // Reading one here would invent an answer: with no authorized scope there
    // is no run whose frozen decision this could be.
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        tokens: { "server-1": "tok" },
        harnessEvidence: { captureEnabled: true, gradingSource: "evidence" },
      }),
    );

    const result = await fetchHarnessProxyTokens(baseArgs);

    expect(result).toEqual({ ok: true, tokens: { "server-1": "tok" } });
  });
});

describe("claim-bearing mints", () => {
  test("send the iteration and surface the run's frozen decision", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        tokens: { "server-1": "tok" },
        harnessEvidence: { captureEnabled: true, gradingSource: "evidence" },
      }),
    );

    const result = await fetchHarnessProxyTokens({
      ...baseArgs,
      evalScope: { iterationId: "iter_1" },
    });

    expect(result).toMatchObject({
      ok: true,
      harnessEvidence: { captureEnabled: true, gradingSource: "evidence" },
    });
    expect(lastRequestBody().iterationId).toBe("iter_1");
  });

  test("never report evidence grading without capture", async () => {
    // Grading from evidence a run never captured would score every real tool
    // call as a hallucination, so the pair is clamped on the way in as well as
    // at the freeze.
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        tokens: { "server-1": "tok" },
        harnessEvidence: { captureEnabled: false, gradingSource: "evidence" },
      }),
    );

    const result = await fetchHarnessProxyTokens({
      ...baseArgs,
      evalScope: { iterationId: "iter_1" },
    });

    expect(result).toMatchObject({
      ok: true,
      harnessEvidence: { captureEnabled: false, gradingSource: "narration" },
    });
  });

  test("treat a malformed decision as no decision", async () => {
    // Capture is an awaited durable write in front of every tool call. "The
    // field was there but unreadable" must never resolve to on.
    for (const harnessEvidence of [
      null,
      "on",
      ["on"],
      {},
      { captureEnabled: "yes" },
      { gradingSource: "evidence" },
    ]) {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ok: true,
          tokens: { "server-1": "tok" },
          harnessEvidence,
        }),
      );
      const result = await fetchHarnessProxyTokens({
        ...baseArgs,
        evalScope: { iterationId: "iter_1" },
      });
      expect(result.ok).toBe(true);
      expect(
        (result as { harnessEvidence?: unknown }).harnessEvidence,
      ).toBeUndefined();
    }
  });

  test("a 422 on the scope fails the mint and is NOT retried claimless", async () => {
    // The whole all-or-nothing doctrine in one test. A silent downgrade here
    // produces an iteration that recorded nothing and looks like one that had
    // no tool calls to record.
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        ok: false,
        error: "Not authorized to mint evidence-scoped tokens",
        reason: "not_launcher",
      }),
    );

    const result = await fetchHarnessProxyTokens({
      ...baseArgs,
      evalScope: { iterationId: "iter_1" },
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      error: "Not authorized to mint evidence-scoped tokens",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("failures stay on the result contract", () => {
  test("a network error, a non-JSON body and a malformed token map all report", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchHarnessProxyTokens(baseArgs)).toMatchObject({
      ok: false,
      status: 502,
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    expect(await fetchHarnessProxyTokens(baseArgs)).toMatchObject({
      ok: false,
    });

    // Tokens must be a record of strings; `typeof null === "object"` and
    // arrays pass a bare typeof check, so both are refused here.
    for (const tokens of [null, ["tok"], { "server-1": 42 }]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, tokens }));
      expect(await fetchHarnessProxyTokens(baseArgs)).toMatchObject({
        ok: false,
      });
    }
  });

  test("an unconfigured endpoint does not throw", async () => {
    delete process.env.CONVEX_HTTP_URL;
    expect(await fetchHarnessProxyTokens(baseArgs)).toMatchObject({
      ok: false,
      status: 500,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
