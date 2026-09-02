/**
 * LIFECYCLE CONFORMANCE RUNNER — abort mid-turn, orphan recovery, destroy.
 *   HOME=<scratch>/home CONFORMANCE_ROOT=<scratch> npx tsx run-lifecycle.ts abort
 *   HOME=... npx tsx run-lifecycle.ts orphan-a   # starts a session, then dies without stopping it
 *   HOME=... npx tsx run-lifecycle.ts orphan-b   # a fresh supervisor reclaims the orphan
 */
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { LocalHarnessSupervisor } from "../supervisor.js";
import { createSupervisedLocalHarnessProvider, sessionStateDirFor } from "../supervised-provider.js";
import { resolveLocalHarnessAvailability } from "../availability.js";
import { getLocalMachineId, grantLocalHarnessConsent, localHarnessStateRoot, registerWorkspaceGrant } from "../grants.js";
import { computeTreeDigest, resolveManagedBundle } from "../runtime-identity.js";
import { resolveNodeLauncher } from "../node-launcher.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { localPackTarget, LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";
import { listProcessRecords } from "../process-registry.js";
import { installedAdapterVersion } from "./adapter-version.js";


const execFileP = promisify(execFile);
const ROOT = process.env.CONFORMANCE_ROOT!;
/** The pack is per platform, and so is the digest that admits it. */
const PLATFORM = process.platform as "darwin" | "linux";
/**
 * …and per ARCHITECTURE, which is the key the digest table actually uses. The
 * pack the build step produced is for this machine, so this is the entry the
 * manifest needs to carry.
 */
const PACK_TARGET = (() => {
  const target = localPackTarget();
  if (target === null) {
    throw new Error(
      `no runtime pack target exists for ${process.platform}-${process.arch}`,
    );
  }
  return target;
})();
/** Stamped into the manifest so a run cannot claim evidence it did not
 *  gather; PR 5's CI job replaces it with the job's own output. */
const CONFORMANCE_VERSION =
  process.env.MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION ?? "local-dev";

const MODE = process.argv[2] ?? "abort";
const RUNTIME_ROOT = join(ROOT, "runtime");
const BUNDLE = join(RUNTIME_ROOT, "claude-code");
const WORKSPACE = join(ROOT, "workspace");
/**
 * `fileURLToPath`, not `.pathname`. On Windows a `file:///D:/…` URL's pathname
 * is `/D:/…`, and the leading slash makes it a path node cannot resolve — the
 * windows leg failed at the first helper spawn with a bare `MODULE_NOT_FOUND`
 * for three runs. (It also percent-decodes, so a checkout under a path with a
 * space stops being a `%20` mystery on every platform.)
 */
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const CAPABILITY = `cap_${randomBytes(24).toString("base64url")}`;
const POP_SECRET = randomBytes(32).toString("hex");
/**
 * The credential the gateway forwards upstream. Named once so the mock can be
 * told to REQUIRE it: a mock that accepts any key cannot tell a gateway that
 * forwards the credential from one that drops it.
 */
const UPSTREAM_KEY = `upstream-${randomBytes(8).toString("hex")}`;
const ORPHAN_FILE = join(ROOT, "orphan.json");
const log = (...a: unknown[]) => console.log("[lifecycle]", ...a);
/** Fail the RUN, not just the log: CI reads the exit code. */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
/**
 * Is this pid a process that is still RUNNING?
 *
 * Not `kill(pid, 0)`, which answers "the kernel still has a table entry" — and
 * a zombie has one. A zombie has no address space and executes nothing; it is
 * a terminated process whose exit status nobody has collected. On a runner
 * whose PID 1 is not a real init — which is where this suite runs — an orphan
 * that WAS correctly terminated stays visible to `kill(pid, 0)` indefinitely,
 * so a naive check reports the supervisor failed at exactly the job it just
 * did.
 *
 * Deliberately NOT `probeProcess` from the code under test: this suite exists
 * to check that code, so it reads the state itself. `ps -o stat=` reports `Z`
 * for a zombie on both macOS and Linux; an empty answer means the pid is gone
 * outright.
 */
async function running(pid: number): Promise<boolean> {
  let state: string;
  try {
    state = (await execFileP("ps", ["-o", "stat=", "-p", String(pid)])).stdout.trim();
  } catch {
    return false; // `ps` exits non-zero for a pid that does not exist.
  }
  if (state.length === 0) return false;
  return !state.startsWith("Z");
}

/** Which of these pids are still running — zombies do not count. */
async function stillRunning(pids: readonly number[]): Promise<number[]> {
  const states = await Promise.all(pids.map(running));
  return pids.filter((_, i) => states[i]);
}

