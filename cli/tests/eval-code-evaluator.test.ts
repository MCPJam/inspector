/**
 * `mcpjam cloud eval code-evaluator test <file>`: the script comes from a
 * local file and its name from the file's own name; a draft a saved evaluator
 * couldn't be is refused before any request.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { Command } from "commander";
import { registerEvalCodeEvaluatorCommands } from "../src/commands/eval-code-evaluator.js";
import { CliError } from "../src/lib/output.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";
import { captureProcessOutput } from "./support/cli-run.js";

const PROJECT = {
  id: "project-1",
  name: "Checkout",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const SUITE = {
  id: "suite-1",
  name: "Invoices",
  projectId: PROJECT.id,
  createdAt: 1,
  updatedAt: 2,
  latestRun: null,
};
const TEST_PATH = `/api/v1/projects/${PROJECT.id}/eval-suites/${SUITE.id}/code-evaluators/test`;
const RESULT = {
  runId: "run-1",
  iterationId: "it-1",
  input: "stored",
  network: "web",
  result: { status: "scored", score: 1, threshold: 0.5, passed: true },
  logs: { output: "ok\n", exitCode: 0, durationMs: 12 },
};

const dir = mkdtempSync(join(tmpdir(), "mcpjam-code-evaluator-"));
const script = join(dir, "totals.py");
writeFileSync(script, "import json\nprint(json.dumps({'score': 1}))\n");
after(() => rmSync(dir, { recursive: true, force: true }));

type Captured = { method: string; path: string; body: unknown };

function stubFetch(): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith("/projects")) {
      return Response.json({ items: [PROJECT] });
    }
    if (url.pathname.endsWith("/eval-suites")) {
      return Response.json({ items: [SUITE] });
    }
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.pathname === TEST_PATH) return Response.json(RESULT);
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
  return requests;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerEvalCodeEvaluatorCommands(cloud.command("eval"));
  return program;
}

async function run(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await captureProcessOutput(() =>
    buildProgram().parseAsync(
      [
        "cloud",
        "eval",
        "code-evaluator",
        "test",
        ...args,
        "--project",
        PROJECT.id,
        "--api-key",
        "sk_test",
      ],
      { from: "user" }
    )
  );
  return JSON.parse(stdout);
}

test("sends the file's script under its own name and prints the test", async () => {
  const requests = stubFetch();
  const printed = await run([
    script,
    "--suite",
    "Invoices",
    "--iteration",
    "it-1",
    "--threshold",
    "0.5",
    "--network",
    "web",
  ]);
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: TEST_PATH,
      body: {
        iterationId: "it-1",
        evaluator: {
          fileName: "totals.py",
          script: "import json\nprint(json.dumps({'score': 1}))\n",
          threshold: 0.5,
        },
        network: "web",
      },
    },
  ]);
  assert.equal(printed.runId, "run-1");
  assert.deepEqual(printed.result, RESULT.result);
  assert.deepEqual(printed.suite, { id: SUITE.id, name: "Invoices" });
});

test("refuses a draft a saved evaluator couldn't be, before any request", async () => {
  const requests = stubFetch();
  const unsupported = join(dir, "totals.rb");
  writeFileSync(unsupported, "puts 1\n");
  for (const args of [
    [unsupported, "--suite", "Invoices", "--iteration", "it-1"],
    [script, "--suite", "Invoices", "--iteration", "it-1", "--threshold", "2"],
    [script, "--suite", "Invoices", "--iteration", "it-1", "--network", "all"],
    [join(dir, "missing.py"), "--suite", "Invoices", "--iteration", "it-1"],
  ]) {
    await assert.rejects(
      run(args),
      (error: unknown) =>
        error instanceof CliError && error.code === "USAGE_ERROR"
    );
  }
  assert.equal(requests.length, 0);
});
