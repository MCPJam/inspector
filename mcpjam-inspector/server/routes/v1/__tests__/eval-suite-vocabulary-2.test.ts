import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The suite routes under `x-mcpjam-eval-vocabulary: 2`: `settings.checks`
 * answers to `settings.defaultAssertions` (legacy `defaultPredicates`, and the
 * REST wire's own `checks`) and the policy-2 default `settings.repetitions`
 * to `settings.iterations`. Both fold onto today's `updateTestSuite`
 * arguments, and both read back under the canonical name. Vocabulary 1 is
 * pinned unchanged — including the pre-existing property that its `settings`
 * object silently strips an unknown key rather than refusing it.
 */

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
import { EVAL_VOCABULARY_HEADER } from "../eval-vocabulary.js";

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  vocabulary?: "1" | "2",
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
        ...(vocabulary !== undefined
          ? { [EVAL_VOCABULARY_HEADER]: vocabulary }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const SUITE_ID = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const RULE = { type: "noToolErrors" };

const LEGACY_SUITE = {
  _id: SUITE_ID,
  projectId: "p1",
  name: "Legacy suite",
  minIterations: 3,
  defaultPredicates: [RULE],
};

const V2_SUITE = {
  ...LEGACY_SUITE,
  verdictPolicyVersion: 2,
  verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.8 },
};

const SUITE_PATH = `/api/v1/projects/p1/eval-suites/${SUITE_ID}`;

function useSuite(suite: Record<string, unknown>): void {
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuite") return Promise.resolve(suite);
    return Promise.resolve(null);
  });
}

function updateArgs(): any {
  const calls = convexMutationMock.mock.calls.filter(
    (c) => c[0] === "testSuites:updateTestSuite",
  );
  return calls[calls.length - 1]?.[1];
}

async function message(res: Response): Promise<string> {
  return ((await res.json()) as { message?: string }).message ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  useSuite(V2_SUITE);
  convexMutationMock.mockResolvedValue(null);
});

