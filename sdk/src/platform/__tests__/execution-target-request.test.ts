import { describe, expect, it } from "vitest";
import {
  executionTargetRequest,
  platformExecutionTargetBodySchema,
} from "../local-execution.js";
const target = {
  kind: "local-native",
  scope: "unattended",
  harnessId: "codex",
  machineId: "machine",
  workspaceGrantId: "workspace",
  runtimeId: "runtime",
  permissionProfile: "unrestricted",
  policyVersion: "policy",
  grantToken: "a-valid-capability-token",
} as const;
describe("execution target wire contract", () => {
  it("keeps the grant capability out of the request body", () => {
    const { grantToken, ...body } = target;
    expect(executionTargetRequest(target)).toEqual({ body, grantToken });
    expect(platformExecutionTargetBodySchema.safeParse(target).success).toBe(
      false
    );
    expect(platformExecutionTargetBodySchema.parse(body)).toEqual(body);
  });
  it("preserves explicit hosted and absent legacy requests", () => {
    expect(executionTargetRequest({ kind: "hosted" })).toEqual({
      body: { kind: "hosted" },
    });
    expect(executionTargetRequest(undefined)).toEqual({});
  });
});
