/**
 * GATEWAY RUNTIME CONFORMANCE — any local runtime that reaches its model
 * through the local model gateway, driven end to end on this machine: its real
 * pack under the real supervisor and supervised provider, MCPJam's bridge from
 * this checkout's Inspector layer, the real vendor CLI, and a mock upstream
 * for the runtime's protocol behind a loopback gateway. Only the model is fake.
 *
 *   HOME=<scratch>/home CONFORMANCE_ROOT=<scratch> \
 *     npx tsx run-gateway-turn.ts <harnessId>
 *
 * The pack is `<scratch>/runtime/<harnessId>`. Everything this asserts is what
 * every local runtime owes the member, so a runtime made local runs it before
 * anything runtime-specific:
 *
 *  - a text turn comes back through the gateway, with the capability, never
 *    the upstream key, in any supervised process's environment;
 *  - a host tool MCPJam registers runs here and its result reaches the model;
 *  - the conversation survives detach and resume, and after Stop the next
 *    message continues it on a fresh bridge, as a chat turn resumes it;
 *  - no supervised process listens off loopback;
 *  - Stop leaves no process and no registry record, and nothing in the
 *    workspace.
 *
 * Every verdict is asserted; a run that observes a violation exits non-zero.
 */
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { HARNESS_DESCRIPTORS } from "../../../../../shared/harness-descriptors.js";
import { getHarnessAdapter } from "../../registry.js";
import { withLocalRuntimeBootstrap } from "../pack-bootstrap.js";
import { diskResumeState } from "../resume-state.js";
import { LocalHarnessSupervisor } from "../supervisor.js";
import { createSupervisedLocalHarnessProvider, sessionStateDirFor } from "../supervised-provider.js";
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
import { localPackTarget, LOCAL_HARNESS_POLICY_VERSION, type LocalPlatform } from "../targets.js";
import { listProcessRecords } from "../process-registry.js";
import { localRuntimeOf } from "../runtimes/index.js";
import {
  descendants,
  freePort,
  isLoopbackListener,
  listeners,
  processEnvironment,
  running,
  startHelper,
  stopHelpers,
} from "./process-checks.js";

const HARNESS_ID = process.argv[2] ?? "";
const runtime = localRuntimeOf(HARNESS_ID);
if (runtime === undefined) throw new Error(`${JSON.stringify(HARNESS_ID)} is not a local runtime`);
const ROOT = process.env.CONFORMANCE_ROOT!;
const PLATFORM = process.platform as LocalPlatform;
const PACK_TARGET = localPackTarget();
if (PACK_TARGET === null) throw new Error(`no pack target for ${process.platform}-${process.arch}`);
const CONFORMANCE_VERSION = process.env.MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION ?? "local-dev";
const RUNTIME_ROOT = join(ROOT, "runtime");
const WORKSPACE = join(ROOT, `workspace-${runtime.harnessId}`);
const UPSTREAM_KEY_CANARY = `upstream-canary-${randomBytes(8).toString("hex")}`;
const CAPABILITY = `cap_${randomBytes(24).toString("base64url")}`;
const POP_SECRET = randomBytes(32).toString("hex");

/** The scenario turns the mock saw, oldest first, from its COUNT reply. */
const scenariosSeen = (text: string) => /SCENARIOS=([A-Z,]*)/.exec(text)?.[1] ?? "";

/** The mock upstream for each model protocol, and how it names the probe. */
const MOCKS: Partial<Record<string, { script: string; env: Record<string, string> }>> = {
  // MCPJam's host tools reach a non-Codex runtime as plain functions.
  "openai-responses": { script: "mock-responses.mjs", env: { MOCK_PROBE_NAMESPACE: "" } },
};

// A CI log, not the server's: plain lines on stdout, failures on stderr.
const say = (line: string) => process.stdout.write(`[${HARNESS_ID}-conformance] ${line}\n`);
const t0 = performance.now();
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = Math.round(performance.now() - t0);
  say(`+${marks[name]}ms ${name}`);
};
const helpers: ChildProcess[] = [];
let owned: { supervisor: LocalHarnessSupervisor; sessionId: string } | null = null;

