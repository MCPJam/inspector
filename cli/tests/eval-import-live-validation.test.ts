/**
 * Live, project-aware validation of a suite file's deterministic tool
 * references — the check `eval validate --project` performs on request and
 * every `eval run --file` performs whether you ask for it or not.
 *
 * What is worth asserting here, over and above "the command ran":
 *
 *  - `eval validate` with NO `--project` still reaches no network. Driven below
 *    against a fixture that counts every request, so a client construction
 *    sneaking into the offline path fails the test instead of quietly working.
 *  - A refusal happens BEFORE the writes. The assertions are on the fixture's
 *    recorded bodies being EMPTY, not merely on a non-zero exit — a run that
 *    synced a suite and then refused would pass the weaker check while leaving
 *    the caller's project half-written.
 *  - A disabled imported case is PERSISTED with a rewritten claim rather than
 *    dropped. Deleting it would destroy the case's hosted history the moment
 *    somebody parks a converted test.
 *  - Multi-target is checked per target, never over the union. The union is the
 *    false negative this whole check exists to prevent.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { describe } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../src/index.js";

const telemetryDisabled = {
  env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" },
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

async function withSuiteFile<T>(
  contents: string,
  run: (file: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-import-live-"));
  const file = path.join(dir, "suite.yaml");
  await writeFile(file, contents, "utf8");
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── suite files ──────────────────────────────────────────────────────────────

/**
 * `c_render` calls a tool the fixture server exposes; `c_missing` calls one it
 * does not. Both are imported, and `c_missing` is DISABLED — the combination
 * that has to be persisted-but-rewritten rather than refused or dropped.
 */
const IMPORTED_WITH_TOOL_CALLS = `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_billing
  name: Billing smoke
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_render
    title: Renders the refund widget
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_refund
        arguments: {}
    import:
      status: exact
      sourceCaseKey: upstream/refunds/render
      note: "1:1 with the upstream render assertion."
  - id: c_missing
    title: Renders a widget that no longer exists
    disabled: true
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_gone
        arguments: {}
    import:
      status: exact
      sourceCaseKey: upstream/refunds/gone
      note: "1:1 with the upstream legacy render assertion."
provenance:
  sourceHash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  sourceFormat: upstream-evals
  reportHash: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
`;

/** The same missing tool, but on an ENABLED case: the launch must refuse. */
const IMPORTED_ENABLED_MISSING = IMPORTED_WITH_TOOL_CALLS.replace(
  "    disabled: true\n",
  ""
);

/** No import block anywhere, and the missing tool is on a disabled case. */
const NATIVE_WITH_TOOL_CALLS = `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_billing
  name: Billing smoke
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_render
    title: Renders the refund widget
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_refund
        arguments: {}
  - id: c_missing
    title: Renders a widget that no longer exists
    disabled: true
    steps:
      - id: step-1
        kind: toolCall
        serverName: billing
        toolName: render_gone
        arguments: {}
`;

/** Prompt-only: nothing deterministic, so nothing to resolve and nothing to fetch. */
const PROMPT_ONLY = `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_billing
  name: Billing smoke
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_refund
    title: Refunds a duplicate charge
    steps:
      - id: step-1
        kind: prompt
        prompt: Refund the duplicate charge on invoice 4471.
`;

/**
 * The mention is in PROMPT TEXT and in an ASSERTION, never in a `toolCall`.
 * Neither is a deterministic reference, so neither may produce a finding.
 */
const MENTIONS_ONLY = `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_billing
  name: Billing smoke
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_hint
    title: Mentions a tool it does not deterministically call
    steps:
      - id: step-1
        kind: prompt
        prompt: Use render_gone to show the refund.
      - id: step-2
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: render_gone
          args:
            args: {}
            argumentMatching: partial
`;

// ── the fixture ──────────────────────────────────────────────────────────────

type FixtureOptions = {
  /** Tool names per server NAME. A server absent here exposes nothing. */
  toolsByServer?: Record<string, string[]>;
  /** Servers the project holds, in list order. */
  servers?: Array<{ id: string; name: string }>;
  /** Environment name → the server names it resolves to. */
  environments?: Record<string, string[]>;
};

