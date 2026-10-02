import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSupervisor,
  findPortConflicts,
  npmInvocation,
  parseLauncherArgs,
  planLaunch,
} from "../dev-worktree.mjs";

const STANDARD = [
  "VITE_CONVEX_URL=https://energized-ant-201.convex.cloud",
  "VITE_WORKOS_CLIENT_ID=client_01KTN2EWHHJCKRB8RSR307X4SG",
  "CONVEX_HTTP_URL=https://energized-ant-201.convex.site",
].join("\n");

function inspectorDir() {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-launch-"));
  const dir = join(root, "mcpjam-inspector");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env.local"), STANDARD);
  return { dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("keeps the existing local/staging/preview modes and adds --env-file and port overrides", () => {
  assert.deepEqual(parseLauncherArgs(["2"]), {
    instance: 2,
    target: "local",
    previewUrls: undefined,
    envFile: undefined,
    portOverrides: {},
    worker: true,
    prepare: true,
    printConfig: false,
  });
  assert.equal(parseLauncherArgs(["1", "staging"]).target, "staging");
  assert.deepEqual(
    parseLauncherArgs([
      "1",
      "preview",
      "https://a.convex.cloud",
      "https://a.convex.site",
    ]).previewUrls,
    ["https://a.convex.cloud", "https://a.convex.site"],
  );
  const parsed = parseLauncherArgs([
    "1",
    "--env-file",
    "x.env",
    "--server-port",
    "7000",
    "--no-worker",
  ]);
  assert.equal(parsed.envFile, "x.env");
  assert.deepEqual(parsed.portOverrides, { server: "7000" });
  assert.equal(parsed.worker, false);
  assert.throws(() => parseLauncherArgs([]), /Usage/);
  assert.throws(() => parseLauncherArgs(["1", "prod"]), /Unknown target/);
  assert.throws(() => parseLauncherArgs(["1", "--bogus"]), /Unknown option/);
});

test("plans one coherent instance: ports, origins, worker vars, no inherited target", () => {
  const w = inspectorDir();
  try {
    const plan = planLaunch({
      args: parseLauncherArgs(["2"]),
      inspectorDir: w.dir,
      env: {
        PATH: "/bin",
        // A main-instance origin and another target's backend in the shell.
        CLI_AUTH_PUBLIC_ORIGIN: "http://localhost:5173",
        VITE_API_BASE_URL: "http://localhost:6274",
        CONVEX_HTTP_URL: "https://someone-else-9.convex.site",
      },
    });
    assert.deepEqual(plan.ports, {
      client: 5175,
      server: 6276,
      worker: 8789,
      debugger: 9231,
    });
    assert.equal(
      plan.childEnv.CONVEX_HTTP_URL,
      "https://energized-ant-201.convex.site",
    );
    assert.equal(plan.childEnv.CLI_AUTH_PUBLIC_ORIGIN, "http://localhost:5175");
    assert.equal(plan.childEnv.VITE_API_BASE_URL, "http://localhost:6276");
    assert.equal(plan.childEnv.MCPJAM_BROWSER_PORT, "5175");
    assert.equal(
      plan.childEnv.MCPJAM_PLATFORM_MCP_URL,
      "http://localhost:8789/mcp",
    );
    assert.equal(plan.childEnv.MCPJAM_RESOLVED_RUNTIME, "1");
    assert.equal(
      plan.workerVars.PLATFORM_API_URL,
      "http://localhost:6276/api/v1",
    );
    assert.equal(plan.workerVars.MCPJAM_APP_ORIGIN, "http://localhost:6276");
  } finally {
    w.done();
  }
});

test("a worker override changes only the worker's addresses", () => {
  const w = inspectorDir();
  try {
    const plan = planLaunch({
      args: parseLauncherArgs([
        "1",
        "--worker-port",
        "18787",
        "--debugger-port",
        "19229",
      ]),
      inspectorDir: w.dir,
      env: {},
    });
    assert.equal(plan.ports.worker, 18787);
    assert.equal(
      plan.childEnv.MCPJAM_PLATFORM_MCP_URL,
      "http://localhost:18787/mcp",
    );
    assert.equal(
      plan.workerVars.PLATFORM_API_URL,
      "http://localhost:6275/api/v1",
    );
  } finally {
    w.done();
  }
});

test("an explicit target ignores the main worktree's profile", () => {
  const w = inspectorDir();
  const main = inspectorDir();
  writeFileSync(
    join(main.dir, ".env.development.local"),
    "OPENAI_API_KEY=from-main\n",
  );
  try {
    const implicit = planLaunch({
      args: parseLauncherArgs(["1"]),
      inspectorDir: w.dir,
      mainInspectorDir: main.dir,
      env: {},
    });
    assert.equal(implicit.childEnv.OPENAI_API_KEY, "from-main");

    const explicit = planLaunch({
      args: parseLauncherArgs(["1", "--env-file", join(w.dir, ".env.local")]),
      inspectorDir: w.dir,
      mainInspectorDir: main.dir,
      env: {},
    });
    assert.equal(explicit.childEnv.OPENAI_API_KEY, undefined);
  } finally {
    w.done();
    main.done();
  }
});

test("reports ports that are already taken", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const taken = server.address().port;
  try {
    const conflicts = await findPortConflicts({ client: taken });
    assert.deepEqual(conflicts, [{ role: "client", port: taken }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * Running, as opposed to gone or a zombie. An orphaned grandchild that was
 * killed stays a zombie until its new parent reaps it, and in a container
 * PID 1 often never does — `kill(pid, 0)` would still "find" it.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(
      stat.lastIndexOf(")") + 2,
      stat.lastIndexOf(")") + 3,
    );
    return state !== "Z" && state !== "X";
  } catch {
    return true;
  }
}

test(
  "when one child fails at startup, every other child (and what it spawned) is stopped",
  { skip: process.platform === "win32" },
  async () => {
    const supervisor = createSupervisor({ log: () => {} });
    // A long-lived child that itself spawns a grandchild, like npm → vite.
    const parent = supervisor.start(
      "server",
      process.execPath,
      [
        "-e",
        "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('GRANDCHILD',c.pid);setInterval(()=>{},1000)",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const grandchildPid = await new Promise((resolve) => {
      parent.stdout.on("data", (chunk) => {
        const match = /GRANDCHILD (\d+)/.exec(String(chunk));
        if (match) resolve(Number(match[1]));
      });
    });
    supervisor.start("worker", process.execPath, ["-e", "process.exit(3)"], {});

    const code = await supervisor.done;
    assert.equal(code, 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(parent.pid), false);
    assert.equal(alive(grandchildPid), false);
  },
);

test(
  "stopping the launcher stops every child",
  { skip: process.platform === "win32" },
  async () => {
    const supervisor = createSupervisor({ log: () => {} });
    const a = supervisor.start(
      "a",
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {},
    );
    const b = supervisor.start(
      "b",
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    supervisor.stopAll(0);
    assert.equal(await supervisor.done, 0);
    assert.equal(alive(a.pid), false);
    assert.equal(alive(b.pid), false);
  },
);

test("npm runs through its JS entry point, never a Windows .cmd shim", () => {
  const underNpm = npmInvocation({
    env: { npm_execpath: "C:\\npm\\bin\\npm-cli.js" },
    platform: "win32",
    execPath: "C:\\node\\node.exe",
  });
  assert.equal(underNpm.command, "C:\\node\\node.exe");
  assert.deepEqual(underNpm.args(["run", "dev:server"]), [
    "C:\\npm\\bin\\npm-cli.js",
    "run",
    "dev:server",
  ]);

  // Another package manager's entry point is not npm: fall back to npm itself.
  const underPnpm = npmInvocation({
    env: { npm_execpath: "/usr/lib/pnpm/bin/pnpm.cjs" },
    platform: "linux",
    execPath: "/usr/bin/node",
  });
  assert.equal(underPnpm.command, "npm");
  assert.deepEqual(underPnpm.args(["run", "x"]), ["run", "x"]);
});

test("on Windows without npm's entry point the launcher refuses instead of spawning npm.cmd", () => {
  assert.throws(
    () => npmInvocation({ env: {}, platform: "win32", execPath: "node.exe" }),
    /through npm/,
  );
});

test("an empty --env-file is an error, not the default profile", () => {
  assert.throws(() => parseLauncherArgs(["1", "--env-file="]), /needs a path/);
  assert.throws(
    () => parseLauncherArgs(["1", "--env-file", ""]),
    /needs a path/,
  );
});

test("a relative --env-file is resolved from the directory npm was run in", () => {
  const w = inspectorDir();
  try {
    const plan = planLaunch({
      args: parseLauncherArgs([
        "1",
        "--env-file",
        "mcpjam-inspector/.env.local",
      ]),
      inspectorDir: w.dir,
      env: { INIT_CWD: join(w.dir, "..") },
    });
    assert.equal(
      plan.childEnv.CONVEX_HTTP_URL,
      "https://energized-ant-201.convex.site",
    );
  } finally {
    w.done();
  }
});

test(
  "a child whose leader already exited still has its process group stopped",
  { skip: process.platform === "win32" },
  async () => {
    const supervisor = createSupervisor({ log: () => {} });
    // Like an npm wrapper that exits while the vite it started keeps running.
    const leader = supervisor.start(
      "client",
      process.execPath,
      [
        "-e",
        "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('GRANDCHILD',c.pid);setTimeout(()=>process.exit(0),200)",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const grandchildPid = await new Promise((resolve) => {
      leader.stdout.on("data", (chunk) => {
        const match = /GRANDCHILD (\d+)/.exec(String(chunk));
        if (match) resolve(Number(match[1]));
      });
    });
    assert.equal(await supervisor.done, 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(grandchildPid), false);
  },
);
