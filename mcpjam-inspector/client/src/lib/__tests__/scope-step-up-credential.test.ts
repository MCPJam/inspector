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
  settlePendingChatScopeStepUpAfterCallback,
} from "../scope-step-up-pending";
import {
  claimPendingDirectScopeStepUpReplay,
  savePendingDirectScopeStepUpReplay,
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

describe("hosted step-up redirect", () => {
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    sessionStorage.clear();
    __resetScopeStepUpInFlightForTests();
    applyToolCallStepUp.mockReset().mockImplementation(
      async (_server: unknown, _challenge: unknown, options: any) => {
        // The orchestrator calls this right before navigating.
        options?.beforeRedirect?.({});
        return { action: "reauthorize", scopes: [], attempt: 0 };
      },
    );
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it("writes the hosted marker through the bridge before redirecting", async () => {
    const prepareRedirect = vi.fn();
    unregister = registerScopeStepUpHostBridge({ prepareRedirect });
    saveChatStepUp();
    driveScopeStepUp(server, { requiredScope: "orders:read" });
    await vi.waitFor(() => expect(prepareRedirect).toHaveBeenCalledTimes(1));
    // A call that used no credential: the classic first-credential flow.
    expect(prepareRedirect).toHaveBeenCalledWith(server, undefined);
    expect(readPendingChatScopeStepUp()?.credentialBinding).toEqual({
      kind: "none",
    });
  });

  it("reauthorizes an owned credential in place", async () => {
    const prepareRedirect = vi.fn();
    unregister = registerScopeStepUpHostBridge({
      prepareRedirect,
      resolveCredentialBinding: async (_server, connectionId) => ({
        kind: "owned",
        credentialId: connectionId!,
      }),
    });
    saveChatStepUp("c1");
    driveScopeStepUp(
      server,
      { requiredScope: "orders:read" },
      { method: "tools/call", operation: "get_my_orders" },
      { connectionId: "c1" },
    );
    await vi.waitFor(() => expect(prepareRedirect).toHaveBeenCalledTimes(1));
    expect(prepareRedirect).toHaveBeenCalledWith(server, {
      kind: "replace",
      credentialId: "c1",
    });
  });

  it("never replaces a shared credential", async () => {
    const prepareRedirect = vi.fn();
    unregister = registerScopeStepUpHostBridge({
      prepareRedirect,
      resolveCredentialBinding: async (_server, connectionId) => ({
        kind: "shared",
        credentialId: connectionId!,
      }),
    });
    saveChatStepUp("c1");
    driveScopeStepUp(
      server,
      { requiredScope: "orders:read" },
      { method: "tools/call", operation: "get_my_orders" },
      { connectionId: "c1" },
    );
    await vi.waitFor(() => expect(prepareRedirect).toHaveBeenCalledTimes(1));
    expect(prepareRedirect).toHaveBeenCalledWith(server, { kind: "add" });
  });

  it("treats an ownership lookup failure as not ours", async () => {
    const prepareRedirect = vi.fn();
    unregister = registerScopeStepUpHostBridge({
      prepareRedirect,
      resolveCredentialBinding: async () => {
        throw new Error("network");
      },
    });
    saveChatStepUp("c1");
    driveScopeStepUp(
      server,
      { requiredScope: "orders:read" },
      undefined,
      { connectionId: "c1" },
    );
    await vi.waitFor(() => expect(prepareRedirect).toHaveBeenCalledTimes(1));
    expect(prepareRedirect).toHaveBeenCalledWith(server, { kind: "add" });
  });
});

describe("settling the pending stores on the callback", () => {
  beforeEach(() => sessionStorage.clear());

  it("marks a chat step-up ready, or cancels it with the reason", () => {
    saveChatStepUp("c1");
    settlePendingChatScopeStepUpAfterCallback("orders", "c1");
    expect(readPendingChatScopeStepUp()?.phase).toBe("ready");

    saveChatStepUp("c1");
    sessionStorage.setItem(
      "mcp-scope-step-up-chat-v1",
      JSON.stringify({
        ...readPendingChatScopeStepUp(),
        credentialBinding: { kind: "owned", credentialId: "c1" },
      }),
    );
    settlePendingChatScopeStepUpAfterCallback("orders", "c2");
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
    expect(
      settlePendingDirectScopeStepUpReplayAfterCallback("orders", "c9"),
    ).toBeUndefined();
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "orders",
        surface: "tools",
      }),
    ).toBeDefined();

    save();
    const stored = JSON.parse(
      sessionStorage.getItem("mcp-scope-step-up-replay-v1")!,
    );
    sessionStorage.setItem(
      "mcp-scope-step-up-replay-v1",
      JSON.stringify({
        ...stored,
        credentialBinding: { kind: "shared", credentialId: "c1" },
      }),
    );
    expect(
      settlePendingDirectScopeStepUpReplayAfterCallback("orders", "mine"),
    ).toBe(SIGNED_IN_WITH_OWN_ACCOUNT_MESSAGE);
    expect(sessionStorage.getItem("mcp-scope-step-up-replay-v1")).toBeNull();
  });
});
