/**
 * What the CLI declares itself as on an eval-run launch.
 *
 * The platform stamps `source` itself, and everything the CLI sends over the
 * public API is `api` — so a developer's `mcpjam cloud eval run` and the same
 * command inside a GitHub Actions job were one indistinguishable badge in the
 * Runs table. These headers are the difference, DECLARED: a display label
 * beside the stamp, never an authorization input, and never something a flag
 * can forge.
 *
 * `detectLauncherKind` reads the same `GITHUB_ACTIONS` variable that
 * `report-conformance-run`'s `detectSource` does, deliberately: a composite run
 * and an eval run from one job must not disagree about where they came from.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RUN_LAUNCH_HEADERS } from "@mcpjam/sdk/platform";
import { CliError } from "../src/lib/output.js";
import {
  buildPlatformClient,
  resolvePlatformExtraHeaders,
} from "../src/lib/platform-client.js";

const GITHUB_ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_SHA: "a1b2c3d4",
  GITHUB_REF_NAME: "main",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "evals",
  GITHUB_WORKFLOW: "CI",
} as const;

/** Capture the headers of the one request a launch makes. */
function captureHeaders(sink: Array<Record<string, string>>): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    sink.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    return new Response(JSON.stringify({ runId: "run_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function launchWith(
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const sink: Array<Record<string, string>> = [];
  const { client } = buildPlatformClient(
    { apiKey: "sk_test", apiUrl: "https://api.test/api/v1" },
    { env, fetchFn: captureHeaders(sink) },
  );
  await client.createEvalRun({ projectId: "p1", body: { suiteId: "s1" } });
  return sink[0]!;
}

test("declares `cli` outside CI", async () => {
  const headers = await launchWith({});
  const launcher = JSON.parse(headers[RUN_LAUNCH_HEADERS.launcher]!);
  assert.equal(launcher.kind, "cli");
  assert.equal(launcher.client, "mcpjam-cli");
  assert.ok(
    typeof launcher.version === "string" && launcher.version.length > 0,
    "the CLI's own version identifies which release produced the run",
  );
  // Nothing to say about a job that does not exist.
  assert.equal(headers[RUN_LAUNCH_HEADERS.ci], undefined);
});

test("declares `github_action` and the job inside GitHub Actions", async () => {
  const headers = await launchWith({ ...GITHUB_ENV });
  assert.equal(
    JSON.parse(headers[RUN_LAUNCH_HEADERS.launcher]!).kind,
    "github_action",
  );
  const ci = JSON.parse(headers[RUN_LAUNCH_HEADERS.ci]!);
  assert.equal(ci.provider, "github_actions");
  assert.equal(ci.commitSha, "a1b2c3d4");
  assert.equal(ci.branch, "main");
  // `runId` and `job` are GitHub's spellings; the platform maps them onto the
  // run row's `pipelineId`/`jobId` at its own boundary, in one place.
  assert.equal(ci.runId, "42.1");
  assert.equal(ci.job, "evals");
});

test("declares nothing on a call that starts no run", async () => {
  const sink: Array<Record<string, string>> = [];
  const { client } = buildPlatformClient(
    { apiKey: "sk_test", apiUrl: "https://api.test/api/v1" },
    { env: { ...GITHUB_ENV }, fetchFn: captureHeaders(sink) },
  );
  await client.getMe();
  assert.equal(sink[0]![RUN_LAUNCH_HEADERS.launcher], undefined);
  assert.equal(sink[0]![RUN_LAUNCH_HEADERS.ci], undefined);
});

test("`--api-header` cannot forge either declaration", () => {
  // A badge settable from a flag is a badge worth nothing. This is the same
  // rule that keeps `--api-header` away from `authorization`.
  for (const name of [RUN_LAUNCH_HEADERS.launcher, RUN_LAUNCH_HEADERS.ci]) {
    assert.throws(
      () =>
        resolvePlatformExtraHeaders(
          { apiHeader: [`${name}: {"kind":"github_action"}`] },
          {},
        ),
      (error: unknown) =>
        error instanceof CliError &&
        String(error.message).includes(name) &&
        /cannot set/.test(String(error.message)),
      `accepted a forged ${name}`,
    );
  }
});
