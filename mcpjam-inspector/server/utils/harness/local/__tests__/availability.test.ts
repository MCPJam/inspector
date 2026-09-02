import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_HARNESS_MANIFEST,
  type LocalHarnessCompatibility,
} from "../compatibility.js";
import {
  grantLocalHarnessConsent,
  registerWorkspaceGrant,
  revokeLocalHarnessGrants,
  type HarnessGrantBinding,
} from "../grants.js";
import {
  clearRuntimeVerificationCache,
  computeTreeDigest,
} from "../runtime-identity.js";
import {
  isActorEligibleForLocalHarness,
  resolveLocalHarnessAvailability,
  type LocalHarnessActor,
} from "../availability.js";
import {
  LOCAL_HARNESS_POLICY_VERSION,
  type LocalHarnessExecutionTarget,
} from "../targets.js";

let base: string;
let workspace: string;
let runtimeRoot: string;
let workspaceGrantId: string;
let runtimeId: string;
let manifests: Record<string, LocalHarnessCompatibility>;
const realHome = process.env.HOME;

const USER = "user_1";
const PROJECT = "proj_1";
const MACHINE = "mach_1";

function target(
  overrides: Partial<
    Extract<LocalHarnessExecutionTarget, { kind: "local-native" }>
  > = {},
): LocalHarnessExecutionTarget {
  return {
    kind: "local-native",
    machineId: MACHINE,
    workspaceGrantId,
    harnessId: "claude-code",
    runtimeId,
    permissionProfile: "workspace-edits",
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
    ...overrides,
  };
}

function binding(t: LocalHarnessExecutionTarget): HarnessGrantBinding {
  return {
    userId: USER,
    machineId: t.machineId,
    projectId: PROJECT,
    workspaceGrantId: t.workspaceGrantId,
    harnessId: t.harnessId,
    targetKind: t.kind,
    runtimeId: t.runtimeId,
    permissionProfile: t.permissionProfile,
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  };
}

const ATTENDED: LocalHarnessActor = {
  isGuest: false,
  isScenarioSession: false,
  isJourneySession: false,
};

