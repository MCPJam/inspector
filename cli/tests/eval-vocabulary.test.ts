/**
 * The CLI's eval-vocabulary handshake and the one projection it owns.
 *
 * Pinned here: the capability read is the ONLY thing that turns the header
 * on; a deployment without the block, or without the route, is spoken to in
 * vocabulary 1; and a vocabulary-2 response settles onto the CLI's internal
 * model with exactly the renamed keys moved and nothing else touched.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EVAL_VOCABULARY_HEADER,
  PlatformApiClient,
  type PlatformEvalCaseV2,
  type PlatformEvalSuiteDetailV2,
} from "@mcpjam/sdk/platform";
import {
  CASE_WIRE_KEYS,
  caseFromWire,
  negotiateEvalVocabulary,
  suiteDetailFromWire,
} from "../src/lib/eval-vocabulary.js";

type Call = { url: string; headers: Record<string, string> };

function clientAnswering(
  capabilities: Record<string, unknown> | { status: number },
  calls: Call[] = []
): { client: PlatformApiClient; calls: Call[] } {
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      });
      if ("status" in capabilities && typeof capabilities.status === "number") {
        return new Response(
          JSON.stringify({
            error: { code: "NOT_FOUND", message: "no such route" },
          }),
          {
            status: capabilities.status,
            headers: { "content-type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify(capabilities), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

const BASE_CAPABILITIES = {
  projectId: "p1",
  organizationId: "o1",
  role: "owner",
  projectRole: "owner",
  surface: "api",
  features: {},
  plan: null,
  can: {},
};

describe("negotiateEvalVocabulary", () => {
  test("speaks 2 when the deployment advertises it, with a derived client", async () => {
    const { client, calls } = clientAnswering({
      ...BASE_CAPABILITIES,
      vocabulary: {
        version: 2,
        evaluatorKinds: ["assertion", "judge"],
        assertionKinds: [],
        fields: {},
      },
    });
    const negotiated = await negotiateEvalVocabulary(client, {
      projectId: "p1",
    });
    assert.equal(negotiated.vocabulary, 2);
    assert.notEqual(negotiated.client, client);
    // The handshake itself went out without the header…
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/projects/p1/capabilities"));
    assert.equal(EVAL_VOCABULARY_HEADER in calls[0].headers, false);
    // …and the derived client sends it on everything.
    await negotiated.client.getMe();
    assert.equal(calls[1].headers[EVAL_VOCABULARY_HEADER], "2");
    // The original never learned the word.
    await client.getMe();
    assert.equal(EVAL_VOCABULARY_HEADER in calls[2].headers, false);
  });

  test("stays on 1 when the block is absent, or advertises another version", async () => {
    for (const capabilities of [
      BASE_CAPABILITIES,
      { ...BASE_CAPABILITIES, vocabulary: { version: 1, evaluatorKinds: [], assertionKinds: [], fields: {} } },
      { ...BASE_CAPABILITIES, vocabulary: { version: 3, evaluatorKinds: [], assertionKinds: [], fields: {} } },
    ]) {
      const { client } = clientAnswering(capabilities);
      const negotiated = await negotiateEvalVocabulary(client, {
        projectId: "p1",
      });
      assert.equal(negotiated.vocabulary, 1);
      assert.equal(negotiated.client, client);
    }
  });

  test("treats a deployment without the capabilities route as vocabulary 1", async () => {
    const { client } = clientAnswering({ status: 404 });
    const negotiated = await negotiateEvalVocabulary(client, {
      projectId: "p1",
    });
    assert.equal(negotiated.vocabulary, 1);
    assert.equal(negotiated.client, client);
  });

  test("lets any other failure through — it is the command's error, not a vocabulary answer", async () => {
    const { client } = clientAnswering({ status: 403 });
    await assert.rejects(
      negotiateEvalVocabulary(client, { projectId: "p1" }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { status?: number }).status === 403
    );
  });
});

describe("caseFromWire", () => {
  const v2: PlatformEvalCaseV2 = {
    id: "row_1",
    declaredId: "c_refund",
    title: "Refunds",
    steps: [{ id: "s1", kind: "prompt", prompt: "Refund it." }],
    legacyIterations: 3,
    iterations: 5,
    passThreshold: 0.8,
    isNegative: false,
    models: [{ model: "m" }],
    assertions: { mode: "replace", list: [{ type: "noToolErrors" }] },
    createdAt: 1,
    updatedAt: 2,
  };

  test("moves exactly the three renamed keys back, positions preserved", () => {
    const settled = caseFromWire(2, v2);
    assert.equal(settled.iterations, 3);
    assert.equal(settled.repetitions, 5);
    assert.deepEqual(settled.checks, v2.assertions);
    assert.equal("legacyIterations" in settled, false);
    assert.equal("assertions" in settled, false);
    assert.deepEqual(
      Object.keys(settled),
      Object.keys(v2).map(
        (key) =>
          ({
            [CASE_WIRE_KEYS[2].floor]: CASE_WIRE_KEYS[1].floor,
            [CASE_WIRE_KEYS[2].exact]: CASE_WIRE_KEYS[1].exact,
            [CASE_WIRE_KEYS[2].rules]: CASE_WIRE_KEYS[1].rules,
          })[key] ?? key
      )
    );
  });

  test("leaves an absent exact count and absent rules absent", () => {
    const { iterations: _exact, assertions: _rules, ...inherits } = v2;
    const settled = caseFromWire(2, inherits as PlatformEvalCaseV2);
    assert.equal(settled.iterations, 3);
    assert.equal("repetitions" in settled, false);
    assert.equal("checks" in settled, false);
  });

  test("returns a vocabulary-1 row untouched — the same object", () => {
    const v1 = {
      id: "row_1",
      title: "Refunds",
      steps: [],
      iterations: 3,
      isNegative: false,
      models: [],
      createdAt: null,
      updatedAt: null,
    };
    assert.equal(caseFromWire(1, v1), v1);
  });
});

describe("suiteDetailFromWire", () => {
  test("settles defaultAssertions and the policy-2 default count", () => {
    const v2 = {
      id: "s1",
      name: "Suite",
      description: null,
      projectId: "p1",
      environment: { servers: [] },
      executionConfig: null,
      hosts: [],
      schedule: {},
      createdAt: null,
      updatedAt: null,
      settings: {
        minimumAccuracy: null,
        matchOptions: null,
        defaultAssertions: [{ type: "noToolErrors" }],
        judge: {},
        verdictPolicyVersion: 2,
        verdictPolicyDefaults: { iterations: 5, passThreshold: 0.8 },
        policy: "v2",
      },
    } as unknown as PlatformEvalSuiteDetailV2;
    const settled = suiteDetailFromWire(2, v2);
    assert.deepEqual(settled.settings.checks, [{ type: "noToolErrors" }]);
    assert.deepEqual(settled.settings.verdictPolicyDefaults, {
      repetitions: 5,
      passThreshold: 0.8,
    });
    assert.equal("defaultAssertions" in settled.settings, false);
    // Everything else rides along, and the input is not mutated.
    assert.equal(settled.settings.policy, "v2");
    assert.deepEqual(v2.settings.verdictPolicyDefaults, {
      iterations: 5,
      passThreshold: 0.8,
    });
  });

  test("returns a vocabulary-1 detail untouched", () => {
    const v1 = { id: "s1", settings: { checks: [] } } as never;
    assert.equal(suiteDetailFromWire(1, v1), v1);
  });
});