describe("vocabulary 2 — suite settings", () => {
  it.each([
    ["defaultAssertions", { defaultAssertions: [RULE] }],
    ["defaultPredicates", { defaultPredicates: [RULE] }],
    ["checks", { checks: [RULE] }],
  ])(
    "folds `%s` onto the stored default predicates",
    async (_label, settings) => {
      const res = await request("PATCH", SUITE_PATH, { settings }, "2");
      expect(res.status).toBe(200);
      expect(updateArgs().defaultPredicates).toEqual([RULE]);
    },
  );

  it("clears the defaults with `defaultAssertions: null`", async () => {
    const res = await request(
      "PATCH",
      SUITE_PATH,
      { settings: { defaultAssertions: null } },
      "2",
    );
    expect(res.status).toBe(200);
    expect(updateArgs().defaultPredicates).toBeNull();
  });

  it("folds `settings.iterations` onto the policy-2 default", async () => {
    const res = await request(
      "PATCH",
      SUITE_PATH,
      { settings: { iterations: 7 } },
      "2",
    );
    expect(res.status).toBe(200);
    expect(updateArgs().verdictPolicyDefaults).toMatchObject({
      repetitions: 7,
      passThreshold: 0.8,
    });
  });

  it.each([
    [
      "defaultAssertions + defaultPredicates",
      { defaultAssertions: [], defaultPredicates: [] },
      "defaultAssertions",
    ],
    [
      "defaultAssertions + checks",
      { defaultAssertions: [], checks: [] },
      "defaultAssertions",
    ],
    [
      "defaultPredicates + checks",
      { defaultPredicates: [], checks: [] },
      "defaultPredicates",
    ],
    [
      "iterations + repetitions",
      { iterations: 3, repetitions: 3 },
      "iterations",
    ],
  ])("refuses %s", async (_label, settings, path) => {
    const res = await request("PATCH", SUITE_PATH, { settings }, "2");
    expect(res.status).toBe(400);
    expect(await message(res)).toContain(`settings.${path}: Send`);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("names the upgrade by its vocabulary-2 spelling on a legacy suite", async () => {
    useSuite(LEGACY_SUITE);
    const res = await request(
      "PATCH",
      SUITE_PATH,
      { settings: { iterations: 3 } },
      "2",
    );
    expect(res.status).toBe(400);
    const text = await message(res);
    expect(text).toContain(
      "both settings.iterations and settings.passThreshold",
    );
    expect(text).not.toContain("settings.repetitions");
  });

  it("upgrades a legacy suite with `iterations` + `passThreshold`", async () => {
    useSuite(LEGACY_SUITE);
    const res = await request(
      "PATCH",
      SUITE_PATH,
      { settings: { iterations: 3, passThreshold: 0.5 } },
      "2",
    );
    expect(res.status).toBe(200);
    expect(updateArgs().verdictPolicyDefaults).toEqual({
      repetitions: 3,
      passThreshold: 0.5,
    });
  });

  it("still refuses the legacy percent beside the vocabulary-2 count", async () => {
    // The legacy-vs-v2 refine runs on the FOLDED settings, so `iterations`
    // counts as a v2 field exactly as `repetitions` does under vocabulary 1.
    const res = await request(
      "PATCH",
      SUITE_PATH,
      { settings: { minimumAccuracy: 80, iterations: 3 } },
      "2",
    );
    expect(res.status).toBe(400);
    expect(await message(res)).toContain("minimumAccuracy");
  });

  it("projects `defaultAssertions` and `verdictPolicyDefaults.iterations` on read, with Vary", async () => {
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { name: "Renamed" }],
    ] as const) {
      const res = await request(method, SUITE_PATH, body, "2");
      expect(res.status, method).toBe(200);
      expect(res.headers.get("vary") ?? "").toContain(EVAL_VOCABULARY_HEADER);
      const detail = (await res.json()) as {
        settings: Record<string, unknown> & {
          verdictPolicyDefaults?: Record<string, unknown>;
        };
      };
      expect(detail.settings.defaultAssertions).toEqual([RULE]);
      expect(detail.settings).not.toHaveProperty("checks");
      expect(detail.settings.verdictPolicyDefaults).toMatchObject({
        iterations: 5,
        passThreshold: 0.8,
      });
      expect(detail.settings.verdictPolicyDefaults).not.toHaveProperty(
        "repetitions",
      );
      // The same word in both vocabularies: the suite-level floor.
      expect(detail.settings.minimumIterations).toBe(3);
    }
  });
});

describe("vocabulary 1 — suite settings unchanged", () => {
  it("still reads `checks` and `verdictPolicyDefaults.repetitions`", async () => {
    const res = await request("GET", SUITE_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("vary") ?? "").toContain(EVAL_VOCABULARY_HEADER);
    const detail = (await res.json()) as { settings: Record<string, unknown> };
    expect(detail.settings.checks).toEqual([RULE]);
    expect(detail.settings).not.toHaveProperty("defaultAssertions");
    expect(detail.settings.verdictPolicyDefaults).toMatchObject({
      repetitions: 5,
    });
  });

  it("still folds `settings.checks` and `settings.repetitions`", async () => {
    const res = await request("PATCH", SUITE_PATH, {
      settings: { checks: [RULE], repetitions: 7 },
    });
    expect(res.status).toBe(200);
    expect(updateArgs().defaultPredicates).toEqual([RULE]);
    expect(updateArgs().verdictPolicyDefaults).toMatchObject({
      repetitions: 7,
    });
  });

  it("silently strips `defaultAssertions` — the pre-existing non-strict settings object", async () => {
    // Pinned as what it IS, not as what it should be: vocabulary 1's
    // refusals are frozen by the contract, and `settings` was never strict.
    // A vocabulary-2 client that forgets the header gets a 200 that wrote
    // nothing, which is why the capability block exists for it to read.
    const res = await request("PATCH", SUITE_PATH, {
      settings: { defaultAssertions: [RULE] },
    });
    expect(res.status).toBe(200);
    expect(updateArgs()).toBeUndefined();
  });
});