type Fixture = {
  baseUrl: string;
  requests: string[];
  fromFileBodies: unknown[];
  batchBodies: unknown[];
  updateBodies: unknown[];
  runBodies: unknown[];
  toolListings: string[];
  close: () => Promise<void>;
};

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const servers = options.servers ?? [{ id: "srv_billing", name: "billing" }];
  const toolsByServer = options.toolsByServer ?? {
    billing: ["render_refund", "issue_refund"],
  };
  const environments = options.environments ?? {};

  const requests: string[] = [];
  const fromFileBodies: unknown[] = [];
  const batchBodies: unknown[] = [];
  const updateBodies: unknown[] = [];
  const runBodies: unknown[] = [];
  const toolListings: string[] = [];
  const casesByDeclaredId = new Map<
    string,
    { id: string; declaredId: string; title: string }
  >();

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://fixture");
    const method = req.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    const body = raw ? JSON.parse(raw) : {};
    const json = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };

    if (url.pathname === "/api/v1/projects") {
      json({
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
      });
      return;
    }

    if (url.pathname === "/api/v1/projects/proj-alpha/servers") {
      json({
        items: servers.map((entry) => ({
          ...entry,
          projectId: "proj-alpha",
          enabled: true,
          transportType: "http",
          url: `https://example.test/${entry.name}`,
          useOAuth: false,
          hasClientSecret: false,
          createdAt: 1,
          updatedAt: 2,
        })),
      });
      return;
    }

    const toolsMatch = url.pathname.match(
      /^\/api\/v1\/projects\/proj-alpha\/servers\/([^/]+)\/tools$/
    );
    if (toolsMatch && method === "POST") {
      const serverId = decodeURIComponent(toolsMatch[1]);
      const named = servers.find((entry) => entry.id === serverId);
      toolListings.push(serverId);
      json({
        items: (toolsByServer[named?.name ?? ""] ?? []).map((name) => ({
          name,
          description: name,
        })),
      });
      return;
    }

    if (url.pathname === "/api/v1/projects/proj-alpha/environments") {
      json({
        items: Object.keys(environments).map((name, index) => ({
          id: `env_${index}`,
          name,
          archived: false,
        })),
      });
      return;
    }

    const resolveMatch = url.pathname.match(
      /^\/api\/v1\/projects\/proj-alpha\/environments\/([^/]+)\/resolve$/
    );
    if (resolveMatch) {
      const environmentId = decodeURIComponent(resolveMatch[1]);
      const name =
        Object.keys(environments)[Number(environmentId.split("_")[1] ?? "0")] ??
        environmentId;
      json({
        environment: { id: environmentId, name, revision: 1 },
        hostId: "host_1",
        hostName: "Claude Desktop",
        hostConfigId: "hc_1",
        selectedServerIds: [],
        effectiveServerIds: [],
        pluginVersions: [],
        servers: (environments[name] ?? []).map((serverName) => ({
          serverId:
            servers.find((entry) => entry.name === serverName)?.id ??
            `srv_${serverName}`,
          name: serverName,
        })),
      });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/from-file" &&
      method === "POST"
    ) {
      fromFileBodies.push(body);
      json(
        {
          created: true,
          suite: {
            id: "suite-file-1",
            declaredId: body.declaredSuiteId,
            name: body.name,
            description: null,
            projectId: "proj-alpha",
            environment: { servers: ["billing"], computerEnvironment: null },
            executionConfig: { model: "anthropic/claude-sonnet-4-6" },
            hosts: [],
            environmentIds: [],
            settings: {},
            schedule: {},
            createdAt: 1,
            updatedAt: 2,
          },
        },
        201
      );
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases" &&
      method === "GET"
    ) {
      json({ items: [...casesByDeclaredId.values()] });
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases/batch" &&
      method === "POST"
    ) {
      batchBodies.push(body);
      const created = (
        body.cases as Array<{ id?: string; title: string }>
      ).map((testCase, index) => {
        const declaredId = testCase.id ?? `minted_${index}`;
        casesByDeclaredId.set(declaredId, {
          id: `row_${declaredId}`,
          declaredId,
          title: testCase.title,
        });
        return {
          index,
          id: `row_${declaredId}`,
          declaredId,
          title: testCase.title,
          replayed: false,
        };
      });
      json({ created, failed: [], duplicatePolicy: "block" }, 201);
      return;
    }

    if (
      url.pathname.startsWith(
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases/"
      ) &&
      method === "PATCH"
    ) {
      updateBodies.push(body);
      json({ id: "row_c_render", title: "updated" });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/suite-file-1" &&
      method === "GET"
    ) {
      json({
        id: "suite-file-1",
        declaredId: "s_billing",
        name: "Billing smoke",
        description: null,
        projectId: "proj-alpha",
        environment: { servers: ["billing"] },
        executionConfig: { model: "anthropic/claude-sonnet-4-6" },
        hosts: [],
        environmentIds: [],
        settings: {},
        schedule: {},
        createdAt: 1,
        updatedAt: 2,
      });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites" &&
      method === "GET"
    ) {
      json({
        items: [
          {
            id: "suite-file-1",
            name: "Billing smoke",
            projectId: "proj-alpha",
            createdAt: 1,
            updatedAt: 2,
            latestRun: null,
            totals: { passed: 0, failed: 0, runs: 0 },
            passRateTrend: [],
          },
        ],
      });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs" &&
      method === "POST"
    ) {
      runBodies.push(body);
      json(
        {
          runId: `run-${runBodies.length}`,
          suiteId: "suite-file-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [{ id: "srv_billing", name: "billing" }],
          environment: null,
        },
        202
      );
      return;
    }

    json({ error: { message: `no route ${url.pathname}` } }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("fixture server did not bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    fromFileBodies,
    batchBodies,
    updateBodies,
    runBodies,
    toolListings,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

function validateArgv(file: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "cloud",
    "eval",
    "validate",
    "--file",
    file,
    ...args,
    "--format",
    "json",
  ];
}

function runArgv(baseUrl: string, file: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "cloud",
    "eval",
    "run",
    "--file",
    file,
    "--project",
    "Alpha",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    baseUrl,
    "--format",
    "json",
  ];
}

