/**
 * CODEX TURN CONFORMANCE — drives local Codex end to end on this machine: the
 * real Codex pack (bundled Node, MCPJam's app-server bridge, the pinned
 * `@openai/codex` platform binary) under the real supervisor and supervised
 * provider, against a mock OpenAI Responses upstream behind a loopback
 * gateway. Only the model is fake.
 *
 *   HOME=<scratch>/home CONFORMANCE_ROOT=<scratch> \
 *     npx tsx run-codex-turn.ts [attended|unattended]
 *
 * attended   — the Playground profile (`workspace-edits` → `allow-edits` →
 *              Codex `untrusted`): a command pauses for approval and runs only
 *              once approved; a host-executed MCP tool runs through MCPJam's
 *              relay; the conversation survives detach + resume; Stop leaves
 *              no process behind.
 * unattended — the eval/swarm profile (`unrestricted` → `allow-all` inside the
 *              explicit D2 sandbox policy): no approval is asked; a command
 *              can write the run's folder and its private TMPDIR, cannot write
 *              elsewhere under /tmp, and has no network — while the MCP tool,
 *              which is not a command, still runs.
 *
 * Every verdict is asserted; a run that observes a violation exits non-zero.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tool } from "ai";
import { z } from "zod";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { getHarnessAdapter } from "../../registry.js";
import { withLocalPackBootstrap } from "../pack-bootstrap.js";
import { withAutoApprovedNativeRequests } from "../../auto-approve-harness.js";
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
import { LOCAL_HARNESS_MANIFEST, localSandboxPolicyFor } from "../compatibility.js";
import {
  localPackTarget,
  LOCAL_HARNESS_POLICY_VERSION,
  type LocalPlatform,
} from "../targets.js";
import { listProcessRecords } from "../process-registry.js";
import { CODEX_LOCAL_ADAPTER_IDENTITY } from "../../codex-appserver/local-identity.js";

const execFileP = promisify(execFile);
const ROOT = process.env.CONFORMANCE_ROOT!;
const PLATFORM = process.platform as LocalPlatform;
const PACK_TARGET = (() => {
  const target = localPackTarget();
  if (target === null) throw new Error(`no pack target for ${process.platform}-${process.arch}`);
  return target;
})();
const CONFORMANCE_VERSION =
  process.env.MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION ?? "local-dev";
const MODE = (process.argv[2] ?? "attended") as "attended" | "attended-off" | "unattended";
const UNATTENDED = MODE === "unattended";
const AUTO_APPROVE = MODE === "attended-off";
const RUNTIME_ROOT = join(ROOT, "runtime");
const BUNDLE = join(RUNTIME_ROOT, "codex");
const WORKSPACE = join(ROOT, UNATTENDED ? "workspace-unattended" : "workspace");
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const UPSTREAM_KEY_CANARY = `upstream-canary-${randomBytes(8).toString("hex")}`;
const CAPABILITY = `cap_${randomBytes(24).toString("base64url")}`;
const POP_SECRET = randomBytes(32).toString("hex");
const WIN = process.platform === "win32";

const t0 = performance.now();
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = Math.round(performance.now() - t0);
  console.log(`[codex-conformance] +${marks[name]}ms ${name}`);
};
const findings: string[] = [];
const note = (s: string) => {
  findings.push(s);
  console.log(`[finding] ${s}`);
};

const helpers: ChildProcess[] = [];
let owned: { supervisor: LocalHarnessSupervisor; sessionId: string } | null = null;

async function stopOwnedTree(): Promise<void> {
  const current = owned;
  owned = null;
  if (current === null) return;
  try {
    await current.supervisor.stopSession(current.sessionId);
  } catch {
    /* best effort */
  }
}

async function stopHelpers(graceMs = 2_000): Promise<void> {
  await Promise.all(
    helpers.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* gone */ }
            resolve();
          }, graceMs);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
        }),
    ),
  );
}

/** Narrow environment for helpers; see `run-native-turn.ts` for why. */
function helperEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  const latency = process.env.MOCK_LATENCY_MS;
  return { ...base, ...(latency ? { MOCK_LATENCY_MS: latency } : {}), ...extra };
}

