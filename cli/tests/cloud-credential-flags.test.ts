import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/index.js";
import { captureProcessOutput, runCli } from "./support/cli-run.js";

async function startMeFixture(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith("/me")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "user-1",
          email: "dev@example.com",
          name: "Dev",
          imageUrl: null,
          profilePictureUrl: null,
          plan: "pro",
          createdAt: null,
          updatedAt: null,
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "no route" }));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

test("cloud credential flags work after a descendant command", async () => {
  const fixture = await startMeFixture();
  try {
    const run = await runCli([
      "cloud",
      "whoami",
      "--api-key",
      "sk_test",
      "--api-url",
      fixture.baseUrl,
      "--format",
      "json",
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).email, "dev@example.com");
  } finally {
    await fixture.close();
  }
});

test("cloud credential flags work before a descendant command", async () => {
  const fixture = await startMeFixture();
  try {
    const run = await runCli([
      "cloud",
      "--api-key",
      "sk_test",
      "--api-url",
      fixture.baseUrl,
      "whoami",
      "--format",
      "json",
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).email, "dev@example.com");
  } finally {
    await fixture.close();
  }
});

test("credential flags remain invalid before cloud", async () => {
  const run = await runCli([
    "--api-key",
    "sk_test",
    "cloud",
    "whoami",
    "--format",
    "json",
  ]);
  assert.equal(run.exitCode, 2);
  const payload = JSON.parse(run.stderr);
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /unknown option '--api-key'/i);
});

test("local commands still reject cloud credential flags", async () => {
  const run = await runCli([
    "server",
    "probe",
    "--url",
    "http://127.0.0.1:9/mcp",
    "--api-key",
    "sk_test",
  ]);
  assert.equal(run.exitCode, 2);
  const payload = JSON.parse(run.stderr);
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /unknown option '--api-key'/i);
});

test("cloud login rejects --api-key instead of ignoring it", async () => {
  const run = await runCli(["cloud", "login", "--api-key", "sk_test"]);
  assert.equal(run.exitCode, 2);
  const payload = JSON.parse(run.stderr);
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /browser OAuth/);
});

test("hosted readiness still accepts leaf --api-key", async () => {
  const run = await runCli([
    "readiness",
    "start",
    "claude",
    "--server",
    "demo",
    "--api-key",
    "mcpjam_legacy",
    "--format",
    "json",
  ]);
  // Unknown option would be exit 2 with unknown option. A legacy key is a
  // usage error from credential resolution — proof the flag was accepted.
  assert.equal(run.exitCode, 2);
  const payload = JSON.parse(run.stderr);
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /Legacy mcpjam_ API keys/);
});

test("telemetry events never include raw cloud credential values", async () => {
  const fixture = await startMeFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-telemetry-"));
  const statePath = path.join(directory, "telemetry.json");
  const events: Array<{ properties: Record<string, unknown> }> = [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DO_NOT_TRACK",
    "MCPJAM_TELEMETRY_DISABLED",
    "MCPJAM_TELEMETRY_DEBUG",
    "CI",
    "GITHUB_ACTIONS",
  ]) {
    delete env[key];
  }

  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "cloud",
          "whoami",
          "--api-key",
          "sk_telemetry_secret",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ],
        {
          telemetry: {
            statePath,
            env,
            createClient: () => ({
              capture(event) {
                events.push(event);
              },
              async flush() {},
            }),
          },
        }
      )
    );

    assert.equal(run.result.exitCode, 0, run.stderr);
    assert.ok(events.length >= 1, "expected a telemetry event");
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("sk_telemetry_secret"), false);
    assert.equal(serialized.includes(fixture.baseUrl), false);
  } finally {
    await fixture.close();
  }
});
