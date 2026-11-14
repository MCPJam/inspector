/**
 * RUNTIME-LOGIN LIFECYCLE CONFORMANCE: a local runtime that reaches its own
 * vendor on a login (Cursor), driven end to end on this machine: its real pack
 * under the real supervisor and supervised provider, the bridge from this
 * checkout's Inspector layer, and the real vendor CLI, started with a login
 * the vendor will refuse.
 *
 *   HOME=<scratch>/home CONFORMANCE_ROOT=<scratch> \
 *     npx tsx run-login-lifecycle.ts <harnessId>
 *
 * CI has no vendor account, so no turn can succeed here. What this proves is
 * everything around one (`run-gateway-turn.ts` is the gateway runtimes' full
 * turn, and its setup is the same):
 *
 *  - every command the pinned adapter sends is one the translator knows, and
 *    the bridge starts the CLI from the verified pack;
 *  - the CLI checks the login it was started with, and a refused one ends the
 *    turn with an error: no browser opens to sign in, and nothing waits on
 *    one;
 *  - the login is in no file the session leaves behind;
 *  - no supervised process listens off loopback;
 *  - Stop leaves no process, no registry record, and nothing in the workspace.
 *
 * Every verdict is asserted; a run that observes a violation exits non-zero.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { getHarnessAdapter } from "../../registry.js";
import { resolveLocalHarnessAvailability } from "../availability.js";
import {
  getLocalMachineId,
  grantLocalHarnessConsent,
  localHarnessStateRoot,
  registerWorkspaceGrant,
  revokeLocalHarnessGrants,
} from "../grants.js";
import { resolveNodeLauncher } from "../node-launcher.js";
import { withLocalRuntimeBootstrap } from "../pack-bootstrap.js";
import { listProcessRecords } from "../process-registry.js";
import { computeTreeDigest, resolveManagedBundle } from "../runtime-identity.js";
import { localRuntimeOf } from "../runtimes/index.js";
import { createSupervisedLocalHarnessProvider, sessionStateDirFor } from "../supervised-provider.js";
import { LocalHarnessSupervisor } from "../supervisor.js";
import { localPackTarget, LOCAL_HARNESS_POLICY_VERSION, type LocalPlatform } from "../targets.js";
import { descendants, freePort, isLoopbackListener, running, treeListeners } from "./process-checks.js";

const HARNESS_ID = process.argv[2] ?? "";
const runtime = localRuntimeOf(HARNESS_ID);
if (runtime === undefined) throw new Error(`${JSON.stringify(HARNESS_ID)} is not a local runtime`);
const credential = runtime.credential;
if (credential.kind !== "runtime-login") throw new Error(`${HARNESS_ID} runs through a model gateway; use run-gateway-turn.ts`);
const loginCredential = credential;
const ROOT = process.env.CONFORMANCE_ROOT!;
const PLATFORM = process.platform as LocalPlatform;
const PACK_TARGET = localPackTarget();
if (PACK_TARGET === null) throw new Error(`no pack target for ${process.platform}-${process.arch}`);
const CONFORMANCE_VERSION = process.env.MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION ?? "local-dev";
const RUNTIME_ROOT = join(ROOT, "runtime");
const WORKSPACE = join(ROOT, `workspace-${runtime.harnessId}`);
/** A login the vendor refuses, and a canary to look for in what the session leaves. */
const LOGIN_CANARY = `login-canary-${randomBytes(12).toString("hex")}`;
/** Longer than any refusal takes; a sign-in waiting on a person never ends. */
const TURN_TIMEOUT_MS = 120_000;

