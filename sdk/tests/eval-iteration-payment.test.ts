import { afterEach, expect, it, vi } from "vitest";
vi.unmock("../src/eval-run-start.js");
vi.unmock("../src/eval-iteration-payment.js");
import { EvalTest } from "../src/EvalTest.js";
import { EvalSuite } from "../src/EvalSuite.js";
import {
  runToEvalResults,
  suiteRunToEvalResults,
} from "../src/eval-result-mapping.js";
import * as reporting from "../src/eval-reporting-receipt.js";
import { PromptResult } from "../src/PromptResult.js";
import type { HostExecutor } from "../src/HostExecutor.js";

const options = {
  iterations: 1,
  apiKey: "sk_test",
  mcpjam: { enabled: false, baseUrl: "http://localhost:3000" },
};
function executor() {
  const history: PromptResult[] = [];
  const run = vi.fn<HostExecutor["run"]>(async (message) => {
    const result = new PromptResult({
      prompt: typeof message === "string" ? message : "test",
      text: "ok",
      messages: [],
      latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    history.push(result);
    return result;
  });
  const host: HostExecutor = {
    run,
    getPromptHistory: () => history,
    resetPromptHistory: () => {
      history.length = 0;
    },
    withOptions: () => host,
  };
  return host;
}
function online(
  payment?: (body: Record<string, unknown>) => Response | Promise<Response>
) {
  const payments: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (String(url).endsWith("start-run"))
        return Response.json({
          ok: true,
          runStartId: body.runStartId,
          projectId: "project",
          organizationId: "org",
        });
      payments.push(body);
      return payment
        ? payment(body)
        : Response.json({
            ok: true,
            ...body,
            paymentId: `payment-${payments.length}`,
          });
    })
  );
  return payments;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("pays once before callbacks and reuses payment across retries", async () => {
  const payments = online();
  let attempts = 0;
  const test = new EvalTest({
    id: "case_a",
    name: "paid",
    execute: async () => {
      expect(payments).toHaveLength(1);
      if (++attempts === 1) throw new Error("retry");
    },
  });
  const result = await test.run(executor(), { ...options, retries: 1 });
  expect(attempts).toBe(2);
  expect(payments).toHaveLength(1);
  expect(result.iterationDetails[0].billingPaymentId).toBe("payment-1");
  expect(
    runToEvalResults(result, { casePrefix: "paid" })[0].billingPaymentId
  ).toBe("payment-1");
  expect(
    suiteRunToEvalResults(new Map([["paid", result]]), {
      casePrefix: "suite",
    })[0].billingPaymentId
  ).toBe("payment-1");
  expect(Object.keys(payments[0]).sort()).toEqual([
    "billableSteps",
    "caseId",
    "iterationKey",
    "runStartId",
  ]);
});

it.each([false, true])(
  "keeps overflow terminal when caught and replaced=%s",
  async (replaceError) => {
    online();
    const host = executor();
    let callbacks = 0;
    const test = new EvalTest({
      id: "case_a",
      name: "overflow",
      execute: async (agent) => {
        callbacks++;
        await agent.run("first");
        agent.resetPromptHistory();
        try {
          await agent.withOptions({}).run("excess");
        } catch {
          /* The runner must still refuse success. */
        }
        if (replaceError) throw new Error("different error");
      },
    });
    await expect(
      test.run(host, { ...options, retries: 3 })
    ).rejects.toMatchObject({ code: "BILLABLE_STEPS_EXCEEDED" });
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(callbacks).toBe(1);
    expect(test.getResults()?.iterationDetails[0].billingPaymentId).toBe(
      "payment-1"
    );
  }
);

it("stops queued payments and drains already paid callbacks after refusal", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const payments = online(() =>
    payments.length === 5
      ? Response.json(
          {
            code: "FORBIDDEN",
            message: "Add credits.",
            details: { reason: "PLATFORM_FEE_REQUIRED" },
          },
          { status: 403 }
        )
      : Response.json({
          ok: true,
          ...payments[payments.length - 1],
          paymentId: `paid-${payments.length}`,
        })
  );
  let callbacks = 0;
  let finished = false;
  const test = new EvalTest({
    id: "case_a",
    name: "drain",
    execute: async () => {
      callbacks++;
      await gate;
    },
  });
  const pending = test
    .run(executor(), { ...options, iterations: 10, concurrency: 5 })
    .finally(() => {
      finished = true;
    });
  const rejected = expect(pending).rejects.toMatchObject({
    code: "PLATFORM_FEE_REQUIRED",
  });
  await vi.waitFor(() => expect(callbacks).toBe(4));
  expect(finished).toBe(false);
  expect(payments).toHaveLength(5);
  release();
  await rejected;
  expect(payments).toHaveLength(5);
  expect(test.getResults()?.iterationDetails).toHaveLength(4);
  expect(
    test.getResults()?.iterationDetails.every((row) => row.billingPaymentId)
  ).toBe(true);
});

