import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliError } from "../src/lib/output.js";
import {
  parseServerOverride,
  resolveLocalServerBindings,
} from "../src/lib/local-server-bindings.js";

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-bindings-"));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(
      full,
      typeof content === "string" ? content : JSON.stringify(content)
    );
  }
  return dir;
}

function resolve(
  cwd: string,
  targetNames: string[],
  extra: Partial<Parameters<typeof resolveLocalServerBindings>[0]> = {}
) {
  return resolveLocalServerBindings({
    targetNames,
    cwd,
    env: {},
    requestTimeoutMs: 1234,
    ...extra,
  });
}

function refused(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

test("--server splits on the FIRST '=' so a query string survives", () => {
  assert.deepEqual(parseServerOverride("notes=https://x.test/mcp?a=1&b=2"), {
    name: "notes",
    url: "https://x.test/mcp?a=1&b=2",
  });
  assert.equal(
    refused(() => parseServerOverride("=https://x.test")).exitCode,
    2
  );
  assert.equal(refused(() => parseServerOverride("notes")).exitCode, 2);
  assert.equal(
    refused(() => parseServerOverride("notes=file:///etc/passwd")).exitCode,
    2
  );
});

test("precedence per name: --server > --mcp-config > .mcp.json > .mcpjam/mcp.json", () => {
  const cwd = workspace({
    "explicit.json": { mcpServers: { b: { url: "https://explicit.test/b" } } },
    ".mcp.json": {
      mcpServers: {
        a: { url: "https://dotmcp.test/a" },
        b: { url: "https://dotmcp.test/b" },
        c: { url: "https://dotmcp.test/c" },
      },
    },
    ".mcpjam/mcp.json": {
      mcpServers: {
        c: { url: "https://mcpjam.test/c" },
        d: { url: "https://mcpjam.test/d" },
      },
    },
  });
  const bindings = resolve(cwd, ["a", "b", "c", "d"], {
    serverOverrides: ["a=https://flag.test/a"],
    mcpConfigPath: "explicit.json",
  });
  const urls = Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [
      name,
      [(binding.config as { url: string }).url, binding.source],
    ])
  );
  assert.deepEqual(urls, {
    a: ["https://flag.test/a", "--server"],
    // The explicit config wins for the name it declares…
    b: ["https://explicit.test/b", "--mcp-config"],
    // …and the conventional files still supply the others.
    c: ["https://dotmcp.test/c", ".mcp.json"],
    d: ["https://mcpjam.test/d", ".mcpjam/mcp.json"],
  });
  assert.equal((bindings.a!.config as { timeout?: number }).timeout, 1234);
});

test("only winning entries are interpolated; unset variables are named, never valued", () => {
  const cwd = workspace({
    ".mcp.json": {
      mcpServers: {
        notes: {
          url: "https://${NOTES_HOST}/mcp",
          headers: {
            authorization: "Bearer ${NOTES_TOKEN}",
            "x-region": "${REGION:-us}",
          },
        },
        unrelated: { url: "https://${NEVER_SET}/mcp" },
      },
    },
  });
  const bindings = resolve(cwd, ["notes"], {
    env: { NOTES_HOST: "notes.test", NOTES_TOKEN: "tok_secret_value" },
  });
  const config = bindings.notes!.config as {
    url: string;
    requestInit?: { headers?: Record<string, string> };
  };
  assert.equal(config.url, "https://notes.test/mcp");
  assert.deepEqual(config.requestInit?.headers, {
    authorization: "Bearer tok_secret_value",
    "x-region": "us",
  });

  const error = refused(() =>
    resolve(cwd, ["notes"], { env: { NOTES_HOST: "notes.test" } })
  );
  assert.equal(error.exitCode, 4);
  assert.match(error.message, /NOTES_TOKEN/);
  assert.doesNotMatch(error.message, /tok_secret_value/);
});

test("an unset variable in credentialsFile is named, never read as a truncated path", () => {
  const cwd = workspace({
    ".mcp.json": {
      mcpServers: {
        notes: {
          url: "https://notes.test/mcp",
          credentialsFile: "${CREDS_DIR}/creds.json",
        },
      },
    },
  });
  const error = refused(() => resolve(cwd, ["notes"]));
  assert.equal(error.code, "MCP_CONFIG_INTERPOLATION");
  assert.equal(error.exitCode, 4);
  assert.match(error.message, /CREDS_DIR/);
});

