#!/usr/bin/env node

/**
 * Launch a complete development instance on its own ports, so several
 * worktrees (or several instances of one) run side by side.
 *
 * Usage:
 *   npm run dev:worktree -- <instance> [local|staging|preview <viteConvexUrl> <convexHttpUrl>]
 *                           [--env-file <profile>] [--client-port N] [--server-port N]
 *                           [--worker-port N] [--debugger-port N] [--no-worker]
 *                           [--skip-prepare] [--print-config]
 *
 * Ports (instance N, each overridable):
 *   client 5173+N   server 6274+N   worker 8787+N   worker debugger 9229+N
 *
 * The configuration is resolved ONCE, here (`bin/runtime-profile.mjs`), and
 * handed to the server, Vite and the platform MCP worker in their environment
 * with `MCPJAM_RESOLVED_RUNTIME=1`, so none of them reads a `.env` file of its
 * own. Every per-instance address — the API base, allowed origins, the CLI
 * login and Slack/Discord callback origins, the worker's platform URL — is
 * computed from this instance's ports; an inherited value from the main
 * instance never survives a port change.
 *
 * All children run in their own process groups and are stopped together: when
 * any of them exits, when startup fails, and when this launcher exits.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccessLink, createLaunchToken } from "../bin/access-link.mjs";
import {
  RuntimeConfigError,
  buildChildEnv,
  computeInstanceEnv,
  computeInstancePorts,
  computeWorkerVars,
  describeProfile,
  findMainInspectorDir,
  formatEnvAssignment,
  resolveRuntimeProfile,
} from "../bin/runtime-profile.mjs";

const TARGETS = new Set(["local", "staging", "preview"]);
const LOCAL_DEV_SERVICE_TOKEN = "mcpjam-local-dev-service-token";

export function parseLauncherArgs(argv) {
  const positional = [];
  const options = {
    envFile: undefined,
    portOverrides: {},
    worker: true,
    prepare: true,
    printConfig: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value === undefined)
        throw new RuntimeConfigError(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--env-file") options.envFile = take();
    else if (arg.startsWith("--env-file=")) options.envFile = arg.slice(11);
    else if (arg === "--client-port") options.portOverrides.client = take();
    else if (arg === "--server-port") options.portOverrides.server = take();
    else if (arg === "--worker-port") options.portOverrides.worker = take();
    else if (arg === "--debugger-port") options.portOverrides.debugger = take();
    else if (arg === "--no-worker") options.worker = false;
    else if (arg === "--skip-prepare") options.prepare = false;
    else if (arg === "--print-config") options.printConfig = true;
    else if (arg.startsWith("--"))
      throw new RuntimeConfigError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  const instance = Number(positional[0]);
  if (
    positional[0] === undefined ||
    !/^\d+$/.test(positional[0]) ||
    !Number.isInteger(instance)
  ) {
    throw new RuntimeConfigError(
      "Usage: npm run dev:worktree -- <instance> [local|staging|preview <viteConvexUrl> <convexHttpUrl>] [--env-file <profile>]",
    );
  }
  const target = positional[1] ?? "local";
  if (!TARGETS.has(target)) {
    throw new RuntimeConfigError(
      `Unknown target "${target}" (expected local, staging or preview).`,
    );
  }
  const previewUrls = target === "preview" ? positional.slice(2, 4) : undefined;
  if (target !== "preview" && positional.length > 2) {
    throw new RuntimeConfigError(
      `Unexpected arguments: ${positional.slice(2).join(" ")}`,
    );
  }
  return { instance, target, previewUrls, ...options };
}

function gitCommonDir(cwd) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd,
      encoding: "utf8",
    },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Everything the launch needs, with no side effects beyond reading profile
 * files. Exported for tests.
 */
