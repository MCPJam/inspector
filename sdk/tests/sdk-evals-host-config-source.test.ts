/**
 * Tests for `resolveRunLevelHostSnapshot` (Stage 5, Step 3).
 *
 * Source priority:
 *   1. PRIMARY  — per-iteration `iteration.hostSnapshot`.
 *   2. FALLBACK — `executor.getHostSnapshot?.()`.
 *   3. LAST     — `explicitHost.toJSON()`.
 *
 * Homogeneity gate (pass 1): heterogeneous per-iteration snapshots return
 * `null` (omit). Homogeneous returns the shared snapshot.
 */

import { resolveRunLevelHostSnapshot } from "../src/sdk-evals-host-config-source";
import { Host } from "../src/host-config/index";
import type { HostJson } from "../src/host-config/index";

function snapshotA(): HostJson {
  return new Host({
    style: "claude",
    model: "anthropic/claude-sonnet-4-6",
    systemPrompt: "alpha",
    temperature: 0.7,
    requireToolApproval: false,
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
  }).toJSON();
}

function snapshotB(): HostJson {
  return new Host({
    style: "claude",
    model: "anthropic/claude-sonnet-4-6",
    systemPrompt: "beta — different",
    temperature: 0.7,
    requireToolApproval: false,
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
  }).toJSON();
}

describe("resolveRunLevelHostSnapshot", () => {
  it("returns the shared snapshot when all iterations agree (homogeneous)", async () => {
    const snap = snapshotA();
    const result = await resolveRunLevelHostSnapshot({
      iterations: [
        { hostSnapshot: snap },
        { hostSnapshot: { ...snap } },
        { hostSnapshot: { ...snap } },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.systemPrompt).toBe("alpha");
  });

  it("returns null when iterations are heterogeneous (homogeneity gate)", async () => {
    const result = await resolveRunLevelHostSnapshot({
      iterations: [
        { hostSnapshot: snapshotA() },
        { hostSnapshot: snapshotB() },
      ],
    });
    expect(result).toBeNull();
  });

  it("returns the single snapshot when only one iteration carries one", async () => {
    const snap = snapshotA();
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{ hostSnapshot: snap }],
    });
    expect(result).toBe(snap);
  });

  it("falls back to executor.getHostSnapshot when no iteration carries one", async () => {
    const snap = snapshotA();
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{}, {}],
      executor: { getHostSnapshot: () => snap },
    });
    expect(result).toBe(snap);
  });

  it("falls back to explicitHost.toJSON() when no iteration or executor snapshot", async () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "explicit-host",
      temperature: 0.7,
      requireToolApproval: false,
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
    });
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{}],
      explicitHost: host,
    });
    expect(result).not.toBeNull();
    expect(result!.systemPrompt).toBe("explicit-host");
  });

  it("prefers iteration snapshot over executor.getHostSnapshot", async () => {
    const iterSnap = snapshotA();
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{ hostSnapshot: iterSnap }],
      executor: { getHostSnapshot: () => snapshotB() },
    });
    expect(result).toBe(iterSnap);
  });

  it("prefers executor over explicitHost", async () => {
    const execSnap = snapshotA();
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "explicit",
      temperature: 0.7,
      requireToolApproval: false,
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
    });
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{}],
      executor: { getHostSnapshot: () => execSnap },
      explicitHost: host,
    });
    expect(result).toBe(execSnap);
  });

  it("returns null when nothing is available", async () => {
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{}, {}, {}],
    });
    expect(result).toBeNull();
  });

  it("empty iterations array falls through to executor/explicitHost", async () => {
    const snap = snapshotA();
    const result = await resolveRunLevelHostSnapshot({
      iterations: [],
      executor: { getHostSnapshot: () => snap },
    });
    expect(result).toBe(snap);
  });

  it("treats an ill-configured explicitHost as no-snapshot", async () => {
    // `Host` without `model` will throw at `toJSON()` — the resolver must
    // swallow and return null rather than crash the reporter.
    const host = new Host({ style: "claude" } as any);
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{}],
      explicitHost: host,
    });
    expect(result).toBeNull();
  });

  it("treats executor.getHostSnapshot returning undefined as no-snapshot", async () => {
    const result = await resolveRunLevelHostSnapshot({
      iterations: [{}],
      executor: { getHostSnapshot: () => undefined },
    });
    expect(result).toBeNull();
  });
});
