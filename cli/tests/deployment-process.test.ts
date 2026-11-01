/**
 * Which MCPJam server the CLI and SDK talk to, proved on the real processes:
 * the built CLI and an SDK child script run under the network guard, which
 * refuses and records every destination except the loopback fixtures below.
 *
 * Server A is the one each scenario chooses; server B is another server, which
 * must never receive anything. Telemetry and the update check are opted out
 * here so an empty guard log means "nothing but A and B"; the positive
 * controls at the end show the guard sees that traffic when it is on.
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
  runGuarded,
  startRecorder,
  waitForAttempts,
  writeSavedLogin,
  type Recorder,
  type Sandbox,
} from "./support/deployment-fixtures.js";

const SDK_SCENARIO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/sdk-scenario.mjs",
);
const QUIET = { MCPJAM_TELEMETRY_DISABLED: "1", MCPJAM_NO_UPDATE_CHECK: "1" };
const ME = { id: "user_a", email: "dev@a.example.test", name: "Dev" };

let A: Recorder;
let B: Recorder;
let mcpTarget: Recorder;
let sandbox: Sandbox;

before(async () => {
  B = await startRecorder();
  A = await startRecorder({
    "GET /api/v1/me": (_request, response) => json(response, 200, ME),
    "GET /moved/*": (_request, response) => {
      response.writeHead(307, { location: `${B.url}/api/v1/me` });
      response.end();
    },
    "GET /api/cli/auth/config": (_request, response) =>
      json(response, 200, {
        issuer: `${A.url}/issuer`,
        clientId: "client_a",
        authStartUrl: `${A.url}/authorize`,
        tokenEndpoint: `${A.url}/oauth/token`,
        redirectUri: `${A.url}/cli/callback`,
      }),
    "POST /oauth/token": (_request, response) =>
      json(response, 200, {
        access_token: "login-token-a",
        refresh_token: "refresh-a",
        expires_in: 3600,
      }),
    "POST /api/v1/projects/default/conformance-ingest/*": (request, response) =>
      json(response, 200, {
        runId: "run_a",
        ...(request.path.endsWith("/finalize") ? { outcome: "failed" } : {}),
      }),
    "POST /api/v1/projects/default/eval-ingest/report": (_request, response) =>
      json(response, 200, {
        suiteId: "suite_a",
        runId: "eval_run_a",
        status: "completed",
        result: "passed",
        summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
      }),
  });
  // An MCP "server" that refuses everything: conformance fails fast, and the
  // upload that follows is what these tests watch.
  mcpTarget = await startRecorder();
});

after(async () => {
  await Promise.all([A.close(), B.close(), mcpTarget.close()]);
});

async function scenario<T>(run: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  A.requests.length = 0;
  B.requests.length = 0;
  sandbox = await createSandbox();
  try {
    return await run(sandbox);
  } finally {
    await sandbox.remove();
  }
}

function cli(args: string[], env: Record<string, string> = {}) {
  return runGuarded(CLI_ENTRY, args, {
    sandbox,
    allow: [A.port, B.port, mcpTarget.port],
    env: { ...QUIET, ...env },
  });
}

const apiA = () => `${A.url}/api/v1`;

/** The SDK prints its own "View run" line first; the outcome is the last. */
function outcomeOf(stdout: string): { ok: boolean; code?: string; runId?: string | null } {
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
}

