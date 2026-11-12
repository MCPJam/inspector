/**
 * `mcpjam cloud server-accounts`.
 *
 * What these pin: `set` takes the access token from a file, an environment
 * variable or stdin and sends it in the upload body; a token typed on the
 * command line is refused before any request; and the other verbs send the
 * routes and bodies the accounts API documents.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerServerAccountsCommands } from "../src/commands/server-accounts.js";
import { CliError } from "../src/lib/output.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";
import { captureProcessOutput } from "./support/cli-run.js";
import { json, startRecorder } from "./support/deployment-fixtures.js";
import { runCli } from "./support/task-cli-harness.js";

const PROJECT = {
  id: "project-1",
  name: "Checkout",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

const SERVER = {
  id: "server-1",
  projectId: PROJECT.id,
  name: "markets",
  enabled: true,
  transportType: "http",
  url: "https://mcp.example.com/mcp",
  useOAuth: true,
  hasClientSecret: false,
  createdAt: 1,
  updatedAt: 2,
};

const ACCOUNT = {
  id: "acct_1",
  name: "test-automation-1",
  kind: "personal",
  isDefault: false,
  needsReconnect: false,
  hostedOnly: true,
  expiresAt: null,
  createdAt: 10,
  updatedAt: 20,
};

const ACCOUNTS = "/api/v1/projects/project-1/servers/server-1/accounts";

type Captured = { method: string; path: string; body: unknown };

/** The API the commands reach, answering account calls and recording them. */
function stubFetch(): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/projects")) {
      return Response.json({ items: [PROJECT] });
    }
    if (url.pathname.endsWith("/projects/project-1/servers")) {
      return Response.json({ items: [SERVER] });
    }
    requests.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === "PUT") return Response.json(ACCOUNT, { status: 201 });
    if (method === "DELETE") {
      return Response.json({ account: "test-automation-1", deleted: true });
    }
    if (url.pathname === ACCOUNTS) return Response.json({ items: [ACCOUNT] });
    return Response.json(ACCOUNT);
  }) as typeof fetch;
  return requests;
}

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerServerAccountsCommands(cloud);
  return program;
}

const realFetch = globalThis.fetch;
const ENV_NAME = "MCPJAM_TEST_ACCESS_TOKEN";
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[ENV_NAME];
});

/** Runs one verb against the stubbed API and returns what it printed. */
async function run(
  verb: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const { stdout } = await captureProcessOutput(() =>
    buildProgram().parseAsync(
      [
        "cloud",
        "server-accounts",
        verb,
        "--server",
        "markets",
        "--project",
        "project-1",
        "--api-key",
        "sk_test",
        ...args,
      ],
      { from: "user" },
    ),
  );
  return JSON.parse(stdout);
}

const SET = ["--account", "test-automation-1", "--client-id", "client-1"];

async function tokenFile(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-account-"));
  const file = path.join(dir, "token");
  await writeFile(file, contents, "utf8");
  return file;
}

function assertUsageError(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "USAGE_ERROR");
    assert.match(error.message, pattern);
    return true;
  };
}

test("set uploads the token from a file, with the refresh token and expiry", async () => {
  const requests = stubFetch();
  const access = await tokenFile("access-from-file\n");
  const refresh = await tokenFile("refresh-from-file\n");
  const printed = await run("set", [
    ...SET,
    "--access-token-file",
    access,
    "--refresh-token-file",
    refresh,
    "--expires-in",
    "3600",
  ]);

  assert.deepEqual(requests, [
    {
      method: "PUT",
      path: `${ACCOUNTS}/test-automation-1`,
      body: {
        tokens: {
          access_token: "access-from-file",
          refresh_token: "refresh-from-file",
          expires_in: 3600,
        },
        clientInformation: { clientId: "client-1" },
      },
    },
  ]);
  assert.deepEqual(printed.account, ACCOUNT);
  assert.equal(printed.created, true);
  assert.doesNotMatch(JSON.stringify(printed), /from-file/);
});

test("set uploads the token from an environment variable", async () => {
  const requests = stubFetch();
  process.env[ENV_NAME] = "access-from-env";
  await run("set", [...SET, "--access-token-env", ENV_NAME]);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {
    tokens: { access_token: "access-from-env" },
    clientInformation: { clientId: "client-1" },
  });
});