export function planLaunch({
  args,
  inspectorDir,
  env = process.env,
  mainInspectorDir,
}) {
  const ports = computeInstancePorts(args.instance, args.portOverrides);
  const profile = resolveRuntimeProfile({
    target: args.target,
    envFile: args.envFile,
    previewUrls: args.previewUrls,
    inspectorDir,
    // A main-worktree profile is a fallback for the default target ONLY.
    mainInspectorDir:
      args.envFile || args.target !== "local" ? null : mainInspectorDir,
    env,
  });
  const instanceEnv = computeInstanceEnv({
    ports,
    browserPort: ports.client,
    profile: profile.instanceHints,
    withWorker: args.worker,
  });
  const { env: childEnv, droppedInheritedKeys } = buildChildEnv({
    baseEnv: env,
    profileValues: profile.values,
    instanceEnv,
  });
  const workerVars = args.worker
    ? {
        ...computeWorkerVars({ ports, profile: profile.values }),
        // The worker's local-only sentinel, accepted by this instance's server
        // only because `dev:server` opts in (ALLOW_LOCAL_DEV_SERVICE_TOKEN).
        MCPJAM_INSPECTOR_SERVICE_TOKEN: LOCAL_DEV_SERVICE_TOKEN,
      }
    : null;
  return { ports, profile, childEnv, droppedInheritedKeys, workerVars };
}

// ── ports ─────────────────────────────────────────────────────────────────