async function query(overrides: Record<string, unknown> = {}) {
  return resolveLocalHarnessAvailability({
    target: target(),
    actor: ATTENDED,
    userId: USER,
    projectId: PROJECT,
    grantToken: null,
    runtimeRoot,
    installedAdapterVersion:
      LOCAL_HARNESS_MANIFEST["claude-code"].adapterVersion,
    localMachineId: MACHINE,
    manifests,
    platform: "linux",
    killSwitchEnabled: true,
    hosted: false,
    ...overrides,
  } as Parameters<typeof resolveLocalHarnessAvailability>[0]);
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-avail-")));
  process.env.HOME = base;
  workspace = join(base, "project");
  runtimeRoot = join(base, "runtimes");
  await mkdir(workspace, { recursive: true });
  const bundleRoot = join(runtimeRoot, "claude-code");
  await mkdir(join(bundleRoot, "bin"), { recursive: true });
  await writeFile(join(bundleRoot, "bridge.mjs"), "console.log(1)");
  await writeFile(join(bundleRoot, "launcher.mjs"), 'await import("./bridge.mjs");');
  await writeFile(join(bundleRoot, "bin", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bundleRoot, "bin", "node"), 0o755);

  const grant = await registerWorkspaceGrant(workspace);
  if (!grant.ok) throw new Error(grant.message);
  workspaceGrantId = grant.grant.workspaceGrantId;

  const digest = await computeTreeDigest(bundleRoot);
  manifests = {
    "claude-code": {
      ...LOCAL_HARNESS_MANIFEST["claude-code"],
      lifecycleConformanceVersion: "conformance-test",
      runtime: {
        ...LOCAL_HARNESS_MANIFEST["claude-code"].runtime,
        bundleDigest: { linux: digest, darwin: digest },
      },
    } as LocalHarnessCompatibility,
  };

  // Resolve once to learn the runtime id consent must bind to.
  const probe = await resolveLocalHarnessAvailability({
    target: target({ runtimeId: "rt_placeholder" }),
    actor: ATTENDED,
    userId: USER,
    projectId: PROJECT,
    grantToken: null,
    runtimeRoot,
    installedAdapterVersion:
      LOCAL_HARNESS_MANIFEST["claude-code"].adapterVersion,
    localMachineId: MACHINE,
    manifests,
    platform: "linux",
    killSwitchEnabled: true,
    hosted: false,
  });
  expect(probe.available).toBe(false);
  const { resolveManagedBundle } = await import("../runtime-identity.js");
  const resolved = await resolveManagedBundle({
    manifest: manifests["claude-code"]!,
    runtimeRoot,
    platform: "linux",
  });
  if (!resolved.ok) throw new Error(resolved.message);
  runtimeId = resolved.runtime.runtimeId;
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

beforeEach(async () => {
  await revokeLocalHarnessGrants();
});

describe("the machine gate", () => {
  it("refuses a target granted on a different installation", async () => {
    await expect(
      query({ target: target({ machineId: "mach_elsewhere" }) }),
    ).resolves.toMatchObject({ status: "machine-mismatch" });
  });
});

describe("the gates, in order", () => {
  it("refuses in hosted mode before anything else is considered", async () => {
    await expect(query({ hosted: true })).resolves.toMatchObject({
      status: "hosted",
    });
  });

  it("refuses when the server kill switch is off", async () => {
    await expect(query({ killSwitchEnabled: false })).resolves.toMatchObject({
      status: "server-disabled",
    });
  });

  it.each([
    ["a guest", { isGuest: true }],
    ["a shared scenario session", { isScenarioSession: true }],
    ["a journey session", { isJourneySession: true }],
    ["a swarm-scoped run", { executionScopeKind: "swarm" as const }],
  ])("refuses %s", async (_label, actorOverrides) => {
    await expect(
      query({ actor: { ...ATTENDED, ...actorOverrides } }),
    ).resolves.toMatchObject({ status: "actor-not-eligible" });
  });

  it("refuses a platform whose process trees it cannot own", async () => {
    await expect(query({ platform: "win32" })).resolves.toMatchObject({
      status: "ownership-unprovable",
    });
  });

  it("refuses an unknown workspace grant", async () => {
    await expect(
      query({ target: target({ workspaceGrantId: "ws_unknown" }) }),
    ).resolves.toMatchObject({ status: "workspace-grant-invalid" });
  });

  it("refuses when the runtime is not the one the target names", async () => {
    await expect(
      query({ target: target({ runtimeId: "rt_someone_elses" }) }),
    ).resolves.toMatchObject({ status: "runtime-changed" });
  });

  it("refuses without consent, even when everything else resolves", async () => {
    await expect(query()).resolves.toMatchObject({
      status: "consent-required",
    });
  });
});

describe("a fully authorized turn", () => {
  it("returns an explicit permission mode and the resolved identities", async () => {
    const t = target();
    const { token } = await grantLocalHarnessConsent(binding(t));
    const result = await query({ grantToken: token });
    expect(result.available).toBe(true);
    if (!result.available) return;
    // The SDK's `allow-all` default is never what a local turn inherits.
    expect(result.plan.permissionMode).toBe("allow-edits");
    expect(result.plan.workspacePath).toBe(workspace);
    expect(result.plan.runtime.runtimeId).toBe(runtimeId);
    expect(result.plan.grantId).toMatch(/^grant_/);
  });

  it("read-only maps to allow-reads", async () => {
    const t = target({ permissionProfile: "read-only" });
    const { token } = await grantLocalHarnessConsent(binding(t));
    const result = await query({ target: t, grantToken: token });
    expect(result).toMatchObject({ available: true });
    if (!result.available) return;
    expect(result.plan.permissionMode).toBe("allow-reads");
  });

  it("stops honoring a capability once it is revoked", async () => {
    const t = target();
    const { token } = await grantLocalHarnessConsent(binding(t));
    await expect(query({ grantToken: token })).resolves.toMatchObject({
      available: true,
    });
    await revokeLocalHarnessGrants();
    await expect(query({ grantToken: token })).resolves.toMatchObject({
      status: "consent-required",
    });
  });

  it("stops honoring a capability once the bundle changes underneath it", async () => {
    // A cold process: nothing has been verified yet, so the full digest runs
    // and reports the bundle failing verification. The digest check fires
    // before the identity comparison, which is why this is not a runtime-id
    // mismatch.
    clearRuntimeVerificationCache();
    const t = target();
    const { token } = await grantLocalHarnessConsent(binding(t));
    await writeFile(
      join(runtimeRoot, "claude-code", "bridge.mjs"),
      "console.log(2)",
    );
    const result = await query({ grantToken: token });
    expect(result.available).toBe(false);
    expect(result).toMatchObject({ status: "runtime-unavailable" });
    await writeFile(
      join(runtimeRoot, "claude-code", "bridge.mjs"),
      "console.log(1)",
    );
    clearRuntimeVerificationCache();
  });

  it("catches a bundle that changes AFTER this process verified it", async () => {
    // The other half of the same guarantee, and the one the digest cache has
    // to keep honest: once a pack has been verified in this process, resolving
    // it again is answered from cache — so the pre-spawn re-verify is what
    // notices a tree that changed since. It refuses by a different name
    // (`runtime-changed`, not `runtime-unavailable`) because that is exactly
    // what happened: the runtime consent named is no longer what is on disk.
    clearRuntimeVerificationCache();
    const t = target();
    const { token } = await grantLocalHarnessConsent(binding(t));
    await expect(query({ grantToken: token })).resolves.toMatchObject({
      available: true,
    });

    await writeFile(
      join(runtimeRoot, "claude-code", "bridge.mjs"),
      "console.log(3)",
    );
    const result = await query({ grantToken: token });
    expect(result.available).toBe(false);
    expect(result).toMatchObject({ status: "runtime-changed" });

    await writeFile(
      join(runtimeRoot, "claude-code", "bridge.mjs"),
      "console.log(1)",
    );
    clearRuntimeVerificationCache();
  });
});

describe("codex", () => {
  it("cannot reach a native launch plan, consent or not", async () => {
    const codexManifests = {
      ...manifests,
      codex: {
        ...LOCAL_HARNESS_MANIFEST.codex,
        lifecycleConformanceVersion: "conformance-test",
      } as LocalHarnessCompatibility,
    };
    const t = target({ harnessId: "codex", permissionProfile: "unrestricted" });
    const { token } = await grantLocalHarnessConsent(binding(t));
    await expect(
      query({
        target: t,
        grantToken: token,
        manifests: codexManifests,
        installedAdapterVersion: LOCAL_HARNESS_MANIFEST.codex.adapterVersion,
      }),
    ).resolves.toMatchObject({ status: "native-not-eligible" });
  });
});

describe("actor eligibility", () => {
  it("mirrors the personal-computer engine's rule", () => {
    expect(isActorEligibleForLocalHarness(ATTENDED)).toBe(true);
    expect(
      isActorEligibleForLocalHarness({
        ...ATTENDED,
        executionScopeKind: "project",
      }),
    ).toBe(true);
    expect(
      isActorEligibleForLocalHarness({
        ...ATTENDED,
        executionScopeKind: "swarm",
      }),
    ).toBe(false);
  });
});
