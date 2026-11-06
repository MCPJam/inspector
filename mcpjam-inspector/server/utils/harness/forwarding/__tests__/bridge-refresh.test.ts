import { safeValidateTypes } from "@ai-sdk/provider-utils";
import type { HarnessV1 } from "@ai-sdk/harness";
import { describe, expect, it, vi } from "vitest";
import { codexAppServerResumeStateSchema } from "../../codex-appserver/codex-appserver-lifecycle-state";
import { withForwardingResume } from "../bridge-refresh";

const runtime: HarnessV1 = {
  specificationVersion: "harness-v1",
  harnessId: "codex",
  lifecycleStateSchema: codexAppServerResumeStateSchema,
  doStart: vi.fn<HarnessV1["doStart"]>(),
};

describe("forwarding lifecycle validation", () => {
  const wrapped = withForwardingResume(runtime, {}, "policy");
  const schema = wrapped.lifecycleStateSchema;
  if (!schema) throw new Error("Missing lifecycle validator");

  it("keeps the host policy through the framework's runtime validation", async () => {
    const result = await safeValidateTypes({
      schema,
      value: {
        threadId: "thread",
        mcpjamForwardingPolicy: "policy",
        unrelated: "discard",
      },
    });
    expect(result).toMatchObject({
      success: true,
      value: { threadId: "thread", mcpjamForwardingPolicy: "policy" },
    });
    if (result.success) expect(result.value).not.toHaveProperty("unrelated");
  });

  it.each([
    { threadId: 7, mcpjamForwardingPolicy: "policy" },
    { threadId: "thread", mcpjamForwardingPolicy: 7 },
  ])("still refuses invalid runtime or policy fields", async (value) => {
    expect(await safeValidateTypes({ schema, value })).toMatchObject({
      success: false,
    });
  });
});
