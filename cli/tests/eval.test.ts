import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { main } from "../src/index.js";

const telemetryDisabled = {
  env: {
    ...process.env,
    MCPJAM_TELEMETRY_DISABLED: "1",
  },
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

  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stdout += chunk;
      return true;
    }
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stderr += chunk;
      return true;
    }
    return (originalStderrWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
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

const SERVERS = [
  {
    id: "srv-ready",
    projectId: "proj-alpha",
    name: "Ready Server",
    enabled: true,
    transportType: "http",
    url: "https://ready.example.com/mcp",
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "srv-stdio",
    projectId: "proj-alpha",
    name: "Stdio Server",
    enabled: true,
    transportType: "stdio",
    url: null,
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
];

const ENVIRONMENTS = [
  {
    id: "env-staging",
    projectId: "proj-alpha",
    name: "Staging",
    hostId: "host-1",
    revision: 4,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "env-prod",
    projectId: "proj-alpha",
    name: "Prod",
    hostId: "host-1",
    revision: 2,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
];

const STEP_RESULTS = [
  { stepId: "s1", stepIndex: 0, kind: "prompt", status: "ok", reason: null },
  {
    stepId: "s2",
    stepIndex: 1,
    kind: "assert",
    status: "fail",
    reason: "clear-cart never called",
    evidence: { screenshotUrl: "https://blob/s2.png", source: "scripted" },
  },
];

const TRACE = {
  traceVersion: 1,
  messages: [{ role: "user", content: "hi" }],
  videoUrl: "https://blob.example.com/run.webm",
  widgetRenderObservations: [],
  browserInteractionSteps: [],
};

async function startEvalFixture(): Promise<{
  baseUrl: string;
  authHeaders: string[];
  createBodies: unknown[];
  close: () => Promise<void>;
}> {
  const authHeaders: string[] = [];
  const createBodies: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    authHeaders.push(req.headers.authorization ?? "");
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/projects") {
      res.end(JSON.stringify({ items: PROJECTS }));
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/servers") {
      res.end(JSON.stringify({ items: SERVERS }));
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/environments") {
      res.end(JSON.stringify({ items: ENVIRONMENTS }));
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/suite-1" &&
      req.method === "PATCH"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      createBodies.push(body);
      res.end(
        JSON.stringify({
          id: "suite-1",
          name: "Smoke",
          environmentIds: body.environmentIds ?? [],
          settings: {},
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites" &&
      req.method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      createBodies.push(body);
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          suiteId: "suite-created",
          name: body.name ?? null,
          servers: (body.serverIds ?? []).map((id: string) => ({ id })),
          caseUpsert: { committed: [{ name: "case-1" }], failed: [] },
        }),
      );
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-1/iterations/iter-1/steps" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(JSON.stringify({ items: STEP_RESULTS }));
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-1/iterations/iter-1/trace" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(JSON.stringify(TRACE));
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "suite-1",
              name: "Smoke",
              projectId: "proj-alpha",
              createdAt: 1,
              updatedAt: 2,
              latestRun: null,
              totals: { passed: 0, failed: 0, runs: 0 },
              passRateTrend: [],
            },
          ],
        }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-1/cases" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          items: [{ id: "case-1", suiteId: "suite-1", title: "echo works" }],
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs" &&
      req.method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      createBodies.push(body);
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          runId: "run-case",
          suiteId: "suite-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [{ id: "srv-ready", name: "Ready Server" }],
          environment: body.environmentId
            ? { id: body.environmentId, name: "Staging", revision: 4 }
            : null,
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          id: "run-1",
          suiteId: "suite-1",
          runNumber: 3,
          status: "completed",
          result: "passed",
          summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 1,
          completedAt: 2,
          judges: {
            goalCompletion: {
              status: "completed",
              errorCode: null,
              summary: "Both answers hit the goal.",
              generatedAt: 9,
              modelUsed: "openai/gpt-5.4-mini",
              threshold: 0.7,
              cases: [
                {
                  caseKey: "a",
                  score: 0.9,
                  passed: true,
                  reason: "ok",
                  rubricHits: [],
                },
                {
                  caseKey: "b",
                  score: 0.4,
                  passed: false,
                  reason: "missed",
                  rubricHits: [],
                },
              ],
            },
            // Never requested — the CLI must print nothing for it.
            groundedness: {
              status: null,
              errorCode: null,
              summary: null,
              generatedAt: null,
              modelUsed: null,
              threshold: null,
              cases: [],
            },
          },
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1/judge" &&
      req.method === "POST"
    ) {
      createBodies.push(raw ? JSON.parse(raw) : {});
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          runId: "run-1",
          projectId: "proj-alpha",
          status: "pending",
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1/cancel" &&
      req.method === "POST"
    ) {
      res.end(
        JSON.stringify({
          id: "run-1",
          suiteId: "suite-created",
          runNumber: 1,
          status: "cancelled",
          result: "cancelled",
          summary: null,
          source: "api",
          notes: null,
          createdAt: 1,
          completedAt: 2,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "no route" }));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    authHeaders,
    createBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function evalArgv(fixtureUrl: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "eval",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    fixtureUrl,
  ];
}

