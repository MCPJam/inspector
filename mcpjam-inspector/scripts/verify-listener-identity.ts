/**
 * Dev-only: run the github-checks LISTENER IDENTITY check against a REAL E2B box.
 *
 * NOT IN CI, on purpose — it provisions live sandboxes and costs money. Run it
 * by hand when the identity plumbing changes:
 *
 *   npx tsx scripts/verify-listener-identity.ts            # from mcpjam-inspector/
 *   npx tsx scripts/verify-listener-identity.ts --only squatter
 *
 * WHY IT EXISTS. Everything the identity check reads is an assumption about ONE
 * image: that `ss`/`lsof` are absent (so the `/proc` walk is the only option),
 * that `/proc/net/tcp` and `/proc/net/tcp6` are laid out the way the parser
 * expects, that `/proc/<pid>/fd` links read as `socket:[<inode>]`, and — the one
 * this PR turns on — that the pid E2B's `CommandHandle` reports is the pid the
 * sandbox's own `/proc` knows the start command by. Unit tests cannot check any
 * of that: they fake the box, so they can only confirm the code agrees with the
 * fixture. This runs the SAME exported functions (`buildAndStart`,
 * `inspectListener`, `judgeListeners`) against the live template.
 *
 * The four scenarios are the matrix the review asked for:
 *
 *   happy      our spawned server binds the port           → identity PASSES
 *   squatter   a lifecycle-hook-like detached process binds
 *              it first and our start command dies          → identity FAILS
 *   doublefork the server double-forks and is reparented,
 *              so ancestry is gone                          → identity PASSES
 *                                                             via the spawn-time
 *                                                             process group
 *   ipv6       the server binds `::` only                   → the walk still
 *                                                             attributes it
 *
 * Every box is killed in a `finally`, including on a throw.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  buildAndStart,
  CHECKOUT_DIR,
  killCheckSandbox,
  provisionCheckSandbox,
  type CheckSandbox,
} from "../server/services/github-checks/sandbox.js";
import {
  inspectListener,
  listenerScript,
} from "../server/services/github-checks/sandbox-inspect.js";
import { judgeListeners } from "../server/services/github-checks/resolve-and-start.js";

const PORT = 3001;
const MCP_PATH = "/mcp";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Read `.env.development` ourselves rather than depending on a loader: this
 * script is run by hand from a checkout, and the two values it needs are the
 * two the worker needs.
 */
function loadEnv(): void {
  const path = resolvePath(process.cwd(), ".env.development");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.warn(`[verify] no ${path}; relying on the ambient environment`);
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
  if (!process.env.GITHUB_CHECKS_E2B_TEMPLATE_ID) {
    // The alias the template was published under. Named here rather than
    // silently defaulting somewhere in the product code.
    process.env.GITHUB_CHECKS_E2B_TEMPLATE_ID = "mcpjam-github-checks";
    console.warn(
      "[verify] GITHUB_CHECKS_E2B_TEMPLATE_ID unset; using the alias 'mcpjam-github-checks'"
    );
  }
}

// ---------------------------------------------------------------------------
// The programs we plant in the box
// ---------------------------------------------------------------------------

/**
 * A minimal server that answers the health probe's legacy `initialize`.
 *
 * `HOST` decides IPv4 vs IPv6, which is the axis scenario `ipv6` is about: the
 * `/proc/net/tcp` walk reads two files and a listener in the wrong one is
 * invisible.
 */
function mcpServerSource(host: string, tag: string): string {
  return `
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let id = 1;
    try { id = JSON.parse(body).id; } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: ${JSON.stringify(tag)}, version: '1.0.0' },
      },
    }));
  });
}).listen(${PORT}, ${JSON.stringify(host)}, () => {
  console.log('listening ${tag} on ${host}');
});
`;
}

/** Write a file into the box without any shell quoting hazard. */
async function plant(
  sandbox: CheckSandbox,
  path: string,
  contents: string
): Promise<void> {
  const b64 = Buffer.from(contents, "utf8").toString("base64");
  await sandbox.commands.run(
    `bash -lc 'mkdir -p "$(dirname ${path})" && echo ${b64} | base64 -d > ${path}'`,
    { timeoutMs: 30_000 }
  );
}