async function descendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    let kids = ""; try { kids = (await execFileP("pgrep", ["-P", String(p)])).stdout; } catch { return; }
    for (const k of kids.split("\n").map((s) => Number(s.trim())).filter(Boolean)) { out.push(k); await walk(k); }
  };
  await walk(pid); return out;
}
async function psLine(pid: number) { try { return (await execFileP("ps", ["-o", "pid=,ppid=,pgid=,rss=,command=", "-p", String(pid)])).stdout.trim(); } catch { return ""; } }
/**
 * Every helper process this run started, so a FAILURE can take them down too.
 *
 * The gateway and the mock are servers bound to loopback ports. They used to
 * be killed only after the report printed, so any throw between spawning them
 * and that line left two servers running, holding their ports, for the rest of
 * the CI job — and left the granted consent in place. The next scenario then
 * failed for a reason that had nothing to do with it.
 */
const helpers: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];

/**
 * The supervised tree this run owns, so a FAILURE can stop it.
 *
 * Set as soon as a supervisor and a session id exist. Without this, a throw
 * anywhere after `createSession` left a real vendor agent running on the
 * machine while the runner exited reporting a failure — the one outcome a
 * suite about lifecycle guarantees must not produce.
 */
let owned: { supervisor: LocalHarnessSupervisor; sessionId: string } | null =
  null;

async function stopOwnedTree(): Promise<void> {
  const current = owned;
  owned = null;
  if (current === null) return;
  try {
    await current.supervisor.stopSession(current.sessionId);
  } catch {
    /* best effort: the report below says the run failed either way */
  }
}

function stopHelpers(): void {
  for (const child of helpers.splice(0)) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/**
 * The environment a conformance helper needs, and nothing else.
 *
 * Deliberately narrow — these servers stand in for the gateway and for
 * Anthropic, and inheriting the runner's whole environment would let a
 * variable set for something else change what they do. But narrow is not the
 * same as empty: on Windows a process with no `SystemRoot` cannot initialize
 * Winsock, so `http.createServer().listen()` fails and the helper exits before
 * printing its port — which is exactly what the Windows conformance leg has
 * been doing on every run.
 */
function helperEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return { ...base, ...extra };
}

/**
 * `MOCK_LATENCY_MS`, forwarded explicitly. `helperEnv` is an allowlist on
 * purpose — the scenario asserts on what a supervised child's environment
 * contains, so it cannot inherit the parent's — which means a knob that is
 * only exported by the caller silently does nothing. That is precisely how
 * this one first went in: set in CI, never delivered, and the run it was
 * meant to make deterministic stayed a race.
 */
function mockLatencyEnv(): Record<string, string> {
  const raw = process.env.MOCK_LATENCY_MS;
  return raw === undefined || raw === "" ? {} : { MOCK_LATENCY_MS: raw };
}

async function startChild(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [join(SCRIPT_DIR, script)], { env: helperEnv(env), stdio: ["ignore", "pipe", "pipe"], detached: true });
  // Kept, not discarded: a helper that dies at startup has nothing else to
  // say for itself, and "exited 1" alone has cost one Windows debugging round
  // already.
  const stderr: string[] = [];
  child.stderr!.on("data", (c) =>
    stderr.push(...String(c).split("\n").filter(Boolean)),
  );
  const port = await new Promise<number>((resolve, reject) => {
    // On a COMPLETE line only: a chunk boundary can land mid-JSON, and
    // `JSON.parse` on the partial then threw inside a `data` handler and
    // killed the runner with an error about the wrong thing entirely.
    let buf = "";
    child.stdout!.on("data", (c) => {
      buf += String(c);
      const newline = buf.indexOf("\n");
      if (newline < 0) return;
      const line = buf.slice(0, newline);
      try {
        resolve(JSON.parse(line).port);
      } catch (error) {
        reject(new Error(`${script} printed ${JSON.stringify(line)}: ${error}`));
      }
    });
    child.on("exit", (code) =>
      reject(
        new Error(
          `${script} exited ${code}` +
            (stderr.length > 0 ? `\n${stderr.slice(-10).join("\n")}` : ""),
        ),
      ),
    );
  });
  child.unref();
  // `stderr` too: the abort scenario reads the gateway's log to tell a turn
  // that was genuinely in flight from one that only looked busy retrying.
  return { child, port, stderr };
}
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

