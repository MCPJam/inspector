import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { main } from "../src/index.js";

/**
 * `mcpjam cloud eval rerun <run-id> --failed`.
 *
 * The platform picks the cases; the CLI only names the run and the scope. So
 * the claims here are about the wire — the POST carries `scope:
 * "failed_cases"` and nothing that would pick cases — plus `--dry-run`
 * reading the preview instead of launching, `--wait` polling the NEW run, and
 * the usage rules that keep a typo from spending.
 */

const telemetryDisabled = {
  env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" },
};

const PROJECTS = [
  {
    id: "proj-alpha",
    name: "Alpha",
    description: null,
    icon: null,
    organizationId: "org-1",
    visibility: null,
    createdAt: 1,
    updatedAt: 200,
  },
];

const PREVIEW = {
  runId: "run-src",
  suiteId: "suite-1",
  scope: "failed_cases",
  sourceStatus: "completed",
  sourceTerminal: true,
  totalCaseCount: 3,
  selectedCaseCount: 2,
  selectedCaseIds: ["case-b", "case-c"],
  reasons: {
    failed: 1,
    evaluator_error: 1,
    timed_out: 0,
    execution_failed: 0,
    setup_failed: 0,
    pending: 0,
  },
  excluded: { passed: 1, cancelled: 0, skipped: 0 },
  rerunnable: true,
};

