import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { main } from "../src/index.js";

/**
 * `mcpjam cloud eval regrade <run-id>`: the persisted re-grade from stored
 * traces. The command is a thin binding — the inspector grades and the
 * backend persists — so what is pinned here is the wire: which route, which
 * body, and that `--json` / `--dry-run` / `--draft` mean what they say.
 */

const telemetryDisabled = {
  env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" },
};

const REPORT = {
  schemaVersion: 1,
  runId: "run-1",
  suiteId: "suite-1",
  draftHash: "d".repeat(64),
  dryRun: false,
  applied: true,
  counts: { iterations: 2, regraded: 1, unchanged: 1, skipped: 0, flipped: 1 },
  iterations: [],
  run: { result: "passed" },
  modelUse: "none",
};

async function startFixture(): Promise<{
  baseUrl: string;
  regradeBodies: unknown[];
  close: () => Promise<void>;
}> {
  const regradeBodies: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") {
      res.end(
        JSON.stringify({
          items: [
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
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1") {
      res.end(
        JSON.stringify({
          id: "run-1",
          suiteId: "suite-1",
          status: "completed",
          result: "failed",
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1/regrade" &&
      req.method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      regradeBodies.push(body);
      res.end(
        JSON.stringify({
          ...REPORT,
          dryRun: body.dryRun === true,
          applied: body.dryRun !== true,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "nope" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    regradeBodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function capture<T>(fn: () => Promise<T>) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  // Strings only: the node:test runner reports over the same stream in
  // binary frames, which must pass through untouched.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== "string")
      return (out as (...args: unknown[]) => boolean)(chunk, ...rest);
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== "string")
      return (err as (...args: unknown[]) => boolean)(chunk, ...rest);
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

const argv = (baseUrl: string, ...args: string[]) => [
  "node",
  "mcpjam",
  "cloud",
  "eval",
  "regrade",
  ...args,
  "--project",
  "proj-alpha",
  "--api-key",
  "sk_test",
  "--api-url",
  baseUrl,
];

test("eval regrade POSTs the frozen-assertion re-grade and --json prints the report", async () => {
  const fixture = await startFixture();
  try {
    const run = await capture(() =>
      main(argv(fixture.baseUrl, "run-1", "--json"), {
        telemetry: telemetryDisabled,
      }),
    );
    assert.equal(run.result.exitCode, 0, run.stderr);
    // No draft ⇒ the frozen assertions; no dry run ⇒ persisted.
    assert.deepEqual(fixture.regradeBodies, [{}]);
    const payload = JSON.parse(run.stdout) as {
      runId: string;
      report: typeof REPORT;
    };
    assert.equal(payload.runId, "run-1");
    assert.equal(payload.report.applied, true);
    assert.equal(payload.report.modelUse, "none");
    assert.equal(payload.report.run.result, "passed");
  } finally {
    await fixture.close();
  }
});

test("eval regrade --dry-run --draft sends the draft and asks for no write", async () => {
  const fixture = await startFixture();
  try {
    const draft = {
      assertions: {
        mode: "replace",
        list: [{ type: "responseContains", needle: "cats" }],
      },
    };
    const run = await capture(() =>
      main(
        argv(
          fixture.baseUrl,
          "run-1",
          "--dry-run",
          "--draft",
          JSON.stringify(draft),
          "--json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 0, run.stderr);
    assert.deepEqual(fixture.regradeBodies, [{ ...draft, dryRun: true }]);
    const payload = JSON.parse(run.stdout) as { report: typeof REPORT };
    assert.equal(payload.report.dryRun, true);
    assert.equal(payload.report.applied, false);
  } finally {
    await fixture.close();
  }
});

test("eval regrade refuses a malformed draft before any request", async () => {
  const fixture = await startFixture();
  try {
    const run = await capture(() =>
      main(
        argv(
          fixture.baseUrl,
          "run-1",
          "--draft",
          JSON.stringify({ assertions: { mode: "sometimes", list: [] } }),
          "--json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.notEqual(run.result.exitCode, 0);
    assert.deepEqual(fixture.regradeBodies, []);
  } finally {
    await fixture.close();
  }
});
