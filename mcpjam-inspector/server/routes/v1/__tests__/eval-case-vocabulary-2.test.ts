import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The case routes under `x-mcpjam-eval-vocabulary: 2`.
 *
 * Two things are pinned, and the second is the one that matters more:
 *
 *   1. Under vocabulary 2 the legacy per-case floor answers to
 *      `legacyIterations` (legacy spelling `runs`), folds onto the stored
 *      `runs`, and is projected back under that name. Sending both spellings
 *      is a refusal, not a precedence rule.
 *   2. Vocabulary 1 (no header) is BYTE-FOR-BYTE what it was: `iterations` is
 *      the floor, `legacyIterations` and `runs` are unknown keys, the DTO
 *      says `iterations`. The negotiation widens nothing.
 *
 * Harness and fixtures follow `eval-case-policy-fields.test.ts`.
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
import {
  EVAL_VOCABULARY_HEADER,
  bothSpellingsMessage,
} from "../../../utils/eval-vocabulary.js";

type Vocabulary = "1" | "2" | undefined;

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  vocabulary: Vocabulary = undefined,
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
const CASE_ID = "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx";

const V2_SUITE = {
  _id: SUITE_ID,
  projectId: "p1",
  name: "Suite",
  minIterations: 3,
  verdictPolicyVersion: 2,
  verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.8 },
};

const LEGACY_SUITE = {
  _id: SUITE_ID,
  projectId: "p1",
  name: "Legacy suite",
  minIterations: 3,
};

const CASE_DOC = {
  _id: CASE_ID,
  testSuiteId: SUITE_ID,
  projectId: "p1",
  caseKey: "ui_abc",
  title: "Lists tools",
  query: "What tools?",
  runs: 4,
  repetitions: 2,
  models: [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }],
  caseType: "prompt",
};

const CASE_BODY = {
  title: "Lists tools",
  steps: [{ id: "s1", kind: "prompt", prompt: "What tools?" }],
};

const SUITE_PATH = `/api/v1/projects/p1/eval-suites/${SUITE_ID}`;
const CASE_PATH = `${SUITE_PATH}/cases/${CASE_ID}`;

function useSuite(suite: Record<string, unknown>): void {
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuite") return Promise.resolve(suite);
    if (name === "testSuites:getTestCase") return Promise.resolve(CASE_DOC);
    if (name === "testSuites:listTestCases") return Promise.resolve([CASE_DOC]);
    return Promise.resolve(null);
  });
}

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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  useSuite(V2_SUITE);
  convexMutationMock.mockImplementation((name: string, args?: any) => {
    if (name === "testSuites:createTestCases") {
      return Promise.resolve({
        caseUpsert: {
          committed: (args?.cases ?? []).map((item: any, index: number) => ({
            index,
            title: String(item.title ?? ""),
            testCaseId: CASE_ID,
            replayed: false,
          })),
          failed: [],
        },
        duplicatePolicy: { effectivePolicy: "block", coerced: false },
        warnings: [],
      });
    }
    if (name === "testSuites:updateTestCase") return Promise.resolve(CASE_DOC);
    return Promise.resolve(null);
  });
});

