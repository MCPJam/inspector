/**
 * The IT settings file and its lock, proved on the real processes: the built
 * CLI and SDK child scripts under the network guard, with the settings file
 * placed through the guard's test seam.
 *
 * Server A is the server the file names; server B is another MCPJam server
 * and T an MCP server under test. Neither B nor T may receive anything a
 * refusal stopped, and the guard log must stay empty: no MCPJam Cloud, no
 * PostHog, no Sentry, no npm.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  blockedAttempts,
  CLI_ENTRY,
  createSandbox,
  errorCode,
  json,
  readAttempts,
  runGuarded,
  startRecorder,
  waitForAttempts,
  writeSavedLogin,
  type Recorder,
  type Sandbox,
} from "./support/deployment-fixtures.js";
import { fakeMcpjamRoutes } from "./support/fake-mcpjam.js";
import { startAnthropicStub } from "./support/local-test-smoke.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK_SCENARIO = path.join(here, "fixtures/sdk-scenario.mjs");
const NOTES_SERVER = path.join(here, "fixtures/policy-target-server.mjs");
const QUIET = { MCPJAM_TELEMETRY_DISABLED: "1", MCPJAM_NO_UPDATE_CHECK: "1" };

let A: Recorder;
let B: Recorder;
let T: Recorder;
let anthropic: Awaited<ReturnType<typeof startAnthropicStub>>;
const anthropicPort = () => Number(new URL(anthropic.baseUrl).port);
let sandbox: Sandbox;
/** Answer the next requests to a path with a 500, this many times. */
const failures = new Map<string, number>();
/** More failures than the SDK's reporting transport retries. */
const PERSISTENT = 10;
const DEPLOYMENT_REFUSALS = [
  "DEPLOYMENT_LOCKED",
  "DEPLOYMENT_CONFLICT",
  "MANAGED_SETTINGS_INVALID",
  "LOGIN_DEPLOYMENT_MISMATCH",
  "BACKEND_REDIRECT_REFUSED",
];

before(async () => {
  const routesFor = (origin: () => string) => {
    const routes = fakeMcpjamRoutes(origin);
    return Object.fromEntries(
      Object.entries(routes).map(([key, route]) => [
        key,
        ((request, response) => {
          const pathname = new URL(request.path, "http://fixture").pathname;
          const remaining = failures.get(pathname) ?? 0;
          if (remaining > 0) {
            failures.set(pathname, remaining - 1);
            return json(response, 500, { code: "INTERNAL_ERROR", message: "Fixture failure" });
          }
          return route(request, response);
        }) satisfies (typeof routes)[string],
      ]),
    );
  };
  A = await startRecorder(routesFor(() => A.url));
  B = await startRecorder(routesFor(() => B.url));
  T = await startRecorder();
  anthropic = await startAnthropicStub();
});

after(async () => {
  await Promise.all([A.close(), B.close(), T.close(), anthropic.close()]);
});

/** The IT file's JSON, or raw text for a file that does not parse. */
type Settings = Record<string, unknown> | string;

async function scenario<R>(settings: Settings | null, run: () => Promise<R>): Promise<R> {
  for (const server of [A, B, T]) server.requests.length = 0;
  failures.clear();
  sandbox = await createSandbox();
  try {
    if (settings !== null) {
      await writeFile(
        path.join(sandbox.home, "managed-settings.json"),
        typeof settings === "string" ? settings : JSON.stringify(settings),
      );
    }
    return await run();
  } finally {
    await sandbox.remove();
  }
}

const apiA = () => `${A.url}/api/v1`;
const apiB = () => `${B.url}/api/v1`;
const locked = () => ({ version: 1, apiUrl: apiA(), lock: true });

function settingsEnv(): Record<string, string> {
  return { MCPJAM_TEST_MANAGED_SETTINGS: path.join(sandbox.home, "managed-settings.json") };
}

