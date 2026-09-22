/**
 * Cloud audience line and credential preflight.
 *
 * Machine-readable results stay on stdout. Who/where context goes to stderr
 * and is omitted under `--quiet`. Missing credentials fail with the login
 * guidance before a network call.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MISSING_CLOUD_CREDENTIAL_MESSAGE } from "../src/lib/cloud-context.js";
import { runCli } from "./support/cli-run.js";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

async function startEvalListFixture(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
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
        })
      );
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/eval-suites") {
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (url.pathname.endsWith("/me")) {
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
    res.end(JSON.stringify({ code: "NOT_FOUND", message: url.pathname }));
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

function isolatedEnv(
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    MCPJAM_PROJECT: undefined,
    MCPJAM_PROJECT_ID: undefined,
    MCPJAM_API_KEY: undefined,
    MCPJAM_API_URL: undefined,
    MCPJAM_AUTH_FILE: path.join(tmpdir(), "mcpjam-no-auth.json"),
    ...extra,
  };
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withCwd<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

test("cloud eval list writes the audience line to stderr and keeps stdout JSON", async () => {
  const fixture = await startEvalListFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-audience-"));
  try {
    const run = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () =>
        runCli([
          "cloud",
          "eval",
          "list",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ])
      )
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.ok(Array.isArray(payload.items));
    assert.match(
      run.stderr,
      /Using MCPJam Cloud as sk_… · project: automatic \(most recently updated\) · /
    );
    assert.match(run.stderr, new RegExp(fixture.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(run.stdout, /Using MCPJam Cloud/);
  } finally {
    await fixture.close();
  }
});

test("cloud eval list --quiet suppresses the audience line", async () => {
  const fixture = await startEvalListFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-audience-quiet-"));
  try {
    const run = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () =>
        runCli([
          "--quiet",
          "cloud",
          "eval",
          "list",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ])
      )
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /Using MCPJam Cloud/);
    JSON.parse(run.stdout);
  } finally {
    await fixture.close();
  }
});

test("missing Cloud credentials fail with the login string before a network call", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-audience-missing-"));
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () =>
      runCli([
        "cloud",
        "eval",
        "list",
        "--api-url",
        "http://127.0.0.1:1/api/v1",
        "--format",
        "json",
      ])
    )
  );
  assert.equal(run.exitCode, 1, run.stderr);
  const payload = JSON.parse(run.stderr) as { error: { message: string } };
  assert.equal(payload.error.message, MISSING_CLOUD_CREDENTIAL_MESSAGE);
  assert.doesNotMatch(run.stderr, /Using MCPJam Cloud/);
  assert.doesNotMatch(run.stderr, /ECONNREFUSED|fetch failed|timed out/i);
});

test("missing Cloud credentials name a leftover legacy MCPJAM_API_KEY", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-audience-legacy-"));
  const run = await withEnv(isolatedEnv({ MCPJAM_API_KEY: "mcpjam_legacy" }), () =>
    withCwd(cwd, () =>
      runCli([
        "cloud",
        "eval",
        "list",
        "--api-url",
        "http://127.0.0.1:1/api/v1",
        "--format",
        "json",
      ])
    )
  );
  assert.equal(run.exitCode, 1, run.stderr);
  const payload = JSON.parse(run.stderr) as { error: { message: string } };
  assert.ok(payload.error.message.includes(MISSING_CLOUD_CREDENTIAL_MESSAGE));
  assert.match(payload.error.message, /Ignoring legacy mcpjam_ key in MCPJAM_API_KEY/);
  assert.match(payload.error.message, /Legacy mcpjam_ API keys/);
  assert.doesNotMatch(run.stderr, /ECONNREFUSED|fetch failed|timed out/i);
});

test("cloud whoami does not print the audience line", async () => {
  const fixture = await startEvalListFixture();
  try {
    const run = await withEnv(isolatedEnv(), () =>
      runCli([
        "cloud",
        "whoami",
        "--api-key",
        "sk_test",
        "--api-url",
        fixture.baseUrl,
        "--format",
        "json",
      ])
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).email, "dev@example.com");
    assert.doesNotMatch(run.stderr, /Using MCPJam Cloud/);
  } finally {
    await fixture.close();
  }
});

test("hosted readiness does not print a Cloud audience line", async () => {
  const fixture = await startEvalListFixture();
  try {
    const run = await withEnv(isolatedEnv(), () =>
      runCli([
        "readiness",
        "list",
        "--api-key",
        "sk_test",
        "--api-url",
        fixture.baseUrl,
        "--format",
        "json",
      ])
    );
    assert.notEqual(run.exitCode, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /Using MCPJam Cloud/);
  } finally {
    await fixture.close();
  }
});

test("announce: false is only used at the allowlisted Cloud call sites", () => {
  const allowlist = [
    "commands/auth.ts",
    "commands/cloud-link.ts",
    "commands/projects.ts",
    "commands/environments.ts",
  ];
  const hits: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts")) continue;
      const text = readFileSync(full, "utf8");
      if (!/announce:\s*false/.test(text)) continue;
      hits.push(path.relative(SRC_ROOT, full));
    }
  };
  walk(SRC_ROOT);
  for (const file of hits) {
    assert.ok(
      allowlist.some((allowed) => file.endsWith(allowed)),
      `unexpected announce: false in ${file}`
    );
  }
  assert.deepEqual([...hits].sort(), [...allowlist].sort());
});

test("bindOperation suppresses the audience line outside mcpjam cloud unless a group opts in", () => {
  const source = readFileSync(
    path.join(SRC_ROOT, "lib/platform-command.ts"),
    "utf8"
  );
  assert.match(source, /announce:\s*bindExtras\.announce \?\? underCloud/);
});

test("platform-auth does not import cloud-context", () => {
  const source = readFileSync(
    path.join(SRC_ROOT, "lib/platform-auth.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /cloud-context/);
});

test("environments create audience names the JSON body project, not MCPJAM_PROJECT", async () => {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "proj-env",
              name: "EnvProject",
              organizationId: "org-1",
              createdAt: 1,
              updatedAt: 50,
            },
            {
              id: "proj-file",
              name: "FileProject",
              organizationId: "org-1",
              createdAt: 1,
              updatedAt: 10,
            },
          ],
        })
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-file/environments" &&
      req.method === "POST"
    ) {
      res.end(
        JSON.stringify({
          id: "env-1",
          projectId: "proj-file",
          name: "FromFile",
          hostId: "host-1",
          revision: 1,
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: url.pathname }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  try {
    const run = await withEnv(isolatedEnv({ MCPJAM_PROJECT: "proj-env" }), () =>
      runCli([
        "cloud",
        "environments",
        "create",
        "--api-key",
        "sk_test",
        "--api-url",
        baseUrl,
        "--format",
        "json",
        "--json",
        JSON.stringify({
          project: "proj-file",
          name: "FromFile",
          hostId: "host-1",
        }),
      ])
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(
      run.stderr,
      /Using MCPJam Cloud as sk_… · project: input \(proj-file\) · /
    );
    assert.doesNotMatch(run.stderr, /project: env \(proj-env\)/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("environments create rejects a non-string JSON project before any write", async () => {
  const run = await withEnv(isolatedEnv(), () =>
    runCli([
      "cloud",
      "environments",
      "create",
      "--api-key",
      "sk_test",
      "--api-url",
      "http://127.0.0.1:1/api/v1",
      "--json",
      JSON.stringify({
        project: 123,
        name: "FromFile",
        hostId: "host-1",
      }),
    ])
  );
  assert.equal(run.exitCode, 2, run.stderr);
  const payload = JSON.parse(run.stderr) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(payload.error?.code, "USAGE_ERROR");
  assert.equal(
    payload.error?.message,
    '"project" must be a string when supplied in JSON input.'
  );
});