type ValidateEnvelope = {
  valid: boolean;
  projectValidation?: {
    project: { id: string; name: string };
    targets: string[];
    valid: boolean;
    findings: Array<Record<string, unknown>>;
  };
};

// ── offline compatibility ────────────────────────────────────────────────────

describe("eval validate stays offline without --project", () => {
  test("no --project reaches no network and reports no projectValidation", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          // Deliberately no --api-key and no --api-url: a client construction
          // sneaking into this path cannot even be configured, so it fails
          // here rather than working quietly on a machine that happens to be
          // logged in.
          main(validateArgv(file), { telemetry: telemetryDisabled })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.equal(envelope.valid, true);
        assert.equal(envelope.projectValidation, undefined);
        assert.deepEqual(fixture.requests, []);
      });
    } finally {
      await fixture.close();
    }
  });
});

// ── the live check ───────────────────────────────────────────────────────────

describe("eval validate --project", () => {
  test("names the case, pointer and tool of a missing deterministic reference", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        // A completed live check with an unresolved reference is a VERDICT on
        // the file — the command's ordinary "judged invalid" exit, not the
        // "no verdict was reached" exit an unreadable file gets.
        assert.equal(run.result.exitCode, 1, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.equal(envelope.valid, false);
        const live = envelope.projectValidation!;
        assert.equal(live.valid, false);
        assert.deepEqual(live.project, { id: "proj-alpha", name: "Alpha" });
        assert.equal(live.findings.length, 1);
        const [found] = live.findings;
        assert.equal(found.code, "TOOL_REFERENCE_UNRESOLVED");
        assert.equal(found.caseId, "c_missing");
        assert.equal(found.toolName, "render_gone");
        assert.equal(found.serverName, "billing");
        assert.equal(found.pointer, "cases[1].steps[0].toolName");
        // The two flags that decide what a RUN does with this case.
        assert.equal(found.disabled, true);
        assert.equal(found.imported, true);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a file whose references all resolve stays valid", async () => {
    const fixture = await startFixture({
      toolsByServer: { billing: ["render_refund", "render_gone"] },
    });
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.equal(envelope.projectValidation?.valid, true);
        assert.deepEqual(envelope.projectValidation?.findings, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("prompt mentions and assertion expectations are not deterministic references", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(MENTIONS_ONLY, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.deepEqual(envelope.projectValidation?.findings, []);
        // …and it never even looked: with nothing deterministic in the file
        // there is nothing to resolve, so a target listing here would be a
        // round trip bought for no question.
        assert.deepEqual(fixture.toolListings, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("resolves against the environment the file names, not the project's whole server set", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_legacy", name: "legacy" },
      ],
      // The tool EXISTS — on a server the environment does not include. A
      // union across the project's servers would call this resolved.
      toolsByServer: { billing: ["render_refund"], legacy: ["render_gone"] },
      environments: { prod: ["billing"] },
    });
    try {
      const scoped = IMPORTED_WITH_TOOL_CALLS.replace(
        "target:\n  servers:\n    - name: billing\n",
        "target:\n  servers:\n    - name: billing\n  environment: prod\n"
      );
      await withSuiteFile(scoped, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 1, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        assert.deepEqual(envelope.projectValidation?.targets, [
          "environment prod",
        ]);
        assert.equal(envelope.projectValidation?.findings.length, 1);
        assert.equal(
          envelope.projectValidation?.findings[0].toolName,
          "render_gone"
        );
        // The legacy server was never listed: it is not in the target.
        assert.deepEqual(fixture.toolListings, ["srv_billing"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a step scoped to a server outside the target is unresolved there", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_legacy", name: "legacy" },
      ],
      toolsByServer: { billing: ["render_refund"], legacy: ["render_refund"] },
    });
    try {
      const crossServer = IMPORTED_WITH_TOOL_CALLS.replace(
        "        serverName: billing\n        toolName: render_gone",
        "        serverName: legacy\n        toolName: render_refund"
      );
      await withSuiteFile(crossServer, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 1, run.stderr);
        const envelope = JSON.parse(run.stdout) as ValidateEnvelope;
        const [found] = envelope.projectValidation!.findings;
        // The tool name exists on `legacy` — but `legacy` is not in the file's
        // target, so the reference still cannot execute.
        assert.equal(found.code, "TOOL_REFERENCE_UNRESOLVED");
        assert.equal(found.serverName, "legacy");
        assert.match(String(found.message), /not part of/);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a reference must resolve in EVERY target, not in their union", async () => {
    const fixture = await startFixture({
      servers: [
        { id: "srv_billing", name: "billing" },
        { id: "srv_billing_eu", name: "billing" },
      ],
      // Both targets carry a server called `billing`; only one exposes the
      // tool. The union says "resolved"; per-target says "fails in eu".
      toolsByServer: { billing: ["render_refund"] },
      environments: { us: ["billing"], eu: [] },
    });
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(
            validateArgv(
              file,
              "--project",
              "Alpha",
              "--api-key",
              "sk_test",
              "--api-url",
              fixture.baseUrl
            ),
            { telemetry: telemetryDisabled }
          )
        );
        assert.equal(run.result.exitCode, 1, run.stderr);
      });
    } finally {
      await fixture.close();
    }
  });
});

