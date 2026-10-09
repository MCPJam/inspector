/**
 * `mcpjam test` against a server that asks for sign-in mid-run: the run never
 * signs in. The SDK classifies the iteration `authorization_required` with the
 * parsed challenge; the CLI names the command that gets a credential and
 * where to bind it, on stderr, without changing the exit code.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV3 } from "ai/test";
import type { SuiteFileAuthRequired, SuiteFileRunResult } from "@mcpjam/sdk";
import { main } from "../src/index.js";
import { localSignInHints } from "../src/commands/test.js";
import { captureProcessOutput, telemetryDisabled } from "./support/cli-run.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/sign-in-target-server.mjs", import.meta.url)
);

function challenged(
  overrides: Partial<SuiteFileAuthRequired> = {}
): SuiteFileAuthRequired {
  return {
    classification: "authorization_required",
    server: "orders",
    toolName: "list_orders",
    challengedCalls: 1,
    challenge: {
      source: "http_401",
      error: "invalid_token",
      requiredScope: "orders:read",
      resourceMetadataUrl:
        "https://orders.example/.well-known/oauth-protected-resource",
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: true,
        hasScope: true,
        hasErrorParams: false,
      },
    },
    ...overrides,
  };
}

function resultWith(
  ...entries: Array<SuiteFileAuthRequired | undefined>
): Pick<SuiteFileRunResult, "cases"> {
  return {
    cases: [
      {
        iterations: entries.map((entry, index) => ({
          iterationNumber: index + 1,
          ...(entry ? { authRequired: entry } : {}),
        })),
      },
    ],
  } as unknown as Pick<SuiteFileRunResult, "cases">;
}

test("a --url binding is told to sign in and pass --credentials-file", () => {
  const hints = localSignInHints(resultWith(challenged(), challenged()), {
    orders: {
      config: { url: "https://orders.example/mcp" },
      source: "--url",
    },
  });
  assert.deepEqual(hints, [
    'Server "orders" asked for sign-in when "list_orders" was called; a local run never signs in. Sign in with `mcpjam oauth login --url https://orders.example/mcp --scopes "orders:read" --credentials-out <file>`, then retry with `--credentials-file <file>`.',
  ]);
});

test("any other binding is told to set credentialsFile in its MCP config entry", () => {
  const [hint] = localSignInHints(resultWith(challenged()), {
    orders: {
      config: { url: "https://orders.example/mcp" },
      source: ".mcp.json",
    },
  });
  assert.equal(
    hint,
    'Server "orders" asked for sign-in when "list_orders" was called; a local run never signs in. Sign in with `mcpjam oauth login --url https://orders.example/mcp --scopes "orders:read" --credentials-out <file>`, then set "credentialsFile" to that file in the "orders" entry of your MCP config.'
  );
});

test("a scope that could expand in a shell is never pasted into the command", () => {
  const [hint] = localSignInHints(
    resultWith(
      challenged({
        challenge: {
          ...challenged().challenge,
          requiredScope: 'orders:read" $(touch /tmp/pwned) "',
        },
      })
    ),
    {
      orders: {
        config: { url: "https://orders.example/mcp" },
        source: "--url",
      },
    }
  );
  assert.ok(hint?.includes('--scopes "<scopes>"'), hint);
  assert.ok(!hint?.includes("$("), hint);
});

test("no challenge, no hint", () => {
  assert.deepEqual(localSignInHints(resultWith(undefined), {}), []);
});

let callCounter = 0;
/** Call list_orders once, then answer with whatever the tool said. */
function scripted() {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt as unknown as Array<{ role: string }>;
      const afterTool = prompt.some((message) => message.role === "tool");
      const usage = {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      };
      if (!afterTool) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call_${++callCounter}`,
              toolName: "list_orders",
              input: "{}",
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "You need to sign in." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

const SUITE = `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_cli_sign_in
  name: cli sign-in test
target:
  servers:
    - name: orders
defaults:
  judge:
    enabled: false
  model: anthropic/claude-haiku-4.5
  iterations: 1
  passThreshold: 1
  validity: {}
cases:
  - id: c_orders
    title: lists the orders
    steps:
      - id: s1
        kind: prompt
        prompt: List my orders
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: list_orders
`;

test("end to end: the iteration is classified, the report carries it, and stderr says what to run", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-test-sign-in-"));
  const callsFile = path.join(dir, "calls.log");
  mkdirSync(path.join(dir, ".mcpjam", "evals"), { recursive: true });
  writeFileSync(path.join(dir, ".mcpjam", "evals", "example.yaml"), SUITE);
  writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        orders: {
          command: process.execPath,
          args: [FIXTURE],
          env: { SIGN_IN_TARGET_CALLS_FILE: "${CALLS_FILE}" },
        },
      },
    })
  );
  const run = await captureProcessOutput(() =>
    main(
      [
        "node",
        "mcpjam",
        "--format",
        "json",
        "test",
        ".mcpjam/evals/example.yaml",
      ],
      {
        telemetry: telemetryDisabled,
        localTest: {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? "",
            CALLS_FILE: callsFile,
            ANTHROPIC_API_KEY: "sk-ant-api03-CLISENTINELCLISENTINELCLISENTINEL",
          },
          runtime: { createLanguageModel: () => scripted() as never },
        },
      }
    )
  );

  // The call reached the server once; nothing retried or signed in.
  assert.ok(existsSync(callsFile), run.stderr);
  assert.deepEqual(
    readFileSync(callsFile, "utf8").split("\n").filter(Boolean),
    ["list_orders"]
  );

  const report = JSON.parse(run.stdout) as {
    verdict: string;
    metadata: {
      cases: Array<{
        iterations: Array<{ authRequired?: SuiteFileAuthRequired }>;
      }>;
      issues: Array<{ code: string; category: string; message: string }>;
    };
  };
  const [iteration] = report.metadata.cases[0]!.iterations;
  assert.equal(
    iteration?.authRequired?.classification,
    "authorization_required"
  );
  assert.equal(iteration?.authRequired?.server, "orders");
  assert.equal(iteration?.authRequired?.challenge.source, "tool_result_meta");
  assert.equal(iteration?.authRequired?.challenge.requiredScope, "orders:read");
  assert.ok(
    report.metadata.issues.some(
      (issue) =>
        issue.code === "AUTHORIZATION_REQUIRED" &&
        issue.category === "authorization"
    ),
    JSON.stringify(report.metadata.issues)
  );

  // A stdio server has no URL to sign in to; the command still names the flag.
  assert.match(
    run.stderr,
    /Server "orders" asked for sign-in when "list_orders" was called; a local run never signs in\. Sign in with `mcpjam oauth login --url <server-url> --scopes "orders:read" --credentials-out <file>`/
  );
  // Reported, never a changed outcome: the verdict alone decides the exit.
  assert.equal(
    run.result.exitCode,
    report.verdict === "passed" ? 0 : 1,
    run.stderr
  );
});