test("eval create posts an authored suite and echoes the new suite id", async () => {
  const fixture = await startEvalFixture();
  try {
    const definition = {
      project: "proj-alpha",
      name: "Authored smoke",
      servers: ["Ready Server"],
      model: "anthropic/claude-haiku-4.5",
      cases: [
        {
          title: "echo works",
          steps: [
            { id: "s1", kind: "prompt", prompt: "say hi" },
            {
              id: "s2",
              kind: "assert",
              assertion: {
                type: "toolCalledWith",
                toolName: "echo",
                args: { args: {} },
              },
            },
          ],
          advancedConfig: { system: "be terse", temperature: 0.1 },
        },
      ],
    };
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "create",
            "--json",
            JSON.stringify(definition),
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(fixture.createBodies.length, 1);
    const body = fixture.createBodies[0] as Record<string, any>;
    assert.equal(body.name, "Authored smoke");
    assert.deepEqual(body.serverIds, ["srv-ready"]);
    assert.deepEqual(body.serverNames, ["Ready Server"]);
    assert.equal(body.model, "anthropic/claude-haiku-4.5");
    assert.equal(body.tests.length, 1);
    assert.equal(body.tests[0].title, "echo works");
    // Advanced authoring fields forward instead of being stripped.
    assert.deepEqual(body.tests[0].advancedConfig, {
      system: "be terse",
      temperature: 0.1,
    });

    assert.ok(fixture.authHeaders.includes("Bearer sk_test"));
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.suite.id, "suite-created");
  } finally {
    await fixture.close();
  }
});

test("eval create lets --server override the file's servers", async () => {
  const fixture = await startEvalFixture();
  try {
    const definition = {
      name: "Override",
      servers: ["Stdio Server"],
      model: "anthropic/claude-haiku-4.5",
      cases: [{ title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] }],
    };
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--project",
          "proj-alpha",
          "--json",
          JSON.stringify(definition),
          "--server",
          "Ready Server",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const body = fixture.createBodies[0] as Record<string, any>;
    assert.deepEqual(body.serverIds, ["srv-ready"]);
  } finally {
    await fixture.close();
  }
});

test("eval create forwards a --provider override for bare model ids", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--project",
          "proj-alpha",
          "--name",
          "Bare model",
          "--model",
          "my-local-model",
          "--provider",
          "custom",
          "--server",
          "Ready Server",
          "--json",
          JSON.stringify({ cases: [{ title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] }] }),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const body = fixture.createBodies[0] as Record<string, any>;
    assert.equal(body.model, "my-local-model");
    assert.equal(body.provider, "custom");
  } finally {
    await fixture.close();
  }
});

test("eval create rejects stdio servers before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    const definition = {
      project: "proj-alpha",
      name: "Bad",
      servers: ["Stdio Server"],
      model: "anthropic/claude-haiku-4.5",
      cases: [{ title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] }],
    };
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--json",
          JSON.stringify(definition),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.equal(fixture.createBodies.length, 0);
    assert.match(run.stderr, /stdio/i);
  } finally {
    await fixture.close();
  }
});

