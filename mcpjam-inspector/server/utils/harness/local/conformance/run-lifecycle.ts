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
import { LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";
import { listProcessRecords } from "../process-registry.js";

import { createRequire } from "node:module";

const execFileP = promisify(execFile);
const ROOT = process.env.CONFORMANCE_ROOT!;
/** The pack is per platform, and so is the digest that admits it. */
const PLATFORM = process.platform as "darwin" | "linux";
/** Stamped into the manifest so a run cannot claim evidence it did not
 *  gather; PR 5's CI job replaces it with the job's own output. */
const CONFORMANCE_VERSION =
  process.env.MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION ?? "local-dev";

const MODE = process.argv[2] ?? "abort";
const RUNTIME_ROOT = join(ROOT, "runtime");
const BUNDLE = join(RUNTIME_ROOT, "claude-code");
const WORKSPACE = join(ROOT, "workspace");
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const CAPABILITY = `cap_${randomBytes(24).toString("base64url")}`;
const POP_SECRET = randomBytes(32).toString("hex");
const ORPHAN_FILE = join(ROOT, "orphan.json");
const log = (...a: unknown[]) => console.log("[lifecycle]", ...a);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function descendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    let kids = ""; try { kids = (await execFileP("pgrep", ["-P", String(p)])).stdout; } catch { return; }
    for (const k of kids.split("\n").map((s) => Number(s.trim())).filter(Boolean)) { out.push(k); await walk(k); }
  };
  await walk(pid); return out;
}
async function psLine(pid: number) { try { return (await execFileP("ps", ["-o", "pid=,ppid=,pgid=,rss=,command=", "-p", String(pid)])).stdout.trim(); } catch { return ""; } }
async function startChild(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [join(SCRIPT_DIR, script)], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stderr!.on("data", () => {});
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ""; child.stdout!.on("data", (c) => { buf += String(c); const line = buf.split("\n")[0]; if (line?.includes("port")) resolve(JSON.parse(line).port); });
    child.on("exit", (code) => reject(new Error(`${script} exited ${code}`)));
  });
  child.unref();
  return { child, port };
}
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

async function setup() {
  const mock = await startChild("mock-anthropic.mjs", { MOCK_POP_SECRET: POP_SECRET });
  const gw = await startChild("local-gateway.mjs", { GW_UPSTREAM: `http://127.0.0.1:${mock.port}`, GW_SESSION_CAPABILITY: CAPABILITY, GW_UPSTREAM_KEY: "upstream-key", GW_POP_SECRET: POP_SECRET });
  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(join(WORKSPACE, "hello.txt"), "hello\n");
  const ws = await registerWorkspaceGrant(WORKSPACE); if (!ws.ok) throw new Error(ws.message);
  const digest = await computeTreeDigest(BUNDLE);
  const bridgeBytes = await readFile(join(BUNDLE, "bridge.mjs"));
  const base = LOCAL_HARNESS_MANIFEST["claude-code"];
  const manifest = { ...base, runtime: { ...(base.runtime as any), bundleDigest: { [PLATFORM]: digest }, launcherRelativePath: "launcher.mjs" }, lifecycleConformanceVersion: CONFORMANCE_VERSION, bridgeBundleDigest: `sha256:${createHash("sha256").update(bridgeBytes).digest("hex")}` } as typeof base;
  const rt = await resolveManagedBundle({ manifest, runtimeRoot: RUNTIME_ROOT, platform: "darwin" }); if (!rt.ok) throw new Error(rt.message);
  const machineId = await getLocalMachineId();
  const target = { kind: "local-native" as const, machineId, workspaceGrantId: ws.grant.workspaceGrantId, harnessId: "claude-code" as const, runtimeId: rt.runtime.runtimeId, permissionProfile: "workspace-edits" as const, policyVersion: LOCAL_HARNESS_POLICY_VERSION };
  const grant = await grantLocalHarnessConsent({ userId: "conformance-user", machineId, projectId: "conformance-project", workspaceGrantId: target.workspaceGrantId, harnessId: "claude-code", targetKind: "local-native", runtimeId: target.runtimeId, permissionProfile: target.permissionProfile, policyVersion: LOCAL_HARNESS_POLICY_VERSION });
  const adapterVersion = JSON.parse(
    await readFile(
      // Resolved through the package manager, never as a path relative to
      // this file: the adapter hoists to the workspace root, and a
      // source-layout-relative URL breaks the moment it does (which is
      // what `check:bundled-runtime-paths` exists to catch).
      createRequire(import.meta.url).resolve(
        "@ai-sdk/harness-claude-code/package.json",
      ),
      "utf8",
    ),
  ).version;
  const availability = await resolveLocalHarnessAvailability({ target, actor: { isGuest: false, isScenarioSession: false, isJourneySession: false }, userId: "conformance-user", projectId: "conformance-project", grantToken: grant.token, runtimeRoot: RUNTIME_ROOT, installedAdapterVersion: adapterVersion, manifests: { "claude-code": manifest }, killSwitchEnabled: true, hosted: false });
  if (!availability.available) throw new Error(`${availability.status}: ${availability.message}`);
  const plan = availability.plan;
  const supervisor = new LocalHarnessSupervisor();
  const launcher = resolveNodeLauncher({ bundledNodePath: plan.runtime.nodePath! });
  const bridgePort = await freePort();
  const sessionId = `life-${MODE}-${Date.now()}`;
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
    log("orphan record from previous run:", orphan, "alive now:", orphan.pids.filter(alive));
    const t = performance.now();
    const result = await supervisor.reclaimOrphans();
    log(`reclaimOrphans in ${Math.round(performance.now() - t)}ms:`, JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 500));
    log("orphan pids alive after reclaim:", orphan.pids.filter(alive), "(expect [])");
    log("registry records now:", (await listProcessRecords()).length);
    for (const pid of orphan.helperPids ?? []) { try { process.kill(pid, "SIGTERM"); } catch {} }
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
  const tAbort = performance.now();
  ac.abort(new Error("user cancelled"));
  const parts = await reader;
  log(`stream ended ${Math.round(performance.now() - tAbort)}ms after abort; parts=${parts.join(",")}`);
  const tDestroy = performance.now();
  await ctx.session.destroy();
  log(`destroy took ${Math.round(performance.now() - tDestroy)}ms (turn started ${Math.round(tDestroy - tStart)}ms ago)`);
  await new Promise((r) => setTimeout(r, 400));
  log("surviving pids:", [bridgePid, ...kids].filter(alive), "(expect [])");
  log("state dir exists after destroy:", await stat(ctx.sessionStateDir).then(() => true, () => false), "(expect false)");
  log("registry records:", (await listProcessRecords()).length, "(expect 0)");
  ctx.gw.child.kill("SIGTERM"); ctx.mock.child.kill("SIGTERM");
}
main().catch((e) => { console.error("[lifecycle] FAILED", e?.stack ?? e); process.exit(1); });
