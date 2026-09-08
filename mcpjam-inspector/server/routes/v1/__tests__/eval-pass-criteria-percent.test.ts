import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// `passCriteria.minimumPassRate` is compared as a PERCENT — see
// `effectiveRunResult` in `server/services/github-checks-worker.ts`:
//
//   Math.round((passed / total) * 100) >= minimumPassRate
//
// It was declared `z.number()` with no bound at four sites. So `0.8` — the
// natural thing to send for a developer who wrote `passThreshold: 0.8` as a
// fraction two fields earlier — was accepted, meant 0.8%, and produced a CI
// gate that could never fail. `8000` was accepted too, and could never pass.

const {
  validateGuestTokenMock,
  authorEvalSuiteMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  authorEvalSuiteMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js"
  );
  return { ...actual, authorEvalSuite: authorEvalSuiteMock };
});

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js"
  );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

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
  body?: Record<string, unknown>
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
    })
  );
}

function createSuite(passCriteria: unknown) {
  return request("POST", "/api/v1/projects/p1/eval-suites", {
    name: "Fresh suite",
    serverIds: ["s1"],
    model: "anthropic/claude-haiku-4.5",
    passCriteria,
    tests: [
      {
        title: "echo works",
        steps: [{ id: "s1", kind: "prompt", prompt: "Use the echo tool" }],
      },
    ],
  });
}

async function message(res: Response): Promise<string> {
  return ((await res.json()) as { message?: string }).message ?? "";
}

describe("passCriteria is a bounded percent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockResolvedValue(null);
    createAuthorizedManagerMock.mockResolvedValue({
      manager: {
        listServers: () => ["s1"],
        disconnectAllServers: vi.fn().mockResolvedValue(undefined),
      },
    });
    authorEvalSuiteMock.mockResolvedValue({
      suiteId: "suite_new",
      suiteName: "Fresh suite",
      caseUpsert: { committed: [{ name: "echo works" }], failed: [] },
    });
  });

  it("refuses a fraction rather than reading it as 0.8%", async () => {
    // THE bug: accepted, stored, and the gate could never fail afterwards.
    const res = await createSuite({ minimumPassRate: 0.8 });

    expect(res.status).toBe(400);
    const text = await message(res);
    // The message must name BOTH units, or the caller cannot tell which one
    // this field wanted.
    expect(text).toMatch(/percent/i);
    expect(text).toMatch(/fraction/i);
    expect(authorEvalSuiteMock).not.toHaveBeenCalled();
  });

  it("refuses the mirror mistake, which could never pass", async () => {
    const res = await createSuite({ minimumPassRate: 8000 });

    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(/percent/i);
    expect(authorEvalSuiteMock).not.toHaveBeenCalled();
  });

  it("accepts a real percent and stores it unchanged", async () => {
    const res = await createSuite({ minimumPassRate: 80 });

    expect(res.status).toBe(201);
    expect(authorEvalSuiteMock.mock.calls[0][0].passCriteria).toEqual({
      minimumPassRate: 80,
    });
  });

  it("accepts the canonical `minimumPassRatePercent` spelling", async () => {
    // The SDK's own rule (`sdk/src/gates.ts`): a percent-valued field is named
    // `*Percent` so a bare `100` cannot be read as "100%".
    const res = await createSuite({ minimumPassRatePercent: 80 });

    expect(res.status).toBe(201);
    // Normalized to the STORED name — no row changes shape.
    expect(authorEvalSuiteMock.mock.calls[0][0].passCriteria).toEqual({
      minimumPassRate: 80,
    });
  });

  it.each([
    ["both spellings at once", { minimumPassRatePercent: 80, minimumPassRate: 90 }],
    ["neither spelling", {}],
    ["a negative percent", { minimumPassRate: -1 }],
  ] as const)("refuses %s", async (_label, criteria) => {
    const res = await createSuite(criteria);

    expect(res.status).toBe(400);
    expect(authorEvalSuiteMock).not.toHaveBeenCalled();
  });

  it("still accepts 0 — a real floor, not a missing one", async () => {
    const res = await createSuite({ minimumPassRate: 0 });

    expect(res.status).toBe(201);
    expect(authorEvalSuiteMock.mock.calls[0][0].passCriteria).toEqual({
      minimumPassRate: 0,
    });
  });
});

describe("a v2 suite reports no dead legacy percent", () => {
  const V2_SUITE = {
    _id: "suite_1",
    projectId: "p1",
    name: "Upgraded suite",
    // Left behind by the upgrade. `applyVerdictPolicySettings` ADDS
    // `verdictPolicyDefaults` and cannot clear this column — the platform's
    // `updateTestSuite` types the argument `v.optional(passCriteriaValidator)`,
    // so there is no null to send. Nothing reads it once the suite is v2.
    defaultPassCriteria: { minimumPassRate: 80 },
    verdictPolicyVersion: 2,
    verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.9 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) =>
      Promise.resolve(name === "testSuites:getTestSuite" ? V2_SUITE : null)
    );
  });

  it("reports the live fraction and not the stale percent beside it", async () => {
    const res = await request(
      "GET",
      "/api/v1/projects/p1/eval-suites/suite_1"
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings.policy).toBe("v2");
    expect(body.settings.verdictPolicyDefaults.passThreshold).toBe(0.9);
    // 80 is a percent nothing decides with any more. Reporting it beside a
    // live 0.9 fraction leaves a reader — and `mcpjam cloud eval export`,
    // which reads exactly this field — to pick the wrong one.
    expect(body.settings.minimumAccuracy).toBeNull();
  });

  it("still reports it on a legacy suite, where it does decide runs", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      Promise.resolve(
        name === "testSuites:getTestSuite"
          ? {
              _id: "suite_1",
              projectId: "p1",
              name: "Legacy suite",
              defaultPassCriteria: { minimumPassRate: 80 },
            }
          : null
      )
    );

    const res = await request(
      "GET",
      "/api/v1/projects/p1/eval-suites/suite_1"
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings.policy).toBe("legacy");
    expect(body.settings.minimumAccuracy).toBe(80);
  });
});
