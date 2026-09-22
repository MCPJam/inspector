import { describe, expect, it } from "vitest";
import {
  buildToolPolicySnapshot,
  decideToolPolicy,
  decideToolPolicyFromSnapshot,
  type EvalSuiteFileToolPolicy,
} from "../src/contract/index.js";

const policy = (overrides: Partial<EvalSuiteFileToolPolicy> = {}) => ({
  mode: "default" as const,
  ...overrides,
});

/**
 * The snapshot is the SAME decision `decideToolPolicy` makes, resolved once at
 * launch so the MCP proxy performs a lookup instead of a classification. These
 * tests pin that equivalence: a snapshot that forked the precedence would let a
 * harness run diverge from an emulated one under the identical policy.
 */
describe("buildToolPolicySnapshot", () => {
  const tools = [
    { name: "deny_and_allow" },
    { name: "allowed_destructive", annotations: { destructiveHint: true } },
    { name: "destructive", annotations: { destructiveHint: true } },
    { name: "reader", annotations: { readOnlyHint: true } },
    { name: "plain" },
    {
      name: "contradictory",
      annotations: { readOnlyHint: true, destructiveHint: true },
    },
  ];

  const snapshotFor = (p: EvalSuiteFileToolPolicy) =>
    buildToolPolicySnapshot({ policy: p, tools });

  it("agrees with decideToolPolicy on every precedence rung", () => {
    for (const mode of ["default", "readOnly"] as const) {
      const p = policy({
        mode,
        deny: ["deny_and_allow"],
        allow: ["deny_and_allow", "allowed_destructive"],
      });
      const snapshot = snapshotFor(p);
      for (const tool of tools) {
        const direct = decideToolPolicy({
          toolName: tool.name,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          policy: p,
        });
        const viaSnapshot = decideToolPolicyFromSnapshot({
          snapshot,
          toolName: tool.name,
        });
        expect(viaSnapshot.allowed).toBe(direct.allowed);
        if (!viaSnapshot.allowed) {
          expect(viaSnapshot.reason).toBe(direct.reason);
          expect(viaSnapshot.classification).toBe(direct.classification);
        }
      }
    }
  });

  it("deny beats allow; allow beats the destructive default", () => {
    const snapshot = snapshotFor(
      policy({
        deny: ["deny_and_allow"],
        allow: ["deny_and_allow", "allowed_destructive"],
      })
    );
    expect(snapshot.denied.deny_and_allow).toMatchObject({
      reason: "denyList",
    });
    expect(snapshot.denied.allowed_destructive).toBeUndefined();
  });

  it("denies a destructive tool by default, and an unclassified one under readOnly", () => {
    const defaults = snapshotFor(policy());
    expect(defaults.mode).toBe("default");
    expect(defaults.denied.destructive).toMatchObject({
      reason: "destructiveDefaultDeny",
    });
    expect(defaults.denied.plain).toBeUndefined();
    expect(defaults.denied.reader).toBeUndefined();

    const readOnly = snapshotFor(policy({ mode: "readOnly" }));
    expect(readOnly.mode).toBe("readOnly");
    expect(readOnly.denied.reader).toBeUndefined();
    expect(readOnly.denied.plain).toMatchObject({
      reason: "readOnlyModeUnclassified",
      classification: "unknown",
    });
  });

  it("classifies contradictory annotations as unknown and denies them under readOnly", () => {
    const readOnly = snapshotFor(policy({ mode: "readOnly" }));
    expect(readOnly.denied.contradictory).toMatchObject({
      classification: "unknown",
    });
    expect(readOnly.denied.contradictory?.reason).not.toBe(
      "readOnlyModeClassified"
    );
  });

  it("records the launch-known tools, so a tool that appears later is denied", () => {
    const snapshot = snapshotFor(policy());
    expect(snapshot.known).toEqual(tools.map((tool) => tool.name));
    expect(snapshot.unknownTool).toBe("deny");
    expect(
      decideToolPolicyFromSnapshot({ snapshot, toolName: "appeared_later" })
    ).toEqual({
      allowed: false,
      reason: "unknownAtLaunch",
      classification: "unknown",
    });
  });

  it("allows a known-and-permitted tool", () => {
    const snapshot = snapshotFor(policy());
    expect(
      decideToolPolicyFromSnapshot({ snapshot, toolName: "plain" })
    ).toEqual({ allowed: true });
  });
});