async function startChild(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [join(SCRIPT_DIR, script)], {
    env: helperEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  helpers.push(child);
  const stderr: string[] = [];
  let tail = "";
  child.stderr!.on("data", (chunk) => {
    tail += String(chunk);
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) if (line !== "") stderr.push(line);
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (c) => {
      buf += String(c);
      const newline = buf.indexOf("\n");
      if (newline < 0) return;
      try { resolve(JSON.parse(buf.slice(0, newline)).port); }
      catch (error) { reject(new Error(`${script} printed ${JSON.stringify(buf)}: ${error}`)); }
    });
    child.on("exit", (code) => reject(new Error(`${script} exited ${code}\n${stderr.slice(-10).join("\n")}`)));
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

async function running(pid: number): Promise<boolean> {
  let state: string;
  try {
    state = (await execFileP("ps", ["-o", "stat=", "-p", String(pid)])).stdout.trim();
  } catch {
    return false;
  }
  return state.length > 0 && !state.startsWith("Z");
}
async function descendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    let kids = "";
    try { kids = (await execFileP("pgrep", ["-P", String(p)])).stdout; } catch { return; }
    for (const k of kids.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean)) {
      out.push(k);
      await walk(k);
    }
  };
  await walk(pid);
  return out;
}
async function psEnv(pid: number) {
  try { return (await execFileP("ps", ["-E", "-o", "command=", "-p", String(pid)])).stdout; }
  catch { return ""; }
}
async function readProcEnv(pid: number) {
  // `ps -E` is not universal; /proc is authoritative on Linux.
  try { return (await readFile(`/proc/${pid}/environ`, "utf8")).replace(/\0/g, "\n"); }
  catch { return psEnv(pid); }
}
async function listeners(pid: number) {
  try {
    return (await execFileP("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"])).stdout
      .split("\n").slice(1).filter(Boolean).map((l) => l.split(/\s+/).slice(-2).join(" "));
  } catch {
    return [];
  }
}

type TurnResult = {
  text: string;
  parts: Record<string, number>;
  approvals: number;
  errors: string[];
  tools: string[];
  finishMs: number;
};

async function runTurn(label: string, agent: any, sessionRef: { s: any }, prompt: string): Promise<TurnResult> {
  const start = performance.now();
  const parts: Record<string, number> = {};
  const errors: string[] = [];
  const toolCalls = new Map<string, any>();
  let text = "";
  let approvals = 0;
  let res: any = await agent.stream({ session: sessionRef.s, prompt });
  let stream: AsyncIterable<any> = res.fullStream;
  for (let round = 0; round < 4; round++) {
    let paused: any = null;
    for await (const part of stream) {
      const type = String(part.type);
      parts[type] = (parts[type] ?? 0) + 1;
      if (type === "text-delta") text += part.text ?? part.textDelta ?? part.delta ?? "";
      if (type === "tool-call") toolCalls.set(part.toolCallId, part);
      if (type === "tool-approval-request") { paused = part; break; }
      if (type === "error") errors.push(String(part.error?.message ?? part.error ?? part));
    }
    if (!paused) break;
    approvals += 1;
    const tc = toolCalls.get(paused.toolCallId) ?? { toolCallId: paused.toolCallId, toolName: paused.toolName ?? "bash", input: paused.input ?? {} };
    console.log(`[codex-conformance] ${label}: approval requested for ${tc.toolName} — approving through the live process`);
    // The pending approval lives in the bridge process (a live JSON-RPC
    // request), so the continuation must reach THAT process: suspend keeps
    // it running, and the continued session reattaches to it.
    const cont = await sessionRef.s.suspendTurn();
    sessionRef.s = await agent.createSession({ sessionId: sessionRef.s.sessionId, continueFrom: cont });
    res = await agent.continueStream({
      session: sessionRef.s,
      toolApprovalContinuations: [{
        approvalResponse: { type: "tool-approval-response", approvalId: paused.approvalId, approved: true },
        toolCall: { type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input },
      }],
    });
    stream = res.fullStream;
  }
  const finishMs = Math.round(performance.now() - start);
  const tools = [...toolCalls.values()].map((c: any) => String(c.toolName));
  console.log(`[codex-conformance] ${label}: ${finishMs}ms parts=${JSON.stringify(parts)} tools=${JSON.stringify(tools)} text=${JSON.stringify(text.slice(0, 200))}`);
  return { text, parts, approvals, errors, tools, finishMs };
}