it("does not retry permanent quota refusals", async () => {
  const payments = online(() =>
    Response.json(
      { code: "RATE_LIMITED", details: { reason: "billing_limit_reached" } },
      { status: 429 }
    )
  );
  const test = new EvalTest({
    id: "case_a",
    name: "quota",
    execute: async () => {
      throw new Error("must not run");
    },
  });
  await expect(test.run(executor(), options)).rejects.toMatchObject({
    code: "billing_limit_reached",
  });
  expect(payments).toHaveLength(1);
});

it("keeps the terminal billing reason when strict partial reporting fails", async () => {
  const payments = online((body) =>
    payments.length === 1
      ? Response.json({ ok: true, ...body, paymentId: "paid-first" })
      : Response.json(
          { code: "FORBIDDEN", details: { reason: "PLATFORM_FEE_REQUIRED" } },
          { status: 403 }
        )
  );
  const capture = vi
    .spyOn(reporting, "captureEvalReporting")
    .mockResolvedValue({
      error: new Error("upload unavailable"),
      receipt: {
        schemaVersion: 1,
        state: "failed",
        acceptedIterations: 1,
        acknowledgedIterations: null,
        pendingIterations: null,
        error: { code: "EVAL_REPORTING_FAILED", message: "Upload failed." },
      },
    });
  const test = new EvalTest({
    id: "case_a",
    name: "strict refusal",
    execute: async () => {},
  });
  await expect(
    test.run(executor(), {
      ...options,
      iterations: 3,
      concurrency: 1,
      mcpjam: {
        ...options.mcpjam,
        apiKey: "sk_test",
        enabled: true,
        strict: true,
      },
    })
  ).rejects.toMatchObject({ code: "PLATFORM_FEE_REQUIRED" });
  expect(payments).toHaveLength(2);
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedIterations: 1,
      results: [expect.objectContaining({ billingPaymentId: "paid-first" })],
    })
  );
  expect(test.getReportingReceipt().state).toBe("failed");
});

it("stops the suite after a payment refusal and reports its paid partial result", async () => {
  const payments = online((body) =>
    payments.length === 1
      ? Response.json({ ok: true, ...body, paymentId: "first-payment" })
      : Response.json(
          { code: "FORBIDDEN", details: { reason: "PLATFORM_FEE_REQUIRED" } },
          { status: 403 }
        )
  );
  const capture = vi
    .spyOn(reporting, "captureEvalReporting")
    .mockResolvedValue({
      error: new Error("report failed"),
      receipt: {
        schemaVersion: 1,
        state: "failed",
        acceptedIterations: 1,
        acknowledgedIterations: null,
        pendingIterations: null,
        error: { code: "EVAL_REPORTING_FAILED", message: "Report failed." },
      },
    });
  const first = vi.fn(async () => {});
  const later = vi.fn(async () => {});
  const suite = new EvalSuite({ name: "partial" });
  suite.add(new EvalTest({ id: "first", name: "first", execute: first }));
  suite.add(new EvalTest({ id: "later", name: "later", execute: later }));
  await expect(
    suite.run(executor(), {
      ...options,
      iterations: 3,
      concurrency: 1,
      mcpjam: {
        ...options.mcpjam,
        enabled: true,
        apiKey: "sk_test",
        strict: true,
      },
    })
  ).rejects.toMatchObject({ code: "PLATFORM_FEE_REQUIRED" });
  expect(first).toHaveBeenCalledTimes(1);
  expect(later).not.toHaveBeenCalled();
  expect(payments).toHaveLength(2);
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedIterations: 1,
      results: [expect.objectContaining({ billingPaymentId: "first-payment" })],
    })
  );
});
