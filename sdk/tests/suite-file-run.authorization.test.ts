/**
 * `runSuiteFile` and a server that asks for sign-in mid-run: a real MCP server
 * on a loopback socket answers one protected tool with a sign-in challenge.
 * The run never signs in; it classifies the iteration `authorization_required`
 * with the parsed challenge, and leaves the verdict to the verdict policy.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSuiteFileRunner } from "../src/suite-file-run/run-suite-file.js";
import { createLocalAuthChallengeObserver } from "../src/suite-file-run/auth-challenge-observer.js";
import { localEvalRunMetadataSchema } from "../src/suite-file-run/report.js";
import { formatLocalEvalRunSummary } from "../src/suite-file-run/report.js";
import { parseChallengeHeader } from "../src/mcp-client-manager/auth-challenge.js";
import { attachAuthChallenge } from "../src/mcp-client-manager/errors.js";
import type { RunSuiteFileOptions } from "../src/suite-file-run/types.js";
import {
  servePolicyTargetFixture,
  type PolicyTargetFixture,
} from "./support/policy-target-fixture.js";
import { callThenAnswer, scriptedModel } from "./support/scripted-model.js";

const CHALLENGE =
  'Bearer error="invalid_token", resource_metadata="https://x.example/.well-known/oauth-protected-resource", scope="orders:read"';

let fixture: PolicyTargetFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function suite(prompt: string, toolName: string, iterations = 1): string {
  return `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_local_sign_in_test
  name: local sign-in test
target:
  servers:
    - name: orders
defaults:
  judge:
    enabled: false
  model: anthropic/claude-haiku-4.5
  iterations: ${iterations}
  passThreshold: 1
  validity: {}
cases:
  - id: c_orders
    title: lists the orders
    steps:
      - id: s1
        kind: prompt
        prompt: ${prompt}
      - id: a1
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: ${toolName}
          args:
            args: {}
`;
}

function run(toolName: string) {
  return createSuiteFileRunner({
    createLanguageModel: (model) =>
      scriptedModel(
        model,
        callThenAnswer(() => ({ toolName, input: { id: "7" } }))
      ) as never,
  }).run;
}

function options(): RunSuiteFileOptions {
  return {
    servers: {
      orders: { config: { url: fixture!.url }, source: "test-binding" },
    },
    inference: { mode: "byok", providerKeys: { anthropic: "sk-ant-test-key" } },
  };
}

describe("runSuiteFile — a tool call that asks for sign-in", () => {
  describe("an HTTP 401 with WWW-Authenticate", () => {
    beforeEach(async () => {
      fixture = await servePolicyTargetFixture({
        signIn: { unauthorized: { read_note: CHALLENGE } },
      });
    });

    it("classifies the iteration authorization_required, with the parsed challenge", async () => {
      const result = await run("read_note")(
        suite("Read note 7", "read_note", 2),
        options()
      );

      // The call never ran on the server, and nothing signed in.
      expect(fixture!.calls.read_note).toBe(0);
      const iterations = result.cases[0]!.iterations;
      expect(iterations).toHaveLength(2);
      for (const iteration of iterations) {
        expect(iteration.authRequired).toMatchObject({
          classification: "authorization_required",
          server: "orders",
          toolName: "read_note",
          challengedCalls: 1,
          challenge: {
            source: "http_401",
            error: "invalid_token",
            requiredScope: "orders:read",
            resourceMetadataUrl:
              "https://x.example/.well-known/oauth-protected-resource",
            facets: {
              challengeHeader: "bearer",
              hasResourceMetadata: true,
              hasScope: true,
              hasErrorParams: false,
            },
          },
        });
        expect(iteration.authRequired?.toolCallId).toEqual(expect.any(String));
      }

      // One issue per case and server, naming what to fix.
      const issues = result.issues.filter(
        (issue) => issue.code === "AUTHORIZATION_REQUIRED"
      );
      expect(issues).toEqual([
        {
          code: "AUTHORIZATION_REQUIRED",
          phase: "execution",
          category: "authorization",
          caseId: "c_orders",
          message:
            'Server "orders" asked for sign-in when "read_note" was called (2 of 2 iterations; invalid_token; scope "orders:read"). A local run never signs in: bind a credential for "orders" and run again.',
        },
      ]);

      // The report carries it under its validated contract, and says it.
      expect(
        localEvalRunMetadataSchema.safeParse(result.report.metadata).success
      ).toBe(true);
      expect(
        result.report.metadata.cases[0]!.iterations[0]!.authRequired?.server
      ).toBe("orders");
      expect(formatLocalEvalRunSummary(result.report)).toContain(
        'authorization issue (c_orders): Server "orders" asked for sign-in'
      );
    });
  });

  describe('an isError result carrying _meta["mcp/www_authenticate"]', () => {
    beforeEach(async () => {
      fixture = await servePolicyTargetFixture({
        extraTools: ["list_orders"],
        signIn: { meta: { list_orders: CHALLENGE } },
      });
    });

    it("classifies the iteration from the completed result", async () => {
      const result = await run("list_orders")(
        suite("List my orders", "list_orders"),
        options()
      );
      // The tool ran and refused; its result reached the model unchanged.
      expect(fixture!.calls.list_orders).toBe(1);
      const [iteration] = result.cases[0]!.iterations;
      expect(iteration?.authRequired).toMatchObject({
        classification: "authorization_required",
        server: "orders",
        toolName: "list_orders",
        challenge: { source: "tool_result_meta", requiredScope: "orders:read" },
      });
      expect(result.issues.map((issue) => issue.code)).toContain(
        "AUTHORIZATION_REQUIRED"
      );
    });
  });

  describe("a server that never challenges", () => {
    beforeEach(async () => {
      fixture = await servePolicyTargetFixture();
    });

    it("records no authorization evidence", async () => {
      const result = await run("read_note")(
        suite("Read note 7", "read_note"),
        options()
      );
      expect(result.verdict).toBe("passed");
      expect(result.cases[0]!.iterations[0]!.authRequired).toBeUndefined();
      expect(
        result.issues.filter((issue) => issue.category === "authorization")
      ).toEqual([]);
    });
  });
});

describe("createLocalAuthChallengeObserver", () => {
  const signal = parseChallengeHeader(CHALLENGE);

  it("records a thrown challenge, rethrows it unchanged, and counts later ones", async () => {
    const observer = createLocalAuthChallengeObserver({
      serverOf: (toolName) =>
        toolName === "list_orders" ? "orders" : undefined,
    });
    const refused = new Error("HTTP 401");
    attachAuthChallenge(refused, signal);
    const tools = observer.wrap({
      list_orders: {
        inputSchema: {} as never,
        execute: async () => {
          throw refused;
        },
      },
    } as never);
    const execute = (tools.list_orders as { execute: Function }).execute;
    await expect(execute({}, { toolCallId: "call-1" })).rejects.toBe(refused);
    await expect(execute({}, { toolCallId: "call-2" })).rejects.toBe(refused);
    expect(observer.authRequired()).toMatchObject({
      server: "orders",
      toolName: "list_orders",
      toolCallId: "call-1",
      challengedCalls: 2,
      challenge: { source: "http_401", error: "invalid_token" },
    });
    // The raw header is not report evidence.
    expect(observer.authRequired()?.challenge).not.toHaveProperty("raw");
  });

  it("ignores ordinary errors and results", async () => {
    const observer = createLocalAuthChallengeObserver({ serverOf: () => "s" });
    const tools = observer.wrap({
      fails: {
        inputSchema: {} as never,
        execute: async () => {
          throw new Error("boom");
        },
      },
      domainError: {
        inputSchema: {} as never,
        execute: async () => ({
          isError: true,
          content: [{ type: "text", text: "not found" }],
        }),
      },
    } as never);
    await expect(
      (tools.fails as { execute: Function }).execute({}, {})
    ).rejects.toThrow("boom");
    await (tools.domainError as { execute: Function }).execute({}, {});
    expect(observer.authRequired()).toBeUndefined();
  });
});
