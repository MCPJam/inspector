import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChallengeHeader } from "@mcpjam/sdk";
import {
  AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
  authChallengeCancelledText,
  authChallengeRepeatText,
} from "@/shared/auth-challenge";

const store = vi.hoisted(() => ({
  create: vi.fn(),
  claim: vi.fn(),
  markWire: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
  scrub: vi.fn(),
}));

vi.mock("../mrtr-continuation-state.js", () => ({
  createContinuation: store.create,
  claimContinuation: store.claim,
  markContinuationWireStarted: store.markWire,
  finalizeContinuation: store.finalize,
  cancelContinuation: store.cancel,
  scrubContinuation: store.scrub,
}));

import {
  buildHostedScopeStepUpCancellation,
  buildHostedScopeStepUpResume,
  checkRecordedCredentialBinding,
  createHostedAuthChallengeContinuation,
  createHostedScopeStepUpContinuation,
  hostedAuthChallengeContinuationId,
  HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX,
  HOSTED_AUTH_CHALLENGE_REPEATED_REASON,
  isHostedAuthChallengeContinuationId,
  settleHostedAuthChallengeHistoryCall,
} from "../hosted-scope-step-up-continuation.js";

const CHALLENGE =
  'Bearer error="invalid_token", error_description="Sign in to read orders", scope="orders:read"';

function manager() {
  return {
    getInitializationInfo: () => ({
      protocolVersion: "2026-07-28",
      serverCapabilities: { tools: {} },
      serverVersion: { name: "orders", version: "1" },
    }),
    getServerConfig: () => ({ url: "https://orders.example/mcp" }),
  } as any;
}

function http401(): Error {
  return Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
    status: 401,
    data: { authChallenge: parseChallengeHeader(CHALLENGE) },
  });
}

const BASE = {
  bearer: "bearer",
  authPrincipal: "user-1",
  projectId: "project-1",
  chatSessionId: "chat-1",
  serverId: "server-1",
  serverName: "Orders",
  toolCallId: "call-1",
  toolName: "get_my_orders",
  toolInput: { since: "2026-01-01" },
};

const MESSAGES = [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "get_my_orders",
        input: { since: "2026-01-01" },
      },
    ],
  },
] as any;

/** The tool as the rebuilt manager attributes it to a credential. */
function tool(execute: () => unknown, connectionId?: string) {
  return {
    get_my_orders: {
      _serverId: "server-1",
      ...(connectionId
        ? {
            _connectionForInput: () => ({
              serverId: "server-1",
              connectionId,
              label: "Account",
            }),
          }
        : {}),
      execute: vi.fn(async () => execute()),
    },
  } as any;
}

async function saveAndClaim(
  input: Partial<Parameters<typeof createHostedAuthChallengeContinuation>[0]>,
) {
  const saved = await createHostedAuthChallengeContinuation({
    ...BASE,
    manager: manager(),
    ...input,
  } as any);
  const body = store.create.mock.calls.at(-1)![1];
  store.claim.mockResolvedValue({
    ok: true,
    status: "resuming",
    stateVersion: 0,
    state: {
      continuationId: saved.continuationId,
      serverId: "server-1",
      operationId: "call-1",
      operationMethod: "tools/call",
      sideEffecting: true,
      negotiatedEra: "2026-07-28",
      projectId: "project-1",
      chatSessionId: "chat-1",
      resumeState: body.resumeState,
      round: 0,
      maxRounds: 1,
      attempt: 0,
    },
  });
  return saved;
}

function resume(continuationId: string, tools: unknown) {
  return buildHostedScopeStepUpResume({
    request: { continuationId, toolCallId: "call-1" },
    bearer: "bearer",
    authPrincipal: "user-1",
    projectId: "project-1",
    chatSessionId: "chat-1",
    manager: manager(),
    messages: MESSAGES,
    tools: tools as any,
  });
}

function toolResultText(resolution: any): unknown {
  return resolution.toolResultMessage?.content?.[0]?.output?.value;
}