describe("vocabulary 2 — the floor is `legacyIterations`", () => {
  it("stores `legacyIterations` as the case's `runs` on create", async () => {
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, legacyIterations: 3 },
      "2",
    );
    expect(res.status).toBe(201);
    expect(authoredCase().runs).toBe(3);
  });

  it("still accepts the legacy spelling `runs`", async () => {
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, runs: 3 },
      "2",
    );
    expect(res.status).toBe(201);
    expect(authoredCase().runs).toBe(3);
  });

  it("refuses both spellings with the contract's sentence, naming the field", async () => {
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, legacyIterations: 3, runs: 3 },
      "2",
    );
    expect(res.status).toBe(400);
    const text = await message(res);
    expect(text).toContain("legacyIterations");
    expect(text).toContain(bothSpellingsMessage("legacyIterations", "runs"));
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("refuses `iterations` as an unknown key — the name is vacated", async () => {
    // The whole point of this step: under vocabulary 2 nothing answers to
    // `iterations` yet, so the next step can give it the exact count without
    // any reader having meant the floor by it.
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, iterations: 3 },
      "2",
    );
    expect(res.status).toBe(400);
    expect(await message(res)).toContain("iterations");
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("folds the floor on a batch item, and refuses both spellings per item", async () => {
    const ok = await request(
      "POST",
      `${SUITE_PATH}/cases/batch`,
      { cases: [{ ...CASE_BODY, legacyIterations: 2 }] },
      "2",
    );
    expect(ok.status).toBe(201);
    expect(authoredCase().runs).toBe(2);

    vi.clearAllMocks();
    useSuite(V2_SUITE);
    const both = await request(
      "POST",
      `${SUITE_PATH}/cases/batch`,
      { cases: [{ ...CASE_BODY, legacyIterations: 2, runs: 2 }] },
      "2",
    );
    expect(both.status).toBe(400);
    expect(await message(both)).toContain("cases.0.legacyIterations");
  });

  it("forwards `legacyIterations` as `runs` on PATCH, and nothing when absent", async () => {
    const withFloor = await request(
      "PATCH",
      CASE_PATH,
      { legacyIterations: 6 },
      "2",
    );
    expect(withFloor.status).toBe(200);
    expect(patchedCase().runs).toBe(6);

    const titleOnly = await request("PATCH", CASE_PATH, { title: "T" }, "2");
    expect(titleOnly.status).toBe(200);
    // A PATCH that never mentions the floor leaves the stored `runs` alone.
    expect(patchedCase()).not.toHaveProperty("runs");
  });

  it("projects the floor as `legacyIterations` on GET, list, POST and PATCH", async () => {
    const got = (await (
      await request("GET", CASE_PATH, undefined, "2")
    ).json()) as Record<string, unknown>;
    expect(got.legacyIterations).toBe(4);
    expect(got).not.toHaveProperty("iterations");
    // Untouched by this step: the exact count still reads `repetitions`.
    expect(got.repetitions).toBe(2);

    const listed = (await (
      await request("GET", `${SUITE_PATH}/cases`, undefined, "2")
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(listed.items[0]?.legacyIterations).toBe(4);
    expect(listed.items[0]).not.toHaveProperty("iterations");

    const created = (await (
      await request("POST", `${SUITE_PATH}/cases`, CASE_BODY, "2")
    ).json()) as Record<string, unknown>;
    expect(created).toHaveProperty("legacyIterations");
    expect(created).not.toHaveProperty("iterations");

    const patched = (await (
      await request("PATCH", CASE_PATH, { title: "T" }, "2")
    ).json()) as Record<string, unknown>;
    expect(patched).toHaveProperty("legacyIterations");
    expect(patched).not.toHaveProperty("iterations");
  });

  it("keeps the renamed key in the same position as `iterations`", async () => {
    // A reader diffing a vocabulary-2 response against a vocabulary-1 one
    // should see exactly one key renamed, not a reordered object.
    const one = Object.keys(
      (await (await request("GET", CASE_PATH)).json()) as object,
    );
    const two = Object.keys(
      (await (
        await request("GET", CASE_PATH, undefined, "2")
      ).json()) as object,
    );
    expect(two).toEqual(
      one.map((k) => (k === "iterations" ? "legacyIterations" : k)),
    );
  });

  it("names the floor by its vocabulary-2 spelling in the legacy-policy refusal", async () => {
    useSuite(LEGACY_SUITE);
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, repetitions: 5 },
      "2",
    );
    expect(res.status).toBe(400);
    const text = await message(res);
    expect(text).toContain("comes from legacyIterations");
    expect(text).not.toContain("comes from iterations");
  });

  it("marks every case response as varying by vocabulary", async () => {
    for (const [method, path, body] of [
      ["GET", CASE_PATH, undefined],
      ["GET", `${SUITE_PATH}/cases`, undefined],
      ["POST", `${SUITE_PATH}/cases`, CASE_BODY],
      ["PATCH", CASE_PATH, { title: "T" }],
    ] as const) {
      for (const vocabulary of [undefined, "2"] as const) {
        const res = await request(method, path, body, vocabulary);
        expect(res.status, `${method} ${path}`).toBeLessThan(300);
        expect(res.headers.get("vary") ?? "", `${method} ${path}`).toContain(
          EVAL_VOCABULARY_HEADER,
        );
      }
    }
  });
});

describe("vocabulary 1 — not widened", () => {
  it.each([
    ["legacyIterations", { ...CASE_BODY, legacyIterations: 3 }],
    ["runs", { ...CASE_BODY, runs: 3 }],
  ])("refuses `%s` on create as an unknown key", async (field, body) => {
    const res = await request("POST", `${SUITE_PATH}/cases`, body);
    expect(res.status).toBe(400);
    expect(await message(res)).toContain(field);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it.each([
    ["legacyIterations", { legacyIterations: 3 }],
    ["runs", { runs: 3 }],
  ])("refuses `%s` on PATCH as an unknown key", async (field, body) => {
    const res = await request("PATCH", CASE_PATH, body);
    expect(res.status).toBe(400);
    expect(await message(res)).toContain(field);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("still stores `iterations` as the floor and projects it back as `iterations`", async () => {
    const res = await request("POST", `${SUITE_PATH}/cases`, {
      ...CASE_BODY,
      iterations: 3,
    });
    expect(res.status).toBe(201);
    expect(authoredCase().runs).toBe(3);
    const got = (await (await request("GET", CASE_PATH)).json()) as Record<
      string,
      unknown
    >;
    expect(got.iterations).toBe(4);
    expect(got).not.toHaveProperty("legacyIterations");
  });

  it("keeps the legacy-policy refusal's wording", async () => {
    useSuite(LEGACY_SUITE);
    const res = await request("POST", `${SUITE_PATH}/cases`, {
      ...CASE_BODY,
      repetitions: 5,
    });
    expect(res.status).toBe(400);
    expect(await message(res)).toContain(
      "comes from iterations and the suite's minimumIterations",
    );
  });
});