test("--api-url A with a key: A gets the key, nothing else is contacted", () =>
  scenario(async () => {
    const run = await cli([
      "cloud", "whoami", "--api-url", apiA(), "--api-key", "sk_a", "--format", "json",
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual(
      A.requests.map((request) => [request.path, request.headers.authorization]),
      [["/api/v1/me", "Bearer sk_a"]],
    );
    assert.deepEqual(B.requests, []);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("MCPJAM_API_URL and MCPJAM_BASE_URL naming two servers: exit 2, nothing contacted", () =>
  scenario(async () => {
    const run = await cli(["cloud", "whoami", "--api-key", "sk_a"], {
      MCPJAM_API_URL: apiA(),
      MCPJAM_BASE_URL: B.url,
    });
    assert.equal(run.exitCode, 2, run.stderr);
    assert.equal(errorCode(run), "DEPLOYMENT_CONFLICT");
    assert.deepEqual([A.requests, B.requests], [[], []]);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("a saved login for B and --api-url A: exit 3, nothing contacted", () =>
  scenario(async () => {
    await writeSavedLogin(sandbox, `${B.url}/api/v1`);
    const run = await cli(["cloud", "whoami", "--api-url", apiA()]);
    assert.equal(run.exitCode, 3, run.stderr);
    assert.equal(errorCode(run), "LOGIN_DEPLOYMENT_MISMATCH");
    assert.match(run.stderr, new RegExp(`mcpjam cloud login --api-url ${apiA()}`));
    assert.deepEqual([A.requests, B.requests], [[], []]);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("a saved login for B with MCPJAM_API_KEY and --api-url A: only the key, only to A", () =>
  scenario(async () => {
    await writeSavedLogin(sandbox, `${B.url}/api/v1`, "token-for-b");
    const run = await cli(["cloud", "whoami", "--api-url", apiA()], {
      MCPJAM_API_KEY: "sk_a",
    });
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual(
      A.requests.map((request) => request.headers.authorization),
      ["Bearer sk_a"],
    );
    assert.deepEqual(B.requests, []);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("cloud login --api-url A replaces a saved login for B; the sign-in provider gets no edge header", () =>
  scenario(async () => {
    await writeSavedLogin(sandbox, `${B.url}/api/v1`);
    let callback: Promise<Response> | undefined;
    const run = await runGuarded(
      CLI_ENTRY,
      [
        "cloud", "login", "--api-url", apiA(), "--api-header", "x-edge-key: edge-secret",
        "--no-browser", "--format", "json",
      ],
      {
        sandbox,
        allow: [A.port, B.port],
        env: QUIET,
        // Plays the browser: the login page would send it back with a code.
        onStderr: (stderr) => {
          const printed = /Open this URL in your browser to continue:\s+(\S+)/.exec(stderr);
          if (!printed || callback) return;
          const authorize = new URL(printed[1]);
          const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
          redirect.searchParams.set("code", "code_a");
          redirect.searchParams.set("state", authorize.searchParams.get("state") ?? "");
          callback = fetch(redirect);
        },
      },
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(callback, "the CLI printed a login URL");
    await callback;

    const saved = JSON.parse(await readFile(sandbox.authFile, "utf8"));
    assert.equal(saved.apiUrl, apiA());
    assert.equal(saved.accessToken, "login-token-a");
    const edgeHeaderOn = Object.fromEntries(
      A.requests.map((request) => [request.path, request.headers["x-edge-key"] ?? null]),
    );
    assert.deepEqual(edgeHeaderOn, {
      "/api/cli/auth/config": "edge-secret",
      "/oauth/token": null,
      "/api/v1/me": "edge-secret",
    });
    assert.deepEqual(B.requests, []);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

const OFFLINE_SUITE = `schemaVersion: "1"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_offline
  name: Offline
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  repetitions: 1
  passThreshold: 0.8
  validity: {}
cases:
  - id: c_one
    title: One case
    steps:
      - id: step-1
        kind: prompt
        prompt: Say hello.
`;

test("offline cloud subcommands run through a deployment refusal; --project does not", () =>
  scenario(async () => {
    const conflict = { MCPJAM_API_URL: apiA(), MCPJAM_BASE_URL: B.url };
    const file = path.join(sandbox.home, "suite.yaml");
    await writeFile(file, OFFLINE_SUITE);
    const offline = await cli(["cloud", "eval", "validate", "--file", file], conflict);
    assert.equal(offline.exitCode, 0, offline.stderr);
    const live = await cli(
      ["cloud", "eval", "validate", "--file", file, "--project", "p"],
      conflict,
    );
    assert.equal(live.exitCode, 2, live.stderr);
    assert.equal(errorCode(live), "DEPLOYMENT_CONFLICT");

    await writeSavedLogin(sandbox, `${B.url}/api/v1`);
    await mkdir(path.join(sandbox.home, ".mcpjam"), { recursive: true });
    await writeFile(path.join(sandbox.home, ".mcpjam", "project.json"), "{}");
    const remove = await cli(["cloud", "link", "--remove", "--here"], {
      MCPJAM_API_URL: apiA(),
    });
    assert.equal(remove.exitCode, 0, remove.stderr);
    assert.deepEqual([A.requests, B.requests], [[], []]);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("a redirect from A is refused with exit 2; B gets nothing", () =>
  scenario(async () => {
    const run = await cli([
      "cloud", "whoami", "--api-url", `${A.url}/moved/api/v1`, "--api-key", "sk_a",
    ]);
    assert.equal(run.exitCode, 2, run.stderr);
    assert.equal(errorCode(run), "BACKEND_REDIRECT_REFUSED");
    assert.equal(A.requests.length, 1);
    assert.deepEqual(B.requests, []);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("conformance run uploads to MCPJAM_API_URL only, with the key and edge headers", () =>
  scenario(async () => {
    const run = await cli(
      ["conformance", "run", "--url", `${mcpTarget.url}/mcp`, "--suite", "protocol", "--format", "json"],
      {
        MCPJAM_API_URL: apiA(),
        MCPJAM_API_KEY: "sk_a",
        MCPJAM_API_HEADERS: "x-edge-key: edge-secret",
      },
    );
    const uploads = A.requests.filter((request) =>
      request.path.includes("/conformance-ingest/"),
    );
    assert.ok(uploads.length >= 2, run.stderr);
    assert.ok(uploads.at(0)?.path.endsWith("/runs/start"));
    assert.ok(uploads.at(-1)?.path.endsWith("/runs/finalize"));
    for (const upload of uploads) {
      assert.equal(upload.headers.authorization, "Bearer sk_a");
      assert.equal(upload.headers["x-edge-key"], "edge-secret");
    }
    assert.doesNotMatch(run.stderr, /conformance upload failed/);
    assert.deepEqual(B.requests, []);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("SDK reportEvalResults reaches A; conflicting variables throw instead of warning", () =>
  scenario(async () => {
    const sdk = (env: Record<string, string>) =>
      runGuarded(SDK_SCENARIO, ["report"], {
        sandbox,
        allow: [A.port, B.port],
        env: { ...QUIET, ...env },
      });

    const reported = await sdk({ MCPJAM_API_URL: apiA() });
    assert.deepEqual(outcomeOf(reported.stdout), { ok: true, runId: "eval_run_a" });
    assert.deepEqual(
      A.requests.map((request) => [request.path, request.headers.authorization]),
      [["/api/v1/projects/default/eval-ingest/report", "Bearer sk_fixture"]],
    );

    A.requests.length = 0;
    const refused = await sdk({ MCPJAM_API_URL: apiA(), MCPJAM_BASE_URL: B.url });
    assert.equal(outcomeOf(refused.stdout).code, "DEPLOYMENT_CONFLICT");
    assert.doesNotMatch(refused.stderr, /eval reporting failed/);
    assert.deepEqual([A.requests, B.requests], [[], []]);
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test("positive control: with telemetry on and nothing configured, the guard sees MCPJam Cloud, PostHog and npm", () =>
  scenario(async () => {
    const [cloud, offline] = await Promise.all([
      runGuarded(CLI_ENTRY, ["cloud", "whoami", "--api-key", "sk_a"], {
        sandbox,
        allow: [],
      }),
      runGuarded(CLI_ENTRY, ["cloud", "status"], { sandbox, allow: [] }),
    ]);
    assert.notEqual(cloud.exitCode, 0);
    assert.equal(offline.exitCode, 0, offline.stderr);
    const hosts = (attempts: { host?: string }[]) =>
      new Set(attempts.map((attempt) => attempt.host));
    const attempts = await waitForAttempts(sandbox, (seen) =>
      ["app.mcpjam.com", "us.i.posthog.com", "registry.npmjs.org"].every((host) =>
        hosts(seen).has(host),
      ),
    );
    for (const host of ["app.mcpjam.com", "us.i.posthog.com", "registry.npmjs.org"]) {
      assert.ok(hosts(attempts).has(host), `expected an attempt to ${host}`);
    }
  }));
