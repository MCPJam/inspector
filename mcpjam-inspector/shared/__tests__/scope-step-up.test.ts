import { describe, expect, it } from "vitest";
import {
  canonicalizeStepUpResourceUrl,
  isScopeStepUpRequiredEvent,
  normalizeStepUpOperationKey,
  parseScopeStepUpCancelRequest,
  parseScopeStepUpResumeRequest,
  serializeStepUpOperationKey,
} from "../scope-step-up.js";

describe("SEP-2350 shared contract", () => {
  it("canonicalizes a resource and operation into a stable retry identity", () => {
    const key = normalizeStepUpOperationKey({
      resourceUrl: "https://bench.example/mcp",
      method: "tools/call",
      operation: " bench_write ",
    });
    expect(key).toEqual({
      resourceUrl: "https://bench.example/mcp",
      method: "tools/call",
      operation: "bench_write",
    });
    expect(serializeStepUpOperationKey(key)).toBe(
      '["https://bench.example/mcp","tools/call","bench_write"]'
    );
  });

  it("does not collapse different operations on the same protected resource", () => {
    const base = {
      resourceUrl: "https://bench.example/mcp",
      method: "tools/call" as const,
    };
    expect(
      serializeStepUpOperationKey({ ...base, operation: "bench_write" })
    ).not.toBe(
      serializeStepUpOperationKey({ ...base, operation: "bench_delete" })
    );
  });

  it("keeps opaque non-URL resource identities deterministic", () => {
    expect(canonicalizeStepUpResourceUrl(" local:bench ")).toBe("local:bench");
  });

  it("validates the versioned suspension event and opaque resume request", () => {
    const event = {
      version: 1,
      kind: "scope_step_up_required",
      continuationId: "opaque",
      serverId: "bench",
      toolCallId: "call-1",
      operation: { method: "tools/call", operation: "bench_write" },
      requiredScope: "bench:write",
      expiresAt: Date.now() + 60_000,
    };
    expect(isScopeStepUpRequiredEvent(event)).toBe(true);
    expect(
      parseScopeStepUpResumeRequest({
        continuationId: "opaque",
        toolCallId: "call-1",
      })
    ).toEqual({ continuationId: "opaque", toolCallId: "call-1" });
    expect(
      parseScopeStepUpResumeRequest({
        continuationId: "opaque",
        toolCallId: "",
      })
    ).toBeUndefined();
    expect(
      parseScopeStepUpCancelRequest({
        continuationId: "opaque",
        toolCallId: "call-1",
      })
    ).toEqual({ continuationId: "opaque", toolCallId: "call-1" });
  });
});