function cli(args: string[], env: Record<string, string> = QUIET) {
  return runGuarded(CLI_ENTRY, args, {
    sandbox,
    allow: [A.port, B.port, T.port, anthropicPort()],
    env: { ...settingsEnv(), ...env },
  });
}

async function sdk(mode: string, options: unknown = {}, env: Record<string, string> = QUIET) {
  const run = await runGuarded(SDK_SCENARIO, [mode, JSON.stringify(options)], {
    sandbox,
    allow: [A.port, B.port],
    env: { ...settingsEnv(), ...env },
  });
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
    ok: boolean;
    code?: string;
  };
}

const paths = (server: Recorder) => server.requests.map((request) => request.path);

async function assertNothingElse(): Promise<void> {
  assert.deepEqual(paths(B), [], "server B received a request");
  assert.deepEqual(await blockedAttempts(sandbox), [], "something outside the fixtures was contacted");
}

test("locked to A: a flag, variable, --catalog-url or auto-upload naming B exits 2 before any request", () =>
  scenario(locked(), async () => {
    const runs = [
      await cli(["cloud", "whoami", "--api-url", apiB(), "--api-key", "sk_a"]),
      await cli(["cloud", "whoami", "--api-key", "sk_a"], { ...QUIET, MCPJAM_API_URL: apiB() }),
      await cli(["compat", "--url", `${T.url}/mcp`, "--catalog-url", apiB()]),
      await cli(["conformance", "run", "--url", `${T.url}/mcp`, "--suite", "protocol"], {
        ...QUIET,
        MCPJAM_API_KEY: "sk_a",
        MCPJAM_BASE_URL: B.url,
      }),
    ];
    for (const run of runs) {
      assert.equal(run.exitCode, 2, run.stderr);
      assert.equal(errorCode(run), "DEPLOYMENT_LOCKED");
    }
    assert.match(runs[2].stderr, /--catalog-url names/);
    assert.deepEqual([paths(A), paths(T)], [[], []]);
    await assertNothingElse();
  }));

test("locked to A: an SDK baseUrl option for B throws before any request", () =>
  scenario(locked(), async () => {
    const outcome = await sdk("report", { input: { baseUrl: B.url } });
    assert.deepEqual(outcome.code, "DEPLOYMENT_LOCKED");
    assert.deepEqual(paths(A), []);
    await assertNothingElse();
  }));

test("locked to A with a saved login for B: a request exits 3, a key and cloud login reach A, logout contacts nothing", () =>
  scenario(locked(), async () => {
    await writeSavedLogin(sandbox, apiB(), "token-for-b");
    const mismatch = await cli(["cloud", "whoami"]);
    assert.equal(mismatch.exitCode, 3, mismatch.stderr);
    assert.equal(errorCode(mismatch), "LOGIN_DEPLOYMENT_MISMATCH");
    assert.deepEqual(paths(A), []);

    const keyed = await cli(["cloud", "whoami", "--api-key", "sk_a"]);
    assert.equal(keyed.exitCode, 0, keyed.stderr);
    assert.deepEqual(A.requests.map((request) => request.headers.authorization), ["Bearer sk_a"]);

    let callback: Promise<Response> | undefined;
    const login = await runGuarded(CLI_ENTRY, ["cloud", "login", "--no-browser"], {
      sandbox,
      allow: [A.port, B.port],
      env: { ...settingsEnv(), ...QUIET },
      onStderr: (stderr) => {
        const printed = /Open this URL in your browser to continue:\s+(\S+)/.exec(stderr);
        if (!printed || callback) return;
        const authorize = new URL(printed[1]);
        const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "code_a");
        redirect.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        callback = fetch(redirect);
      },
    });
    assert.equal(login.exitCode, 0, login.stderr);
    await callback;
    assert.equal(JSON.parse(await readFile(sandbox.authFile, "utf8")).apiUrl, apiA());

    A.requests.length = 0;
    const logout = await cli(["cloud", "logout"]);
    assert.equal(logout.exitCode, 0, logout.stderr);
    assert.deepEqual(paths(A), []);
    await assertNothingElse();
  }));