test("a malformed conventional file is read only when a name still needs it", () => {
  const cwd = workspace({
    ".mcp.json": "{ not json",
    ".mcpjam/mcp.json": { mcpServers: { a: { url: "https://x.test" } } },
  });
  // Fully bound by the flag: the broken file is never read.
  assert.ok(
    resolve(cwd, ["a"], { serverOverrides: ["a=https://flag.test"] }).a
  );
  // Needed: the broken file fails setup, even though a later file has the name.
  const error = refused(() => resolve(cwd, ["a"]));
  assert.equal(error.exitCode, 4);
  assert.equal(error.code, "MCP_CONFIG_INVALID");
});

test("an explicit --mcp-config that is missing or invalid fails setup", () => {
  const cwd = workspace({ "bad.json": "[]" });
  assert.equal(
    refused(() =>
      resolve(cwd, ["a"], {
        mcpConfigPath: "missing.json",
        serverOverrides: ["a=https://x.test"],
      })
    ).exitCode,
    4
  );
  assert.equal(
    refused(() => resolve(cwd, ["a"], { mcpConfigPath: "bad.json" })).exitCode,
    4
  );
});

test("every unbound name is listed together, exit 4", () => {
  const cwd = workspace({});
  const error = refused(() =>
    resolve(cwd, ["a", "b", "c"], { serverOverrides: ["b=https://x.test"] })
  );
  assert.equal(error.exitCode, 4);
  assert.equal(error.code, "SERVER_BINDING_MISSING");
  assert.deepEqual((error.details as { missing: string[] }).missing, [
    "a",
    "c",
  ]);
});

test("duplicate or unknown --server names are usage errors", () => {
  const cwd = workspace({});
  assert.equal(
    refused(() =>
      resolve(cwd, ["a"], {
        serverOverrides: ["a=https://x.test", "a=https://y.test"],
      })
    ).exitCode,
    2
  );
  assert.equal(
    refused(() =>
      resolve(cwd, ["a"], { serverOverrides: ["typo=https://x.test"] })
    ).exitCode,
    2
  );
});

test("stdio cwd: relative to the declaring config file, else the invocation directory", () => {
  const cwd = workspace({
    "configs/servers.json": {
      mcpServers: {
        withCwd: { command: "node", args: ["server.mjs"], cwd: "../srv" },
        withoutCwd: { command: "node", args: ["${SCRIPT:-server.mjs}"] },
      },
    },
  });
  const bindings = resolve(cwd, ["withCwd", "withoutCwd"], {
    mcpConfigPath: "configs/servers.json",
  });
  const withCwd = bindings.withCwd!.config as { cwd?: string; args?: string[] };
  const withoutCwd = bindings.withoutCwd!.config as {
    cwd?: string;
    args?: string[];
  };
  assert.equal(withCwd.cwd, path.join(cwd, "srv"));
  assert.equal(withoutCwd.cwd, cwd);
  // Arguments are interpolated and otherwise left exactly as written.
  assert.deepEqual(withCwd.args, ["server.mjs"]);
  assert.deepEqual(withoutCwd.args, ["server.mjs"]);
});

test("--url binds exactly one target and never competes with --server for it", () => {
  const cwd = workspace({});
  const single = resolve(cwd, ["notes"], {
    singleServer: { url: "https://single.test/mcp" },
  });
  assert.equal(
    (single.notes!.config as { url: string }).url,
    "https://single.test/mcp"
  );
  assert.equal(single.notes!.source, "--url");
  assert.equal(
    refused(() =>
      resolve(cwd, ["a", "b"], {
        singleServer: { url: "https://single.test/mcp" },
      })
    ).exitCode,
    2
  );
  assert.equal(
    refused(() =>
      resolve(cwd, ["notes"], {
        singleServer: { url: "https://single.test/mcp" },
        serverOverrides: ["notes=https://flag.test"],
      })
    ).exitCode,
    2
  );
});

test("--url accepts a credentials file for that one server", () => {
  const cwd = workspace({
    "creds.json": {
      version: 1,
      serverUrl: "https://single.test/mcp",
      accessToken: "at_single",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  const bindings = resolve(cwd, ["notes"], {
    singleServer: {
      url: "https://single.test/mcp",
      credentialsFile: path.join(cwd, "creds.json"),
    },
  });
  assert.equal(
    (bindings.notes!.config as { accessToken?: string }).accessToken,
    "at_single"
  );
});

test("ignores entries for servers the suite does not target", () => {
  const cwd = workspace({
    ".mcp.json": {
      mcpServers: {
        notes: { url: "https://notes.test" },
        other: { command: "definitely-not-a-real-binary" },
      },
    },
  });
  assert.deepEqual(Object.keys(resolve(cwd, ["notes"])), ["notes"]);
});
