#!/usr/bin/env node
/**
 * Run the working tree's built CLI and keep the evidence.
 *
 *   node .agents/skills/cli-change/verify.mjs doctor
 *   node .agents/skills/cli-change/verify.mjs run <label> [--kill-after <s>] -- <mcpjam args...>
 *
 * `run` spawns `node cli/dist/index.js <args>` without a shell, so arguments
 * reach the CLI unchanged on every platform. The CLI gets a fresh empty home
 * directory and no `MCPJAM_*` or credential-like environment variables, so a
 * saved login, API key or telemetry state on this machine does not reach it.
 * An argument containing `{http}` starts
 * `examples/conformance/basic/mock-http-server.mjs` on a free loopback port
 * first, replaces `{http}` with its `/mcp` URL, and stops that process when
 * the command exits. `--kill-after` bounds the whole run, fixture startup
 * included, and kills the CLI's process tree when it runs out. Evidence goes
 * to a new private `<os tmpdir>/mcpjam-cli-verify-<label>-XXXXXX/` directory.
 * `run` exits with the CLI's exit code, or 1 when the command was killed.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
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
const verifyScript = path
  .relative(repoRoot, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join("/");
const cliEntry = path.join(repoRoot, "cli/dist/index.js");
const httpFixture = path.join(
  repoRoot,
  "examples/conformance/basic/mock-http-server.mjs",
);
const DEFAULT_KILL_AFTER_SECONDS = 60;

/**
 * The caller's environment minus anything that carries MCPJam state or a
 * credential, with every home and config directory the CLI and SDK read
 * pointed at `home`.
 */
function isolatedEnv(home) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^MCPJAM_/i.test(name) &&
        !/(?:API_?KEY|TOKEN|SECRET|PASSWORD)/i.test(name),
    ),
  );
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    MCPJAM_TELEMETRY_DISABLED: "1",
    MCPJAM_NO_UPDATE_CHECK: "1",
    MCPJAM_NON_INTERACTIVE: "1",
  };
}

// Flags whose value is a credential. `-env` and `-file` variants name an
// environment variable or a path, so they stay readable.
const SECRET_FLAG = /^--[\w-]*(?:token|secret|password|key|header)$/;
const NAMES_A_SOURCE = /-(?:env|file|endpoint|auth-method)$/;