describe("hosted sign-in continuations", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    store.create.mockImplementation(async (_bearer: string, body: any) => ({
      ok: true,
      continuationId: body.continuationId,
      status: "awaiting_input",
      round: 0,
      stateVersion: 0,
      expiresAt: 1_900_000_000_000,
      createdAt: 1,
      idempotent: false,
    }));
    store.markWire.mockResolvedValue({ ok: true, attempt: 1 });
    store.finalize.mockResolvedValue({
      ok: true,
      stateVersion: 1,
      status: "completed",
    });
    store.cancel.mockResolvedValue({ ok: true, status: "cancelled" });
    store.scrub.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("stores the reason and derives an opaque, reason-marked id", async () => {
    const saved = await createHostedAuthChallengeContinuation({
      ...BASE,
      manager: manager(),
    });
    expect(saved).toEqual({
      continuationId: hostedAuthChallengeContinuationId(BASE),
      expiresAt: 1_900_000_000_000,
      credentialBinding: { kind: "none" },
    });
    expect(
      saved.continuationId.startsWith(
        HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX,
      ),
    ).toBe(true);
    expect(saved.continuationId).not.toContain("call-1");
    const body = store.create.mock.calls[0][1];
    expect(JSON.parse(body.resumeState)).toMatchObject({
      reason: "authorization_required",
      serverName: "Orders",
      credentialBinding: { kind: "none" },
      toolName: "get_my_orders",
    });
    expect(body).toMatchObject({
      chatSessionId: "chat-1",
      operationId: "call-1",
      maxRounds: 1,
    });
  });

  it("refuses to offer the same call again once its continuation settled", async () => {
    store.create.mockResolvedValueOnce({
      ok: true,
      continuationId: "x",
      status: "cancelled",
      round: 0,
      stateVersion: 1,
      expiresAt: 1,
      createdAt: 1,
      idempotent: true,
    });
    await expect(
      createHostedAuthChallengeContinuation({ ...BASE, manager: manager() }),
    ).rejects.toThrow("auth_challenge_continuation_cancelled");
  });

  describe("credential binding", () => {
    it("binds nothing for a tokenless call", async () => {
      const ownsCredential = vi.fn();
      const saved = await createHostedAuthChallengeContinuation({
        ...BASE,
        manager: manager(),
        ownsCredential,
      });
      expect(saved.credentialBinding).toEqual({ kind: "none" });
      expect(ownsCredential).not.toHaveBeenCalled();
    });

    it("records an owned credential", async () => {
      const saved = await createHostedAuthChallengeContinuation({
        ...BASE,
        manager: manager(),
        connectionId: "c1",
        ownsCredential: async () => true,
      });
      expect(saved.credentialBinding).toEqual({
        kind: "owned",
        credentialId: "c1",
      });
    });

    it("records a shared credential, and treats an unknown owner as shared", async () => {
      for (const ownsCredential of [
        async () => false,
        async () => {
          throw new Error("lookup failed");
        },
      ]) {
        const saved = await createHostedAuthChallengeContinuation({
          ...BASE,
          manager: manager(),
          connectionId: "c1",
          ownsCredential,
        });
        expect(saved.credentialBinding).toEqual({
          kind: "shared",
          credentialId: "c1",
        });
      }
    });

    it("reads ownership from the connection listing by default", async () => {
      vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
      const fetchMock = vi.fn(async (_url: string, init: any) => {
        const owned = JSON.parse(init.body).serverId === "server-1";
        return new Response(
          JSON.stringify(
            owned
              ? { connections: [{ connectionId: "c1" }], shared: false }
              : { connections: [{ connectionId: "c1" }], shared: true },
          ),
          { status: 200 },
        );
      });
      global.fetch = fetchMock as any;

      const owned = await createHostedAuthChallengeContinuation({
        ...BASE,
        manager: manager(),
        connectionId: "c1",
      });
      expect(owned.credentialBinding).toEqual({
        kind: "owned",
        credentialId: "c1",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://convex.example/web/oauth/connections",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer bearer" }),
        }),
      );

      const shared = await createHostedAuthChallengeContinuation({
        ...BASE,
        serverId: "server-2",
        manager: manager(),
        connectionId: "c1",
      });
      expect(shared.credentialBinding.kind).toBe("shared");
    });

    it("checks the recorded binding on resume", () => {
      expect(checkRecordedCredentialBinding({ kind: "none" }, "new")).toEqual({
        ok: true,
        firstBinding: true,
      });
      expect(
        checkRecordedCredentialBinding(
          { kind: "owned", credentialId: "c1" },
          "c1",
        ),
      ).toEqual({ ok: true, firstBinding: false });
      expect(
        checkRecordedCredentialBinding(
          { kind: "owned", credentialId: "c1" },
          "c2",
        ),
      ).toEqual({ ok: false });
      expect(
        checkRecordedCredentialBinding(
          { kind: "shared", credentialId: "c1" },
          "c1",
        ),
      ).toEqual({ ok: false });
    });

    it("replays a tokenless call on the personal connection the sign-in made", async () => {
      const saved = await saveAndClaim({});
      const tools = tool(
        () => ({ content: [{ type: "text", text: "2" }] }),
        "new-personal",
      );
      const resolution = await resume(saved.continuationId, tools).resolve(
        () => undefined,
      );
      expect(resolution.kind).toBe("complete");
      expect(tools.get_my_orders.execute).toHaveBeenCalledTimes(1);
    });

    it("replays an owned credential only on that credential", async () => {
      const saved = await saveAndClaim({
        connectionId: "c1",
        ownsCredential: async () => true,
      });
      const same = tool(() => ({ content: [] }), "c1");
      expect(
        (await resume(saved.continuationId, same).resolve(() => undefined))
          .kind,
      ).toBe("complete");

      const switched = tool(() => ({ content: [] }), "c2");
      const resolution = await resume(saved.continuationId, switched).resolve(
        () => undefined,
      );
      expect(switched.get_my_orders.execute).not.toHaveBeenCalled();
      expect(resolution.kind).toBe("recover");
      expect(toolResultText(resolution)).toContain("a different account");
      expect(store.cancel).toHaveBeenCalled();
    });

    it("never replays a shared credential's call", async () => {
      const saved = await saveAndClaim({
        connectionId: "c1",
        ownsCredential: async () => false,
      });
      const tools = tool(() => ({ content: [] }), "c1");
      const resolution = await resume(saved.continuationId, tools).resolve(
        () => undefined,
      );
      expect(tools.get_my_orders.execute).not.toHaveBeenCalled();
      expect(resolution.kind).toBe("recover");
      expect(toolResultText(resolution)).toContain("their own account");
    });
  });

  describe("repeat after sign-in", () => {
    it("answers a replay refused with a 401 with the repeat copy", async () => {
      const saved = await saveAndClaim({});
      const chunks: any[] = [];
      const resolution = await resume(
        saved.continuationId,
        tool(() => {
          throw http401();
        }),
      ).resolve((chunk) => chunks.push(chunk));

      expect(resolution.kind).toBe("recover");
      expect(toolResultText(resolution)).toBe(
        authChallengeRepeatText("Orders", "get_my_orders"),
      );
      expect(store.finalize).toHaveBeenCalledWith(
        "bearer",
        expect.objectContaining({
          status: "failed",
          terminalReason: HOSTED_AUTH_CHALLENGE_REPEATED_REASON,
        }),
        undefined,
      );
      expect(chunks).toEqual([
        expect.objectContaining({
          type: AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
          data: expect.objectContaining({ reason: "repeat-after-sign-in" }),
        }),
      ]);
    });

    it("answers a `_meta`-challenged replay the same way, never completing", async () => {
      const saved = await saveAndClaim({});
      const resolution = await resume(
        saved.continuationId,
        tool(() => ({
          isError: true,
          content: [{ type: "text", text: "sign in" }],
          _meta: { "mcp/www_authenticate": [CHALLENGE] },
        })),
      ).resolve(() => undefined);
      expect(toolResultText(resolution)).toBe(
        authChallengeRepeatText("Orders", "get_my_orders"),
      );
      expect(store.finalize).not.toHaveBeenCalledWith(
        "bearer",
        expect.objectContaining({ status: "completed" }),
        undefined,
      );
    });

    it("does not settle a step-up replay that returned a challenge as completed", async () => {
      await createHostedScopeStepUpContinuation({
        bearer: "bearer",
        authPrincipal: "user-1",
        projectId: "project-1",
        chatSessionId: "chat-1",
        manager: manager(),
        info: {
          serverId: "server-1",
          toolCallId: "call-1",
          requiredScope: "orders:write",
        },
        toolName: "get_my_orders",
        toolInput: { since: "2026-01-01" },
      });
      const body = store.create.mock.calls.at(-1)![1];
      store.claim.mockResolvedValue({
        ok: true,
        status: "resuming",
        stateVersion: 0,
        state: {
          continuationId: body.continuationId,
          serverId: "server-1",
          operationId: "call-1",
          operationMethod: "tools/call",
          sideEffecting: true,
          negotiatedEra: "2026-07-28",
          projectId: "project-1",
          chatSessionId: "chat-1",
          resumeState: body.resumeState,
          round: 0,
          maxRounds: 1,
          attempt: 0,
        },
      });
      const chunks: any[] = [];
      const resolution = await resume(
        body.continuationId,
        tool(() => ({
          isError: true,
          content: [],
          _meta: { "mcp/www_authenticate": CHALLENGE },
        })),
      ).resolve((chunk) => chunks.push(chunk));
      expect(resolution.kind).toBe("recover");
      expect(store.finalize).toHaveBeenCalledWith(
        "bearer",
        expect.objectContaining({ status: "failed" }),
        undefined,
      );
      expect(chunks).toHaveLength(0);
    });
  });

  describe("cancel (send without clicking)", () => {
    it("answers a sign-in continuation with the sign-in copy", async () => {
      const continuationId = hostedAuthChallengeContinuationId(BASE);
      expect(isHostedAuthChallengeContinuationId(continuationId)).toBe(true);
      const resolution = await buildHostedScopeStepUpCancellation({
        request: { continuationId, toolCallId: "call-1" },
        bearer: "bearer",
        messages: MESSAGES,
        tools: tool(() => undefined),
        serverNameFor: () => "Orders",
      }).resolve(() => undefined);
      expect(toolResultText(resolution)).toBe(
        authChallengeCancelledText("Orders", "get_my_orders"),
      );
    });

    it("keeps the step-up copy for a step-up continuation", async () => {
      const resolution = await buildHostedScopeStepUpCancellation({
        request: { continuationId: "continuation-1", toolCallId: "call-1" },
        bearer: "bearer",
        messages: MESSAGES,
        tools: tool(() => undefined),
        serverNameFor: () => "Orders",
      }).resolve(() => undefined);
      expect(toolResultText(resolution)).toBe(
        "Authorization was not completed, so the tool was not retried.",
      );
    });
  });

  describe("history settlement", () => {
    it("cancels the pending continuation the resent call belongs to", async () => {
      await expect(
        settleHostedAuthChallengeHistoryCall({
          bearer: "bearer",
          authPrincipal: "user-1",
          chatSessionId: "chat-1",
          toolCallId: "call-1",
        }),
      ).resolves.toBe(true);
      expect(store.cancel).toHaveBeenCalledWith("bearer", {
        continuationId: hostedAuthChallengeContinuationId(BASE),
        reason: "the user continued without signing in",
      });
      expect(store.scrub).toHaveBeenCalled();
    });

    it("leaves a call it never suspended alone", async () => {
      store.cancel.mockResolvedValueOnce({
        ok: false,
        status: 404,
        error: "not found",
      });
      await expect(
        settleHostedAuthChallengeHistoryCall({
          bearer: "bearer",
          authPrincipal: "user-1",
          chatSessionId: "chat-1",
          toolCallId: "other",
        }),
      ).resolves.toBe(false);
      expect(store.scrub).not.toHaveBeenCalled();
    });

    it("derives a different id per caller, conversation and call", () => {
      const id = hostedAuthChallengeContinuationId(BASE);
      expect(
        hostedAuthChallengeContinuationId({ ...BASE, authPrincipal: "user-2" }),
      ).not.toBe(id);
      expect(
        hostedAuthChallengeContinuationId({ ...BASE, chatSessionId: "chat-2" }),
      ).not.toBe(id);
      expect(
        hostedAuthChallengeContinuationId({ ...BASE, toolCallId: "call-2" }),
      ).not.toBe(id);
    });
  });
});