type TurnResult = { text: string; parts: Record<string, number>; errors: string[]; tools: string[] };

async function runTurn(label: string, agent: HarnessAgent, session: HarnessAgentSession, prompt: string): Promise<TurnResult> {
  const parts: Record<string, number> = {};
  const errors: string[] = [];
  const tools: string[] = [];
  let text = "";
  const result = await agent.stream({ session, prompt });
  for await (const part of result.fullStream) {
    parts[part.type] = (parts[part.type] ?? 0) + 1;
    if (part.type === "text-delta") text += part.text;
    if (part.type === "tool-call") tools.push(part.toolName);
    if (part.type === "error") errors.push(part.error instanceof Error ? part.error.message : String(part.error));
  }
  say(`${label}: parts=${JSON.stringify(parts)} tools=${JSON.stringify(tools)} text=${JSON.stringify(text.slice(0, 200))}`);
  return { text, parts, errors, tools };
}

async function main() {
  const protocol = HARNESS_DESCRIPTORS[runtime!.harnessId].protocol;
  const mockSpec = protocol === null ? undefined : MOCKS[protocol];
  if (mockSpec === undefined) {
    throw new Error(`${HARNESS_ID} speaks ${String(protocol)}, which has no mock upstream here; add one to MOCKS`);
  }
  mark("start");
  const mock = await startHelper(mockSpec.script, {
    ...mockSpec.env,
    MOCK_POP_SECRET: POP_SECRET,
    MOCK_UPSTREAM_KEY: UPSTREAM_KEY_CANARY,
  }, helpers);
  const gateway = await startHelper("local-gateway.mjs", {
    GW_UPSTREAM: `http://127.0.0.1:${mock.port}`,
    GW_SESSION_CAPABILITY: CAPABILITY,
    GW_UPSTREAM_KEY: UPSTREAM_KEY_CANARY,
    GW_POP_SECRET: POP_SECRET,
  }, helpers);
  mark("gateway_ready");

  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(join(WORKSPACE, "hello.txt"), "hello from the conformance workspace\n");
  const before = new Set(await readdir(WORKSPACE));
  const workspace = await registerWorkspaceGrant(WORKSPACE);
  if (!workspace.ok) throw new Error(workspace.message);

  const bundle = join(RUNTIME_ROOT, runtime!.harnessId);
  const digest = await computeTreeDigest(bundle);
  const base = runtime!.manifest;
  // THIS scenario's manifest: conformance recorded and this target's pack
  // pinned, the claims the run exists to test.
  const manifest = {
    ...base,
    runtime: base.runtime.source === "managed-bundle"
      ? { ...base.runtime, bundleDigest: { [PACK_TARGET!]: digest } }
      : base.runtime,
    lifecycleConformanceVersion: CONFORMANCE_VERSION,
    nativePlatforms: [...new Set([...base.nativePlatforms, PLATFORM])],
    ...(base.nativeTargets ? { nativeTargets: [...new Set([...base.nativeTargets, PACK_TARGET!])] } : {}),
  };
  const resolved = await resolveManagedBundle({ manifest, runtimeRoot: RUNTIME_ROOT, platform: PLATFORM });
  if (!resolved.ok) throw new Error(`${resolved.status}: ${resolved.message}`);
  if (resolved.runtime.layer === undefined) throw new Error(`${HARNESS_ID} resolved without an Inspector layer`);
  say(`pack=${digest} layer=${resolved.runtime.layer.digest}`);

  const machineId = await getLocalMachineId();
  const target = {
    kind: "local-native" as const,
    machineId,
    workspaceGrantId: workspace.grant.workspaceGrantId,
    harnessId: runtime!.harnessId,
    runtimeId: resolved.runtime.runtimeId,
    permissionProfile: "workspace-edits" as const,
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  };
  const grant = await grantLocalHarnessConsent({
    userId: "conformance-user",
    machineId,
    projectId: "conformance-project",
    workspaceGrantId: target.workspaceGrantId,
    harnessId: target.harnessId,
    targetKind: "local-native",
    runtimeId: target.runtimeId,
    permissionProfile: target.permissionProfile,
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
    scope: "attended",
  });
  const availability = await resolveLocalHarnessAvailability({
    target,
    scope: "attended",
    actor: { isGuest: false, isScenarioSession: false, isJourneySession: false },
    userId: "conformance-user",
    projectId: "conformance-project",
    grantToken: grant.token,
    runtimeRoot: RUNTIME_ROOT,
    installedAdapterVersion: runtime!.installedAdapterVersion(),
    manifests: { [runtime!.harnessId]: manifest },
    killSwitchEnabled: true,
    hosted: false,
  });
  if (!availability.available) throw new Error(`availability: ${availability.status}: ${availability.message}`);
  const plan = availability.plan;
  mark("availability_ok");

  const supervisor = new LocalHarnessSupervisor();
  await supervisor.reclaimOrphans();
  const sessionId = `${HARNESS_ID}-conformance-${Date.now()}`;
  owned = { supervisor, sessionId };
  let bridgePid = -1;
  const provider = createSupervisedLocalHarnessProvider({
    harnessId: runtime!.harnessId,
    manifest: plan.manifest,
    runtime: plan.runtime,
    supervisor,
    launcher: resolveNodeLauncher({ bundledNodePath: plan.runtime.nodePath! }),
    workspacePath: plan.workspacePath,
    workspaceGrantId: target.workspaceGrantId,
    sessionStateDir: sessionStateDirFor(localHarnessStateRoot(), sessionId),
    targetKind: "local-native",
    bridgePort: await freePort(),
    bridgeReadinessTimeoutMs: 60_000,
    onBridgeStarted: async ({ pid }) => {
      bridgePid = pid;
      mark("bridge_listening");
    },
  });

  // A host-executed tool, exactly as the turn runner projects one.
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
  const harness = getHarnessAdapter(runtime!.harnessId).createHarness({
    modelId: "gpt-5.5",
    auth: runtime!.childAuth({ baseUrl: `http://127.0.0.1:${gateway.port}`, sessionCapability: CAPABILITY }),
    // No forwarded server: the host tool above is the MCP path this checks.
    mcpJson: { mcpServers: {} },
  });
  const agent = new HarnessAgent({
    harness: await withLocalRuntimeBootstrap(harness, plan.runtime),
    sandbox: provider,
    permissionMode: "allow-reads",
    instructions: "You are running a conformance check.",
    sandboxConfig: { workDir: "project" },
    tools: hostTools,
  } as ConstructorParameters<typeof HarnessAgent>[0]);
  let session = await agent.createSession({ sessionId });
  mark("session_ready");

  const failures: string[] = [];
  const turns: Record<string, TurnResult> = {};
  turns.text = await runTurn("text", agent, session, "HELLO");
  turns.probe = await runTurn("host-tool", agent, session, "MCPPROBE");
  if (probeCalls < 1) failures.push("the host tool never ran");
  if (!turns.probe.text.includes("PROBE_OK:conformance")) failures.push("the host tool's result did not come back through the model");

  const tree = [bridgePid, ...(await descendants(bridgePid))];
  const environments = await Promise.all(tree.map(processEnvironment));
  if (environments.some((env) => env?.includes(UPSTREAM_KEY_CANARY))) failures.push("the upstream model key reached a child process's environment");
  if (process.platform === "win32") {
    say("child environments cannot be read on Windows; the upstream key check did not run");
  } else if (environments.includes(null)) {
    failures.push("a supervised process's environment could not be read, so the upstream key check proved nothing");
  }
  const offLoopback = (await Promise.all(tree.map(listeners))).flat().filter((listener) => !isLoopbackListener(listener));
  if (offLoopback.length > 0) failures.push(`a supervised process listened off loopback: ${JSON.stringify(offLoopback)}`);

  const resumeState = await session.detach();
  session = await agent.createSession({ sessionId, resumeFrom: resumeState });
  turns.count = await runTurn("count-after-resume", agent, session, "COUNT");
  // Exactly HELLO, MCPPROBE and this COUNT, in order: a turn lost, repeated or
  // reordered on resume fails here.
  const afterResume = scenariosSeen(turns.count.text);
  if (afterResume !== "HELLO,MCPPROBE,COUNT") {
    failures.push(`after resume the model saw ${afterResume || "no scenario turns"}, expected HELLO,MCPPROBE,COUNT`);
  }

  const stopAndCheck = async (current: HarnessAgentSession, label: string) => {
    const tree = [bridgePid, ...(await descendants(bridgePid))];
    // The supervisor below reaps the tree either way; a Stop that throws has
    // still failed the member.
    await current.stop().catch((error: unknown) => failures.push(`${label}: stop() threw: ${String(error)}`));
    await supervisor.stopSession(sessionId);
    const survivors: number[] = [];
    for (const pid of tree) if (await running(pid)) survivors.push(pid);
    if (survivors.length > 0) failures.push(`${label} left ${survivors.length} process(es) running: ${survivors}`);
    const records = (await listProcessRecords()).length;
    if (records !== 0) failures.push(`${records} process registry record(s) survived ${label}`);
  };
  await stopAndCheck(session, "Stop");

  // The member's next message: the saved state with its bridge stripped, so a
  // fresh bridge resumes the conversation from disk.
  session = await agent.createSession({ sessionId, resumeFrom: diskResumeState(resumeState) });
  turns.afterStop = await runTurn("after-stop", agent, session, "COUNT");
  const afterStop = scenariosSeen(turns.afterStop.text);
  if (afterStop !== "HELLO,MCPPROBE,COUNT,COUNT") {
    failures.push(`after Stop the next message saw ${afterStop || "no scenario turns"}, expected HELLO,MCPPROBE,COUNT,COUNT`);
  }
  await stopAndCheck(session, "the second Stop");
  owned = null;
  for (const [label, turn] of Object.entries(turns)) {
    if (turn.errors.length > 0) failures.push(`${label} reported stream errors: ${JSON.stringify(turn.errors.slice(0, 3))}`);
    if (turn.text.trim() === "") failures.push(`${label} produced no assistant text`);
  }
  const rejected = gateway.stderr.filter((line) => /upstream error|upstream timeout|REJECT/.test(line));
  if (rejected.length > 0) failures.push(`the gateway reported: ${JSON.stringify(rejected.slice(0, 3))}`);
  const unexpected = (await readdir(WORKSPACE)).filter((entry) => !before.has(entry));
  if (unexpected.length > 0) failures.push(`the session left entries in the workspace: ${JSON.stringify(unexpected)}`);

  await stopHelpers(helpers);
  await revokeLocalHarnessGrants();
  process.stdout.write(`\n=====REPORT=====\n${JSON.stringify({ harness: HARNESS_ID, marks, turns, mock: mock.stderr.slice(-12), gateway: gateway.stderr.slice(-6) }, null, 2)}\n`);
  if (failures.length > 0) throw new Error(`${HARNESS_ID} conformance assertions failed:\n  - ${failures.join("\n  - ")}`);
  say("PASS");
}

main().catch(async (error: unknown) => {
  const current = owned;
  owned = null;
  // Cleanup on a failed run. The run's own error is what fails it, so a
  // cleanup error is only reported beside it.
  const cleanup = await Promise.allSettled([
    current?.supervisor.stopSession(current.sessionId),
    stopHelpers(helpers),
    revokeLocalHarnessGrants(),
  ]);
  const report = (line: string) => process.stderr.write(`[${HARNESS_ID}-conformance] ${line}\n`);
  report(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  report(`marks: ${JSON.stringify(marks)}`);
  for (const outcome of cleanup) if (outcome.status === "rejected") report(`cleanup failed: ${String(outcome.reason)}`);
  process.exit(1);
});