async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  // Strings are the command's output; anything else (the test reporter's own
  // buffers) passes straight through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stdout += chunk;
      return true;
    }
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stderr += chunk;
      return true;
    }
    return (originalStderrWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    );
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function startFixture(
  options: {
    rerunResult?: "passed" | "failed";
    nothingToRerun?: boolean;
    preview?: Record<string, unknown>;
  } = {}
): Promise<{
  baseUrl: string;
  requests: string[];
  rerunBodies: unknown[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const rerunBodies: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://fixture");
    const method = req.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/projects") {
      res.end(JSON.stringify({ items: PROJECTS }));
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-src/rerun-preview" &&
      method === "GET"
    ) {
      res.end(JSON.stringify({ ...PREVIEW, ...options.preview }));
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-src/rerun" &&
      method === "POST"
    ) {
      rerunBodies.push(raw ? JSON.parse(raw) : {});
      if (options.nothingToRerun) {
        res.statusCode = 409;
        res.end(
          JSON.stringify({
            code: "CONFLICT",
            message:
              "Every case in that run passed, so there is nothing to rerun.",
            details: { reason: "RERUN_NOTHING_TO_RERUN" },
          })
        );
        return;
      }
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          runId: "run-rerun",
          suiteId: "suite-1",
          status: "running",
          rerunOfRunId: "run-src",
          rerunScope: "failed_cases",
          servers: [{ id: "srv-1", name: "Server" }],
          environment: null,
        })
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-rerun" &&
      method === "GET"
    ) {
      res.end(
        JSON.stringify({
          id: "run-rerun",
          suiteId: "suite-1",
          runNumber: 7,
          status: "completed",
          result: options.rerunResult ?? "passed",
          summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 1,
          completedAt: 2,
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: url.pathname }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    rerunBodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function rerunArgv(baseUrl: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "cloud",
    "eval",
    "rerun",
    ...args,
    "--project",
    "proj-alpha",
    "--api-key",
    "sk_test",
    "--api-url",
    baseUrl,
  ];
}

test("eval rerun --failed POSTs the failed-cases scope and prints the new run", async () => {
  const fixture = await startFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(rerunArgv(fixture.baseUrl, "run-src", "--failed", "--json"), {
        telemetry: telemetryDisabled,
      })
    );
    assert.equal(run.result.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout) as {
      rerun: {
        runId: string;
        rerunOfRunId: string;
        rerunScope: string;
      };
    };
    assert.equal(payload.rerun.runId, "run-rerun");
    assert.equal(payload.rerun.rerunOfRunId, "run-src");
    assert.equal(payload.rerun.rerunScope, "failed_cases");
    // The platform picks the cases: the body names the scope and nothing else.
    assert.deepEqual(fixture.rerunBodies, [{ scope: "failed_cases" }]);
    // No --wait: the new run is never polled.
    assert.ok(
      !fixture.requests.includes(
        "GET /api/v1/projects/proj-alpha/eval-runs/run-rerun"
      )
    );
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval rerun --failed --wait polls the new run and exits on its verdict", async () => {
  for (const [rerunResult, expectedExit] of [
    ["passed", 0],
    ["failed", 1],
  ] as const) {
    const fixture = await startFixture({ rerunResult });
    try {
      const run = await captureProcessOutput(() =>
        main(
          rerunArgv(
            fixture.baseUrl,
            "run-src",
            "--failed",
            "--wait",
            "--notes",
            "flake check",
            "--json"
          ),
          { telemetry: telemetryDisabled }
        )
      );
      assert.equal(run.result.exitCode, expectedExit, run.stderr);
      const payload = JSON.parse(run.stdout) as {
        rerun: { runId: string };
        run: { id: string; result: string };
      };
      assert.equal(payload.run.id, "run-rerun");
      assert.equal(payload.run.result, rerunResult);
      assert.deepEqual(fixture.rerunBodies, [
        { scope: "failed_cases", notes: "flake check" },
      ]);
    } finally {
      process.exitCode = 0;
      await fixture.close();
    }
  }
});

test("eval rerun --failed --dry-run reads the preview and launches nothing", async () => {
  const fixture = await startFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        rerunArgv(
          fixture.baseUrl,
          "run-src",
          "--failed",
          "--dry-run",
          "--json"
        ),
        { telemetry: telemetryDisabled }
      )
    );
    assert.equal(run.result.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout) as { preview: typeof PREVIEW };
    assert.equal(payload.preview.selectedCaseCount, 2);
    assert.deepEqual(payload.preview.selectedCaseIds, ["case-b", "case-c"]);
    assert.equal(payload.preview.reasons.evaluator_error, 1);
    assert.deepEqual(fixture.rerunBodies, []);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval rerun --dry-run exits non-zero when nothing can rerun", async () => {
  const fixture = await startFixture({
    preview: { selectedCaseCount: 0, selectedCaseIds: [], rerunnable: false },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        rerunArgv(
          fixture.baseUrl,
          "run-src",
          "--failed",
          "--dry-run",
          "--json"
        ),
        { telemetry: telemetryDisabled }
      )
    );
    assert.equal(run.result.exitCode, 1, run.stderr);
    const payload = JSON.parse(run.stdout) as {
      preview: { rerunnable: boolean };
    };
    assert.equal(payload.preview.rerunnable, false);
    assert.deepEqual(fixture.rerunBodies, []);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval rerun surfaces the platform's nothing-to-rerun refusal", async () => {
  const fixture = await startFixture({ nothingToRerun: true });
  try {
    const run = await captureProcessOutput(() =>
      main(rerunArgv(fixture.baseUrl, "run-src", "--failed", "--json"), {
        telemetry: telemetryDisabled,
      })
    );
    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /nothing to rerun/);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval rerun --wait maps a refusal to the invalid-request exit code", async () => {
  const fixture = await startFixture({ nothingToRerun: true });
  try {
    const run = await captureProcessOutput(() =>
      main(
        rerunArgv(fixture.baseUrl, "run-src", "--failed", "--wait", "--json"),
        { telemetry: telemetryDisabled }
      )
    );
    // A refusal is the request's answer (2), never an infrastructure failure.
    assert.equal(run.result.exitCode, 2, run.stderr);
    assert.ok(
      !fixture.requests.includes(
        "GET /api/v1/projects/proj-alpha/eval-runs/run-rerun"
      )
    );
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval rerun without --failed is a usage error that sends nothing", async () => {
  const fixture = await startFixture();
  try {
    for (const args of [
      ["run-src"],
      ["run-src", "--failed", "--wait-timeout", "1000"],
      ["run-src", "--failed", "--dry-run", "--wait"],
    ]) {
      const run = await captureProcessOutput(() =>
        main(rerunArgv(fixture.baseUrl, ...args, "--json"), {
          telemetry: telemetryDisabled,
        })
      );
      assert.equal(run.result.exitCode, 2, args.join(" "));
    }
    assert.deepEqual(fixture.requests, []);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});