async function runRaw(
  sandbox: CheckSandbox,
  command: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = (await sandbox.commands.run(command, {
      timeoutMs: 60_000,
    })) as { exitCode?: number; stdout?: string; stderr?: string };
    return {
      exitCode: result?.exitCode ?? 0,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
    };
  } catch (error) {
    const exit = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof exit?.exitCode === "number" ? exit.exitCode : -1,
      stdout: exit?.stdout ?? "",
      stderr: exit?.stderr ?? String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Scenario = {
  name: string;
  /** What the identity check MUST conclude on this image. */
  expect: "ok" | "mismatch";
  /** Bind address for the server under test. */
  host: string;
  /** Extra work the "build" does — this is where a lifecycle hook squats. */
  build: string;
  /** The start command, exactly as a recipe would carry it. */
  start: string;
};

const SCENARIOS: Scenario[] = [
  {
    name: "happy",
    expect: "ok",
    host: "0.0.0.0",
    build: "true",
    start: `node ${CHECKOUT_DIR}/server.js`,
  },
  {
    name: "squatter",
    expect: "mismatch",
    host: "0.0.0.0",
    // A detached process started by the BUILD — i.e. exactly the shape an
    // install/build lifecycle hook has — binds the port first. It survives the
    // build command, so it is holding the socket when our start command runs.
    build: `nohup node ${CHECKOUT_DIR}/squatter.js > /tmp/squatter.log 2>&1 & sleep 2; true`,
    // Ours then loses the bind and exits. The probe is answered by the squatter.
    start: `node ${CHECKOUT_DIR}/server.js`,
  },
  {
    name: "doublefork",
    expect: "ok",
    host: "0.0.0.0",
    build: "true",
    // The supervisor forks the real server and EXITS, so the server is
    // reparented to init and the ancestry link to our spawn is gone. Only the
    // process group captured at spawn can still identify it.
    start: `bash -c 'node ${CHECKOUT_DIR}/server.js & exit 0'`,
  },
  {
    name: "ipv6",
    expect: "ok",
    host: "::",
    build: "true",
    start: `node ${CHECKOUT_DIR}/server.js`,
  },
];

async function runScenario(scenario: Scenario): Promise<boolean> {
  console.log(`\n${"═".repeat(72)}\n▶ ${scenario.name}\n${"═".repeat(72)}`);
  let sandbox: CheckSandbox | null = null;
  try {
    sandbox = await provisionCheckSandbox({
      triggerId: `verify-${scenario.name}`,
      repoFullName: "mcpjam/verify-listener-identity",
      prNumber: 0,
    });
    console.log(`  sandbox: ${sandbox.sandboxId}`);

    await runRaw(sandbox, `bash -lc 'mkdir -p ${CHECKOUT_DIR}'`);
    await plant(
      sandbox,
      `${CHECKOUT_DIR}/server.js`,
      mcpServerSource(scenario.host, "ours")
    );
    await plant(
      sandbox,
      `${CHECKOUT_DIR}/squatter.js`,
      mcpServerSource("0.0.0.0", "squatter")
    );

    // Probe the image's own tooling ONCE, on the first scenario: the code's
    // choice of a `/proc` walk over `ss`/`lsof` is an assumption about this
    // template, and an assumption is worth re-checking against the image.
    if (scenario.name === "happy") {
      for (const tool of ["ss", "lsof", "netstat", "fuser", "setsid"]) {
        const which = await runRaw(
          sandbox,
          `bash -lc 'command -v ${tool} || true'`
        );
        console.log(
          `  tool ${tool.padEnd(8)} ${which.stdout.trim() || "(absent)"}`
        );
      }
    }

    const started = await buildAndStart(
      sandbox,
      {
        build: scenario.build,
        start: scenario.start,
        port: PORT,
        mcpPath: MCP_PATH,
      },
      { healthTimeoutMs: 60_000, healthIntervalMs: 1_000 }
    );
    console.log(`  probe answered at ${started.url}`);
    console.log(
      `  SpawnIdentity: pid=${started.spawn.pid} pgrp=${started.spawn.pgrp}`
    );

    // The raw kernel state the walk reads, so a layout difference is visible
    // rather than inferred from a verdict.
    const rawTcp = await runRaw(
      sandbox,
      `bash -lc 'head -c 2000 /proc/net/tcp; echo "--- tcp6 ---"; head -c 2000 /proc/net/tcp6'`
    );
    console.log(`  /proc/net/tcp{,6}:\n${indent(rawTcp.stdout)}`);
    const rawScript = await runRaw(
      sandbox,
      `node -e ${JSON.stringify(listenerScript(PORT))}`
    );
    console.log(`  raw walk output:\n${indent(rawScript.stdout.trim())}`);

    const report = await inspectListener(sandbox, { port: PORT });
    console.log(`  report: ${JSON.stringify(report)}`);
    if (!report) {
      console.log(`  ✗ ${scenario.name}: the box did not answer the walk`);
      return false;
    }
    const verdict = judgeListeners(report, started.spawn);
    console.log(`  verdict: ${JSON.stringify(verdict)}`);

    const pass = verdict.status === scenario.expect;
    console.log(
      `  ${pass ? "✓" : "✗"} ${scenario.name}: expected ${
        scenario.expect
      }, got ${verdict.status}`
    );
    return pass;
  } catch (error) {
    console.log(`  ✗ ${scenario.name} threw: ${String(error)}`);
    return false;
  } finally {
    if (sandbox) {
      await killCheckSandbox(sandbox).catch(() => {});
      console.log(`  killed ${sandbox.sandboxId}`);
    }
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

async function main(): Promise<void> {
  loadEnv();
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
  const scenarios = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;

  const results: { name: string; pass: boolean }[] = [];
  for (const scenario of scenarios) {
    results.push({ name: scenario.name, pass: await runScenario(scenario) });
  }

  console.log(`\n${"═".repeat(72)}\nSUMMARY\n${"═".repeat(72)}`);
  for (const result of results) {
    console.log(`  ${result.pass ? "✓" : "✗"} ${result.name}`);
  }
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
}

void main();
