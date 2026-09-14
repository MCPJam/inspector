vi.mock("../src/sentry", () => ({
  addBreadcrumb: vi.fn().mockResolvedValue(undefined),
  captureEvalReportingFailure: vi.fn().mockResolvedValue(undefined),
}));
import { createServer } from "node:http";
import { startEvalRun } from "../src/report-eval-results";

const config = {
  apiKey: "sk_test",
  project: "default",
  baseUrl: "http://localhost",
  timeoutMs: 25,
  retryDelaysMs: [],
};
afterEach(() => vi.unstubAllGlobals());
it("bounds a stalled response body even when fetch ignores abort", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      signal = init.signal;
      return { ok: true, status: 200, json: () => new Promise(() => {}) };
    })
  );
  const outcome = await Promise.race([
    startEvalRun(config, { suiteName: "test", externalRunId: "run" }).then(
      () => "success",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 100)),
  ]);
  expect(outcome).toBe("rejected");
  expect(signal?.aborted).toBe(true);
});

import {
  reportingRequest,
  retryAfterMs,
} from "../src/eval-reporting-transport";
import {
  appendEvalRunIterations,
  finalizeEvalRun,
  uploadWidgetSnapshots,
} from "../src/report-eval-results";
const response = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>
) => new Response(JSON.stringify(body), { status, headers });
const start = (
  options: typeof config & {
    operationTimeoutMs?: number;
    maxResponseBytes?: number;
  } = config
) => startEvalRun(options, { suiteName: "test", externalRunId: "run" });
it.each([
  {},
  [],
  null,
  { suiteId: "suite" },
  { suiteId: "suite", runId: "run", status: "future" },
  { suiteId: "suite", runId: "run", verdictPolicyVersion: 9 },
])("rejects invalid acknowledgments without retry: %j", async (body) => {
  const fetch = vi.fn(async () => response(body));
  vi.stubGlobal("fetch", fetch);
  await expect(start({ ...config, retryDelaysMs: [1] })).rejects.toThrow(
    "Invalid reporting response"
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("accepts a legacy start", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ suiteId: "suite", runId: "run" }))
  );
  await expect(start()).resolves.toMatchObject({
    suiteId: "suite",
    runId: "run",
  });
});
it("rejects partial append acknowledgment and mismatched final run", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ inserted: 0, skipped: 0, total: 0 }))
  );
  await expect(
    appendEvalRunIterations(config, {
      runId: "run",
      results: [{ caseTitle: "case", passed: true }],
    })
  ).rejects.toThrow("Invalid reporting response");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ suiteId: "suite", runId: "other" }))
  );
  await expect(
    finalizeEvalRun(config, { runId: "run", externalRunId: "run" })
  ).rejects.toThrow("Invalid reporting response");
});
it.each([400, 401, 403, 409, 422])(
  "does not retry HTTP %i with misleading transient error text",
  async (status) => {
    const fetch = vi.fn(async () =>
      response({ error: "network timeout 503 429" }, status)
    );
    vi.stubGlobal("fetch", fetch);
    await expect(start({ ...config, retryDelaysMs: [1] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);
it("retries identical bytes after a lost committed response", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(response({ suiteId: "suite", runId: "run" }));
  vi.stubGlobal("fetch", fetch);
  await start({ ...config, retryDelaysMs: [1] });
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
});
it("bounds Retry-After by the overall budget", async () => {
  const fetch = vi.fn(async () =>
    response({ error: "busy" }, 503, { "retry-after": "3600" })
  );
  vi.stubGlobal("fetch", fetch);
  const started = Date.now();
  await expect(
    start({ ...config, retryDelaysMs: [1], operationTimeoutMs: 40 })
  ).rejects.toThrow("deadline");
  expect(Date.now() - started).toBeLessThan(250);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("cancels during backoff preserving the original reason", async () => {
  const abort = new AbortController();
  const reason = new Error("caller cancelled");
  const fetch = vi.fn(async () => {
    setTimeout(() => abort.abort(reason), 10);
    return response({}, 503, { "retry-after": "10" });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(
    reportingRequest(
      { ...config, signal: abort.signal, retryDelaysMs: [1] },
      "http://localhost",
      {},
      (x) => x,
      () => true
    )
  ).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("parses Retry-After seconds and dates", () => {
  expect(retryAfterMs("2")).toBe(2000);
  expect(retryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000);
  expect(retryAfterMs("-1")).toBeUndefined();
  expect(retryAfterMs("bad")).toBeUndefined();
});
it("limits streamed response bytes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("x".repeat(128)))
  );
  await expect(start({ ...config, maxResponseBytes: 32 })).rejects.toThrow(
    "byte limit"
  );
});
it("bounds a real HTTP response stalled after headers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const before = Date.now();
    await expect(
      start({
        ...config,
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 40,
      })
    ).rejects.toThrow("deadline");
    expect(Date.now() - before).toBeLessThan(300);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("bounds presigned artifact response bodies", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({ uploadUrl: "https://storage.example/upload" })
    )
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    });
  vi.stubGlobal("fetch", fetch);
  const before = Date.now();
  const result = await uploadWidgetSnapshots(config, [
    {
      caseTitle: "case",
      passed: true,
      widgetSnapshots: [
        { toolName: "tool", widgetHtml: "<html></html>" } as any,
      ],
    },
  ]);
  expect(Date.now() - before).toBeLessThan(250);
  expect(result[0].widgetSnapshots?.[0].widgetHtml).toBe("<html></html>");
  expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  warn.mockRestore();
});
it("does not start transport for an already cancelled operation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancel before start"));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    reportingRequest(
      { ...config, signal: controller.signal },
      "http://localhost",
      {},
      (body) => body,
      () => true
    )
  ).rejects.toThrow("cancel before start");
  expect(fetch).not.toHaveBeenCalled();
});
it("shares one absolute deadline across requests", async () => {
  const deadlineAt = Date.now() + 40;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return response({ suiteId: "suite", runId: "run" });
    })
  );
  await startEvalRun(
    { ...config, timeoutMs: 100, deadlineAt },
    { suiteName: "test", externalRunId: "run" }
  );
  await expect(
    startEvalRun(
      { ...config, timeoutMs: 100, deadlineAt },
      { suiteName: "test", externalRunId: "run" }
    )
  ).rejects.toThrow("deadline");
});
