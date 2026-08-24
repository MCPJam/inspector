/**
 * `mcpjam cloud link` / `mcpjam cloud status` and project-selector wiring.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runCli } from "./support/cli-run.js";
import { projectLinkPathForDir } from "../src/lib/project-link.js";

const execFile = promisify(execFileCallback);

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

async function startProjectFixture(): Promise<{
  baseUrl: string;
  suitePaths: string[];
  close: () => Promise<void>;
}> {
  const suitePaths: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") {
      res.end(JSON.stringify({ items: PROJECTS }));
      return;
    }
    const suites = url.pathname.match(
      /^\/api\/v1\/projects\/([^/]+)\/eval-suites$/
    );
    if (suites) {
      suitePaths.push(decodeURIComponent(suites[1] ?? ""));
      if ((req.method ?? "GET") === "POST") {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            suiteId: "suite-created",
            name: "created",
            servers: [],
            caseUpsert: { committed: [], failed: [] },
          })
        );
        return;
      }
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers$/.test(url.pathname)) {
      res.end(JSON.stringify({ items: [] }));
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
    suitePaths,
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

function assertSamePath(left: string, right: string): void {
  assert.equal(realpathSync(left), realpathSync(right));
}

function writeLink(
  directory: string,
  body: Record<string, unknown>
): string {
  const filePath = projectLinkPathForDir(directory);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
  return filePath;
}

test("cloud status reports missing credentials and automatic project offline", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-"));
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () => runCli(["cloud", "status", "--format", "json"]))
  );
  assert.equal(run.exitCode, 0, run.stderr);
  const payload = JSON.parse(run.stdout) as {
    ok: boolean;
    credential: { source: string; valid: boolean | null };
    deployment: { valid: boolean };
    project: { source: string; description: string };
    link: { valid: boolean | null };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.credential.source, "missing");
  assert.equal(payload.credential.valid, null);
  assert.equal(payload.deployment.valid, true);
  assert.equal(payload.project.source, "automatic");
  assert.equal(payload.project.description, "automatic (most recently updated)");
  assert.equal(payload.link.valid, null);
  assert.doesNotMatch(run.stdout, /project: default/i);
});

test("cloud status reports a valid configuration without leaking the key", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-ok-"));
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () =>
      runCli([
        "cloud",
        "status",
        "--api-key",
        "sk_live_abcd1234efgh",
        "--format",
        "json",
      ])
    )
  );
  assert.equal(run.exitCode, 0, run.stderr);
  const payload = JSON.parse(run.stdout) as {
    ok: boolean;
    credential: {
      source: string;
      valid: boolean | null;
      redactedKey?: string;
    };
    deployment: { valid: boolean; source: string };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.credential.source, "flag");
  assert.equal(payload.credential.valid, true);
  assert.equal(payload.credential.redactedKey, "sk_…efgh");
  assert.equal(payload.deployment.valid, true);
  assert.doesNotMatch(run.stdout, /sk_live_abcd1234efgh/);
  assert.doesNotMatch(run.stderr, /sk_live_abcd1234efgh/);
});

test("cloud status names MCPJAM_PROJECT_ID as eval-reporting only", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-id-"));
  const run = await withEnv(
    isolatedEnv({ MCPJAM_PROJECT_ID: "proj-from-sdk" }),
    () => withCwd(cwd, () => runCli(["cloud", "status", "--format", "json"]))
  );
  assert.equal(run.exitCode, 0, run.stderr);
  const payload = JSON.parse(run.stdout) as { warnings: string[] };
  assert.match(
    payload.warnings.join("\n"),
    /MCPJAM_PROJECT_ID is set; it is used only for SDK eval reporting/
  );
  assert.equal(JSON.parse(run.stdout).project.source, "automatic");
});

test("cloud status reports an invalid link and exits nonzero", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-bad-"));
  writeLink(cwd, { version: 2, project: { id: "x", name: "y" } });
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () => runCli(["cloud", "status", "--format", "json"]))
  );
  assert.equal(run.exitCode, 1, run.stderr);
  const payload = JSON.parse(run.stdout) as {
    ok: boolean;
    link: { valid: boolean; error?: string };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.link.valid, false);
  assert.match(payload.link.error ?? "", /unsupported version/);
});

test("cloud status warns when link apiUrl does not match the active deployment", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-url-"));
  writeLink(cwd, {
    version: 1,
    project: { id: "proj-alpha", name: "Alpha" },
    apiUrl: "https://staging.example.com/api/v1",
  });
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () => runCli(["cloud", "status", "--format", "json"]))
  );
  assert.equal(run.exitCode, 0, run.stderr);
  const payload = JSON.parse(run.stdout) as {
    warnings: string[];
    link: { apiUrlMatchesDeployment: boolean };
    project: { source: string };
  };
  assert.equal(payload.link.apiUrlMatchesDeployment, false);
  assert.equal(payload.project.source, "link");
  assert.match(payload.warnings.join("\n"), /does not match the active deployment/);
  assert.match(
    payload.warnings.join("\n"),
    /The active deployment's API URL is used; the link's project selector remains active/
  );
});

test("cloud status reports a legacy --api-key in JSON and exits 1", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-legacy-"));
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () =>
      runCli([
        "cloud",
        "status",
        "--api-key",
        "mcpjam_legacy_secret",
        "--format",
        "json",
      ])
    )
  );
  assert.equal(run.exitCode, 1, run.stderr);
  const payload = JSON.parse(run.stdout) as {
    ok: boolean;
    credential: {
      valid: boolean | null;
      error?: string;
      redactedKey?: string;
    };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.credential.valid, false);
  assert.match(payload.credential.error ?? "", /Legacy mcpjam_ API keys/);
  assert.equal(payload.credential.redactedKey, "mcpjam_…cret");
  assert.doesNotMatch(run.stdout, /mcpjam_legacy_secret/);
});

test("cloud status reports an invalid --api-url in JSON and exits 1", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-badurl-"));
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () =>
      runCli([
        "cloud",
        "status",
        "--api-key",
        "sk_test_xxxxYYYY",
        "--api-url",
        "not-a-url",
        "--format",
        "json",
      ])
    )
  );
  assert.equal(run.exitCode, 1, run.stderr);
  const payload = JSON.parse(run.stdout) as {
    ok: boolean;
    credential: { valid: boolean | null; redactedKey?: string };
    deployment: { valid: boolean; error?: string; apiUrl: string };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.credential.valid, true);
  assert.equal(payload.credential.redactedKey, "sk_…YYYY");
  assert.equal(payload.deployment.valid, false);
  assert.equal(payload.deployment.apiUrl, "not-a-url");
  assert.match(payload.deployment.error ?? "", /Invalid --api-url/);
  assert.doesNotMatch(run.stdout, /sk_test_xxxxYYYY/);
});

test("other Cloud commands still reject a legacy --api-key with exit 2", async () => {
  const run = await withEnv(isolatedEnv(), () =>
    runCli([
      "cloud",
      "eval",
      "list",
      "--api-key",
      "mcpjam_legacy",
      "--format",
      "json",
    ])
  );
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, "");
  const payload = JSON.parse(run.stderr) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(payload.error?.code, "USAGE_ERROR");
  assert.match(payload.error?.message ?? "", /Legacy mcpjam_ API keys/);
});

test("other Cloud commands still reject an invalid --api-url with exit 2", async () => {
  const run = await withEnv(isolatedEnv(), () =>
    runCli([
      "cloud",
      "eval",
      "list",
      "--api-key",
      "sk_test",
      "--api-url",
      "not-a-url",
      "--format",
      "json",
    ])
  );
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, "");
  const payload = JSON.parse(run.stderr) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(payload.error?.code, "USAGE_ERROR");
  assert.match(payload.error?.message ?? "", /Invalid --api-url/);
});

test("cloud link writes .mcpjam/project.json at the Git worktree root", async () => {
  const fixture = await startProjectFixture();
  const root = mkdtempSync(path.join(tmpdir(), "mcpjam-link-git-"));
  await execFile("git", ["init"], { cwd: root });
  const nested = path.join(root, "pkg");
  mkdirSync(nested);
  try {
    const run = await withEnv(isolatedEnv(), () =>
      withCwd(nested, () =>
        runCli([
          "cloud",
          "link",
          "Beta",
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
    const payload = JSON.parse(run.stdout) as {
      status: string;
      path: string;
      project: { id: string; name: string };
    };
    assert.equal(payload.status, "linked");
    assert.equal(payload.project.id, "proj-beta");
    const written = JSON.parse(readFileSync(payload.path, "utf8")) as {
      version: number;
      project: { id: string; name: string };
      apiUrl: string;
    };
    assert.equal(written.version, 1);
    assert.equal(written.project.name, "Beta");
    assert.equal(written.apiUrl, fixture.baseUrl);
    assertSamePath(payload.path, projectLinkPathForDir(root));
  } finally {
    await fixture.close();
  }
});

test("cloud link --here writes in cwd; --remove deletes the nearest file", async () => {
  const fixture = await startProjectFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-link-here-"));
  try {
    const linkRun = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () =>
        runCli([
          "cloud",
          "link",
          "proj-alpha",
          "--here",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ])
      )
    );
    assert.equal(linkRun.exitCode, 0, linkRun.stderr);
    assertSamePath(
      JSON.parse(linkRun.stdout).path as string,
      projectLinkPathForDir(cwd)
    );

    const removeRun = await withEnv(isolatedEnv(), () =>
      withCwd(cwd, () =>
        runCli(["cloud", "link", "--remove", "--format", "json"])
      )
    );
    assert.equal(removeRun.exitCode, 0, removeRun.stderr);
    assert.equal(JSON.parse(removeRun.stdout).status, "removed");
    assert.throws(() => readFileSync(projectLinkPathForDir(cwd), "utf8"));
  } finally {
    await fixture.close();
  }
});

test("cloud link empty project argument is a usage error", async () => {
  const run = await runCli(["cloud", "link", "   ", "--format", "json"]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /Project argument cannot be empty/);
  assert.doesNotMatch(run.stderr, /--project cannot be empty/);
});

test("cloud link --remove rejects an empty project argument", async () => {
  const run = await runCli([
    "cloud",
    "link",
    "",
    "--remove",
    "--format",
    "json",
  ]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /Do not pass a project argument with --remove/);
});

test("cloud status reports empty MCPJAM_PROJECT as unresolved, not automatic", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-status-empty-"));
  const run = await withEnv(isolatedEnv({ MCPJAM_PROJECT: "   " }), () =>
    withCwd(cwd, () => runCli(["cloud", "status", "--format", "json"]))
  );
  assert.equal(run.exitCode, 1, run.stderr);
  const payload = JSON.parse(run.stdout) as {
    ok: boolean;
    project: { source: string; description: string };
    warnings: string[];
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.project.source, "unresolved");
  assert.equal(payload.project.description, "unresolved");
  assert.match(payload.warnings.join("\n"), /MCPJAM_PROJECT cannot be empty/);
});

test("cloud link --here --remove without a link is a usage error", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-link-here-missing-"));
  const run = await withEnv(isolatedEnv(), () =>
    withCwd(cwd, () =>
      runCli(["cloud", "link", "--here", "--remove", "--format", "json"])
    )
  );
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /No project link found/);
});

test("cloud link --remove rejects a project argument", async () => {
  const run = await runCli([
    "cloud",
    "link",
    "Alpha",
    "--remove",
    "--format",
    "json",
  ]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /Do not pass a project argument with --remove/);
});

test("eval list uses MCPJAM_PROJECT then a project link, and --project wins", async () => {
  const fixture = await startProjectFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-eval-link-"));
  writeLink(cwd, {
    version: 1,
    project: { id: "proj-beta", name: "Beta" },
    apiUrl: fixture.baseUrl,
  });
  try {
    const fromLink = await withEnv(isolatedEnv(), () =>
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
    assert.equal(fromLink.exitCode, 0, fromLink.stderr);
    assert.deepEqual(fixture.suitePaths, ["proj-beta"]);

    fixture.suitePaths.length = 0;
    const fromEnv = await withEnv(
      isolatedEnv({ MCPJAM_PROJECT: "Alpha" }),
      () =>
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
    assert.equal(fromEnv.exitCode, 0, fromEnv.stderr);
    assert.deepEqual(fixture.suitePaths, ["proj-alpha"]);

    fixture.suitePaths.length = 0;
    const fromFlag = await withEnv(
      isolatedEnv({ MCPJAM_PROJECT: "Alpha" }),
      () =>
        withCwd(cwd, () =>
          runCli([
            "cloud",
            "eval",
            "list",
            "--project",
            "Beta",
            "--api-key",
            "sk_test",
            "--api-url",
            fixture.baseUrl,
            "--format",
            "json",
          ])
        )
    );
    assert.equal(fromFlag.exitCode, 0, fromFlag.stderr);
    assert.deepEqual(fixture.suitePaths, ["proj-beta"]);
  } finally {
    await fixture.close();
  }
});

test("empty --project is a usage error", async () => {
  const run = await withEnv(isolatedEnv(), () =>
    runCli([
      "cloud",
      "eval",
      "list",
      "--project",
      "",
      "--api-key",
      "sk_test",
      "--format",
      "json",
    ])
  );
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /--project cannot be empty/);
});

test("a stale link selector appends the re-link hint", async () => {
  const fixture = await startProjectFixture();
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-stale-link-"));
  const linkPath = writeLink(cwd, {
    version: 1,
    project: { id: "proj-missing", name: "Missing" },
    apiUrl: fixture.baseUrl,
  });
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
    assert.equal(run.exitCode, 1, run.stdout);
    assert.match(run.stderr, /proj-missing/);
    assert.match(run.stderr, /Selector came from /);
    assert.ok(run.stderr.includes(linkPath));
    assert.match(run.stderr, /mcpjam cloud link/);
  } finally {
    await fixture.close();
  }
});

test("hosted readiness is not given ambient Cloud project context", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-readiness-"));
  writeLink(cwd, {
    version: 1,
    project: { id: "proj-beta", name: "Beta" },
    apiUrl: "https://app.mcpjam.com/api/v1",
  });
  const run = await withEnv(isolatedEnv({ MCPJAM_PROJECT: "" }), () =>
    withCwd(cwd, () =>
      runCli([
        "readiness",
        "start",
        "claude",
        "--server",
        "any",
        "--format",
        "json",
      ])
    )
  );
  assert.notEqual(run.exitCode, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /MCPJAM_PROJECT cannot be empty/);
});
