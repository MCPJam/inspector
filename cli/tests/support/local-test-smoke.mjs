// An account-free `mcpjam test` smoke, shared by the built-CLI test
// (`tests/local-test-smoke.test.ts`) and the packed-package release smoke
// (`.github/scripts/smoke-packed-npm-packages.mjs`).
//
// It exercises the PRODUCTION path end to end — the CLI binary, local config
// discovery, the SDK runner and the real provider factory — against a
// loopback Anthropic-compatible stub (reached through the standard
// ANTHROPIC_BASE_URL variable) and a real stdio MCP server. No account, no
// login, no paid inference, and no test-only flag.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const SUITE = `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_local_smoke
  name: local smoke
target:
  servers:
    - name: notes
defaults:
  judge:
    enabled: false
  model: anthropic/claude-haiku-4.5
  iterations: 1
  passThreshold: 1
  validity: {}
cases:
  - id: c_reads
    title: reads the note
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: read_note
  - id: c_fails
    title: expects a tool it never gets
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 8
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: echo
`;

/** A minimal Anthropic Messages API: call read_note once, then answer. */
export async function startAnthropicStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      if (req.method !== "POST" || !req.url?.endsWith("/v1/messages")) {
        res.writeHead(404).end("not found");
        return;
      }
      const toolTurn = !body.includes("tool_result");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: toolTurn
            ? [
                {
                  type: "tool_use",
                  id: `toolu_${requests.length}`,
                  name: "read_note",
                  input: { id: "7" },
                },
              ]
            : [{ type: "text", text: "The note says buy milk." }],
          stop_reason: toolTurn ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 4 },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function runCli(cliEntry, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`mcpjam ${args.join(" ")} timed out.\n${stderr}`));
    }, options.timeoutMs ?? 60_000);
    child.on("error", reject);
    // `close`, not `exit`: only `close` waits for stdio to drain, and the
    // caller parses stdout as one JSON document.
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

function assert(condition, message) {
  if (!condition) throw new Error(`local test smoke: ${message}`);
}

/**
 * Run the smoke. `cliEntry` is the CLI's JS entry (built `dist/index.js`, or
 * the installed package's bin); `fixturePath` a stdio MCP server resolvable
 * from where it lives; `workDir` a fresh empty directory.
 */
export async function runLocalTestSmoke({
  cliEntry,
  fixturePath,
  workDir,
  env = process.env,
}) {
  const stub = await startAnthropicStub();
  try {
    mkdirSync(path.join(workDir, ".mcpjam", "evals"), { recursive: true });
    mkdirSync(path.join(workDir, "home"), { recursive: true });
    writeFileSync(
      path.join(workDir, ".mcpjam", "evals", "example.yaml"),
      SUITE
    );
    const pidFile = path.join(workDir, "server.pid");
    writeFileSync(
      path.join(workDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          notes: {
            command: process.execPath,
            args: [fixturePath],
            env: { POLICY_TARGET_PID_FILE: pidFile },
          },
        },
      })
    );
    const childEnv = {
      PATH: env.PATH ?? "",
      // A fresh HOME: no stored login exists, so the run is account-free.
      HOME: path.join(workDir, "home"),
      USERPROFILE: path.join(workDir, "home"),
      MCPJAM_TELEMETRY_DISABLED: "1",
      ANTHROPIC_API_KEY: "sk-ant-smoke-not-a-real-key",
      ANTHROPIC_BASE_URL: stub.baseUrl,
    };

    // The whole suite: one pass, one measured failure → exit 1.
    const full = await runCli(
      cliEntry,
      ["--format", "json", "test", ".mcpjam/evals/example.yaml"],
      {
        cwd: workDir,
        env: childEnv,
      }
    );
    assert(
      full.exitCode === 1,
      `expected exit 1 for a failed decision, got ${full.exitCode}\n${full.stderr}`
    );
    const report = JSON.parse(full.stdout);
    assert(report.kind === "eval-local-run", "stdout is not the local report");
    assert(report.verdict === "failed", `verdict ${report.verdict}`);
    assert(
      report.metadata.execution.servers[0].source === ".mcp.json",
      "the binding was not discovered from ./.mcp.json"
    );
    assert(report.metadata.upload.requested === false, "upload must be off");

    // Rerun the passing case alone → exit 0.
    const rerun = await runCli(
      cliEntry,
      [
        "--format",
        "json",
        "test",
        ".mcpjam/evals/example.yaml",
        "--case",
        "c_reads",
        "--out",
        "report.json",
      ],
      { cwd: workDir, env: childEnv }
    );
    assert(
      rerun.exitCode === 0,
      `expected exit 0 for the single-case rerun, got ${rerun.exitCode}\n${rerun.stderr}`
    );
    assert(
      existsSync(path.join(workDir, "report.json")),
      "--out artifact was not written"
    );
    const artifact = JSON.parse(
      readFileSync(path.join(workDir, "report.json"), "utf8")
    );
    assert(
      JSON.stringify(artifact.metadata.selection.selected) === '["c_reads"]',
      "the rerun selected more than one case"
    );

    // The production factory reached the stub with the BYOK key, and nothing
    // else left the process.
    const messages = stub.requests.filter((request) =>
      request.url?.endsWith("/v1/messages")
    );
    assert(messages.length >= 2, "the provider stub was never called");
    assert(
      messages.every(
        (request) =>
          request.headers["x-api-key"] === "sk-ant-smoke-not-a-real-key"
      ),
      "the BYOK key was not sent"
    );

    // The stdio server this run started is gone.
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert(
      await waitForExit(pid, 5000),
      `the MCP server process ${pid} outlived the run`
    );
    return { full, rerun, requests: stub.requests };
  } finally {
    await stub.close();
  }
}