test("eval create rejects an invalid suite definition as a usage error", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--json",
          JSON.stringify({ name: "No cases", servers: ["Ready Server"] }),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(fixture.createBodies.length, 0);
    assert.match(run.stderr, /USAGE_ERROR/);
  } finally {
    await fixture.close();
  }
});

test("eval create rejects malformed JSON in --json", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(fixture.baseUrl, "create", "--json", "{ not json"),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval steps returns per-authored-step results for an iteration", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "steps",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--iteration",
            "iter-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      runId: string;
      iterationId: string;
      steps: Array<{ stepId: string; status: string }>;
    };
    assert.equal(payload.runId, "run-1");
    assert.equal(payload.iterationId, "iter-1");
    assert.deepEqual(
      payload.steps.map((s) => [s.stepId, s.status]),
      [
        ["s1", "ok"],
        ["s2", "fail"],
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("eval video surfaces the iteration's resolved replay URL", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "video",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--iteration",
            "iter-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      runId: string;
      iterationId: string;
      videoUrl: string;
    };
    assert.equal(payload.runId, "run-1");
    assert.equal(payload.iterationId, "iter-1");
    assert.equal(payload.videoUrl, "https://blob.example.com/run.webm");
  } finally {
    await fixture.close();
  }
});

test("eval cancel POSTs the cancel and echoes the cancelled run", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "cancel",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      run: { id: string; status: string; result: string };
    };
    assert.equal(payload.run.id, "run-1");
    assert.equal(payload.run.status, "cancelled");
    assert.equal(payload.run.result, "cancelled");
  } finally {
    await fixture.close();
  }
});

test("eval cases run starts a persisted single-case run with caseIds", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "cases",
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--case",
            "case-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      runId: string;
      case: { id: string };
    };
    assert.equal(payload.runId, "run-case");
    assert.equal(payload.case.id, "case-1");
    // The run-create POST carried the single-case filter.
    const runBody = fixture.createBodies.at(-1) as { caseIds?: string[] };
    assert.deepEqual(runBody.caseIds, ["case-1"]);
  } finally {
    await fixture.close();
  }
});

test("eval run --environment resolves the name and reports the pinned revision", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--environment",
            "staging",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      environment: { id: string; name: string; revision: number } | null;
    };
    assert.deepEqual(payload.environment, {
      id: "env-staging",
      name: "Staging",
      revision: 4,
    });
    const runBody = fixture.createBodies.at(-1) as { environmentId?: string };
    assert.equal(runBody.environmentId, "env-staging");
  } finally {
    await fixture.close();
  }
});

test("eval run rejects --environment together with --server before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--environment",
          "Staging",
          "--server",
          "Ready Server",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /either environment or servers/);
    // The CLI calls the operation directly, so this guard has to live in the
    // execute body — a schema-only refine would never fire here.
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval update --judge on writes enabled AND autoRun together", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--judge",
            "on",
            "--judge-threshold",
            "0.8",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      settings?: { judge?: Record<string, unknown> };
    };
    // `enabled` alone is a no-op — it already defaults on, and the grader
    // gates on `autoRun`. One flag, both fields, matching the app's switch.
    assert.deepEqual(patchBody.settings?.judge, {
      enabled: true,
      autoRun: true,
      threshold: 0.8,
    });
  } finally {
    await fixture.close();
  }
});

test("eval update --judge off turns autoRun off with it", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--judge",
            "off",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      settings?: { judge?: Record<string, unknown> };
    };
    assert.deepEqual(patchBody.settings?.judge, {
      enabled: false,
      autoRun: false,
    });
  } finally {
    await fixture.close();
  }
});

test("eval update rejects an out-of-range --judge-threshold before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "update",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--judge-threshold",
          "80",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /--judge-threshold must be a number between 0 and 1/);
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval environments set PATCHes the resolved ids in the given order", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "environments",
            "set",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--environment",
            "Prod",
            "env-staging",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      environmentIds?: string[] | null;
    };
    assert.deepEqual(patchBody.environmentIds, ["env-prod", "env-staging"]);
  } finally {
    await fixture.close();
  }
});

test("eval environments clear sends an explicit null", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "environments",
            "clear",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      environmentIds?: string[] | null;
    };
    assert.equal(patchBody.environmentIds, null);
  } finally {
    await fixture.close();
  }
});

