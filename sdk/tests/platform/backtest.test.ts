import { expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  backtestEvalRunOperation,
  backtestEvalRunJudgeOperation,
} from "../../src/platform/index.js";
it("posts an explicit draft and preserves cancellation", async () => {
  const report = {
    schemaVersion: 1,
    sourceRunId: "run",
    sourceHash: "source",
    draftHash: "draft",
    complete: false,
    continuationAvailable: false,
    counts: { iterations: 1, comparable: 0, ungradable: 1, flipped: 0 },
    differences: [],
    modelUse: "none",
  };
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(report), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  const client = new PlatformApiClient({
    baseUrl: "https://example.com/api/v1",
    getAuth: () => "token",
    fetch: fetch as typeof globalThis.fetch,
  });
  const draft = { assertions: { mode: "replace" as const, list: [] } };
  const controller = new AbortController();
  expect(
    await client.backtestEvalRun(
      { projectId: "project", runId: "run", draft },
      { signal: controller.signal }
    )
  ).toEqual(report);
  expect(String(fetch.mock.calls[0][0])).toContain(
    "/projects/project/eval-runs/run/backtest"
  );
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(draft);
  expect(backtestEvalRunOperation.readOnly).toBe(false);
  expect(backtestEvalRunOperation.risk).toBe("none");
});

it("passes a continuation with the unchanged draft", async () => {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ schemaVersion: 1 }), { status: 200 })
  );
  const client = new PlatformApiClient({
    baseUrl: "https://example.com/api/v1",
    getAuth: () => "token",
    fetch: fetch as typeof globalThis.fetch,
  });
  const draft = { assertions: { mode: "inherit" as const, list: [] } };
  const continuation = {
    cursor: "next",
    sourceHash: "source",
    reservationId: "reservation",
    draftHash: "draft",
  };
  await client.backtestEvalRun({
    projectId: "project",
    runId: "run",
    draft,
    continuation,
  });
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
    ...draft,
    continuation,
  });
});

it("uses the shared grading rubric and bound continuation for judge previews", async () => {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  const client = new PlatformApiClient({
    baseUrl: "https://example.com/api/v1",
    getAuth: () => "token",
    fetch: fetch as typeof globalThis.fetch,
  });
  const request = {
    rubric: { instructions: "Verify the complete result" },
    continuation: {
      cursor: 1,
      sourceHash: "a".repeat(64),
      reservationId: "reservation",
    },
  };
  expect(
    backtestEvalRunJudgeOperation.inputSchema.safeParse({
      project: "p",
      runId: "r",
      ...request,
    }).success
  ).toBe(true);
  await client.backtestEvalRunJudge({ projectId: "p", runId: "r", ...request });
  expect(String(fetch.mock.calls[0][0])).toContain(
    "/eval-runs/r/judge/backtest"
  );
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(request);
});
