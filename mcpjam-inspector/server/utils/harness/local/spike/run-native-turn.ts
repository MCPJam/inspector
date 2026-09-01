/**
 * SPIKE RUNNER — drives the merged local-harness foundation end to end on this
 * machine against a mock Anthropic upstream behind a loopback gateway.
 *
 *   HOME=<scratch>/home SPIKE_ROOT=<scratch> npx tsx run-native-turn.ts [full|no-launcher]
 *
 * Nothing here is product code. It exists to pin facts for the implementation:
 * timings, process-tree behaviour, what lands where, and what breaks.
 */
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { LocalHarnessSupervisor } from "../supervisor.js";
import {
  createSupervisedLocalHarnessProvider,
  sessionStateDirFor,
} from "../supervised-provider.js";
import { resolveLocalHarnessAvailability } from "../availability.js";
import {
  getLocalMachineId,
  grantLocalHarnessConsent,
  localHarnessStateRoot,
  registerWorkspaceGrant,
  revokeLocalHarnessGrants,
} from "../grants.js";
import { computeTreeDigest, resolveManagedBundle } from "../runtime-identity.js";
import { resolveNodeLauncher } from "../node-launcher.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";
import { listProcessRecords } from "../process-registry.js";
import { probeProcessGroup, probeProcess } from "../process-identity.js";

const execFileP = promisify(execFile);
const ROOT = process.env.SPIKE_ROOT!;
const MODE = (process.argv[2] ?? "full") as "full" | "no-launcher";
const RUNTIME_ROOT = join(ROOT, "runtime");
const BUNDLE = join(RUNTIME_ROOT, "claude-code");
const WORKSPACE = join(ROOT, "workspace");
const SPIKE_DIR = new URL(".", import.meta.url).pathname;
const UPSTREAM_KEY_CANARY = `upstream-canary-${randomBytes(8).toString("hex")}`;
const CAPABILITY = `cap_${randomBytes(24).toString("base64url")}`;
const POP_SECRET = randomBytes(32).toString("hex");

const t0 = performance.now();
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = Math.round(performance.now() - t0);
  console.log(`[spike] +${marks[name]}ms ${name}`);
};
const findings: string[] = [];
const note = (s: string) => {
  findings.push(s);
  console.log(`[finding] ${s}`);
};

async function startChild(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [join(SPIKE_DIR, script)], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr!.on("data", (c) => stderr.push(...String(c).split("\n").filter(Boolean)));
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (c) => {
      buf += String(c);
      const line = buf.split("\n")[0];
      if (line?.includes("port")) resolve(JSON.parse(line).port);
    });
    child.on("exit", (code) => reject(new Error(`${script} exited ${code}`)));
  });
  return { child, port, stderr };
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function descendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    let kids = "";
    try {
      kids = (await execFileP("pgrep", ["-P", String(p)])).stdout;
    } catch {
      return;
    }
    for (const k of kids.split("\n").map((s) => Number(s.trim())).filter(Boolean)) {
      out.push(k);
      await walk(k);
    }
  };
  await walk(pid);
  return out;
}
async function psLine(pid: number, withEnv = false) {
  try {
    const args = withEnv ? ["-E", "-o", "command=", "-p", String(pid)] : ["-o", "command=", "-p", String(pid)];
    return (await execFileP("ps", args)).stdout.trim();
  } catch {
    return "";
  }
}
async function listeners(pid: number) {
  try {
    return (await execFileP("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"])).stdout
      .split("\n").slice(1).filter(Boolean).map((l) => l.split(/\s+/).slice(-2).join(" "));
  } catch {
    return [];
  }
}