const say = (line: string) => process.stdout.write(`[${HARNESS_ID}-lifecycle] ${line}\n`);
const t0 = performance.now();
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = Math.round(performance.now() - t0);
  say(`+${marks[name]}ms ${name}`);
};
let owned: { supervisor: LocalHarnessSupervisor; sessionId: string } | null = null;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function main() {
  mark("start");
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
  const sessionId = `${HARNESS_ID}-lifecycle-${Date.now()}`;
  owned = { supervisor, sessionId };
  const sessionStateDir = sessionStateDirFor(localHarnessStateRoot(), sessionId);
  let bridgePid = -1;
  const provider = createSupervisedLocalHarnessProvider({
    harnessId: runtime!.harnessId,
    manifest: plan.manifest,
    runtime: plan.runtime,
    supervisor,
    launcher: resolveNodeLauncher({ bundledNodePath: plan.runtime.nodePath! }),
    workspacePath: plan.workspacePath,
    workspaceGrantId: target.workspaceGrantId,
    sessionStateDir,
    targetKind: "local-native",
    bridgePort: await freePort(),
    bridgeReadinessTimeoutMs: 60_000,
    // Exactly as a local turn starts it (`local-turn.ts`).
    scopedEnv: loginCredential.childEnv({ accessToken: LOGIN_CANARY, expiresAt: Date.now() + 3_600_000 }),
    onBridgeStarted: async ({ pid }) => {
      bridgePid = pid;
      mark("bridge_listening");
    },
  });
  const harness = getHarnessAdapter(runtime!.harnessId).createHarness({
    modelId: "auto",
    auth: loginCredential.adapterAuth,
    mcpJson: { mcpServers: {} },
  });
  const agent = new HarnessAgent({
    harness: await withLocalRuntimeBootstrap(harness, plan.runtime),
    sandbox: provider,
    permissionMode: "allow-reads",
    instructions: "You are running a conformance check.",
    sandboxConfig: { workDir: "project" },
    tools: {},
  } as ConstructorParameters<typeof HarnessAgent>[0]);

  const failures: string[] = [];
  const errors: string[] = [];
  let text = "";
  let session: Awaited<ReturnType<typeof agent.createSession>> | null = null;
  const turn = (async () => {
    const created = await agent.createSession({ sessionId });
    session = created;
    mark("session_ready");
    const result = await agent.stream({ session: created, prompt: "HELLO", options: undefined });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      if (part.type === "error") errors.push(describe(part.error));
    }
  })().catch((error: unknown) => {
    errors.push(describe(error));
  });
  const timedOut = await Promise.race([
    turn.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), TURN_TIMEOUT_MS)),
  ]);
  mark("turn_ended");
  say(`errors=${JSON.stringify(errors.slice(0, 3))} text=${JSON.stringify(text.slice(0, 200))}`);
  if (timedOut) failures.push(`the turn with a refused login was still running after ${TURN_TIMEOUT_MS}ms`);
  if (bridgePid < 0) failures.push("the bridge never started");
  if (errors.length === 0) failures.push("a refused login produced no error");
  if (text.trim() !== "") failures.push("a refused login produced assistant text");
  if (errors.some((message) => /not part of the pinned|must be the bridge path|CommandTranslation|is not a local shape/i.test(message))) {
    failures.push("the translator refused a command the pinned adapter sent");
  }
  // The CLI's own log, in the session's home: it checked the login it was
  // started with, and never opened a browser to replace it.
  const cliLog = (await Promise.all((await filesUnder(sessionStateDir)).filter((file) => /cursor-agent-logs/.test(file)).map((file) => readFile(file, "utf8")))).join("\n");
  if (!/login check result: false/.test(cliLog)) failures.push("the CLI never checked the login it was started with");
  if (/Browser opened for login|Waiting for login result/.test(cliLog)) failures.push("the CLI opened a browser to sign in");

  if (bridgePid > 0) {
    const tree = [bridgePid, ...(await descendants(bridgePid))];
    const listening = await treeListeners(tree);
    if (listening === null) failures.push("a supervised process's listeners could not be read, so the loopback check proved nothing");
    const offLoopback = (listening ?? []).filter((listener) => !isLoopbackListener(listener));
    if (offLoopback.length > 0) failures.push(`a supervised process listened off loopback: ${JSON.stringify(offLoopback)}`);
    const current = session as { stop(): Promise<void> } | null;
    await current?.stop().catch((error: unknown) => failures.push(`stop() threw: ${String(error)}`));
    await supervisor.stopSession(sessionId);
    const survivors: number[] = [];
    for (const pid of tree) if (await running(pid)) survivors.push(pid);
    if (survivors.length > 0) failures.push(`Stop left ${survivors.length} process(es) running: ${survivors}`);
  } else {
    await supervisor.stopSession(sessionId);
  }
  owned = null;
  const records = (await listProcessRecords()).length;
  if (records !== 0) failures.push(`${records} process registry record(s) survived Stop`);
  for (const file of [...(await filesUnder(sessionStateDir)), ...(await filesUnder(WORKSPACE))]) {
    if ((await readFile(file, "utf8").catch(() => "")).includes(LOGIN_CANARY)) failures.push(`the login was written to ${file}`);
  }
  const unexpected = (await readdir(WORKSPACE)).filter((entry) => !before.has(entry));
  if (unexpected.length > 0) failures.push(`the session left entries in the workspace: ${JSON.stringify(unexpected)}`);

  await revokeLocalHarnessGrants();
  process.stdout.write(`\n=====REPORT=====\n${JSON.stringify({ harness: HARNESS_ID, marks, errors: errors.slice(0, 5) }, null, 2)}\n`);
  if (failures.length > 0) throw new Error(`${HARNESS_ID} lifecycle assertions failed:\n  - ${failures.join("\n  - ")}`);
  say("PASS");
  process.exit(0);
}

main().catch(async (error: unknown) => {
  const current = owned;
  owned = null;
  const cleanup = await Promise.allSettled([current?.supervisor.stopSession(current.sessionId), revokeLocalHarnessGrants()]);
  const report = (line: string) => process.stderr.write(`[${HARNESS_ID}-lifecycle] ${line}\n`);
  report(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  report(`marks: ${JSON.stringify(marks)}`);
  for (const outcome of cleanup) if (outcome.status === "rejected") report(`cleanup failed: ${String(outcome.reason)}`);
  process.exit(1);
});