test("locked to A with telemetry on: no telemetry, Sentry, update check or spawn, on success or on a 500", () =>
  scenario(locked(), async () => {
    failures.set("/api/v1/me", 1);
    const failed = await cli(["cloud", "whoami", "--api-key", "sk_a"], {});
    assert.equal(failed.exitCode, 1, failed.stderr);
    const succeeded = await cli(["cloud", "whoami", "--api-key", "sk_a"], {});
    assert.equal(succeeded.exitCode, 0, succeeded.stderr);
    assert.deepEqual(await readAttempts(sandbox), [], "the CLI spawned or contacted something");

    // A report that keeps failing reaches Sentry when nothing is locked (the
    // positive control below); under the lock it must not.
    failures.set("/api/v1/projects/default/eval-ingest/report", PERSISTENT);
    const report = await sdk("report", {}, {});
    assert.deepEqual(report, { ok: true, runId: null });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await assertNothingElse();
  }));

test("an invalid IT file stops commands that contact MCPJam; a local command still runs; nothing reaches MCPJam or telemetry", async () => {
  for (const settings of [
    "{ not json",
    { version: 1, apiUrl: `http://127.0.0.1:1/api/v1` },
  ]) {
    await scenario(settings, async () => {
      const refused = await cli(["cloud", "whoami", "--api-key", "sk_a"], {});
      assert.equal(refused.exitCode, 2, refused.stderr);
      assert.equal(errorCode(refused), "MANAGED_SETTINGS_INVALID");
      assert.match(refused.stderr, /managed-settings\.json/);

      const local = await cli(
        ["conformance", "run", "--url", `${T.url}/mcp`, "--suite", "protocol"],
        {},
      );
      assert.ok(!DEPLOYMENT_REFUSALS.includes(errorCode(local) ?? ""), local.stderr);
      assert.ok(T.requests.length > 0, "the local conformance check ran");
      const status = await cli(["telemetry", "status", "--format", "json"], {});
      assert.equal(JSON.parse(status.stdout).telemetry.disableReason, "managed-settings");
      assert.deepEqual(paths(A), []);
      assert.deepEqual(await readAttempts(sandbox), [], "something was spawned or contacted");
    });
  }
});

