import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authorizeLocalExecutionOperation } from "@mcpjam/sdk/platform";
import {
  EXCLUDED_FROM_CATALOG,
  PLATFORM_CATALOG_OPERATIONS,
} from "../src/tools/platformTools.js";

afterEach(() => vi.unstubAllGlobals());
const localTarget = (harnessId: "claude-code" | "codex") => ({
  kind: "local-native",
  scope: "unattended",
  harnessId,
  machineId: "machine",
  workspaceGrantId: "workspace",
  runtimeId: "runtime",
  permissionProfile: "unrestricted",
  policyVersion: "policy",
  grantToken: "test-local-capability",
});
const sendChatMessage = () => {
  const operation = PLATFORM_CATALOG_OPERATIONS.find(
    (candidate) => candidate.name === "send_chat_message",
  );
  if (!operation) throw new Error("send_chat_message is not in the catalog");
  return operation;
};

describe("platform MCP local execution", () => {
  it("does not offer local capability renewal", () => {
    expect(PLATFORM_CATALOG_OPERATIONS).not.toContain(
      authorizeLocalExecutionOperation,
    );
    expect(EXCLUDED_FROM_CATALOG).toHaveProperty("authorize_local_execution");
  });
  it.each(["claude-code", "codex"] as const)(
    "refuses a %s local target in model-visible tool arguments",
    (harnessId) => {
      const { inputSchema } = sendChatMessage();
      const turn = { message: "first", idempotencyKey: "first" };
      expect(
        inputSchema.safeParse({
          ...turn,
          executionTarget: localTarget(harnessId),
        }).success,
      ).toBe(false);
      expect(
        inputSchema.safeParse({ ...turn, executionTarget: { kind: "hosted" } })
          .success,
      ).toBe(true);
      expect(JSON.stringify(z.toJSONSchema(inputSchema))).not.toContain(
        "grantToken",
      );
    },
  );
});
