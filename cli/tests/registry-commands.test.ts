/**
 * `mcpjam registry` project scoping, flag validation, and id routing.
 *
 * The group lives at the program root, not under `cloud`, so these tests pin
 * the property that made I3 reviewable: every project-scoped registry command
 * resolves its project with the same precedence as `cloud projects …` —
 * flag > MCPJAM_PROJECT > repo link > automatic — including the writes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { looksLikeConvexId } from "../src/commands/registry.js";
import { runCli } from "./support/cli-run.js";

type Fixture = {
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
};

/**
 * Three projects so each selector source resolves to a DIFFERENT project:
 * automatic picks the newest (proj-auto), MCPJAM_PROJECT names proj-env, and
 * the repo link pins proj-linked. A test that asserts the request path can
 * therefore tell which source won, not merely that some project was chosen.
 */
async function startRegistryFixture(): Promise<Fixture> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    requests.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") {
      res.end(
        JSON.stringify({
          items: [
            { id: "proj-auto", name: "Auto", organizationId: "org-1", updatedAt: 300 },
            { id: "proj-env", name: "EnvPick", organizationId: "org-1", updatedAt: 200 },
            { id: "proj-linked", name: "Linked", organizationId: "org-1", updatedAt: 100 },
          ],
        })
      );
      return;
    }
    const installMatch = url.pathname.match(
      /^\/api\/v1\/projects\/([^/]+)\/registry\/directory-installs$/
    );
    if (req.method === "POST" && installMatch) {
      res.end(
        JSON.stringify({
          serverId: "srv-1",
          serverName: "linear",
          outcome: "created",
        })
      );
      return;
    }
    const uninstallMatch = url.pathname.match(
      /^\/api\/v1\/projects\/([^/]+)\/registry\/installs\/([^/]+)$/
    );
    if (req.method === "DELETE" && uninstallMatch) {
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    if (/^\/api\/v1\/projects\/[^/]+\/registry\/(connections|servers)$/.test(url.pathname)) {
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+$/.test(url.pathname)) {
      // Read back by the install follow-up hint. Non-OAuth so the SDK does
      // not try to mint a browser connect link.
      res.end(
        JSON.stringify({
          id: "srv-1",
          projectId: "proj-any",
          name: "linear",
          enabled: true,
          transportType: "http",
          url: "https://mcp.linear.app/mcp",
          useOAuth: false,
          hasClientSecret: false,
          createdAt: 1,
          updatedAt: 1,
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
    requests,
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

/** A directory whose `.mcpjam/project.json` pins proj-linked to this fixture. */
function linkedDir(baseUrl: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-registry-linked-"));
  mkdirSync(path.join(dir, ".mcpjam"));
  writeFileSync(
    path.join(dir, ".mcpjam", "project.json"),
    `${JSON.stringify({
      version: 1,
      project: { id: "proj-linked", name: "Linked" },
      apiUrl: baseUrl,
    })}\n`
  );
  return dir;
}

function unlinkedDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mcpjam-registry-plain-"));
}

async function runRegistry(
  fixture: Fixture,
  args: string[],
  options: { env?: Record<string, string | undefined>; cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return withEnv(isolatedEnv(options.env), () =>
    withCwd(options.cwd ?? unlinkedDir(), () =>
      runCli([
        "registry",
        ...args,
        "--api-key",
        "sk_test",
        "--api-url",
        fixture.baseUrl,
      ])
    )
  );
}

test("registry install honors MCPJAM_PROJECT over automatic selection", async () => {
  const fixture = await startRegistryFixture();
  try {
    const run = await runRegistry(
      fixture,
      ["install", "cat_directory_row", "--format", "json"],
      { env: { MCPJAM_PROJECT: "proj-env" } }
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(
      fixture.requests.includes(
        "POST /api/v1/projects/proj-env/registry/directory-installs"
      ),
      `install went elsewhere:\n  ${fixture.requests.join("\n  ")}`
    );
    assert.match(run.stderr, /project: env \(proj-env\)/);
  } finally {
    await fixture.close();
  }
});

test("registry install honors the repo project link", async () => {
  const fixture = await startRegistryFixture();
  try {
    const run = await runRegistry(
      fixture,
      ["install", "cat_directory_row", "--format", "json"],
      { cwd: linkedDir(fixture.baseUrl) }
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(
      fixture.requests.includes(
        "POST /api/v1/projects/proj-linked/registry/directory-installs"
      ),
      `install ignored the link:\n  ${fixture.requests.join("\n  ")}`
    );
    assert.match(run.stderr, /project: link \(Linked\)/);
  } finally {
    await fixture.close();
  }
});

test("registry install --project beats MCPJAM_PROJECT", async () => {
  const fixture = await startRegistryFixture();
  try {
    const run = await runRegistry(
      fixture,
      [
        "install",
        "cat_directory_row",
        "--project",
        "proj-auto",
        "--format",
        "json",
      ],
      { env: { MCPJAM_PROJECT: "proj-env" } }
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(
      fixture.requests.includes(
        "POST /api/v1/projects/proj-auto/registry/directory-installs"
      ),
      `flag lost to env:\n  ${fixture.requests.join("\n  ")}`
    );
  } finally {
    await fixture.close();
  }
});

test("registry install human output prints the server's real connect command", async () => {
  const fixture = await startRegistryFixture();
  try {
    const run = await runRegistry(
      fixture,
      ["install", "cat_directory_row", "--project", "proj-auto", "--format", "human"],
      {}
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /mcpjam cloud projects status --project proj-auto/);
    assert.match(
      run.stdout,
      /mcpjam cloud projects servers connect --server srv-1 --url https:\/\/mcp\.linear\.app\/mcp --project proj-auto/
    );
    assert.doesNotMatch(run.stdout, /<endpoint-url>/);
    assert.doesNotMatch(run.stdout, /get_project_server_connection_status/);
  } finally {
    await fixture.close();
  }
});

test("registry uninstall honors MCPJAM_PROJECT", async () => {
  const fixture = await startRegistryFixture();
  try {
    const run = await runRegistry(
      fixture,
      ["uninstall", "rs_card_1", "--format", "json"],
      { env: { MCPJAM_PROJECT: "proj-env" } }
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(
      fixture.requests.includes(
        "DELETE /api/v1/projects/proj-env/registry/installs/rs_card_1"
      ),
      `uninstall went elsewhere:\n  ${fixture.requests.join("\n  ")}`
    );
  } finally {
    await fixture.close();
  }
});

test("registry connections and servers honor the repo project link", async () => {
  const fixture = await startRegistryFixture();
  try {
    const cwd = linkedDir(fixture.baseUrl);
    const connections = await runRegistry(
      fixture,
      ["connections", "--format", "json"],
      { cwd }
    );
    assert.equal(connections.exitCode, 0, connections.stderr);
    assert.ok(
      fixture.requests.includes(
        "GET /api/v1/projects/proj-linked/registry/connections"
      ),
      `connections ignored the link:\n  ${fixture.requests.join("\n  ")}`
    );

    const servers = await runRegistry(fixture, ["servers", "--format", "json"], {
      env: { MCPJAM_PROJECT: "proj-env" },
      cwd,
    });
    assert.equal(servers.exitCode, 0, servers.stderr);
    assert.ok(
      fixture.requests.includes(
        "GET /api/v1/projects/proj-env/registry/servers"
      ),
      `servers ignored MCPJAM_PROJECT:\n  ${fixture.requests.join("\n  ")}`
    );
    // Bound commands announce like their inline siblings.
    assert.match(servers.stderr, /Using MCPJam Cloud as sk_… · project: env \(proj-env\)/);
  } finally {
    await fixture.close();
  }
});

test("registry search announces the account scope, not an inferred project", async () => {
  const fixture = await startRegistryFixture();
  try {
    // Run inside a linked repo: a directory search must not claim the linked
    // project as its audience — it never reads or writes one.
    const run = await runRegistry(fixture, ["search", "linear", "--format", "json"], {
      cwd: linkedDir(fixture.baseUrl),
    });
    // The fixture 404s the search route; the audience line printed first.
    assert.match(run.stderr, /Using MCPJam Cloud as sk_… · account · /);
    assert.doesNotMatch(run.stderr, /project: link/);
  } finally {
    await fixture.close();
  }
});

test("registry install rejects cross-shelf flag combinations before any request", async () => {
  const fixture = await startRegistryFixture();
  try {
    const cases: { args: string[]; message: RegExp }[] = [
      {
        args: ["install", "id1", "--card", "--endpoint-url", "https://x/mcp"],
        message: /--endpoint-url applies to directory installs/,
      },
      {
        args: ["install", "id1", "--card", "--expected-content-hash", "hash1"],
        message: /--expected-content-hash applies to directory installs/,
      },
      {
        args: ["install", "id1", "--expected-updated-at", "123"],
        message: /--expected-updated-at applies to card installs/,
      },
    ];
    for (const { args, message } of cases) {
      const run = await runRegistry(fixture, [...args, "--format", "json"], {});
      assert.equal(run.exitCode, 2, `${args.join(" ")}\n${run.stderr}`);
      assert.match(run.stderr, message);
    }
    assert.deepEqual(
      fixture.requests,
      [],
      "a rejected flag combination must not reach the network"
    );
  } finally {
    await fixture.close();
  }
});

test("looksLikeConvexId matches the real Convex id shape only", () => {
  // The shape the v1 routes use in their own fixtures: 32 lowercase
  // alphanumerics.
  assert.equal(looksLikeConvexId("k57abcdefghijklmnopqrstuvwxyz012"), true);
  // Long alphanumeric NAMES must stay on the name shelf.
  assert.equal(looksLikeConvexId("microsoftsharepointserver"), false);
  // Convex ids are lowercase; 32 chars with uppercase is a name.
  assert.equal(looksLikeConvexId("K57ABCDEFGHIJKLMNOPQRSTUVWXYZ012"), false);
  assert.equal(looksLikeConvexId("k57abcdefghijklmnopqrst"), false);
  assert.equal(looksLikeConvexId("k57abcdefghijklmnopqrstuvwxyz0123"), false);
});
