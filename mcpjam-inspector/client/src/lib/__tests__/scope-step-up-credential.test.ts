/**
 * Hosted step-up end to end, on the client: the redirect writes the hosted
 * pending marker, and a sign-in replays a saved call only onto the very
 * credential the call used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetScopeStepUpInFlightForTests,
  driveScopeStepUp,
  registerScopeStepUpHostBridge,
} from "../scope-step-up";
import {
  SIGNED_IN_WITH_DIFFERENT_ACCOUNT_MESSAGE,
  SIGNED_IN_WITH_OWN_ACCOUNT_MESSAGE,
  connectionIntentForBinding,
  settleStepUpCredential,
} from "../scope-step-up-credential";
import {
  readPendingChatScopeStepUp,
  savePendingChatScopeStepUp,
  setPendingChatScopeStepUpCredentialBinding,
  setPendingChatScopeStepUpFlowDigest,
  settlePendingChatScopeStepUpAfterCallback,
} from "../scope-step-up-pending";
import {
  claimPendingDirectScopeStepUpReplay,
  clearPendingDirectScopeStepUpReplay,
  savePendingDirectScopeStepUpReplay,
  setPendingDirectScopeStepUpReplayCredentialBinding,
  setPendingDirectScopeStepUpReplayFlowDigest,
  settlePendingDirectScopeStepUpReplayAfterCallback,
} from "../scope-step-up-replay";
import type { ServerWithName } from "@/state/app-types";

const applyToolCallStepUp = vi.fn();
vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: (...args: unknown[]) => applyToolCallStepUp(...args),
  resetToolCallStepUp: vi.fn(),
}));

const server = {
  name: "orders",
  config: { url: "https://orders.example.com/mcp" },
} as unknown as ServerWithName;

function saveChatStepUp(connectionId?: string) {
  savePendingChatScopeStepUp({
    serverName: "orders",
    chatSessionId: "chat-1",
    event: {
      version: 1,
      kind: "scope_step_up_required",
      continuationId: "cont-1",
      serverId: "srv-1",
      serverName: "orders",
      ...(connectionId ? { connectionId } : {}),
      toolCallId: "call-1",
      operation: { method: "tools/call", operation: "get_my_orders" },
      requiredScope: "orders:read",
      expiresAt: Date.now() + 60_000,
    },
  });
}

describe("credential binding", () => {
  it.each([
    [{ kind: "none" } as const, undefined],
    [
      { kind: "owned", credentialId: "c1" } as const,
      { kind: "replace", credentialId: "c1" },
    ],
    [{ kind: "shared", credentialId: "c1" } as const, { kind: "add" }],
  ])("signs %j in with intent %j", (binding, intent) => {
    expect(connectionIntentForBinding(binding)).toEqual(intent);
  });

  it("replays after a first sign-in, or onto the same owned credential", () => {
    expect(settleStepUpCredential({ kind: "none" }, "new")).toEqual({
      outcome: "replay",
    });
    expect(
      settleStepUpCredential({ kind: "owned", credentialId: "c1" }, "c1"),
    ).toEqual({ outcome: "replay" });
    expect(
      settleStepUpCredential({ kind: "owned", credentialId: "c1" }, undefined),
    ).toEqual({ outcome: "replay" });
  });

  it("never replays across credentials or accounts", () => {
    expect(
      settleStepUpCredential({ kind: "shared", credentialId: "c1" }, "mine"),
    ).toEqual({ outcome: "cancel", message: SIGNED_IN_WITH_OWN_ACCOUNT_MESSAGE });
    expect(
      settleStepUpCredential({ kind: "owned", credentialId: "c1" }, "c2"),
    ).toEqual({
      outcome: "cancel",
      message: SIGNED_IN_WITH_DIFFERENT_ACCOUNT_MESSAGE,
    });
  });
});

describe("settling the pending stores on the callback", () => {
  beforeEach(() => sessionStorage.clear());

  it("marks a chat step-up ready, or cancels it with the reason", () => {
    saveChatStepUp("c1");
    setPendingChatScopeStepUpFlowDigest("orders", "flow");
    settlePendingChatScopeStepUpAfterCallback("orders", "c1", "flow");
    expect(readPendingChatScopeStepUp()?.phase).toBe("ready");

    saveChatStepUp("c1");
    setPendingChatScopeStepUpFlowDigest("orders", "flow");
    setPendingChatScopeStepUpCredentialBinding("orders", {
      kind: "owned",
      credentialId: "c1",
    });
    settlePendingChatScopeStepUpAfterCallback("orders", "c2", "flow");
    expect(readPendingChatScopeStepUp()).toMatchObject({
      phase: "cancelled",
      cancellationMessage: SIGNED_IN_WITH_DIFFERENT_ACCOUNT_MESSAGE,
    });
  });

  it("marks a direct replay ready, or drops it and says why", () => {
    const save = () =>
      savePendingDirectScopeStepUpReplay({
        operation: {
          resourceUrl: "https://orders.example.com/mcp",
          method: "tools/call",
          operation: "get_my_orders",
        },
        descriptor: {
          kind: "tool",
          surface: "tools",
          serverName: "orders",
          toolName: "get_my_orders",
          parameters: {},
        },
      });
    save();
    setPendingDirectScopeStepUpReplayFlowDigest("orders", "flow");
    expect(
      settlePendingDirectScopeStepUpReplayAfterCallback("orders", "c9", "flow"),
    ).toBeUndefined();
    const claimed = claimPendingDirectScopeStepUpReplay({
      serverName: "orders",
      surface: "tools",
    });
    expect(claimed).toBeDefined();
    if (claimed) clearPendingDirectScopeStepUpReplay(claimed);

    save();
    setPendingDirectScopeStepUpReplayFlowDigest("orders", "flow");
    setPendingDirectScopeStepUpReplayCredentialBinding("orders", {
      kind: "shared",
      credentialId: "c1",
    });
    expect(
      settlePendingDirectScopeStepUpReplayAfterCallback("orders", "mine", "flow"),
    ).toBe(SIGNED_IN_WITH_OWN_ACCOUNT_MESSAGE);
    expect(sessionStorage.getItem("mcp-scope-step-up-replay-v1")).toBeNull();
  });
});
