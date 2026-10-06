/**
 * The pure rules behind dependable updates: which installed pack a build
 * selects, when repeated launch failures roll an update back, and what the
 * administrator's update policy admits.
 */
import { describe, expect, it } from "vitest";
import { chooseRuntime, type CandidateFacts } from "../runtime-selection.js";
import { foldLaunch, LAUNCH_FAILURE_THRESHOLD, LAUNCH_FAILURE_WINDOW_MS, newHealthRecord } from "../runtime-health.js";
import { managedConfigPath, parseUpdatePolicy, triggerAllowed } from "../runtime-update-policy.js";

const pack = (version: string, facts: Partial<CandidateFacts> = {}): CandidateFacts => ({
  packVersion: version,
  treeDigest: `sha256:${version.replace(/\D/g, "").padStart(64, "0")}`,
  installed: true,
  revoked: false,
  unhealthy: false,
  ...facts,
});

describe("chooseRuntime (invariant 4)", () => {
  it("runs the desired pack when it is installed and healthy", () => {
    expect(chooseRuntime({ desired: pack("1.0.1"), permitted: pack("1.0.0") })).toMatchObject({
      kind: "selected",
      role: "desired",
      packVersion: "1.0.1",
      degraded: false,
    });
  });

  it("falls back to the permitted previous pack while the desired one is not installed", () => {
    expect(chooseRuntime({ desired: pack("1.0.1", { installed: false }), permitted: pack("1.0.0") })).toMatchObject({
      role: "permitted",
      packVersion: "1.0.0",
    });
  });

  it("rolls back from an unhealthy desired pack to a healthy permitted one", () => {
    expect(chooseRuntime({ desired: pack("1.0.1", { unhealthy: true }), permitted: pack("1.0.0") })).toMatchObject({
      role: "permitted",
    });
  });

  it("never selects a revoked pack — not as desired, not as a fallback", () => {
    expect(chooseRuntime({ desired: pack("1.0.1", { revoked: true }), permitted: pack("1.0.0") })).toMatchObject({
      role: "permitted",
    });
    expect(chooseRuntime({ desired: pack("1.0.1", { revoked: true }), permitted: pack("1.0.0", { revoked: true }) })).toEqual({
      kind: "none",
      why: "revoked",
    });
    expect(chooseRuntime({ desired: pack("1.0.1"), permitted: pack("1.0.0", { revoked: true }), preferTreeDigest: pack("1.0.0").treeDigest })).toMatchObject({
      role: "desired",
    });
  });

  it("keeps the pack a live grant names while it is selectable and healthy", () => {
    const permitted = pack("1.0.0");
    expect(chooseRuntime({ desired: pack("1.0.1"), permitted, preferTreeDigest: permitted.treeDigest })).toMatchObject({
      role: "permitted",
    });
    // …but never an unhealthy one: the grant follows the rollback.
    expect(
      chooseRuntime({ desired: pack("1.0.1"), permitted: pack("1.0.0", { unhealthy: true }), preferTreeDigest: permitted.treeDigest }),
    ).toMatchObject({ role: "desired" });
  });

  it("selects an unhealthy pack, degraded, only when nothing healthier is installed", () => {
    expect(chooseRuntime({ desired: pack("1.0.1", { unhealthy: true }), permitted: null })).toMatchObject({
      role: "desired",
      degraded: true,
    });
    expect(chooseRuntime({ desired: pack("1.0.1", { installed: false }), permitted: pack("1.0.0", { unhealthy: true }) })).toMatchObject({
      role: "permitted",
      degraded: true,
    });
  });

  it("is a first-time install (absent) when nothing is installed", () => {
    expect(chooseRuntime({ desired: pack("1.0.1", { installed: false }), permitted: pack("1.0.0", { installed: false }) })).toEqual({
      kind: "none",
      why: "absent",
    });
    expect(chooseRuntime({ desired: null, permitted: null })).toEqual({ kind: "none", why: "absent" });
  });

  it("treats a permitted pack identical to the desired one as the same pack", () => {
    const same = pack("1.0.1");
    expect(chooseRuntime({ desired: same, permitted: { ...same, packVersion: "1.0.0" } })).toMatchObject({ role: "desired" });
  });
});

describe("foldLaunch: when an update is rolled back", () => {
  const fresh = newHealthRecord({ packVersion: "1.0.1", treeDigest: "sha256:x", installStartedAt: 1 });

  it(`marks a pack unhealthy on the ${LAUNCH_FAILURE_THRESHOLD}th failure inside the window, once`, () => {
    let record = fresh;
    const unhealthyAt: number[] = [];
    for (let i = 1; i <= LAUNCH_FAILURE_THRESHOLD + 1; i += 1) {
      const folded = foldLaunch(record, { ok: false, reason: `failure ${i}` }, 1_000 * i);
      if (folded.becameUnhealthy) unhealthyAt.push(i);
      record = folded.record;
    }
    expect(unhealthyAt).toEqual([LAUNCH_FAILURE_THRESHOLD]);
    expect(record.unhealthy).toMatchObject({ reason: `failure ${LAUNCH_FAILURE_THRESHOLD}` });
  });

  it("forgets failures older than the window, and a success clears them", () => {
    let record = foldLaunch(fresh, { ok: false, reason: "a" }, 0).record;
    record = foldLaunch(record, { ok: false, reason: "b" }, 1).record;
    const late = foldLaunch(record, { ok: false, reason: "c" }, LAUNCH_FAILURE_WINDOW_MS + 10);
    expect(late.becameUnhealthy).toBe(false);
    expect(late.record.launchFailures).toEqual([LAUNCH_FAILURE_WINDOW_MS + 10]);
    const cleared = foldLaunch(record, { ok: true }, 5);
    expect(cleared.record.launchFailures).toEqual([]);
  });

  it("reports the first usable launch exactly once", () => {
    const first = foldLaunch(fresh, { ok: true }, 10);
    expect(first.firstUsable).toBe(true);
    expect(first.record.firstUsableAt).toBe(10);
    expect(foldLaunch(first.record, { ok: true }, 20).firstUsable).toBe(false);
  });
});

describe("the update policy", () => {
  it("defaults to auto, and reads an administrator's choice", () => {
    expect(parseUpdatePolicy("{}")).toBe("auto");
    expect(parseUpdatePolicy('{"localHarness":{"updates":"manual"}}')).toBe("manual");
    expect(() => parseUpdatePolicy('{"localHarness":{"updates":"sometimes"}}')).toThrow(/auto.*manual/);
  });

  it("admits only harness install and pre-provisioning under manual", () => {
    for (const trigger of ["cli", "provision"] as const) expect(triggerAllowed(trigger, "manual")).toBe(true);
    for (const trigger of ["gesture", "readiness", "boot"] as const) expect(triggerAllowed(trigger, "manual")).toBe(false);
    for (const trigger of ["cli", "provision", "gesture", "readiness", "boot"] as const) expect(triggerAllowed(trigger, "auto")).toBe(true);
  });

  it("lives where an administrator, not the user's session, writes it", () => {
    expect(managedConfigPath("darwin", {})).toBe("/Library/Application Support/MCPJam/managed.json");
    expect(managedConfigPath("linux", {})).toBe("/etc/mcpjam/managed.json");
    expect(managedConfigPath("win32", { ProgramData: "C:\\ProgramData" })).toMatch(/ProgramData[\\/]MCPJam[\\/]managed\.json$/);
    expect(managedConfigPath("linux", { MCPJAM_MANAGED_CONFIG: "/opt/mdm/mcpjam.json" })).toBe("/opt/mdm/mcpjam.json");
  });
});