function scrubArgs(args) {
  const scrubbed = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    const isEnv = flag === "--env";
    if (!isEnv && !(SECRET_FLAG.test(flag) && !NAMES_A_SOURCE.test(flag))) {
      scrubbed.push(args[i]);
      continue;
    }
    // `--env NAME=value` keeps the name.
    const redact = (value) =>
      isEnv ? value.replace(/=.*/s, "=<redacted>") : "<redacted>";
    if (inline !== undefined) {
      scrubbed.push(`${flag}=${redact(inline)}`);
    } else {
      scrubbed.push(flag);
      if (i + 1 < args.length) scrubbed.push(redact(args[++i]));
    }
  }
  return scrubbed;
}

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

  let version;
  if (built) {
    const home = mkdtempSync(path.join(tmpdir(), "mcpjam-cli-home-"));
    try {
      version = spawnSync(process.execPath, [cliEntry, "--version"], {
        env: isolatedEnv(home),
        encoding: "utf8",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
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

// Spawned children lead their own process group on POSIX, so `killTree`
// reaches whatever they started.
function spawnNode(args, options) {
  return spawn(process.execPath, args, {
    ...options,
    detached: process.platform !== "win32",
    windowsHide: true,
  });
}

function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

class DeadlineError extends Error {}

function atDeadline(deadline, onExpire) {
  return setTimeout(onExpire, Math.max(0, deadline - Date.now()));
}

async function startHttpFixture(env, deadline) {
  const port = await freePort();
  const child = spawnNode([httpFixture], {
    env: { ...env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = atDeadline(deadline, () =>
        reject(
          new DeadlineError(
            `HTTP fixture was not ready before the deadline:\n${stderr}`,
          ),
        ),
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.includes("ready on")) resolve();
      });
      child.once("error", (error) =>
        reject(new Error(`HTTP fixture failed to start: ${error.message}`)),
      );
      child.once("exit", (code) =>
        reject(
          new Error(
            `HTTP fixture exited ${code} before it was ready:\n${stderr}`,
          ),
        ),
      );
    });
  } catch (error) {
    killTree(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { child, url: `http://127.0.0.1:${port}/mcp` };
}

async function runCli(cliArgs, env, deadline) {
  const child = spawnNode([cliEntry, ...cliArgs], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  // Decode as a stream so a UTF-8 character split across chunks stays whole.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let killed = false;
  const timer = atDeadline(deadline, () => {
    killed = true;
    killTree(child);
    // A descendant that outlived the kill would hold the pipes open, and
    // `close` would never come.
    child.stdout.destroy();
    child.stderr.destroy();
  });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    return { exitCode, stdout, stderr, killed };
  } finally {
    clearTimeout(timer);
  }
}

// Quote for bash, so command.txt can be pasted back and keeps JSON quotes
// and argument boundaries.
function shellQuote(arg) {
  return /^[\w@%+=:,./{}-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", "'\\''")}'`;
}

async function run(label, killAfterSeconds, args) {
  const deadline = Date.now() + killAfterSeconds * 1000;
  const home = mkdtempSync(path.join(tmpdir(), "mcpjam-cli-home-"));
  const env = isolatedEnv(home);
  let fixture;
  let result;
  try {
    fixture = args.some((arg) => arg.includes("{http}"))
      ? await startHttpFixture(env, deadline)
      : undefined;
    const cliArgs = fixture
      ? args.map((arg) => arg.replaceAll("{http}", fixture.url))
      : args;
    result = { ...(await runCli(cliArgs, env, deadline)), cliArgs };
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error;
    result = { exitCode: null, stdout: "", stderr: error.message, killed: true };
  } finally {
    if (fixture) killTree(fixture.child);
    rmSync(home, { recursive: true, force: true });
  }

  const dir = mkdtempSync(path.join(tmpdir(), `mcpjam-cli-verify-${label}-`));
  // The replay keeps `{http}`: the fixture URL this run used is gone.
  const replay = [
    "node",
    verifyScript,
    "run",
    label,
    "--kill-after",
    String(killAfterSeconds),
    "--",
    ...scrubArgs(args),
  ];
  const command = replay.map(shellQuote).join(" ");
  const exit = result.killed
    ? `killed after ${killAfterSeconds}s`
    : String(result.exitCode);
  writeFileSync(
    path.join(dir, "command.txt"),
    `# bash, from the repo root\n${command}\n`,
  );
  writeFileSync(
    path.join(dir, "run.json"),
    `${JSON.stringify(
      {
        replay,
        executable: process.execPath,
        cliEntry,
        cliArgs: result.cliArgs && scrubArgs(result.cliArgs),
        fixtureUrl: fixture?.url,
        killAfterSeconds,
        exitCode: result.exitCode,
        killed: result.killed,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(dir, "stdout.txt"), result.stdout);
  writeFileSync(path.join(dir, "stderr.txt"), result.stderr);
  writeFileSync(path.join(dir, "exit-code.txt"), `${exit}\n`);
  process.stdout.write(
    [
      `command: ${command}`,
      `exit code: ${exit}`,
      `--- stdout (${result.stdout.length} chars)`,
      result.stdout.trimEnd(),
      `--- stderr (${result.stderr.length} chars)`,
      result.stderr.trimEnd(),
      `evidence: ${dir}`,
    ].join("\n") + "\n",
  );
  return result.killed || result.exitCode === null ? 1 : result.exitCode;
}

function usage(problem) {
  process.stderr.write(
    `${problem ? `${problem}\n` : ""}Usage: verify.mjs doctor\n       verify.mjs run <label> [--kill-after <seconds>] -- <mcpjam args...>\n`,
  );
  return 2;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "doctor") {
  process.exitCode = doctor();
} else if (mode === "run" && rest[0] && rest.includes("--")) {
  const [label] = rest;
  const separator = rest.indexOf("--");
  const options = rest.slice(1, separator);
  const killIndex = options.indexOf("--kill-after");
  const killAfterInput =
    killIndex === -1 ? String(DEFAULT_KILL_AFTER_SECONDS) : options[killIndex + 1];
  const killAfter = Number(killAfterInput);
  if (!/^[\w.-]+$/.test(label) || /^\.+$/.test(label)) {
    process.exitCode = usage(
      `The label must be one path component of letters, digits, '.', '_' or '-': ${JSON.stringify(label)}`,
    );
  } else if (!Number.isFinite(killAfter) || killAfter <= 0) {
    process.exitCode = usage(
      `--kill-after must be a positive number of seconds, got ${JSON.stringify(killAfterInput)}.`,
    );
  } else {
    process.exitCode = await run(label, killAfter, rest.slice(separator + 1));
  }
} else {
  process.exitCode = usage();
}
