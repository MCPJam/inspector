import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStartOutput,
  errorEventLine,
  hasJsonFlag,
  readyEventLine,
  redactSecrets,
} from "../../bin/start-output.mjs";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz012345";

function capture() {
  const writes = { stdout: [], stderr: [] };
  const output = createStartOutput({
    stdout: (text) => writes.stdout.push(text),
    stderr: (text) => writes.stderr.push(text),
  });
  return { output, writes };
}

test("human mode keeps progress on stdout and sends warnings and errors to stderr", () => {
  const { output, writes } = capture();
  output.out("starting");
  output.warn("careful");
  output.error("Port 6274 is already in use", "❌ Port 6274 is already in use");
  output.ready({ url: "http://127.0.0.1:6274/", port: 6274 });
  output.fail("ignored outside --json");

  assert.deepEqual(writes.stdout, ["starting\n"]);
  assert.deepEqual(writes.stderr, [
    "careful\n",
    "❌ Port 6274 is already in use\n",
  ]);
});

test("--json prints one ready line on stdout and no human progress", () => {
  const { output, writes } = capture();
  output.useJson();
  output.out("banner and progress");
  const url = `http://127.0.0.1:6274/#token=${TOKEN}`;
  output.ready({ url, port: "6274" });
  output.ready({ url, port: 6274 });

  assert.equal(writes.stdout.length, 1);
  assert.ok(writes.stdout[0].endsWith("\n"));
  assert.deepEqual(JSON.parse(writes.stdout[0]), {
    event: "ready",
    url,
    port: 6274,
  });
  assert.deepEqual(writes.stderr, []);
});

test("--json reports a failure once on stderr, without the session token", () => {
  const { output, writes } = capture();
  output.useJson();
  output.addSecret(TOKEN);
  output.fail(`Invalid port: ${TOKEN}\nat http://x/#token=${TOKEN}&tab=a`);
  output.fail("second failure");

  assert.deepEqual(writes.stdout, []);
  assert.equal(writes.stderr.length, 1);
  const line = writes.stderr[0];
  assert.equal(line.trimEnd().split("\n").length, 1);
  assert.ok(!line.includes(TOKEN));
  assert.deepEqual(JSON.parse(line), {
    event: "error",
    message:
      "Invalid port: [redacted]\nat http://x/#token=[redacted]&tab=a",
  });
});

test("a non-zero exit with no event reports the first logged error", () => {
  const { output, writes } = capture();
  output.useJson();
  output.error("MCP config file not found: ./mcp.json");
  output.error("a later, less specific error");
  output.failOnExit(0);
  assert.equal(writes.stderr.length, 2);
  output.failOnExit(1);
  assert.deepEqual(JSON.parse(writes.stderr[2]), {
    event: "error",
    message: "MCP config file not found: ./mcp.json",
  });
});

test("human error lines are redacted too", () => {
  const { output, writes } = capture();
  output.addSecret(TOKEN);
  output.warn(`saw ${TOKEN}`);
  assert.deepEqual(writes.stderr, ["saw [redacted]\n"]);
});

test("event lines are single-line JSON with ANSI color stripped", () => {
  assert.equal(
    readyEventLine({ url: "http://localhost:6274/", port: 6274 }),
    '{"event":"ready","url":"http://localhost:6274/","port":6274}\n',
  );
  assert.equal(
    errorEventLine("\u001b[31mboom\u001b[0m\nnext"),
    '{"event":"error","message":"boom\\nnext"}\n',
  );
  assert.equal(redactSecrets("a token=xyz&b=1", []), "a token=[redacted]&b=1");
});

test("--json is a start flag, not a value or a server argument", () => {
  assert.equal(hasJsonFlag(["--json"]), true);
  assert.equal(hasJsonFlag(["--port", "7000", "--json"]), true);
  assert.equal(hasJsonFlag(["--name", "--json"]), false);
  assert.equal(hasJsonFlag(["--", "--json"]), false);
  assert.equal(hasJsonFlag(["node", "server.js", "--json"]), false);
  assert.equal(hasJsonFlag([]), false);
});

// Spawned, like server/__tests__/harness-install-cli-exit-codes.test.ts: both
// paths fail before start.js builds or spawns a server.
const START = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "start.js",
);

function runStart(args, env = {}) {
  return spawnSync(process.execPath, [START, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

test("start.js writes logError output to stderr", () => {
  const result = runStart(["harness", "bogus"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /usage: mcpjam-inspector harness/);
});

test("start.js --json fails with one redacted error event and no stdout", () => {
  const result = runStart(["--json", "--port", TOKEN], {
    MCPJAM_SESSION_TOKEN: TOKEN,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes(TOKEN));
  const events = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { event: "error", message: "Invalid port: [redacted]" },
  ]);
});
