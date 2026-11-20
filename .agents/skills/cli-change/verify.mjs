#!/usr/bin/env node
/**
 * Run the working tree's built CLI and keep the evidence.
 *
 *   node .agents/skills/cli-change/verify.mjs doctor
 *   node .agents/skills/cli-change/verify.mjs run <label> [--kill-after <s>] -- <mcpjam args...>
 *
 * `run` spawns `node cli/dist/index.js <args>` without a shell, so arguments
 * reach the CLI unchanged on every platform. An argument containing `{http}`
 * starts `examples/conformance/basic/mock-http-server.mjs` on a free loopback
 * port first, replaces `{http}` with its `/mcp` URL, and stops that process
 * when the command exits. Evidence goes to
 * `<os tmpdir>/mcpjam-cli-verify/<label>/`. `run` exits with the CLI's exit
 * code, or 1 when the command was killed.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliEntry = path.join(repoRoot, "cli/dist/index.js");
const httpFixture = path.join(
  repoRoot,
  "examples/conformance/basic/mock-http-server.mjs",
);
const evidenceRoot = path.join(tmpdir(), "mcpjam-cli-verify");
const cliEnv = { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" };

function newestMtime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs,
    );
  }
  return newest;
}

function doctor() {
  const problems = [];
  let built = 0;
  try {
    built = statSync(cliEntry).mtimeMs;
  } catch {
    problems.push(
      "cli/dist/index.js is missing: run `npm run build -w @mcpjam/cli`.",
    );
  }
  if (built && newestMtime(path.join(repoRoot, "cli/src")) > built) {
    problems.push(
      "cli/src is newer than cli/dist: run `npm run build -w @mcpjam/cli`.",
    );
  }

  let sdkDir;
  try {
    const require = createRequire(path.join(repoRoot, "cli/package.json"));
    sdkDir = realpathSync(
      path.dirname(path.dirname(require.resolve("@mcpjam/sdk"))),
    );
  } catch (error) {
    problems.push(`@mcpjam/sdk does not resolve from cli/: ${error.message}`);
  }

  const version = built
    ? spawnSync(process.execPath, [cliEntry, "--version"], {
        env: cliEnv,
        encoding: "utf8",
      })
    : undefined;
  if (version && version.status !== 0) {
    problems.push(
      `mcpjam --version exited ${version.status}: ${version.stderr.trim()}`,
    );
  }

  process.stdout.write(
    [
      `cli entry: ${cliEntry}`,
      `cli version: ${version?.stdout.trim() || "unknown"}`,
      `@mcpjam/sdk: ${sdkDir ?? "unresolved"}`,
      sdkDir && path.relative(repoRoot, sdkDir).startsWith("..")
        ? "@mcpjam/sdk comes from another checkout: SDK changes in this tree are not in the run."
        : undefined,
      ...problems.map((problem) => `PROBLEM: ${problem}`),
      problems.length === 0 ? "doctor: ok" : "doctor: failed",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  return problems.length === 0 ? 0 : 1;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startHttpFixture() {
  const port = await freePort();
  const child = spawn(process.execPath, [httpFixture], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("ready on")) resolve();
    });
    child.once("exit", (code) =>
      reject(
        new Error(
          `HTTP fixture exited ${code} before it was ready:\n${stderr}`,
        ),
      ),
    );
  });
  return { child, url: `http://127.0.0.1:${port}/mcp` };
}

async function run(label, killAfterSeconds, args) {
  const fixture = args.some((arg) => arg.includes("{http}"))
    ? await startHttpFixture()
    : undefined;
  const cliArgs = fixture
    ? args.map((arg) => arg.replaceAll("{http}", fixture.url))
    : args;

  const child = spawn(process.execPath, [cliEntry, ...cliArgs], {
    env: cliEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill();
  }, killAfterSeconds * 1000);
  const exitCode = await new Promise((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  clearTimeout(timer);
  fixture?.child.kill();

  const dir = path.join(evidenceRoot, label);
  mkdirSync(dir, { recursive: true });
  const command = `mcpjam ${cliArgs.join(" ")}`;
  writeFileSync(path.join(dir, "command.txt"), `${command}\n`);
  writeFileSync(path.join(dir, "stdout.txt"), stdout);
  writeFileSync(path.join(dir, "stderr.txt"), stderr);
  writeFileSync(
    path.join(dir, "exit-code.txt"),
    `${killed ? `killed after ${killAfterSeconds}s` : exitCode}\n`,
  );
  process.stdout.write(
    [
      `command: ${command}`,
      `exit code: ${killed ? `killed after ${killAfterSeconds}s` : exitCode}`,
      `--- stdout (${stdout.length} chars)`,
      stdout.trimEnd(),
      `--- stderr (${stderr.length} chars)`,
      stderr.trimEnd(),
      `evidence: ${dir}`,
    ].join("\n") + "\n",
  );
  return killed || exitCode === null ? 1 : exitCode;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "doctor") {
  process.exitCode = doctor();
} else if (mode === "run" && rest[0] && rest.includes("--")) {
  const separator = rest.indexOf("--");
  const options = rest.slice(1, separator);
  const killIndex = options.indexOf("--kill-after");
  const killAfter = killIndex === -1 ? 60 : Number(options[killIndex + 1]);
  process.exitCode = await run(rest[0], killAfter, rest.slice(separator + 1));
} else {
  process.stderr.write(
    "Usage: verify.mjs doctor\n       verify.mjs run <label> [--kill-after <seconds>] -- <mcpjam args...>\n",
  );
  process.exitCode = 2;
}
