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
} from "../eval-vocabulary.js";

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

  it("never reads `iterations` as the floor — that name is the exact count now", async () => {
    // A1 vacated the name; A2 gave it the exact count. A caller who meant
    // the floor and typed `iterations` under vocabulary 2 gets the exact
    // count (and, on create, the same floor), never a silent floor-only write.
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, iterations: 3 },
      "2",
    );
    expect(res.status).toBe(201);
    expect(authoredCase()).toMatchObject({ repetitions: 3, runs: 3 });
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
    // `iterations` is present, but as the EXACT count (CASE_DOC.repetitions).
    expect(got.iterations).toBe(2);
    // The exact count reads under its canonical name.
    expect(got.iterations).toBe(2);
    expect(got).not.toHaveProperty("repetitions");

    const listed = (await (
      await request("GET", `${SUITE_PATH}/cases`, undefined, "2")
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(listed.items[0]?.legacyIterations).toBe(4);
    expect(listed.items[0]?.iterations).toBe(2);

    const created = (await (
      await request("POST", `${SUITE_PATH}/cases`, CASE_BODY, "2")
    ).json()) as Record<string, unknown>;
    expect(created).toHaveProperty("legacyIterations");
    expect(created).not.toHaveProperty("repetitions");

    const patched = (await (
      await request("PATCH", CASE_PATH, { title: "T" }, "2")
    ).json()) as Record<string, unknown>;
    expect(patched).toHaveProperty("legacyIterations");
    expect(patched).not.toHaveProperty("repetitions");
  });

  it("keeps the renamed key in the same position as `iterations`", async () => {
    // A reader diffing a vocabulary-2 response against a vocabulary-1 one
    // should see exactly the renamed keys, not a reordered object.
    const one = Object.keys(
      (await (await request("GET", CASE_PATH)).json()) as object,
    );
    const two = Object.keys(
      (await (
        await request("GET", CASE_PATH, undefined, "2")
      ).json()) as object,
    );
    const RENAMED: Record<string, string> = {
      iterations: "legacyIterations",
      repetitions: "iterations",
      checks: "assertions",
    };
    expect(two).toEqual(one.map((k) => RENAMED[k] ?? k));
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

describe("vocabulary 2 — `iterations` is the exact count, `assertions` the rules", () => {
  const RULE = { type: "toolCalledAtLeastOnce", toolName: "search" };
  const RULES = { mode: "replace", list: [RULE] };

  it("stores `iterations` as the exact count AND, on create, as the floor", async () => {
    // The contract: a CREATE that names an exact count but no floor stores
    // `runs = iterations` — what the legacy resolver would have floored to.
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, iterations: 4 },
      "2",
    );
    expect(res.status).toBe(201);
    expect(authoredCase()).toMatchObject({ repetitions: 4, runs: 4 });
  });

  it("keeps a declared floor beside the exact count — they are two fields", async () => {
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, iterations: 4, legacyIterations: 2 },
      "2",
    );
    expect(res.status).toBe(201);
    expect(authoredCase()).toMatchObject({ repetitions: 4, runs: 2 });
  });

  it("forwards nothing for a create that names neither count", async () => {
    // The platform then applies the same `runs = 1` a headerless create
    // stores today, and no v2 override is materialized.
    const res = await request("POST", `${SUITE_PATH}/cases`, CASE_BODY, "2");
    expect(res.status).toBe(201);
    expect(authoredCase()).not.toHaveProperty("runs");
    expect(authoredCase()).not.toHaveProperty("repetitions");
  });

  it("never derives a floor on PATCH", async () => {
    const res = await request("PATCH", CASE_PATH, { iterations: 4 }, "2");
    expect(res.status).toBe(200);
    expect(patchedCase().repetitions).toBe(4);
    expect(patchedCase()).not.toHaveProperty("runs");
  });

  it.each([
    [
      "iterations + repetitions",
      { iterations: 4, repetitions: 4 },
      "iterations",
    ],
    ["assertions + checks", { assertions: RULES, checks: RULES }, "assertions"],
    [
      "assertions + predicates",
      { assertions: RULES, predicates: RULES },
      "assertions",
    ],
    ["checks + predicates", { checks: RULES, predicates: RULES }, "checks"],
  ])("refuses %s", async (_label, fields, path) => {
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, ...fields },
      "2",
    );
    expect(res.status).toBe(400);
    expect(await message(res)).toContain(`${path}: Send`);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("folds `assertions` onto the stored predicate override, `null` included", async () => {
    const set = await request("PATCH", CASE_PATH, { assertions: RULES }, "2");
    expect(set.status).toBe(200);
    expect(patchedCase().predicates).toEqual(RULES);

    const cleared = await request(
      "PATCH",
      CASE_PATH,
      { assertions: null },
      "2",
    );
    expect(cleared.status).toBe(200);
    expect(patchedCase().predicates).toBeNull();
  });

  it("projects `iterations` and `assertions` on read, and no legacy spelling", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite") return Promise.resolve(V2_SUITE);
      if (name === "testSuites:getTestCase")
        return Promise.resolve({ ...CASE_DOC, predicates: RULES });
      return Promise.resolve(null);
    });
    const got = (await (
      await request("GET", CASE_PATH, undefined, "2")
    ).json()) as Record<string, unknown>;
    expect(got.legacyIterations).toBe(4);
    expect(got.iterations).toBe(2);
    expect(got.assertions).toEqual(RULES);
    for (const legacy of ["repetitions", "checks", "predicates", "runs"]) {
      expect(got).not.toHaveProperty(legacy);
    }
  });

  it("names the exact count and the settings path by their vocabulary-2 spelling in the legacy-policy refusal", async () => {
    useSuite(LEGACY_SUITE);
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases`,
      { ...CASE_BODY, iterations: 5 },
      "2",
    );
    expect(res.status).toBe(400);
    const text = await message(res);
    expect(text).toContain("iterations sets the exact number");
    expect(text).toContain("settings.iterations and settings.passThreshold");
    expect(text).not.toContain("repetitions");
  });

  it("refuses the CLI's vocabulary-1 body under vocabulary 2 — and accepts it under 1", async () => {
    // `cli/src/lib/eval-run-file.ts` sends the file's one configured count
    // under BOTH vocabulary-1 keys. Under vocabulary 2 those are two
    // spellings of the exact count, so the CLI must not send the header
    // before it is rewritten; this is the pin for that hazard.
    const body = { ...CASE_BODY, iterations: 3, repetitions: 3 };
    const two = await request("POST", `${SUITE_PATH}/cases`, body, "2");
    expect(two.status).toBe(400);
    vi.clearAllMocks();
    useSuite(V2_SUITE);
    const one = await request("POST", `${SUITE_PATH}/cases`, body);
    expect(one.status).toBe(201);
  });
});

describe("vocabulary 1 — not widened", () => {
  it.each([
    ["legacyIterations", { ...CASE_BODY, legacyIterations: 3 }],
    ["runs", { ...CASE_BODY, runs: 3 }],
    ["assertions", { ...CASE_BODY, assertions: { mode: "replace", list: [] } }],
    ["predicates", { ...CASE_BODY, predicates: { mode: "replace", list: [] } }],
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

  it("keeps naming the count fields in the CALLER's vocabulary", async () => {
    // The point of this case is the vocabulary, not the criterion's name: a
    // vocabulary-1 caller is told where the count comes from using the words
    // it spells them with, so `iterations` here rather than
    // `legacyIterations`.
    useSuite(LEGACY_SUITE);
    const res = await request("POST", `${SUITE_PATH}/cases`, {
      ...CASE_BODY,
      repetitions: 5,
    });
    expect(res.status).toBe(400);
    expect(await message(res)).toContain(
      "comes from iterations raised to the suite's minimumIterations",
    );
  });
});
