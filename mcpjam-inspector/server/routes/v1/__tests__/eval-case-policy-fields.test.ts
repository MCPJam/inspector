import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// `repetitions` and `passThreshold` are per-case VERDICT POLICY 2 fields. The
// backend reads them only when the suite carries `verdictPolicyVersion: 2`;
// on a legacy suite the trial count comes from `runs` and `minIterations` and
// these two sit inert.
//
// They were nonetheless accepted, forwarded, stored, and echoed back by a GET
// on any suite. Nothing warned — and the echo is exactly the evidence a caller
// uses to conclude the value landed.

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const LEGACY_SUITE = {
  _id: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  projectId: "p1",
  name: "Legacy suite",
  minIterations: 3,
};

const V2_SUITE = {
  ...LEGACY_SUITE,
  verdictPolicyVersion: 2,
  verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.8 },
};

const CASE_DOC = {
  _id: "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
  testSuiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  projectId: "p1",
  caseKey: "ui_abc",
  title: "Lists tools",
  query: "What tools?",
  runs: 1,
  models: [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }],
  caseType: "prompt",
};

const CASE_BODY = {
  title: "Lists tools",
  steps: [{ id: "s1", kind: "prompt", prompt: "What tools?" }],
};

/** Point every suite read at `suite`; case reads always resolve. */
function useSuite(suite: Record<string, unknown>): void {
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuite") return Promise.resolve(suite);
    if (name === "testSuites:getTestCase") return Promise.resolve(CASE_DOC);
    if (name === "testSuites:listTestCases") return Promise.resolve([CASE_DOC]);
    return Promise.resolve(null);
  });
}

/** The per-case payload of the batch create every first-party create goes through. */
function authoredCase(index = 0): any {
  const call = convexMutationMock.mock.calls.find(
    (c) => c[0] === "testSuites:createTestCases",
  );
  return call?.[1]?.cases?.[index];
}

function patchedCase(): any {
  const calls = convexMutationMock.mock.calls.filter(
    (c) => c[0] === "testSuites:updateTestCase",
  );
  return calls[calls.length - 1]?.[1];
}

async function message(res: Response): Promise<string> {
  return ((await res.json()) as { message?: string }).message ?? "";
}

const SUITE_PATH = "/api/v1/projects/p1/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("per-case verdict-policy fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    useSuite(LEGACY_SUITE);
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "testSuites:createTestCases") {
        return Promise.resolve({
          caseUpsert: {
            committed: (args?.cases ?? []).map((item: any, index: number) => ({
              index,
              title: String(item.title ?? ""),
              testCaseId: `case_${index + 1}`,
              replayed: false,
            })),
            failed: [],
          },
          duplicatePolicy: { effectivePolicy: "block", coerced: false },
          warnings: [],
        });
      }
      if (name === "testSuites:updateTestCase")
        return Promise.resolve(CASE_DOC);
      return Promise.resolve(null);
    });
  });

  describe("a legacy suite refuses them instead of storing them inert", () => {
    const WRITES: Array<{
      name: string;
      method: string;
      path: string;
      body: (field: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      {
        name: "POST …/cases",
        method: "POST",
        path: `${SUITE_PATH}/cases`,
        body: (field) => ({ ...CASE_BODY, ...field }),
      },
      {
        name: "POST …/cases/batch",
        method: "POST",
        path: `${SUITE_PATH}/cases/batch`,
        body: (field) => ({ cases: [{ ...CASE_BODY, ...field }] }),
      },
      {
        name: "PATCH …/cases/:caseId",
        method: "PATCH",
        path: `${SUITE_PATH}/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        body: (field) => ({ title: "Lists tools", ...field }),
      },
    ];

    for (const write of WRITES) {
      it.each([
        ["repetitions", 5],
        ["passThreshold", 0.8],
      ] as const)(`${write.name} refuses %s`, async (field, value) => {
        const res = await request(
          write.method,
          write.path,
          write.body({ [field]: value }),
        );

        expect(res.status).toBe(400);
        const text = await message(res);
        expect(text).toContain(field);
        // The message has to name the policy AND the way out, or the caller
        // learns only that something they read on a GET is not writable.
        expect(text).toContain("verdict policy 2");
        expect(text).toMatch(/legacy/);
        expect(convexMutationMock).not.toHaveBeenCalled();
      });
    }

    it("leaves an ordinary edit alone — and does not read the suite for it", async () => {
      const res = await request("PATCH", `${SUITE_PATH}/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx`, {
        title: "Renamed",
      });

      expect(res.status).toBe(200);
      expect(patchedCase().title).toBe("Renamed");
      expect(
        convexQueryMock.mock.calls.filter(
          (c) => c[0] === "testSuites:getTestSuite",
        ),
      ).toHaveLength(0);
    });
  });

  describe("a policy-v2 suite accepts them and they round-trip", () => {
    beforeEach(() => useSuite(V2_SUITE));

    it("forwards repetitions and passThreshold on create", async () => {
      const res = await request("POST", `${SUITE_PATH}/cases`, {
        ...CASE_BODY,
        repetitions: 5,
        passThreshold: 0.8,
      });

      expect(res.status).toBe(201);
      expect(authoredCase()).toMatchObject({
        repetitions: 5,
        passThreshold: 0.8,
      });
    });

    it("forwards repetitions and passThreshold on patch", async () => {
      const res = await request("PATCH", `${SUITE_PATH}/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx`, {
        repetitions: 7,
        passThreshold: 0.5,
      });

      expect(res.status).toBe(200);
      expect(patchedCase()).toMatchObject({
        repetitions: 7,
        passThreshold: 0.5,
      });
    });
  });

  describe("one ceiling for both spellings of the trial count", () => {
    beforeEach(() => useSuite(V2_SUITE));

    // `repetitions` allowed 100 (the suite-FILE contract's MAX_REPETITIONS)
    // while `iterations` allowed 10 and the CLI refused anything above 10
    // against this very API. Which ceiling you hit depended on your client.
    it.each(["repetitions", "iterations"] as const)(
      "refuses %s above the hosted cap of 10",
      async (field) => {
        const res = await request("POST", `${SUITE_PATH}/cases`, {
          ...CASE_BODY,
          [field]: 11,
        });

        expect(res.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();
      },
    );

    it.each(["repetitions", "iterations"] as const)(
      "accepts %s at the cap",
      async (field) => {
        const res = await request("POST", `${SUITE_PATH}/cases`, {
          ...CASE_BODY,
          [field]: 10,
        });

        expect(res.status).toBe(201);
      },
    );
  });
});
