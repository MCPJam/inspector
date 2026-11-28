import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

// A copy of bin/ beside a stub dist/server/index.js, so start.js runs end to
// end without a real build. The stub prints to stdout, confirms the launch's
// session token and listens on PORT, like the real server does.
function stubProject(serverSource) {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-start-"));
  const here = dirname(fileURLToPath(import.meta.url));
  cpSync(join(here, "..", "..", "bin"), join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "dist", "server"), { recursive: true });
  // Outside the repo's package scope the .js files are CommonJS on Node
  // before 22.7, which does not detect module syntax.
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "dist", "server", "index.js"), serverSource);
  symlinkSync(
    join(here, "..", "..", "..", "node_modules"),
    join(root, "node_modules"),
    "junction",
  );
  return root;
}

const LISTENING_STUB = `
import { createServer } from "node:http";
console.log("STUB server log line on stdout");
// The test closes the launcher's stdin when it is done. Killing the launcher
// on Windows is abrupt and leaves this process holding the output pipes, so
// the stub ends itself when its stdin does.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
createServer((req, res) => {
  const ok = req.headers["x-mcp-session-auth"] === "Bearer " + process.env.MCPJAM_SESSION_TOKEN;
  res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

// A port the OS has just handed out, so a stub launch cannot collide with
// another test file or a CI neighbour the way a random pick can.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function runStub(root, args, { stopAfterReady = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "bin", "start.js"), ...args], {
      env: { ...process.env, MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      resolve({ status, stdout, stderr });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stopAfterReady && stdout.includes('"event":"ready"')) {
        setTimeout(() => {
          // The stub server ends with its stdin; then the launcher is stopped.
          child.stdin.end();
          child.kill("SIGTERM");
        }, 300);
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // A pipe held open by a process that outlived the launcher must not keep
    // the test from finishing: `exit` is enough once output has had a moment.
    child.on("exit", (status) => {
      setTimeout(() => settle(status), 500);
    });
    child.on("close", (status) => settle(status));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdin.end();
      setTimeout(() => settle(null), 1000);
    }, 30_000);
    // Release the pipe handles once the result is in, so a process that
    // outlived the launcher cannot keep the test runner alive.
    const release = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
  });
}

test("--json with a running server: stdout is exactly one ready line, the server's output goes to stderr", async () => {
  const root = stubProject(LISTENING_STUB);
  try {
    const port = await freePort();
    const result = await runStub(root, ["--json", "--port", String(port)], {
      stopAfterReady: true,
    });
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const ready = JSON.parse(lines[0]);
    assert.equal(ready.event, "ready");
    assert.equal(ready.port, port);
    assert.match(ready.url, /#token=/);
    assert.match(result.stderr, /STUB server log line on stdout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json: a server that exits before it is ready is one error event, not an unhandled rejection", async () => {
  const root = stubProject('console.error("boom"); process.exit(1);');
  try {
    const port = await freePort();
    const result = await runStub(root, ["--json", "--port", String(port)]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /unhandled|UnhandledPromiseRejection/i);
    const events = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.deepEqual(events, [
      { event: "error", message: "Server process exited with code 1" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json: a server that exits cleanly before it is ready is still a failed start", async () => {
  const root = stubProject('console.error("done early"); process.exit(0);');
  try {
    const port = await freePort();
    const result = await runStub(root, ["--json", "--port", String(port)]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const events = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.deepEqual(events, [
      { event: "error", message: "Server process exited with code 0" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a listener that does not accept this launch's token is not reported as ready", async () => {
  // Answers 401 to every token: the TCP port is open, but it is not this launch.
  const root = stubProject(`
    import { createServer } from "node:http";
    // Ends with its stdin, like the ready-path stub, so a killed launcher
    // cannot leave this process holding the output pipes.
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    createServer((req, res) => { res.writeHead(401); res.end(); })
      .listen(Number(process.env.PORT), "127.0.0.1");
  `);
  try {
    const port = await freePort();
    const result = await runStub(root, ["--json", "--port", String(port)]);
    assert.equal(result.stdout, "");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Server did not become ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-H with no = does not echo the value", () => {
  const secret = "Bearer sk-live-0123456789abcdef";
  const result = runStart(["-H", `Authorization: ${secret}`, "--port", "notaport"]);
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stderr.includes(secret));
  assert.match(result.stderr, /Invalid header format for -H/);
});

test("a session token passed with -e is redacted from the port error", () => {
  const result = runStart(["--json", "-e", `MCPJAM_SESSION_TOKEN=${TOKEN}`, "--port", TOKEN]);
  assert.ok(!result.stderr.includes(TOKEN));
  assert.match(result.stderr, /Invalid port: \[redacted\]/);
});
