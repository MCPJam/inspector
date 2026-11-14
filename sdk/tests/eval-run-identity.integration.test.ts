import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
vi.unmock("../src/eval-run-start.js");
vi.unmock("../src/eval-iteration-payment.js");
import { EvalTest } from "../src/EvalTest.js";
import { EvalSuite } from "../src/EvalSuite.js";
import type { HostExecutor } from "../src/HostExecutor.js";

const execution = vi.fn(async () => true);
const executor: HostExecutor = {
  run: async () => {
    throw new Error("Unexpected model call");
  },
  withOptions: () => executor,
  getPromptHistory: () => [],
  resetPromptHistory: () => {},
};
const makeTest = (name: string) =>
  new EvalTest({ id: `c_${name}`, name, test: execution });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  execution.mockClear();
});

it("refuses standalone and suite callbacks before execution with uploads off", async () => {
  vi.stubEnv("MCPJAM_API_KEY", "");
  vi.stubEnv(
    "MCPJAM_AUTH_FILE",
    `/tmp/missing-eval-auth-${crypto.randomUUID()}`
  );
  const test = makeTest("standalone");
  await expect(
    test.run(executor, { iterations: 1, mcpjam: { enabled: false } })
  ).rejects.toMatchObject({ code: "CREDENTIALS_MISSING" });
  const suite = new EvalSuite({ defaults: { iterations: 1 } });
  suite.add(makeTest("first"));
  await expect(
    suite.run(executor, { mcpjam: { enabled: false } })
  ).rejects.toMatchObject({ code: "CREDENTIALS_MISSING" });
  expect(execution).not.toHaveBeenCalled();
});

it("starts one online record for a multi-test suite, and refuses an outage after success", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (_url, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    return body.iterationKey
      ? Response.json({ ok: true, ...body, paymentId: body.iterationKey })
      : Response.json({
          ok: true,
          runStartId: body.runStartId,
          organizationId: "org",
          projectId: "project",
        });
  });
  vi.stubGlobal("fetch", fetcher);
  const suite = new EvalSuite({ defaults: { iterations: 2 } });
  for (const name of ["first", "second", "third"]) suite.add(makeTest(name));
  const options = {
    apiKey: "sk_test",
    mcpjam: { enabled: false },
    surface: "vitest" as const,
  };
  const result = await suite.run(executor, options);
  expect(result).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(7);
  expect(requests.filter((request) => request.plannedIterations)).toHaveLength(
    1
  );
  expect(new Set(requests.map((request) => request.runStartId)).size).toBe(1);
  expect(
    new Set(
      requests
        .filter((request) => request.iterationKey)
        .map((request) => request.iterationKey)
    ).size
  ).toBe(6);
  expect(requests[0]).toMatchObject({
    plannedIterations: 6,
    surface: "vitest",
  });
  expect(execution).toHaveBeenCalledTimes(6);
  execution.mockClear();
  fetcher.mockImplementation(async () => {
    throw new TypeError("offline");
  });
  await expect(suite.run(executor, options)).rejects.toMatchObject({
    code: "PLATFORM_UNAVAILABLE",
  });
  expect(execution).not.toHaveBeenCalled();
});