function probe(port, host) {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once("error", (error) => {
      // No IPv6 on this machine is not a conflict.
      resolvePromise(
        error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT",
      );
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export async function findPortConflicts(ports) {
  const conflicts = [];
  for (const [role, port] of Object.entries(ports)) {
    const free = (await probe(port, "127.0.0.1")) && (await probe(port, "::1"));
    if (!free) conflicts.push({ role, port });
  }
  return conflicts;
}

// ── supervision ───────────────────────────────────────────────────────────

/**
 * Run children as one unit. Each gets its own process group, so stopping it
 * also stops whatever it started (npm → vite, npm → wrangler → workerd).
 */
export function createSupervisor({
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const children = new Set();
  let stopping = false;
  let resolveDone;
  const done = new Promise((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  let exitCode = 0;

  const signalGroup = (child, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      // Already gone.
    }
  };

  const stopAll = (code) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) signalGroup(child, "SIGTERM");
    const force = setTimeout(() => {
      for (const child of children) signalGroup(child, "SIGKILL");
    }, 5_000);
    force.unref();
    const check = () => {
      if (
        [...children].every((c) => c.exitCode !== null || c.signalCode !== null)
      ) {
        clearTimeout(force);
        resolveDone(exitCode);
      }
    };
    for (const child of children) child.once("exit", check);
    check();
  };

  return {
    start(name, command, args, options) {
      if (stopping) return null;
      const child = spawn(command, args, {
        stdio: "inherit",
        detached: process.platform !== "win32",
        ...options,
      });
      children.add(child);
      child.once("error", (error) => {
        log(`[${name}] failed to start: ${error.message}`);
        stopAll(1);
      });
      child.once("exit", (code, signal) => {
        if (!stopping) {
          log(
            `[${name}] exited (${signal ?? code}); stopping the other processes.`,
          );
          stopAll(code === 0 ? 0 : (code ?? 1));
        }
      });
      return child;
    },
    stopAll,
    done,
    /** Synchronous last resort for `process.on("exit")`. */
    killAllNow() {
      for (const child of children) signalGroup(child, "SIGKILL");
    },
    get children() {
      return [...children];
    },
  };
}

/**
 * How to run npm. Under `npm run`, npm_execpath names npm's JS entry point:
 * running it with this Node needs no shell, which Node otherwise requires to
 * spawn the Windows `npm.cmd` shim (CVE-2024-27980; spawn fails with EINVAL).
 */
export function npmInvocation({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  const npmCli = env.npm_execpath;
  if (npmCli && /npm-cli\.[cm]?js$/.test(npmCli)) {
    return { command: execPath, args: (args) => [npmCli, ...args] };
  }
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: (args) => args,
  };
}

function runToCompletion(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

async function main() {
  const inspectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { command: npm, args: npmArgs } = npmInvocation();
  let args;
  let plan;
  try {
    args = parseLauncherArgs(process.argv.slice(2));
    const common = gitCommonDir(inspectorDir);
    plan = planLaunch({
      args,
      inspectorDir,
      mainInspectorDir: findMainInspectorDir(inspectorDir, common),
    });
  } catch (error) {
    process.stderr.write(`dev:worktree: ${error.message}\n`);
    process.exit(1);
  }

  const { ports, profile, childEnv, droppedInheritedKeys, workerVars } = plan;
  process.stdout.write(
    `\n🌲 Instance ${args.instance}  client :${ports.client}  server :${ports.server}` +
      (workerVars
        ? `  worker :${ports.worker} (debugger :${ports.debugger})`
        : "") +
      `  target ${args.target}${args.envFile ? ` (${args.envFile})` : ""}\n`,
  );
  for (const layer of profile.layers) {
    process.stdout.write(
      `   profile: ${layer.name}${layer.path ? ` — ${layer.path}` : ""}\n`,
    );
  }
  if (droppedInheritedKeys.length > 0) {
    process.stdout.write(
      `   ignored from your shell (set them in the profile instead): ${droppedInheritedKeys.join(", ")}\n`,
    );
  }
  if (args.printConfig) {
    process.stdout.write(
      `${describeProfile(profile)
        .map((l) => `   ${l}`)
        .join("\n")}\n`,
    );
  }

  const conflicts = await findPortConflicts(
    workerVars ? ports : { client: ports.client, server: ports.server },
  );
  if (conflicts.length > 0) {
    process.stderr.write(
      `dev:worktree: ${conflicts.map((c) => `${c.role} port ${c.port}`).join(", ")} already in use. ` +
        "Pick another instance number or pass --client-port/--server-port/--worker-port/--debugger-port.\n",
    );
    process.exit(1);
  }

  if (args.prepare) {
    try {
      await runToCompletion(npm, npmArgs(["run", "sdk:build"]), {
        cwd: inspectorDir,
        env: childEnv,
      });
      await runToCompletion(npm, npmArgs(["run", "bundle:all"]), {
        cwd: inspectorDir,
        env: childEnv,
      });
    } catch (error) {
      process.stderr.write(
        `dev:worktree: preparation failed: ${error.message}\n`,
      );
      process.exit(1);
    }
  }

  const launchToken = createLaunchToken(childEnv);
  if (launchToken) {
    process.stdout.write(
      `\n➜ Dev\n${createAccessLink(childEnv.MCPJAM_INSPECTOR_FRONTEND_URL, launchToken)}\nKeep this link private: it signs a browser in.\n\n`,
    );
  }

  let workerDir = null;
  const supervisor = createSupervisor();
  const cleanup = () => {
    supervisor.killAllNow();
    if (workerDir) rmSync(workerDir, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => supervisor.stopAll(0));
  }

  const serverEnv = {
    ...childEnv,
    ...(launchToken ? { MCPJAM_SESSION_TOKEN: launchToken } : {}),
  };
  supervisor.start("server", npm, npmArgs(["run", "dev:server"]), {
    cwd: inspectorDir,
    env: serverEnv,
  });
  supervisor.start("client", npm, npmArgs(["run", "dev:client"]), {
    cwd: inspectorDir,
    env: childEnv,
  });

  if (workerVars) {
    const mcpDir = resolve(inspectorDir, "..", "mcp");
    if (!existsSync(join(mcpDir, "wrangler.jsonc"))) {
      process.stderr.write(
        "dev:worktree: ../mcp is missing; run with --no-worker.\n",
      );
      supervisor.stopAll(1);
    } else {
      // The worker reads ONLY this file: passing --env-file stops wrangler
      // from loading `.dev.vars`/`.env`, and process env is not included.
      workerDir = mkdtempSync(join(tmpdir(), "mcpjam-worker-env-"));
      const workerEnvFile = join(workerDir, "worker.env");
      writeFileSync(
        workerEnvFile,
        `${Object.entries(workerVars)
          .map(([key, value]) => formatEnvAssignment(key, value))
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      supervisor.start(
        "worker",
        npm,
        npmArgs([
          "--prefix",
          mcpDir,
          "run",
          "dev:local",
          "--",
          "--port",
          String(ports.worker),
          "--inspector-port",
          String(ports.debugger),
          "--env-file",
          workerEnvFile,
        ]),
        {
          cwd: mcpDir,
          env: { ...childEnv, CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" },
        },
      );
    }
  }

  const code = await supervisor.done;
  cleanup();
  process.exit(code);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
