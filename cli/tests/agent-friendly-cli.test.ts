import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { startMockStreamableHttpServer } from "../../sdk/tests/mock-servers/index.js";

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");
const requireFromCli = createRequire(path.join(CLI_DIR, "package.json"));
const TSX_CLI_PATH = requireFromCli.resolve("tsx/cli");
const CLI_ENTRY_PATH = path.join(CLI_DIR, "src", "index.ts");

async function runCli(
  args: string[],
  input?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI_PATH, CLI_ENTRY_PATH, ...args], {
      cwd: CLI_DIR,
      env: { ...process.env, MCPJAM_CLI_DISABLE_BROWSER_OPEN: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    child.stdin.end(input ?? "");
  });
}

test("--format junit-xml is rejected for conformance commands", async () => {
  const protocol = await runCli([
    "--format",
    "junit-xml",
    "protocol",
    "conformance",
    "--url",
    "https://example.com/mcp",
  ]);
  assert.equal(protocol.exitCode, 2);
  assert.match(protocol.stderr, /--reporter junit-xml/);

  const oauth = await runCli([
    "--format",
    "junit-xml",
    "oauth",
    "conformance",
    "--url",
    "https://example.com/mcp",
    "--protocol-version",
    "2025-11-25",
    "--registration",
    "dcr",
  ]);
  assert.equal(oauth.exitCode, 2);
  assert.match(oauth.stderr, /--reporter junit-xml/);

  const apps = await runCli([
    "--format",
    "junit-xml",
    "apps",
    "conformance",
    "--url",
    "https://example.com/mcp",
  ]);
  assert.equal(apps.exitCode, 2);
  assert.match(apps.stderr, /--reporter junit-xml/);
});

test("protocol conformance supports junit reporter output", async () => {
  const server = await startMockStreamableHttpServer();

  try {
    const result = await runCli([
      "--format",
      "json",
      "protocol",
      "conformance",
      "--url",
      server.url,
      "--check-id",
      "ping",
      "--reporter",
      "junit-xml",
    ]);

    assert.notEqual(result.exitCode, 2, result.stderr);
    assert.match(result.stdout, /^<\?xml version="1\.0"/);
    assert.match(result.stdout, /<testsuites/);
  } finally {
    await server.stop();
  }
});

test("JSON options accept stdin and reject duplicate stdin consumers", async () => {
  const valid = await runCli(
    [
      "--format",
      "json",
      "server",
      "probe",
      "--url",
      "http://127.0.0.1:9/mcp",
      "--timeout",
      "1",
      "--client-capabilities",
      "-",
    ],
    '{"sampling":{}}\n',
  );
  assert.notEqual(valid.exitCode, 2);

  const invalid = await runCli(
    [
      "--format",
      "json",
      "server",
      "probe",
      "--url",
      "http://127.0.0.1:9/mcp",
      "--timeout",
      "1",
      "--client-capabilities",
      "-",
    ],
    "{",
  );
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /Client capabilities must be valid JSON/);

  const duplicate = await runCli(
    [
      "--format",
      "json",
      "tools",
      "call",
      "--command",
      "node",
      "--client-capabilities",
      "-",
      "--tool-name",
      "echo",
      "--tool-args",
      "-",
    ],
    '{"sampling":{}}\n',
  );
  assert.equal(duplicate.exitCode, 2);
  assert.match(duplicate.stderr, /stdin was already consumed/);
});
