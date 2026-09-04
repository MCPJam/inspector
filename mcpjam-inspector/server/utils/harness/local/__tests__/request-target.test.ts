import { describe, expect, it } from "vitest";
import { parseHarnessExecutionTarget } from "../request-target.js";

// Reading the local execution target off a chat request. Both chat routes call
// this, so a rule stated here is a rule both of them get — which is the point
// of having one parser rather than two.

const VALID = {
  kind: "local-native",
  workspaceGrantId: "ws_abc123",
  runtimeId: "rt_deadbeef",
  machineId: "mach_abcdef0123456789",
  permissionProfile: "workspace-edits",
  policyVersion: "local-policy-1",
};

const BASE = {
  grantTokenHeader: "grant-token-value",
  actingUserId: "user_1",
  serverEnabled: true,
  actorEligible: true,
};

describe("hosted is the answer to every ambiguity", () => {
  it.each([
    ["no body", null],
    ["no target field", {}],
    ["a null target", { harnessTarget: null }],
    ["an unknown kind", { harnessTarget: { kind: "local-isolated" } }],
  ])("answers hosted for %s", (_label, body) => {
    expect(
      parseHarnessExecutionTarget({ ...BASE, body: body as never }),
    ).toEqual({ kind: "hosted" });
  });
});

describe("an explicit ask that cannot be honoured is REFUSED, not degraded", () => {
  // Silently relocating a turn the user deliberately scoped to their machine is
  // the dishonesty this design exists to remove. Every case here is one where
  // the caller said "local" and gets told why not.
  it("refuses when the server kill switch is off", () => {
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: { harnessTarget: VALID },
      serverEnabled: false,
    });
    expect(result.kind).toBe("refused");
    expect((result as { reason: string }).reason).toMatch(
      /MCPJAM_LOCAL_HARNESS_ENABLED/,
    );
  });

  it("refuses an ineligible actor", () => {
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: { harnessTarget: VALID },
      actorEligible: false,
    });
    expect(result.kind).toBe("refused");
    expect((result as { reason: string }).reason).toMatch(/attended/);
  });

  it("refuses a request with no resolved user", () => {
    // Consent binds to a user, and the route resolves that from the verified
    // bearer. A request the route could not resolve one for has nothing for a
    // grant to verify against.
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: { harnessTarget: VALID },
      actingUserId: null,
    });
    expect(result.kind).toBe("refused");
  });

  it("refuses when no consent capability was presented", () => {
    // The ids alone are not consent. A client whose stored capability was
    // dropped learns that, instead of quietly getting a hosted turn.
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: { harnessTarget: VALID },
      grantTokenHeader: undefined,
    });
    expect(result.kind).toBe("refused");
    expect((result as { reason: string }).reason).toMatch(/authorization/);
  });

  it.each([
    ["a missing workspace grant", { workspaceGrantId: undefined }],
    ["a missing runtime id", { runtimeId: undefined }],
    ["a missing machine id", { machineId: undefined }],
    ["a missing policy version", { policyVersion: undefined }],
    ["an unknown permission profile", { permissionProfile: "root" }],
    ["a non-string id", { runtimeId: 42 }],
    ["an id with a path separator", { workspaceGrantId: "../../etc" }],
    ["an id with a space", { runtimeId: "rt one" }],
    ["an implausibly long id", { runtimeId: "r".repeat(300) }],
  ])("refuses %s", (_label, override) => {
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: { harnessTarget: { ...VALID, ...override } },
    });
    expect(result.kind).toBe("refused");
  });
});

describe("a complete, eligible ask", () => {
  it("carries the ids, the capability and the SERVER-resolved user", () => {
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: { harnessTarget: VALID },
    });
    expect(result).toEqual({
      kind: "local-native",
      target: {
        kind: "local-native",
        workspaceGrantId: "ws_abc123",
        runtimeId: "rt_deadbeef",
        machineId: "mach_abcdef0123456789",
        permissionProfile: "workspace-edits",
        policyVersion: "local-policy-1",
        grantToken: "grant-token-value",
        actingUserId: "user_1",
      },
    });
  });

  it("never takes the acting user from the body", () => {
    // A user the caller names is a user the caller chose, and the grant would
    // then verify against whatever identity the request asserted.
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: {
        harnessTarget: {
          ...VALID,
          actingUserId: "user_somebody_else",
        } as never,
      },
    });
    expect(result.kind).toBe("local-native");
    expect(
      (result as { target: { actingUserId: string } }).target.actingUserId,
    ).toBe("user_1");
  });

  it("trims the capability header", () => {
    const result = parseHarnessExecutionTarget({
      ...BASE,
      body: { harnessTarget: VALID },
      grantTokenHeader: "  token-with-space  ",
    });
    expect(
      (result as { target: { grantToken: string } }).target.grantToken,
    ).toBe("token-with-space");
  });
});
