/**
 * Starting and stopping the one dev instance a driver owns. It wraps
 * `npm run dev:worktree -- <N> --no-worker`, the launcher contributors use,
 * and records what it started in a state file outside the repo so `stop`
 * only ever stops that process tree.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { computeInstancePorts } from "../../bin/runtime-profile.mjs";
import { findPortConflicts, pickFreeInstance } from "../dev-worktree.mjs";
import { redactLog, resolveNpmCli } from "./inspector-driver-core.mjs";

/**
 * Under the home directory, not the system temp directory: the state file
 * holds the session token and a pid that `stop` kills, and on Linux and macOS
 * any local user can write to /tmp.
 */
export const DRIVER_HOME = join(homedir(), ".mcpjam", "driver");

/** POSIX only: Windows has no uid, and its profile directory is per-user. */
function assertPrivate(path) {
  if (typeof process.getuid !== "function") return;
  const stat = statSync(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(
      `${path} must be owned by you and closed to other users (chmod go-rwx). Refusing to use it.`,
    );
  }
}

/** Creates the driver's directory closed to other users, and checks it is. */
export function ensureDriverHome() {
  mkdirSync(DRIVER_HOME, { recursive: true, mode: 0o700 });
  assertPrivate(DRIVER_HOME);
  return DRIVER_HOME;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    // Not a URL at all.
    return false;
  }
}

/** One state file per inspector checkout, so worktrees never share one. */
export function statePath(inspectorDir) {
  const id = createHash("sha256")
    .update(inspectorDir)
    .digest("hex")
    .slice(0, 12);
  return join(DRIVER_HOME, `instance-${id}.json`);
}

/**
 * The state decides which process `stop` kills and where the token is sent,
 * so a file that is not ours, or that names anything but a local instance,
 * is refused instead of trusted.
 */
export function readState(inspectorDir) {
  const path = statePath(inspectorDir);
  if (!existsSync(path)) return null;
  assertPrivate(DRIVER_HOME);
  assertPrivate(path);
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Number.isInteger(state.pid) ||
    state.pid <= 1 ||
    !isLoopbackUrl(state.baseUrl)
  ) {
    throw new Error(`${path} is not a driver state file. Delete it and run \`start\`.`);
  }
  return state;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

function tail(path, lines = 30) {
  if (!existsSync(path)) return "(no log)";
  return redactLog(readFileSync(path, "utf8"))
    .split("\n")
    .slice(-lines)
    .join("\n");
}

async function responds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    // Not listening yet, or still compiling: the caller polls again.
    return false;
  }
}

export async function startInstance({
  inspectorDir,
  instance,
  worker = false,
  prepare = true,
  timeoutSeconds = 300,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const existing = readState(inspectorDir);
  if (existing && isAlive(existing.pid)) {
    throw new Error(
      `This checkout already has a driver instance (pid ${existing.pid}, ${existing.baseUrl}). Run \`stop\` first.`,
    );
  }
  const launcherArgs = { portOverrides: {}, worker };
  const chosen = instance ?? (await pickFreeInstance(launcherArgs));
  const ports = computeInstancePorts(chosen);
  const token = randomBytes(24).toString("base64url");
  const npmCli = resolveNpmCli();
  if (!npmCli && process.platform === "win32") {
    throw new Error(
      "Could not find npm-cli.js next to this Node; run the driver through `npm run driver`.",
    );
  }
  ensureDriverHome();
  const logPath = join(DRIVER_HOME, `instance-${chosen}.log`);
  // The dev server prints its access link, so the log is as private as the state.
  const logFd = openSync(logPath, "w", 0o600);
  const args = [
    "run",
    "dev:worktree",
    "--",
    String(chosen),
    ...(worker ? [] : ["--no-worker"]),
    ...(prepare ? [] : ["--skip-prepare"]),
  ];
  const child = spawn(
    npmCli ? process.execPath : "npm",
    npmCli ? [npmCli, ...args] : args,
    {
      cwd: inspectorDir,
      // A token the driver chose, so it can sign its browser in without
      // reading the access link back out of the log.
      env: {
        ...process.env,
        MCPJAM_SESSION_TOKEN: token,
        MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    },
  );
  closeSync(logFd);
  child.unref();
  const state = {
    pid: child.pid,
    instance: chosen,
    ports,
    baseUrl: `http://localhost:${ports.client}`,
    token,
    logPath,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(statePath(inspectorDir), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  log(
    `starting instance ${chosen}: client :${ports.client} server :${ports.server} (pid ${child.pid}, log ${logPath})`,
  );

  const startedMs = Date.now();
  const deadline = startedMs + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) {
      rmSync(statePath(inspectorDir), { force: true });
      throw new Error(
        `The launcher exited before it was ready. Log tail:\n${tail(logPath)}`,
      );
    }
    const ready =
      (await responds(`http://localhost:${ports.server}/health`)) &&
      (await responds(state.baseUrl));
    if (ready) {
      log(
        `ready ${state.baseUrl} after ${Math.round((Date.now() - startedMs) / 1_000)}s`,
      );
      return state;
    }
    await sleep(1_000);
  }
  await stopInstance({ inspectorDir, log });
  throw new Error(
    `Not ready after ${timeoutSeconds}s; stopped it. A server that crashes under ` +
      "`tsx watch` waits for a file change instead of exiting, so a missing build " +
      "output (try without --skip-prepare) looks like a slow start. " +
      `Full log: ${logPath}\nLog tail:\n${tail(logPath)}`,
  );
}

function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function stopInstance({
  inspectorDir,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const state = readState(inspectorDir);
  if (!state) {
    log("no driver instance recorded for this checkout");
    return;
  }
  if (isAlive(state.pid)) killTree(state.pid);
  // Only the ports this launch listens on; the worker pair may belong to
  // another instance when this one ran with --no-worker.
  const owned = { client: state.ports.client, server: state.ports.server };
  const deadline = Date.now() + 20_000;
  let conflicts = await findPortConflicts(owned);
  while (conflicts.length > 0 && Date.now() < deadline) {
    await sleep(500);
    conflicts = await findPortConflicts(owned);
  }
  rmSync(statePath(inspectorDir), { force: true });
  if (conflicts.length > 0) {
    throw new Error(
      `Stopped pid ${state.pid}, but ${conflicts.map((c) => `${c.role} :${c.port}`).join(", ")} still in use. ` +
        "Find the owner of that port and stop it if it is this instance.",
    );
  }
  log(`stopped instance ${state.instance} (pid ${state.pid}); ports free`);
}