type TurnResult = { text: string; parts: Record<string, number>; firstPartMs: number; firstTextMs: number; finishMs: number; approvals: number; errors: string[] };
async function runTurn(label: string, agent: any, sessionRef: { s: any }, prompt: string): Promise<TurnResult> {
  const start = performance.now();
  const parts: Record<string, number> = {};
  const errors: string[] = [];
  const toolCalls = new Map<string, any>();
  let text = "";
  let firstPartMs = -1, firstTextMs = -1, approvals = 0;
  let res: any = await agent.stream({ session: sessionRef.s, prompt });
  let stream: AsyncIterable<any> = res.fullStream;
  for (let round = 0; round < 4; round++) {
    let paused: any = null;
    for await (const part of stream) {
      const type = String(part.type);
      parts[type] = (parts[type] ?? 0) + 1;
      if (firstPartMs < 0) firstPartMs = Math.round(performance.now() - start);
      if (type === "text-delta") {
        text += part.text ?? part.textDelta ?? part.delta ?? "";
        if (firstTextMs < 0) firstTextMs = Math.round(performance.now() - start);
      }
      if (type === "tool-call") toolCalls.set(part.toolCallId, part);
      if (type === "tool-approval-request") { paused = part; break; }
      if (type === "error") {
        const err: any = part.error;
        errors.push(String(err?.message ?? err ?? part) + (err?.command ? " || command=" + JSON.stringify(err.command) : ""));
      }
    }
    if (!paused) break;
    approvals += 1;
    const tc = toolCalls.get(paused.toolCallId) ?? { toolCallId: paused.toolCallId, toolName: paused.toolName ?? "Bash", input: paused.input ?? {} };
    console.log(`[spike] ${label}: approval requested for ${tc.toolName} ${JSON.stringify(tc.input).slice(0, 80)} — suspending + continuing`);
    const tSusp = performance.now();
    const cont = await sessionRef.s.suspendTurn();
    sessionRef.s = await agent.createSession({ sessionId: sessionRef.s.sessionId, continueFrom: cont });
    res = await agent.continueStream({
      session: sessionRef.s,
      toolApprovalContinuations: [{
        approvalResponse: { type: "tool-approval-response", approvalId: paused.approvalId, approved: true },
        toolCall: { type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input },
      }],
    });
    console.log(`[spike] ${label}: suspend+continue took ${Math.round(performance.now() - tSusp)}ms`);
    stream = res.fullStream;
  }
  const finishMs = Math.round(performance.now() - start);
  console.log(`[spike] ${label}: ${finishMs}ms parts=${JSON.stringify(parts)} text=${JSON.stringify(text.slice(0, 120))}`);
  return { text, parts, firstPartMs, firstTextMs, finishMs, approvals, errors };
}