test("eval environments set rejects an unknown environment before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "environments",
          "set",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--environment",
          "Staging",
          "ghost",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    // The failure names the bad selector AND enumerates the real choices, so a
    // typo is one round trip to fix rather than a bare "not found". Quotes are
    // matched loosely because the payload is JSON-encoded here.
    assert.match(run.stderr, /Project environment .*ghost.* was not found/);
    assert.match(run.stderr, /Staging \(id: env-staging\)/);
    assert.match(run.stderr, /Prod \(id: env-prod\)/);
    // Resolution failing means nothing is PATCHed — a partially-attached suite
    // is worse than an unattached one.
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval run appends a View link in human format", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          // Explicit: the CLI resolves the default format from TTY-ness, and
          // a captured test stream is never a TTY (so it defaults to json).
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const lines = run.stdout.trimEnd().split("\n");
    // The link comes AFTER the payload, on its own line, so a human reader
    // can act on the upload they just made without leaving the terminal.
    assert.equal(
      lines.at(-1),
      "View: http://127.0.0.1:" +
        new URL(fixture.baseUrl).port +
        "/evals/suite/suite-1/runs/run-case?project=proj-alpha",
    );
  } finally {
    await fixture.close();
  }
});

test("eval status appends a View link in human format", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "status",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const lines = run.stdout.trimEnd().split("\n");
    assert.equal(
      lines.at(-1),
      "View: http://127.0.0.1:" +
        new URL(fixture.baseUrl).port +
        "/evals/suite/suite-1/runs/run-1?project=proj-alpha",
    );
  } finally {
    await fixture.close();
  }
});

test("--format json output stays byte-identical — no View line", async () => {
  const fixture = await startEvalFixture();
  try {
    for (const args of [
      ["run", "--project", "proj-alpha", "--suite", "suite-1"],
      ["status", "--project", "proj-alpha", "--run", "run-1"],
    ]) {
      const run = await captureProcessOutput(() =>
        main([...evalArgv(fixture.baseUrl, ...args), "--format", "json"], {
          telemetry: telemetryDisabled,
        }),
      );

      assert.equal(run.result.exitCode, 0);
      // Scripts parse this stream. One line, still valid JSON end to end.
      assert.equal(run.stdout.trimEnd().split("\n").length, 1);
      assert.doesNotThrow(() => JSON.parse(run.stdout));
      assert.ok(!run.stdout.includes("View:"));
    }
  } finally {
    await fixture.close();
  }
});

test("eval judge POSTs the per-run override and echoes the pending receipt", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "judge",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--force",
            "--enable",
            "--judge-model",
            "openai/gpt-5",
            "--judge-threshold",
            "0.8",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.createBodies.at(-1), {
      force: true,
      enable: true,
      model: "openai/gpt-5",
      threshold: 0.8,
    });
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.judge.status, "pending");
  } finally {
    await fixture.close();
  }
});

test("eval judge sends an empty body when no override was asked for", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "judge",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    // An empty body means "grade with the suite's config" — sending
    // `enable: false` or a null model would state something the caller did not.
    assert.deepEqual(fixture.createBodies.at(-1), {});
  } finally {
    await fixture.close();
  }
});

test("eval judge rejects an out-of-range --judge-threshold before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "judge",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--judge-threshold",
          "1.5",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /--judge-threshold must be a number between 0 and 1/);
    // It SPENDS — a bad flag must not reach the wire.
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval status summarizes the judges that graded, and stays silent about the rest", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "status",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const lines = run.stdout.trimEnd().split("\n");
    assert.equal(
      lines.at(-2),
      "Judge goal completion: 1/2 passed at threshold 0.7 — openai/gpt-5.4-mini",
    );
    // groundedness was never requested, so it gets no SUMMARY line — listing
    // it would turn a status read into a catalog of judges the platform could
    // have run. (It is still in the JSON payload above, which is the point:
    // the envelope is complete, the summary is only what happened.)
    assert.ok(!run.stdout.includes("Judge groundedness"));
    // The View link stays the closing line.
    assert.match(lines.at(-1) ?? "", /^View: /);
  } finally {
    await fixture.close();
  }
});