test("set refuses a token typed on the command line, before any request", async () => {
  const requests = stubFetch();
  await assert.rejects(
    run("set", [...SET, "--access-token", "typed-token"]),
    assertUsageError(/typed on the command line/),
  );
  assert.deepEqual(requests, []);
});

test("set refuses no token source, two sources, and an unset variable", async () => {
  const requests = stubFetch();
  const file = await tokenFile("access-from-file");
  await assert.rejects(run("set", SET), assertUsageError(/is required/));
  await assert.rejects(
    run("set", [
      ...SET,
      "--access-token-file",
      file,
      "--access-token-env",
      ENV_NAME,
    ]),
    assertUsageError(/only one of --access-token-file or --access-token-env/),
  );
  await assert.rejects(
    run("set", [...SET, "--access-token-env", ENV_NAME]),
    assertUsageError(/is not set/),
  );
  await assert.rejects(
    run("set", [...SET, "--access-token-file", await tokenFile(" \n")]),
    assertUsageError(/is empty/),
  );
  assert.deepEqual(requests, []);
});

test("set refuses both tokens from stdin", async () => {
  const requests = stubFetch();
  await assert.rejects(
    run("set", [...SET, "--access-token", "-", "--refresh-token-file", "-"]),
    assertUsageError(/Only one token can come from stdin/),
  );
  assert.deepEqual(requests, []);
});

test("rename, default, show, list and delete send the documented calls", async () => {
  const requests = stubFetch();
  const account = ["--account", "test-automation-1"];
  await run("rename", [...account, "--name", "ci-account"]);
  await run("default", account);
  await run("show", account);
  await run("list", []);
  const deleted = await run("delete", account);

  assert.deepEqual(requests, [
    {
      method: "PATCH",
      path: `${ACCOUNTS}/test-automation-1`,
      body: { name: "ci-account" },
    },
    {
      method: "PATCH",
      path: `${ACCOUNTS}/test-automation-1`,
      body: { isDefault: true },
    },
    { method: "GET", path: `${ACCOUNTS}/test-automation-1`, body: undefined },
    { method: "GET", path: ACCOUNTS, body: undefined },
    {
      method: "DELETE",
      path: `${ACCOUNTS}/test-automation-1`,
      body: undefined,
    },
  ]);
  assert.equal(deleted.account, "test-automation-1");
  assert.equal(deleted.deleted, true);
});

test("set --access-token - reads the token from stdin", async () => {
  // Spawns the built CLI: a process cannot repoint its own fd 0, so only a
  // parent with a pipe exercises the stdin branch.
  const api = await startRecorder({
    "GET /api/v1/projects": (_request, response) =>
      json(response, 200, { items: [PROJECT] }),
    "GET /api/v1/projects/project-1/servers": (_request, response) =>
      json(response, 200, { items: [SERVER] }),
    [`PUT ${ACCOUNTS}/test-automation-1`]: (_request, response) =>
      json(response, 200, ACCOUNT),
  });
  const home = await mkdtemp(path.join(os.tmpdir(), "mcpjam-account-home-"));
  try {
    const result = await runCli(
      [
        "--format",
        "json",
        "cloud",
        "server-accounts",
        "set",
        "--server",
        "markets",
        "--project",
        "project-1",
        ...SET,
        "--access-token",
        "-",
        "--api-key",
        "sk_test",
        "--api-url",
        `${api.url}/api/v1`,
      ],
      "access-from-stdin\n",
      {
        env: {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          MCPJAM_API_KEY: "",
          MCPJAM_API_URL: "",
          MCPJAM_BASE_URL: "",
          MCPJAM_PROJECT: "",
        },
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const upload = api.requests.find((request) => request.method === "PUT");
    assert.ok(upload, "expected the upload request");
    assert.deepEqual(JSON.parse(upload.body), {
      tokens: { access_token: "access-from-stdin" },
      clientInformation: { clientId: "client-1" },
    });
    assert.equal(JSON.parse(result.stdout).created, false);
  } finally {
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});