async function main() {
  mark("start");
  const mock = await startChild("mock-anthropic.mjs", { MOCK_POP_SECRET: POP_SECRET });
  const gw = await startChild("local-gateway.mjs", {
    GW_UPSTREAM: `http://127.0.0.1:${mock.port}`, GW_SESSION_CAPABILITY: CAPABILITY,
    GW_UPSTREAM_KEY: UPSTREAM_KEY_CANARY, GW_POP_SECRET: POP_SECRET,
  });
  const gatewayUrl = `http://127.0.0.1:${gw.port}`;
  mark("gateway_ready");

  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(join(WORKSPACE, "hello.txt"), "hello from the spike workspace\n");
  const before = new Set(await readdir(WORKSPACE));
  const ws = await registerWorkspaceGrant(WORKSPACE);
  if (!ws.ok) throw new Error(ws.message);

  const tDigest = performance.now();
  const digest = await computeTreeDigest(BUNDLE);
  marks.bundle_digest_ms = Math.round(performance.now() - tDigest);
  const bridgeBytes = await readFile(join(BUNDLE, "bridge.mjs"));
  const base = LOCAL_HARNESS_MANIFEST["claude-code"];
  const manifest = {
    ...base,
    runtime: { ...(base.runtime as any), bundleDigest: digest, launcherRelativePath: MODE === "no-launcher" ? "bridge.mjs" : "launcher.mjs" },
    lifecycleConformanceVersion: "spike-2026-09-01",
    bridgeBundleDigest: `sha256:${createHash("sha256").update(bridgeBytes).digest("hex")}`,
  } as typeof base;
  const rt = await resolveManagedBundle({ manifest, runtimeRoot: RUNTIME_ROOT, platform: "darwin" });
  if (!rt.ok) throw new Error(`${rt.status}: ${rt.message}`);
  const machineId = await getLocalMachineId();
  const target = {
    kind: "local-native" as const, machineId, workspaceGrantId: ws.grant.workspaceGrantId, harnessId: "claude-code" as const,
    runtimeId: rt.runtime.runtimeId, permissionProfile: "workspace-edits" as const, policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  };
  const grant = await grantLocalHarnessConsent({
    userId: "spike-user", machineId, projectId: "spike-project", workspaceGrantId: target.workspaceGrantId,
    harnessId: "claude-code", targetKind: "local-native", runtimeId: target.runtimeId,
    permissionProfile: target.permissionProfile, policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  });
  mark("consent_granted");

  const adapterVersion = JSON.parse(await readFile(new URL("../../../../../../node_modules/@ai-sdk/harness-claude-code/package.json", import.meta.url), "utf8")).version;
  const tAvail = performance.now();
  const availability = await resolveLocalHarnessAvailability({
    target, actor: { isGuest: false, isScenarioSession: false, isJourneySession: false }, userId: "spike-user", projectId: "spike-project",
    grantToken: grant.token, runtimeRoot: RUNTIME_ROOT, installedAdapterVersion: adapterVersion,
    manifests: { "claude-code": manifest }, killSwitchEnabled: true, hosted: false,
  });
  marks.availability_ms = Math.round(performance.now() - tAvail);
  if (!availability.available) throw new Error(`availability: ${availability.status}: ${availability.message}`);
  const plan = availability.plan;
  mark("availability_ok");
  console.log(`[spike] permissionMode=${plan.permissionMode} runtimeId=${plan.runtime.runtimeId} workspace=${plan.workspacePath}`);

  const supervisor = new LocalHarnessSupervisor();
  const janitor = await supervisor.reclaimOrphans();
  console.log(`[spike] janitor: ${JSON.stringify(janitor).slice(0, 200)}`);
  const launcher = resolveNodeLauncher({ execPath: join(plan.runtime.rootPath, "bin", "node"), isElectron: false });
  const bridgePort = await freePort();
  const sessionId = `spike-${Date.now()}`;
  const sessionStateDir = sessionStateDirFor(localHarnessStateRoot(), sessionId);
  let bridgePid = -1;
  const provider = createSupervisedLocalHarnessProvider({
    harnessId: "claude-code", manifest: plan.manifest, runtime: plan.runtime, supervisor, launcher,
    workspacePath: plan.workspacePath, workspaceGrantId: target.workspaceGrantId, sessionStateDir,
    targetKind: "local-native", bridgePort, bridgeReadinessTimeoutMs: 30_000,
    onBridgeStarted: async ({ pid }) => { bridgePid = pid; mark("bridge_listening_verified_loopback"); },
  });
  const harness = createClaudeCode({
    model: "haiku",
    auth: { ANTHROPIC_API_KEY: CAPABILITY, ANTHROPIC_BASE_URL: gatewayUrl },
    thinking: { type: "disabled" },
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: "unset", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_TMPDIR: join(sessionStateDir, "home", "tmp"),
    },
    startupTimeoutMs: 90_000,
  });
  const agent: any = new HarnessAgent({
    harness: harness as any, sandbox: provider, permissionMode: plan.permissionMode, instructions: "You are a spike.",
    // Work-dir layout: "project" is the symlink to the granted workspace inside
    // session state, so Claude Code's cwd resolves to the user's checkout.
    sandboxConfig: { workDir: "project" },
  });

  mark("create_session_start");
  const sessionRef = { s: await agent.createSession({ sessionId }) };
  mark("session_ready");
  console.log(`[spike] sessionWorkDir=${sessionRef.s.sessionWorkDir ?? "(n/a)"} bridgePid=${bridgePid}`);

  const turn1 = await runTurn("turn1-read", agent, sessionRef, `READFILE ${join(plan.workspacePath, "hello.txt")}`);
  mark("turn1_done");

  // Process-tree + hygiene inspection while the session is live.
  const kids = await descendants(bridgePid);
  console.log(`[spike] tree: bridge ${bridgePid} -> ${JSON.stringify(kids)}`);
  for (const pid of [bridgePid, ...kids]) console.log(`  ${pid}: ${(await psLine(pid)).slice(0, 160)}`);
  const envDump = (await Promise.all([bridgePid, ...kids].map((p) => psLine(p, true)))).join("\n");
  note(`upstream key in any child env: ${envDump.includes(UPSTREAM_KEY_CANARY) ? "LEAKED" : "absent (good)"}`);
  note(`session capability in child env: ${envDump.includes(CAPABILITY) ? "present (env delivery fallback, as designed)" : "absent"}`);
  note(`bridge listeners: ${JSON.stringify(await listeners(bridgePid))}`);
  const homeLeak = envDump.match(/HOME=([^\s]+)/g)?.slice(0, 2);
  note(`child HOME values: ${JSON.stringify(homeLeak)}`);
  const stateFiles = await execFileP("find", [sessionStateDir, "-type", "f"]).then((r) => r.stdout.split("\n").filter(Boolean));
  const stateBlob = (await Promise.all(stateFiles.map((f) => readFile(f, "utf8").catch(() => "")))).join("\n");
  note(`upstream key in session state files: ${stateBlob.includes(UPSTREAM_KEY_CANARY) ? "LEAKED" : "absent (good)"}; capability persisted in state: ${stateBlob.includes(CAPABILITY) ? "yes" : "no"} (${stateFiles.length} files)`);

  const turn2 = await runTurn("turn2-bash-approval", agent, sessionRef, "BASH pwd");
  mark("turn2_done");

  const tDetach = performance.now();
  const resumeState = await sessionRef.s.detach();
  marks.detach_ms = Math.round(performance.now() - tDetach);
  note(`after detach: bridge alive=${alive(bridgePid)} descendants=${JSON.stringify(await descendants(bridgePid))}`);
  const tResume = performance.now();
  const s2 = await agent.createSession({ sessionId, resumeFrom: resumeState });
  marks.resume_session_ms = Math.round(performance.now() - tResume);
  const ref2 = { s: s2 };
  const turn3 = await runTurn("turn3-count-after-resume", agent, ref2, "COUNT");
  mark("turn3_done");
  const m = /USER_TURNS=(\d+)/.exec(turn3.text);
  note(`continuity: model saw ${m?.[1] ?? "?"} user turns after detach+resume (expect >= 3)`);

  const treeBefore = [bridgePid, ...(await descendants(bridgePid))];
  const groupPs = async (pgid: number) => execFileP("ps", ["-o", "pid=,pgid=,stat=,command=", "-ax"]).then((r) => r.stdout.split("\n").filter((l) => l.split(/\s+/).filter(Boolean)[1] === String(pgid)).map((l) => l.trim().slice(0, 100)), () => []);
  note(`pre-stop: root probe=${JSON.stringify(await probeProcess(bridgePid, "darwin"))} group=${await probeProcessGroup(bridgePid, "darwin")} members=${JSON.stringify(await groupPs(bridgePid))}`);
  const tStop = performance.now();
  let stopError: string | undefined;
  try { await ref2.s.stop(); } catch (e: any) { stopError = String(e?.message ?? e); }
  marks.stop_ms = Math.round(performance.now() - tStop);
  note(`stop() ${stopError ? "THREW: " + stopError : "resolved"}; root alive=${alive(bridgePid)} group=${await probeProcessGroup(bridgePid, "darwin")} members=${JSON.stringify(await groupPs(bridgePid))}`);
  await new Promise((r) => setTimeout(r, 300));
  note(`second supervisor.stopSession: ${JSON.stringify(await supervisor.stopSession(sessionId))}`);
  note(`after stop: surviving pids=${JSON.stringify(treeBefore.filter(alive))} (expect [])`);
  note(`registry records after stop: ${(await listProcessRecords()).length}`);

  const after = (await readdir(WORKSPACE)).filter((e) => !before.has(e));
  note(`new entries in workspace after session: ${JSON.stringify(after)}`);
  note(`.harness-bootstrap in workspace: ${(await stat(join(WORKSPACE, ".harness-bootstrap")).then(() => "PRESENT (bad)", () => "absent (good)"))}`);

  gw.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  mock.child.kill("SIGTERM");
  await revokeLocalHarnessGrants();
  const report = { mode: MODE, marks, turn1, turn2, turn3, findings, gateway: gw.stderr.slice(-8), mock: mock.stderr.slice(-12) };
  console.log("\n=====REPORT=====\n" + JSON.stringify(report, null, 2));
}

main().catch(async (e) => {
  console.error("[spike] FAILED:", e?.stack ?? e);
  console.error("[spike] marks:", JSON.stringify(marks));
  console.error("[spike] findings:", JSON.stringify(findings, null, 1));
  process.exit(1);
});