// ── the mandatory pre-sync check on a run ────────────────────────────────────

describe("eval run --file validates before it writes", () => {
  test("an ENABLED unresolved imported case refuses before any write", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        // The assertion that matters: NOTHING was written. A refusal after the
        // suite sync would still exit non-zero while leaving the project with
        // a half-authored suite and the caller with a retry that duplicates.
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
        assert.deepEqual(fixture.runBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a DISABLED unresolved imported case is persisted with a rewritten claim", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const authored = (
          fixture.batchBodies[0] as {
            cases: Array<{ id: string; import?: Record<string, unknown> }>;
          }
        ).cases;
        const rewritten = authored.find((entry) => entry.id === "c_missing")!;
        assert.equal(rewritten.import?.status, "unresolved");
        // Lineage survives the rewrite: which source case this came from is a
        // fact about the import, not about the claim being made for it.
        assert.equal(rewritten.import?.sourceCaseKey, "upstream/refunds/gone");
        assert.match(String(rewritten.import?.note), /render_gone/);
        assert.match(
          String(rewritten.import?.note),
          /Previous claim: exact/
        );
        assert.ok(String(rewritten.import?.note).length <= 2000);
        // The resolvable case keeps the converter's own claim, untouched.
        const kept = authored.find((entry) => entry.id === "c_render")!;
        assert.equal(kept.import?.status, "exact");
        // …and only the enabled case is launched.
        const launched = fixture.runBodies[0] as { caseIds?: string[] };
        assert.deepEqual(launched.caseIds, ["row_c_render"]);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a native case never acquires import provenance from an unresolved reference", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(NATIVE_WITH_TOOL_CALLS, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        const authored = (
          fixture.batchBodies[0] as {
            cases: Array<{ id: string; import?: unknown }>;
          }
        ).cases;
        // Manufacturing a claim here would turn "somebody wrote this by hand"
        // into "something converted this", permanently, on the strength of a
        // tool that is missing today.
        for (const entry of authored) {
          assert.equal("import" in entry, false, entry.id);
        }
      });
    } finally {
      await fixture.close();
    }
  });

  test("a selected NATIVE unresolved case refuses before any write", async () => {
    const fixture = await startFixture();
    try {
      const enabled = NATIVE_WITH_TOOL_CALLS.replace(
        "    disabled: true\n",
        ""
      );
      await withSuiteFile(enabled, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.deepEqual(fixture.batchBodies, []);
      });
    } finally {
      await fixture.close();
    }
  });

  test("an enabled unresolved case NOT named by --case does not refuse the run", async () => {
    const fixture = await startFixture();
    try {
      const enabled = IMPORTED_ENABLED_MISSING;
      await withSuiteFile(enabled, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--case", "c_render"), {
            telemetry: telemetryDisabled,
          })
        );
        // Enabled but unselected: the launch never touches it, so refusing
        // would block a run over a case it was not going to execute. The
        // corrected claim is still persisted.
        assert.equal(run.result.exitCode, 0, run.stderr);
        const authored = (
          fixture.batchBodies[0] as {
            cases: Array<{ id: string; import?: Record<string, unknown> }>;
          }
        ).cases;
        assert.equal(
          authored.find((entry) => entry.id === "c_missing")?.import?.status,
          "unresolved"
        );
        assert.deepEqual(
          (fixture.runBodies[0] as { caseIds?: string[] }).caseIds,
          ["row_c_render"]
        );
      });
    } finally {
      await fixture.close();
    }
  });

  test("a prompt-only suite launches with no tool discovery at all", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(PROMPT_ONLY, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file), {
            telemetry: telemetryDisabled,
          })
        );
        assert.equal(run.result.exitCode, 0, run.stderr);
        // The check is mandatory, but a file with nothing deterministic in it
        // asks no question — so a native suite pays nothing for it.
        assert.deepEqual(fixture.toolListings, []);
        assert.equal(fixture.runBodies.length, 1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("refuses when the run's target set cannot be enumerated", async () => {
    const fixture = await startFixture();
    try {
      await withSuiteFile(IMPORTED_ENABLED_MISSING, async (file) => {
        const run = await captureProcessOutput(() =>
          main(runArgv(fixture.baseUrl, file, "--all-targets"), {
            telemetry: telemetryDisabled,
          })
        );
        // `--all-targets` fans out over the suite's attachments, which do not
        // exist yet at check time. Unknowable is not "fine": the file names
        // deterministic tools, and nothing here can say they resolve.
        assert.equal(run.result.exitCode, 2, run.stdout);
        assert.deepEqual(fixture.fromFileBodies, []);
        assert.match(run.stdout + run.stderr, /cannot be enumerated/);
      });
    } finally {
      await fixture.close();
    }
  });
});
