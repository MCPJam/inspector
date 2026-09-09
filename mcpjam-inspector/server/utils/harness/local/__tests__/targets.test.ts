import { describe, expect, it } from "vitest";
import {
  LOCAL_HARNESS_POLICY_VERSION,
  LOCAL_ISOLATION_POLICY_VERSION,
  currentLocalPlatform,
  executionTargetLabel,
  isLocalTarget,
  localPackTarget,
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

describe("pack targets", () => {
  it("names the five targets the pack build produces", () => {
    // These strings are one identifier shared by four places: this union, the
    // build script's PLATFORMS, the release asset name, and the generated
    // digest table's keys. A rename in one of them and not the rest is a
    // download that resolves and a digest that never matches.
    expect(localPackTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(localPackTarget("darwin", "x64")).toBe("darwin-x64");
    expect(localPackTarget("linux", "x64")).toBe("linux-x64");
    expect(localPackTarget("linux", "arm64")).toBe("linux-arm64");
    expect(localPackTarget("win32", "x64")).toBe("win32-x64");
  });

  it("distinguishes the two architectures of one OS", () => {
    // The reason this type exists. A pack carries `bin/node` and the vendor's
    // native CLI, so an arm64 Mac and an x64 Mac need different artifacts with
    // different digests — and a table keyed on `darwin` alone could hold only
    // one of them, then refuse every install on the other.
    expect(localPackTarget("darwin", "arm64")).not.toBe(
      localPackTarget("darwin", "x64"),
    );
    expect(localPackTarget("linux", "x64")).not.toBe(
      localPackTarget("linux", "arm64"),
    );
  });

  it("answers null for a machine no pack is built for", () => {
    // Fail closed: no pack target means `bundle-absent`, the same answer a
    // missing directory gets, rather than a download that could never verify.
    expect(localPackTarget("linux", "riscv64")).toBeNull();
    expect(localPackTarget("win32", "arm64")).toBeNull();
    expect(localPackTarget("darwin", "ia32")).toBeNull();
    expect(localPackTarget("freebsd", "x64")).toBeNull();
  });
});