test("an unlocked IT file is the organization default, and --api-url still overrides it", () =>
  scenario({ version: 1, apiUrl: apiA(), lock: false }, async () => {
    const byDefault = await cli(["cloud", "whoami", "--api-key", "sk_a"]);
    assert.equal(byDefault.exitCode, 0, byDefault.stderr);
    assert.deepEqual(paths(A), ["/api/v1/me"]);
    const overridden = await cli(["cloud", "whoami", "--api-key", "sk_a", "--api-url", apiB()]);
    assert.equal(overridden.exitCode, 0, overridden.stderr);
    assert.deepEqual(paths(B), ["/api/v1/me"]);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("every CLI caller under the lock reaches only A", () =>
  scenario(locked(), async () => {
    // Every route A has no fixture for answers 404, so the run fails; what
    // matters is where each of its requests went.
    const evalRun = await cli(["cloud", "eval", "run", "--suite", "suite_a", "--wait", "--api-key", "sk_a"]);
    assert.ok(!DEPLOYMENT_REFUSALS.includes(errorCode(evalRun) ?? ""), evalRun.stderr);
    assert.ok(paths(A).length > 0, "cloud eval run reached A");

    const workDir = path.join(sandbox.home, "work");
    await mkdir(path.join(workDir, ".mcpjam", "evals"), { recursive: true });
    await writeFile(
      path.join(workDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [NOTES_SERVER] } } }),
    );
    await writeFile(
      path.join(workDir, ".mcpjam", "evals", "notes.yaml"),
      [
        'schemaVersion: "2"', "mode: agentWorkflow", "reportingMode: standard",
        "suite:", "  id: s_lock", "  name: lock", "target:", "  servers:", "    - name: notes",
        "defaults:", "  judge:", "    enabled: false", "  model: anthropic/claude-haiku-4.5",
        "  iterations: 1", "  passThreshold: 1", "  validity: {}", "cases:", "  - id: c_reads",
        "    title: reads the note", "    steps:", "      - id: s1", "        kind: prompt",
        "        prompt: Read note 7", "      - id: a1", "        kind: assert", "        assertion:",
        "          type: toolCalledAtLeastOnce", "          toolName: read_note", "",
      ].join("\n"),
    );
    const localTest = await runGuarded(
      CLI_ENTRY,
      ["--format", "json", "test", ".mcpjam/evals/notes.yaml"],
      {
        sandbox,
        allow: [A.port, B.port, anthropicPort()],
        env: {
          ...settingsEnv(),
          ...QUIET,
          MCPJAM_API_KEY: "sk_a",
          ANTHROPIC_API_KEY: "sk-ant-fixture",
          ANTHROPIC_BASE_URL: anthropic.baseUrl,
        },
        cwd: workDir,
      },
    );
    assert.equal(localTest.exitCode, 0, localTest.stderr);
    assert.ok(paths(A).some((p) => p.endsWith("/eval-ingest/start-run")), "mcpjam test started its run on A");

    const conformance = await cli(["conformance", "run", "--url", `${T.url}/mcp`, "--suite", "protocol"], {
      ...QUIET,
      MCPJAM_API_KEY: "sk_a",
    });
    assert.ok(!DEPLOYMENT_REFUSALS.includes(errorCode(conformance) ?? ""), conformance.stderr);
    assert.ok(paths(A).some((p) => p.endsWith("/conformance-ingest/runs/finalize")));

    const compat = await cli(["compat", "--url", `${T.url}/mcp`]);
    assert.ok(!DEPLOYMENT_REFUSALS.includes(errorCode(compat) ?? ""), compat.stderr);
    assert.ok(paths(A).includes("/api/v1/host-catalog"));

    const browser = await cli(["browser", "sessions", "--cloud", "--project", "project_a", "--api-key", "sk_a"]);
    assert.equal(browser.exitCode, 0, browser.stderr);
    assert.ok(paths(A).includes("/api/v1/browser-sessions/sessions"));
    await assertNothingElse();
  }));

test("every SDK Node entry point under the lock reaches only A", () =>
  scenario(locked(), async () => {
    for (const mode of ["lease", "suite", "saved-client", "artifact"]) {
      const outcome = await sdk(mode);
      assert.equal(outcome.ok, true, `${mode}: ${JSON.stringify(outcome)}`);
    }
    assert.ok(paths(A).filter((p) => p.endsWith("/model-leases")).length >= 3, "three scenarios minted on A");
    await assertNothingElse();
  }));

test("an SDK eval run's model lease is minted on the server the run started on", () =>
  scenario(null, async () => {
    const outcome = await sdk("suite", { mcpjam: { baseUrl: A.url } });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.ok(paths(A).some((p) => p.endsWith("/eval-ingest/start-run")));
    assert.ok(paths(A).some((p) => p.endsWith("/model-leases")), "the lease was minted on A");
    await assertNothingElse();
  }));

test("positive controls: the guard sees Sentry when nothing is locked; cloud status prints the locked server", async () => {
  await scenario(null, async () => {
    failures.set("/api/v1/projects/default/eval-ingest/report", PERSISTENT);
    const report = await sdk("report", { input: { baseUrl: A.url } }, {});
    assert.deepEqual(report, { ok: true, runId: null });
    const attempts = await waitForAttempts(sandbox, (seen) =>
      seen.some((attempt) => attempt.host?.endsWith(".sentry.io")),
    );
    assert.ok(attempts.some((attempt) => attempt.host?.endsWith(".sentry.io")), JSON.stringify(attempts));
  });
  await scenario(locked(), async () => {
    const status = await cli(["cloud", "status", "--format", "json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).deployment, {
      apiUrl: apiA(),
      source: "managed",
      description: "set by your organization (locked)",
      valid: true,
    });
  });
});
