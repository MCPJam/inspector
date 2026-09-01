import { describe, expect, it } from "vitest";
import {
  LOCAL_HARNESS_POLICY_VERSION,
  LOCAL_ISOLATION_POLICY_VERSION,
  currentLocalPlatform,
  executionTargetLabel,
  isLocalTarget,
  targetHasHostContainment,
  type HarnessExecutionTarget,
} from "../targets.js";

const hosted: HarnessExecutionTarget = { kind: "cloud", provider: "e2b" };
const native: HarnessExecutionTarget = {
  kind: "local-native",
  machineId: "mach_1",
  workspaceGrantId: "ws_1",
  harnessId: "claude-code",
  runtimeId: "rt_1",
  permissionProfile: "workspace-edits",
  policyVersion: LOCAL_HARNESS_POLICY_VERSION,
};
const isolated: HarnessExecutionTarget = {
  kind: "local-isolated",
  machineId: "mach_1",
  workspaceGrantId: "ws_1",
  harnessId: "claude-code",
  runtimeId: "rt_1",
  backend: "linux-bwrap",
  permissionProfile: "unrestricted",
  isolationPolicyVersion: LOCAL_ISOLATION_POLICY_VERSION,
};

describe("labels say what a mode actually is", () => {
  it("never calls native execution sandboxed or isolated", () => {
    const label = executionTargetLabel(native);
    expect(label).toBe("Native on this machine");
    expect(label.toLowerCase()).not.toContain("sandbox");
    expect(label.toLowerCase()).not.toContain("isolat");
  });

  it("names the backend an isolated mode depends on", () => {
    expect(executionTargetLabel(isolated)).toBe(
      "Isolated on this machine (linux-bwrap)",
    );
  });

  it("labels the cloud path as hosted", () => {
    expect(executionTargetLabel(hosted)).toBe("Hosted");
  });
});

describe("host containment", () => {
  it("is false for native, whatever else the target says", () => {
    expect(targetHasHostContainment(native)).toBe(false);
    expect(
      targetHasHostContainment({ ...native, permissionProfile: "read-only" }),
    ).toBe(false);
  });

  it("is true for hosted and for a verified isolated backend", () => {
    expect(targetHasHostContainment(hosted)).toBe(true);
    expect(targetHasHostContainment(isolated)).toBe(true);
  });
});

describe("target discrimination", () => {
  it("separates local from cloud", () => {
    expect(isLocalTarget(hosted)).toBe(false);
    expect(isLocalTarget(native)).toBe(true);
    expect(isLocalTarget(isolated)).toBe(true);
  });

  it("carries no raw host path as an authorization primitive", () => {
    // A path here would be a capability anyone who can send a target could
    // forge; the opaque ids resolve to paths only in the trusted process.
    expect(JSON.stringify(native)).not.toMatch(/\//);
  });
});

describe("platform mapping", () => {
  it("maps the three supported platforms and nothing else", () => {
    expect(currentLocalPlatform("darwin")).toBe("darwin");
    expect(currentLocalPlatform("linux")).toBe("linux");
    expect(currentLocalPlatform("win32")).toBe("win32");
    expect(currentLocalPlatform("aix")).toBeNull();
    expect(currentLocalPlatform("freebsd")).toBeNull();
  });
});

describe("policy versions", () => {
  it("keeps the native and isolation policies separate", () => {
    // An isolation rule change must not re-ask for native consent, and vice
    // versa; one shared constant would couple them.
    expect(LOCAL_HARNESS_POLICY_VERSION).not.toBe(
      LOCAL_ISOLATION_POLICY_VERSION,
    );
  });
});