async function setup() {
  const mock = await startChild("mock-anthropic.mjs", { MOCK_POP_SECRET: POP_SECRET, MOCK_UPSTREAM_KEY: UPSTREAM_KEY, ...mockLatencyEnv() });
  const gw = await startChild("local-gateway.mjs", { GW_UPSTREAM: `http://127.0.0.1:${mock.port}`, GW_SESSION_CAPABILITY: CAPABILITY, GW_UPSTREAM_KEY: UPSTREAM_KEY, GW_POP_SECRET: POP_SECRET });
  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(join(WORKSPACE, "hello.txt"), "hello\n");
  const ws = await registerWorkspaceGrant(WORKSPACE); if (!ws.ok) throw new Error(ws.message);
  const digest = await computeTreeDigest(BUNDLE);
  const bridgeBytes = await readFile(join(BUNDLE, "bridge.mjs"));
  const base = LOCAL_HARNESS_MANIFEST["claude-code"];
  const manifest = { ...base, runtime: { ...(base.runtime as any), bundleDigest: { [PACK_TARGET]: digest }, launcherRelativePath: "launcher.mjs" }, lifecycleConformanceVersion: CONFORMANCE_VERSION, bridgeBundleDigest: `sha256:${createHash("sha256").update(bridgeBytes).digest("hex")}` } as typeof base;
  const rt = await resolveManagedBundle({ manifest, runtimeRoot: RUNTIME_ROOT, platform: PLATFORM }); if (!rt.ok) throw new Error(rt.message);
  const machineId = await getLocalMachineId();
  const target = { kind: "local-native" as const, machineId, workspaceGrantId: ws.grant.workspaceGrantId, harnessId: "claude-code" as const, runtimeId: rt.runtime.runtimeId, permissionProfile: "workspace-edits" as const, policyVersion: LOCAL_HARNESS_POLICY_VERSION };
  const grant = await grantLocalHarnessConsent({ userId: "conformance-user", machineId, projectId: "conformance-project", workspaceGrantId: target.workspaceGrantId, harnessId: "claude-code", targetKind: "local-native", runtimeId: target.runtimeId, permissionProfile: target.permissionProfile, policyVersion: LOCAL_HARNESS_POLICY_VERSION });
  const adapterVersion = await installedAdapterVersion();
  const availability = await resolveLocalHarnessAvailability({ target, actor: { isGuest: false, isScenarioSession: false, isJourneySession: false }, userId: "conformance-user", projectId: "conformance-project", grantToken: grant.token, runtimeRoot: RUNTIME_ROOT, installedAdapterVersion: adapterVersion, manifests: { "claude-code": manifest }, killSwitchEnabled: true, hosted: false });
  if (!availability.available) throw new Error(`${availability.status}: ${availability.message}`);
  const plan = availability.plan;
  const supervisor = new LocalHarnessSupervisor();
  const launcher = resolveNodeLauncher({ bundledNodePath: plan.runtime.nodePath! });
  const bridgePort = await freePort();
  const sessionId = `life-${MODE}-${Date.now()}`;
  owned = { supervisor, sessionId };
  const sessionStateDir = sessionStateDirFor(localHarnessStateRoot(), sessionId);
  let bridgePid = -1;
  const provider = createSupervisedLocalHarnessProvider({ harnessId: "claude-code", manifest: plan.manifest, runtime: plan.runtime, supervisor, launcher, workspacePath: plan.workspacePath, workspaceGrantId: target.workspaceGrantId, sessionStateDir, targetKind: "local-native", bridgePort, bridgeReadinessTimeoutMs: 30_000, onBridgeStarted: async ({ pid }) => { bridgePid = pid; } });
  const harness = createClaudeCode({ model: "haiku", auth: { ANTHROPIC_API_KEY: CAPABILITY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${gw.port}` }, thinking: { type: "disabled" }, env: { CLAUDE_CODE_EFFORT_LEVEL: "unset", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_TMPDIR: join(sessionStateDir, "home", "tmp") }, startupTimeoutMs: 90_000 });
  const agent: any = new HarnessAgent({ harness: harness as any, sandbox: provider, permissionMode: plan.permissionMode, instructions: "Spike." });
  const session = await agent.createSession({ sessionId });
  return { agent, session, supervisor, sessionId, sessionStateDir, bridgePid: () => bridgePid, mock, gw };
}

async function main() {
  if (MODE === "orphan-b") {
    const supervisor = new LocalHarnessSupervisor();
    const orphan = JSON.parse(await readFile(ORPHAN_FILE, "utf8"));
      log("orphan record from previous run:", orphan, "running now:", await stillRunning(orphan.pids));
    const t = performance.now();
    const result = await supervisor.reclaimOrphans();
    log(`reclaimOrphans in ${Math.round(performance.now() - t)}ms:`, JSON.stringify(result));
      await new Promise((r) => setTimeout(r, 500));
    const stranded = await stillRunning(orphan.pids);
    log("orphan pids still running after reclaim:", stranded, "(expect [])");
    const records = (await listProcessRecords()).length;
    log("registry records now:", records);
    for (const pid of orphan.helperPids ?? []) { try { process.kill(pid, "SIGTERM"); } catch {} }
    assert(stranded.length === 0, `the janitor left ${stranded.length} process(es) running: ${stranded}`);
    assert(records === 0, `the janitor left ${records} registry record(s) behind`);
    return;
  }
  const ctx = await setup();
  const bridgePid = ctx.bridgePid();
  log(`session ready; bridge pid ${bridgePid}: ${await psLine(bridgePid)}`);

  if (MODE === "orphan-a") {
    const ac = new AbortController();
    const res: any = await ctx.agent.stream({ session: ctx.session, prompt: "SLOW", abortSignal: ac.signal });
    const reader = (async () => { try { for await (const _ of res.fullStream) {} } catch {} })();
    await new Promise((r) => setTimeout(r, 2500));
    const kids = await descendants(bridgePid);
    log("mid-turn tree:", bridgePid, kids); for (const p of [bridgePid, ...kids]) log("  ", await psLine(p));
    await writeFile(ORPHAN_FILE, JSON.stringify({ sessionId: ctx.sessionId, pids: [bridgePid, ...kids], helperPids: [ctx.mock.child.pid, ctx.gw.child.pid] }));
    log("registry records:", (await listProcessRecords()).length, "— exiting WITHOUT stopping (simulated Inspector crash)");
    void reader;
    process.exit(0);
  }

  // abort: start a slow turn, verify the CLI child exists, abort + destroy, verify the tree is gone.
  const ac = new AbortController();
  const tStart = performance.now();
  const res: any = await ctx.agent.stream({ session: ctx.session, prompt: "SLOW", abortSignal: ac.signal });
  const reader = (async () => { const parts: string[] = []; try { for await (const part of res.fullStream) parts.push(String(part.type)); } catch (e: any) { parts.push(`THROW:${e?.name ?? e}`); } return parts; })();
  await new Promise((r) => setTimeout(r, 2500));
  const kids = await descendants(bridgePid);
  log("mid-turn tree:", bridgePid, kids); for (const p of [bridgePid, ...kids]) log("  ", await psLine(p));
  // Snapshotted BEFORE the abort. Tearing down an in-flight request makes the
  // gateway log an upstream error legitimately, so only failures up to this
  // point say anything — and any of those mean the "mid-turn" tree above was
  // a CLI stuck in its retry loop rather than a turn actually running.
  const gatewayErrorsBeforeAbort = ctx.gw.stderr.filter((l: string) => l.includes("upstream error") || l.includes("upstream timeout"));
  const tAbort = performance.now();
  ac.abort(new Error("user cancelled"));
  const parts = await reader;
  log(`stream ended ${Math.round(performance.now() - tAbort)}ms after abort; parts=${parts.join(",")}`);
  const tDestroy = performance.now();
  await ctx.session.destroy();
  log(`destroy took ${Math.round(performance.now() - tDestroy)}ms (turn started ${Math.round(tDestroy - tStart)}ms ago)`);
  await new Promise((r) => setTimeout(r, 400));
  const survivors = await stillRunning([bridgePid, ...kids]);
  log("surviving pids:", survivors, "(expect [])");
  const stateDirExists = await stat(ctx.sessionStateDir).then(() => true, () => false);
  log("state dir exists after destroy:", stateDirExists, "(expect false)");
  const recordsLeft = (await listProcessRecords()).length;
  log("registry records:", recordsLeft, "(expect 0)");
  ctx.gw.child.kill("SIGTERM"); ctx.mock.child.kill("SIGTERM");
  // Asserted, not merely printed: a scenario that reports a survivor and exits
  // 0 turns this whole suite into a log the CI job never reads.
  assert(survivors.length === 0, `abort left ${survivors.length} process(es) running: ${survivors}`);
  assert(!stateDirExists, "abort left the session state directory behind");
  assert(recordsLeft === 0, `abort left ${recordsLeft} registry record(s) behind`);
  assert(
    gatewayErrorsBeforeAbort.length === 0,
    `the gateway failed ${gatewayErrorsBeforeAbort.length} upstream call(s) before the abort, so the turn was never live: ${JSON.stringify(gatewayErrorsBeforeAbort.slice(0, 3))}`,
  );
}
main().catch(async (e) => {
  // Cleanup FIRST, for the same reason as the native-turn runner: these
  // helpers are detached, and the supervised tree is a real agent. Both would
  // otherwise outlive a failed scenario and break the next one.
  //
  // The `orphan-a` scenario is the deliberate exception and never reaches
  // here: it exits SUCCESSFULLY without stopping its session, which is the
  // crash it exists to simulate.
  await stopOwnedTree();
  stopHelpers();
  console.error("[lifecycle] FAILED", e?.stack ?? e);
  process.exit(1);
});
