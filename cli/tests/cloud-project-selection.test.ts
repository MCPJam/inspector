/**
 * One project-selection rule: remaining eval commands take optional
 * `--project`, and `sessions list` is project-scoped with `--all-projects`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "./support/cli-run.js";
import { projectLinkPathForDir } from "../src/lib/project-link.js";

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
  {
    id: "proj-beta",
    name: "Beta",
    description: null,
    icon: null,
    organizationId: "org-1",
    visibility: null,
    createdAt: 2,
    updatedAt: 100,
  },
];

async function startFixture(): Promise<{
  baseUrl: string;
  requestUrls: string[];
  close: () => Promise<void>;
}> {
  const requestUrls: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    requestUrls.push(`${req.method} ${url.pathname}${url.search}`);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") {
      res.end(JSON.stringify({ items: PROJECTS }));
      return;
    }
    if (url.pathname === "/api/v1/chat-sessions") {
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1") {
      res.end(
        JSON.stringify({
          id: "run-1",
          suiteId: "suite-1",
          status: "completed",
          result: "passed",
          judges: [],
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
    requestUrls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
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

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

function cloudArgv(baseUrl: string, ...args: string[]): string[] {
  return [
    "cloud",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    baseUrl,
    "--format",
    "json",
  ];
}

test("eval status/cancel/judge help treat --project as optional", async () => {
  for (const sub of ["status", "cancel", "judge"]) {
    const run = await runCli(["cloud", "eval", sub, "--help"]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /--project <id-or-name>/);
    assert.doesNotMatch(run.stdout, /required option '--project/);
  }
});

test("eval status without --project uses automatic project selection", async () => {
  const fixture = await startFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-eval-project-"));
  try {
    const run = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () =>
        runCli(cloudArgv(fixture.baseUrl, "eval", "status", "--run", "run-1"))
      )
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(
      fixture.requestUrls.some((url) =>
        url.includes("/projects/proj-alpha/eval-runs/run-1")
      ),
      `expected automatic proj-alpha run fetch, saw: ${fixture.requestUrls.join(", ")}`
    );
    assert.match(
      run.stderr,
      /project: automatic \(most recently updated\)/
    );
  } finally {
    await fixture.close();
  }
});

test("sessions list without --project scopes to the automatic project", async () => {
  const fixture = await startFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-sessions-auto-"));
  try {
    const run = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () => runCli(cloudArgv(fixture.baseUrl, "sessions", "list")))
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(
      fixture.requestUrls.some((url) =>
        url.includes("/chat-sessions") && url.includes("projectId=proj-alpha")
      ),
      `expected projectId=proj-alpha, saw: ${fixture.requestUrls.join(", ")}`
    );
    assert.match(
      run.stderr,
      /project: automatic \(most recently updated\)/
    );
  } finally {
    await fixture.close();
  }
});

test("sessions list --all-projects does not send a project filter", async () => {
  const fixture = await startFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-sessions-all-"));
  try {
    const run = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () =>
        runCli(cloudArgv(fixture.baseUrl, "sessions", "list", "--all-projects"))
      )
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const sessionGets = fixture.requestUrls.filter((url) =>
      url.includes("/chat-sessions")
    );
    assert.equal(sessionGets.length, 1);
    assert.doesNotMatch(sessionGets[0]!, /projectId=/);
    assert.match(run.stderr, /all projects/);
  } finally {
    await fixture.close();
  }
});

test("sessions list honors a project link and --all-projects ignores it", async () => {
  const fixture = await startFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-sessions-link-"));
  const linkPath = projectLinkPathForDir(cwd);
  mkdirSync(path.dirname(linkPath), { recursive: true });
  writeFileSync(
    linkPath,
    `${JSON.stringify({
      version: 1,
      project: { id: "proj-beta", name: "Beta" },
      apiUrl: fixture.baseUrl,
    }, null, 2)}\n`
  );
  try {
    const linked = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () => runCli(cloudArgv(fixture.baseUrl, "sessions", "list")))
    );
    assert.equal(linked.exitCode, 0, linked.stderr);
    assert.ok(
      fixture.requestUrls.some((url) =>
        url.includes("/chat-sessions") && url.includes("projectId=proj-beta")
      ),
      `expected linked proj-beta, saw: ${fixture.requestUrls.join(", ")}`
    );

    fixture.requestUrls.length = 0;
    const all = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () =>
        runCli(cloudArgv(fixture.baseUrl, "sessions", "list", "--all-projects"))
      )
    );
    assert.equal(all.exitCode, 0, all.stderr);
    const sessionGets = fixture.requestUrls.filter((url) =>
      url.includes("/chat-sessions")
    );
    assert.equal(sessionGets.length, 1);
    assert.doesNotMatch(sessionGets[0]!, /projectId=/);
  } finally {
    await fixture.close();
  }
});

test("sessions list rejects --project together with --all-projects", async () => {
  const run = await runCli([
    "cloud",
    "sessions",
    "list",
    "--project",
    "alpha",
    "--all-projects",
    "--format",
    "json",
  ]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /cannot be used with option '--project/i);
});

test("sessions list --help shows --all-projects", async () => {
  const run = await runCli(["cloud", "sessions", "list", "--help"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /--all-projects/);
  assert.match(run.stdout, /--project <id-or-name>/);
});