async function main() {
  if (WIN) throw new Error("the Codex conformance leg has no Windows arm yet (Windows is not a Codex native target)");
  mark("start");
  const mock = await startChild("mock-responses.mjs", { MOCK_POP_SECRET: POP_SECRET, MOCK_UPSTREAM_KEY: UPSTREAM_KEY_CANARY });
  const gw = await startChild("local-gateway.mjs", {
    GW_UPSTREAM: `http://127.0.0.1:${mock.port}`, GW_SESSION_CAPABILITY: CAPABILITY,
    GW_UPSTREAM_KEY: UPSTREAM_KEY_CANARY, GW_POP_SECRET: POP_SECRET,
  });
  const gatewayUrl = `http://127.0.0.1:${gw.port}`;
  mark("gateway_ready");

  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(join(WORKSPACE, "hello.txt"), "hello from the codex conformance workspace\n");
  // A repository's own Codex config, planted where a cloned repo would carry
  // it. Its server must never start: an MCP server launch is not a command,
  // so no approval would ever stand in front of it. `PROBES.md` (b7): Codex
  // trusts a workspace-write cwd by itself unless the session's CODEX_HOME
  // records it untrusted.
  const plantedMarker = join(ROOT, `planted-server-${MODE}.launched`);
  await mkdir(join(WORKSPACE, ".codex"), { recursive: true });
  await writeFile(
    join(WORKSPACE, ".codex", "config.toml"),
    [
      "[mcp_servers.planted_project_server]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ["-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(plantedMarker)}, "launched"); setTimeout(() => {}, 3000)`)}]`,
      "",
    ].join("\n"),
  );
  const before = new Set(await readdir(WORKSPACE));
  const ws = await registerWorkspaceGrant(WORKSPACE);
  if (!ws.ok) throw new Error(ws.message);

  const digest = await computeTreeDigest(BUNDLE);
  const bridgeBytes = await readFile(join(BUNDLE, "bridge.mjs"));
  const base = LOCAL_HARNESS_MANIFEST.codex;
  // THIS scenario's manifest: conformance recorded, this target certified and
  // (for the unattended leg) its sandbox measured — the claims the run exists
  // to test. The shipped manifest keeps refusing until a human records them.
  const manifest = {
    ...base,
    runtime: { ...(base.runtime as any), bundleDigest: { [PACK_TARGET]: digest } },
    lifecycleConformanceVersion: CONFORMANCE_VERSION,
    nativePlatforms: [...new Set([...base.nativePlatforms, PLATFORM])],
    nativeTargets: [...new Set([...(base.nativeTargets ?? []), PACK_TARGET])],
    unattendedSandboxTargets: UNATTENDED ? [PACK_TARGET] : [],
    bridgeBundleDigest: `sha256:${createHash("sha256").update(bridgeBytes).digest("hex")}`,
  } as typeof base;
  const rt = await resolveManagedBundle({ manifest, runtimeRoot: RUNTIME_ROOT, platform: PLATFORM });
  if (!rt.ok) throw new Error(`${rt.status}: ${rt.message}`);
  if (rt.runtime.adapterVersion !== CODEX_LOCAL_ADAPTER_IDENTITY) {
    note(`pack adapter ${rt.runtime.adapterVersion} vs Inspector ${CODEX_LOCAL_ADAPTER_IDENTITY}`);
  }
  const machineId = await getLocalMachineId();
  const permissionProfile = UNATTENDED ? "unrestricted" as const : "workspace-edits" as const;
  const scope = UNATTENDED ? "unattended" as const : "attended" as const;
  const target = {
    kind: "local-native" as const, machineId, workspaceGrantId: ws.grant.workspaceGrantId, harnessId: "codex" as const,
    runtimeId: rt.runtime.runtimeId, permissionProfile, policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  };
  const grant = await grantLocalHarnessConsent({
    userId: "conformance-user", machineId, projectId: "conformance-project", workspaceGrantId: target.workspaceGrantId,
    harnessId: "codex", targetKind: "local-native", runtimeId: target.runtimeId,
    permissionProfile, policyVersion: LOCAL_HARNESS_POLICY_VERSION, scope,
  } as any);
  mark("consent_granted");

  const availability = await resolveLocalHarnessAvailability({
    target, scope,
    actor: { isGuest: false, isScenarioSession: false, isJourneySession: false },
    userId: "conformance-user", projectId: "conformance-project",
    grantToken: grant.token, runtimeRoot: RUNTIME_ROOT, installedAdapterVersion: CODEX_LOCAL_ADAPTER_IDENTITY,
    manifests: { codex: manifest }, killSwitchEnabled: true, hosted: false,
  } as any);
  if (!availability.available) throw new Error(`availability: ${availability.status}: ${availability.message}`);
  const plan = availability.plan;
  mark("availability_ok");
  console.log(`[codex-conformance] permissionMode=${plan.permissionMode} workspace=${plan.workspacePath}`);
  if (plan.permissionMode !== (UNATTENDED ? "allow-all" : "allow-edits")) {
    throw new Error(`profile ${permissionProfile} resolved to ${plan.permissionMode}`);
  }
  const sandboxPolicy = localSandboxPolicyFor("codex", permissionProfile, "local-native", scope);
  if (UNATTENDED !== (sandboxPolicy !== null)) throw new Error("the sandbox policy does not match the scope");

  const supervisor = new LocalHarnessSupervisor();
  await supervisor.reclaimOrphans();
  const launcher = resolveNodeLauncher({ bundledNodePath: plan.runtime.nodePath! });
  const bridgePort = await freePort();
  const sessionId = `codex-conformance-${Date.now()}`;
  owned = { supervisor, sessionId };
  const sessionStateDir = sessionStateDirFor(localHarnessStateRoot(), sessionId);
  let bridgePid = -1;
  const provider = createSupervisedLocalHarnessProvider({
    harnessId: "codex", manifest: plan.manifest, runtime: plan.runtime, supervisor, launcher,
    workspacePath: plan.workspacePath, workspaceGrantId: target.workspaceGrantId, sessionStateDir,
    targetKind: "local-native", bridgePort, bridgeReadinessTimeoutMs: 60_000,
    onBridgeStarted: async ({ pid }) => { bridgePid = pid; mark("bridge_listening"); },
  });

  // A host-executed MCP tool, exactly as the turn runner projects one:
  // `mcp__<server>__<tool>`, executed HERE, relayed from Codex through
  // MCPJam's MCP server inside the session.
  let probeCalls = 0;
  const hostTools = {
    mcp__probe__echo: tool({
      description: "Echo a message back (conformance probe).",
      inputSchema: z.object({ message: z.string() }),
      execute: async ({ message }) => {
        probeCalls += 1;
        return `PROBE_OK:${message}`;
      },
    }),
  };
  // Narrowed on the delivery mode, as the turn runner does: local Codex's MCP
  // tools are host-executed, so its adapter takes no MCP config at all.
  const adapter = getHarnessAdapter("codex", { localExecution: true });
  if (adapter.mcpDelivery !== "host-executed") {
    throw new Error("local Codex must use host-executed MCP delivery");
  }
  const harness = adapter.createHarness({
    modelId: "openai/gpt-5.5",
    auth: { CODEX_API_KEY: CAPABILITY, OPENAI_BASE_URL: gatewayUrl } as any,
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  });
  const localHarness = await withLocalPackBootstrap(harness, plan.runtime.rootPath);
  const agent: any = new HarnessAgent({
    harness: (AUTO_APPROVE ? withAutoApprovedNativeRequests(localHarness) : localHarness) as any,
    sandbox: provider,
    permissionMode: UNATTENDED ? plan.permissionMode : "allow-reads",
    instructions: "You are running a conformance check.",
    sandboxConfig: { workDir: "project" },
    tools: hostTools as any,
  });

  const sessionRef = { s: await agent.createSession({ sessionId }) };
  mark("session_ready");

  const failures: string[] = [];
  const turns: Record<string, TurnResult> = {};
  const ranCommand = (t: TurnResult) => t.tools.some((name) => name.toLowerCase() === "bash");

  if (!UNATTENDED) {
    turns.read = await runTurn("attended-read", agent, sessionRef, "SHELL cat hello.txt");
    if (AUTO_APPROVE ? turns.read.approvals !== 0 : turns.read.approvals < 1) failures.push(`attended: unexpected approval count with auto-approve=${AUTO_APPROVE}`);
    if (!ranCommand(turns.read)) failures.push(`attended: no command tool call (tools=${JSON.stringify(turns.read.tools)})`);
    if (!turns.read.text.includes("hello from the codex conformance workspace")) failures.push("attended: the approved command's output did not come back through the model");
    if (AUTO_APPROVE) {
      await writeFile(join(WORKSPACE, "attended-off-marker.txt"), "");
      turns.marker = await runTurn("attended-off-marker", agent, sessionRef, "SHELL printf 'run\\n' >> attended-off-marker.txt");
      if (turns.marker.approvals !== 0) failures.push("attended Off asked for native approval");
      if ((await readFile(join(WORKSPACE, "attended-off-marker.txt"), "utf8")) !== "run\n") failures.push("attended Off marker command did not execute exactly once");
      await rm(join(WORKSPACE, "attended-off-marker.txt"));
    }
  } else {
    const outsidePath = join("/tmp", `mcpjam-codex-outside-${randomBytes(6).toString("hex")}`);
    turns.inside = await runTurn("unattended-write-inside", agent, sessionRef, "SHELL echo inside > inside.txt && echo WROTE_INSIDE");
    turns.tmpdir = await runTurn("unattended-write-tmpdir", agent, sessionRef, 'SHELL echo private > "$TMPDIR/private.txt" && cat "$TMPDIR/private.txt" && echo TMPDIR_OK');
    turns.outside = await runTurn("unattended-write-outside", agent, sessionRef, `SHELL echo outside > ${outsidePath}; echo EXIT=$?`);
    turns.network = await runTurn("unattended-network", agent, sessionRef, `SHELL bash -c 'exec 3<>/dev/tcp/127.0.0.1/${gw.port} && echo NET_OPEN || echo NET_BLOCKED'`);
    for (const [label, turn] of Object.entries(turns)) {
      if (turn.approvals > 0) failures.push(`unattended ${label}: asked for approval with nobody there to answer`);
      if (!ranCommand(turn)) failures.push(`unattended ${label}: no command ran (tools=${JSON.stringify(turn.tools)})`);
    }
    const inside = await readFile(join(WORKSPACE, "inside.txt"), "utf8").catch(() => null);
    if (inside?.trim() !== "inside") failures.push("unattended: a command could not write the run's own folder");
    if (!turns.tmpdir.text.includes("TMPDIR_OK")) failures.push("unattended: a command could not use its private TMPDIR");
    if (await stat(outsidePath).then(() => true, () => false)) failures.push(`unattended: a command wrote outside the sandbox (${outsidePath})`);
    if (!turns.network.text.includes("NET_BLOCKED") || turns.network.text.includes("NET_OPEN")) failures.push("unattended: a command reached the network");
    note(`sandbox: inside=${inside?.trim()} tmpdir=${turns.tmpdir.text.includes("TMPDIR_OK")} outside-written=${await stat(outsidePath).then(() => true, () => false)} network=${turns.network.text.includes("NET_BLOCKED") ? "blocked" : "OPEN"}`);
  }

  turns.mcp = await runTurn("mcp-relay", agent, sessionRef, "MCPPROBE");
  if (probeCalls < 1) failures.push("the host-executed MCP tool never ran");
  if (!turns.mcp.text.includes("PROBE_OK:conformance")) failures.push("the MCP tool's result did not come back through the model");
  if (turns.mcp.approvals > 0) failures.push("the relayed MCP tool raised a Codex approval (MCPJam's gate must be the single authority)");

  // Process tree and hygiene while the session is live.
  const kids = await descendants(bridgePid);
  const tree = [bridgePid, ...kids];
  const envDump = (await Promise.all(tree.map(readProcEnv))).join("\n");
  if (envDump.includes(UPSTREAM_KEY_CANARY)) failures.push("the upstream model key reached a child process's environment");
  const bridgeListeners = (await Promise.all(tree.map(listeners))).flat();
  const offLoopback = bridgeListeners.filter((l) => !/^(127\.|\[?::1\]?:)/.test(l));
  if (offLoopback.length > 0) failures.push(`a supervised process listened off loopback: ${JSON.stringify(offLoopback)}`);
  note(`tree: ${tree.length} processes; listeners ${JSON.stringify(bridgeListeners)}`);

  // Continuity across detach + resume of the same thread.
  const resumeState = await sessionRef.s.detach();
  const resumed = { s: await agent.createSession({ sessionId, resumeFrom: resumeState }) };
  turns.count = await runTurn("count-after-resume", agent, resumed, "COUNT");
  const seen = Number(/USER_TURNS=(\d+)/.exec(turns.count.text)?.[1] ?? 0);
  const expected = Object.keys(turns).length; // every turn above, plus COUNT itself
  if (seen < expected) failures.push(`after resume the model saw ${seen} user turns, expected >= ${expected}`);
  note(`continuity: ${seen} user turns visible after detach + resume`);

  const treeBefore = [bridgePid, ...(await descendants(bridgePid))];
  let stopError: string | undefined;
  try { await resumed.s.stop(); } catch (e: any) { stopError = String(e?.message ?? e); }
  await new Promise((r) => setTimeout(r, 300));
  await supervisor.stopSession(sessionId);
  owned = null;
  const survivors = (await Promise.all(treeBefore.map(async (pid) => (await running(pid)) ? pid : null))).filter((p): p is number => p !== null);
  if (stopError) note(`stop() threw: ${stopError}`);
  if (survivors.length > 0) failures.push(`Stop left ${survivors.length} process(es) running: ${survivors}`);
  const records = (await listProcessRecords()).length;
  if (records !== 0) failures.push(`${records} process registry record(s) survived Stop`);

  for (const [label, turn] of Object.entries(turns)) {
    if (turn.errors.length > 0) failures.push(`${label} reported stream errors: ${JSON.stringify(turn.errors.slice(0, 3))}`);
    if (turn.text.trim() === "") failures.push(`${label} produced no assistant text`);
  }
  const gatewayErrors = gw.stderr.filter((l) => l.includes("upstream error") || l.includes("upstream timeout") || l.includes("REJECT"));
  if (gatewayErrors.length > 0) failures.push(`the gateway reported: ${JSON.stringify(gatewayErrors.slice(0, 3))}`);
  const plantedLaunched = await stat(plantedMarker).then(() => true, () => false);
  note(`project layer: planted .codex/config.toml server launched=${plantedLaunched}`);
  if (plantedLaunched) failures.push("Codex launched the MCP server from the workspace's own .codex/config.toml");
  const unexpected = (await readdir(WORKSPACE)).filter((e) => !before.has(e) && e !== "inside.txt");
  if (unexpected.length > 0) failures.push(`the session left entries in the workspace: ${JSON.stringify(unexpected)}`);

  await stopHelpers();
  await revokeLocalHarnessGrants();
  console.log("\n=====REPORT=====\n" + JSON.stringify({ mode: MODE, marks, findings, turns, mock: mock.stderr.slice(-12), gateway: gw.stderr.slice(-6) }, null, 2));
  if (failures.length > 0) throw new Error(`codex conformance assertions failed:\n  - ${failures.join("\n  - ")}`);
  console.log(`[codex-conformance] ${MODE}: PASS`);
}

main().catch(async (e) => {
  await stopOwnedTree();
  await stopHelpers();
  await revokeLocalHarnessGrants().catch(() => {});
  console.error("[codex-conformance] FAILED:", e?.stack ?? e);
  console.error("[codex-conformance] marks:", JSON.stringify(marks));
  console.error("[codex-conformance] findings:", JSON.stringify(findings, null, 1));
  process.exit(1);
});
