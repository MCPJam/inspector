import { InsufficientScopeError } from "@modelcontextprotocol/client";
import {
  parseChallengeHeader,
  type AuthChallengeEffectiveAuth,
  type AuthChallengeSignal,
} from "@mcpjam/sdk";
import type { UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
  AUTH_REQUIRED_DATA_PART_TYPE,
  authChallengeRepeatText,
  isAuthChallengeNoticeDataPart,
  isAuthRequiredDataPart,
} from "@/shared/auth-challenge";
import { SCOPE_STEP_UP_DATA_PART_TYPE } from "@/shared/scope-step-up";
import {
  authChallengeInfoFromToolError,
  type AuthChallengeChatObserver,
} from "../auth-challenge-chat.js";
import {
  scopeStepUpInfoFromToolError,
  wrapToolsWithScopeStepUp,
} from "../insufficient-scope-step-up.js";
import { isScopeStepUpSuspendSignal } from "../scope-step-up-continuation.js";
import { authChallengeFromMcpProfile } from "../effective-auth.js";

type Chunk = { type: string; transient?: boolean; data: any };

function makeWriter() {
  const chunks: Chunk[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: UIMessageChunk) => {
        chunks.push(chunk as unknown as Chunk);
      },
    },
  };
}

const CHALLENGE =
  'Bearer error="invalid_token", error_description="Sign in to read orders", scope="orders:read", resource_metadata="https://orders.example/.well-known/oauth-protected-resource/mcp"';

/** The error the SDK's HTTP error fetch throws for a 401 on `tools/call`. */
function http401(header: string | null = CHALLENGE): Error {
  return Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
    status: 401,
    data: { authChallenge: parseChallengeHeader(header) },
  });
}

/** A ChatGPT-style challenged result. */
function metaChallengedResult(value: unknown = [CHALLENGE]) {
  return {
    isError: true,
    content: [{ type: "text", text: "Sign in to read orders" }],
    _meta: { "mcp/www_authenticate": value },
  };
}

function observer(
  overrides: Partial<AuthChallengeChatObserver> & {
    effectiveAuth?: AuthChallengeEffectiveAuth;
  } = {},
): AuthChallengeChatObserver & {
  createContinuation: ReturnType<typeof vi.fn>;
  onSuspend: ReturnType<typeof vi.fn>;
} {
  const { effectiveAuth = "discover", ...rest } = overrides;
  return {
    interactive: true,
    effectiveAuthFor: () => effectiveAuth,
    serverNameFor: () => "Orders",
    readOnlyFor: (_serverId, toolName) => toolName === "get_my_orders",
    securitySchemesFor: () => ({
      schemes: [{ type: "oauth2", scopes: ["orders:read"] }],
      source: "tool",
    }),
    createContinuation: vi.fn(() => ({
      continuationId: "cont-1",
      expiresAt: 1_900_000_000_000,
    })),
    onSuspend: vi.fn(),
    ...rest,
  } as any;
}

function wrap(
  execute: () => unknown,
  authChallenge: AuthChallengeChatObserver | undefined,
  writer: { write: (chunk: UIMessageChunk) => void } | null,
  extra: Record<string, unknown> = {},
) {
  return wrapToolsWithScopeStepUp(
    {
      get_my_orders: {
        inputSchema: {},
        _serverId: "orders",
        execute: vi.fn(async () => execute()),
      },
    } as any,
    () => writer,
    { ...(authChallenge ? { authChallenge } : {}), ...extra },
  ).get_my_orders as { execute: (input: unknown, options: unknown) => any };
}

const call = { toolCallId: "call-1" };

describe("authChallengeInfoFromToolError", () => {
  it("recognizes a thrown 401 and stamps the recorded auth method", () => {
    expect(
      authChallengeInfoFromToolError({
        error: http401(),
        serverId: "orders",
        toolCallId: "call-1",
        effectiveAuth: "discover",
      }),
    ).toMatchObject({
      serverId: "orders",
      toolCallId: "call-1",
      signal: {
        source: "http_401",
        requiredScope: "orders:read",
        effectiveAuth: "discover",
      },
    });
  });

  it("recognizes the hosted tokenless connection's 403 envelope", () => {
    const error = Object.assign(new Error("asked for sign-in"), {
      status: 403,
      details: {
        upstreamAuthRequired: true,
        authChallenge: {
          ...parseChallengeHeader(CHALLENGE),
          effectiveAuth: "discover",
        },
      },
    });
    expect(
      authChallengeInfoFromToolError({ error, serverId: "orders" })?.signal,
    ).toMatchObject({ source: "http_401", effectiveAuth: "discover" });
  });

  it("leaves a 403 step-up and ordinary errors alone", () => {
    expect(
      authChallengeInfoFromToolError({
        error: new InsufficientScopeError({ requiredScope: "orders:write" }),
        serverId: "orders",
      }),
    ).toBeUndefined();
    expect(
      authChallengeInfoFromToolError({
        error: new Error("boom"),
        serverId: "orders",
      }),
    ).toBeUndefined();
  });

  it("keeps the harness helper blind to 401s", () => {
    expect(
      scopeStepUpInfoFromToolError({
        error: http401(),
        serverId: "orders",
        toolCallId: "call-1",
      }),
    ).toBeUndefined();
  });
});

describe("wrapToolsWithScopeStepUp with a sign-in observer", () => {
  it("suspends a 401 behind a Connect card (prompt, discover)", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer();
    const tool = wrap(
      () => {
        throw http401();
      },
      auth,
      writer,
    );

    const thrown = await tool.execute({ id: 7 }, call).catch((e: unknown) => e);
    expect(isScopeStepUpSuspendSignal(thrown)).toBe(true);
    expect(auth.createContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "orders",
        serverName: "Orders",
        toolCallId: "call-1",
        toolName: "get_my_orders",
        toolInput: { id: 7 },
        signal: expect.objectContaining({
          source: "http_401",
          effectiveAuth: "discover",
        }),
      }),
    );
    expect(auth.onSuspend).toHaveBeenCalledWith("call-1");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: AUTH_REQUIRED_DATA_PART_TYPE,
      transient: true,
      data: {
        kind: "auth_required",
        continuationId: "cont-1",
        serverId: "orders",
        serverName: "Orders",
        toolCallId: "call-1",
        operation: { method: "tools/call", operation: "get_my_orders" },
        source: "http_401",
        effectiveAuth: "discover",
        action: "prompt",
        readOnly: true,
        requiredScope: "orders:read",
        resourceMetadataUrl:
          "https://orders.example/.well-known/oauth-protected-resource/mcp",
        errorDescription: "Sign in to read orders",
        expiresAt: 1_900_000_000_000,
      },
    });
    // The client's fail-closed validator accepts exactly what we emit.
    expect(isAuthRequiredDataPart(chunks[0])).toBe(true);
  });

  it("suspends a headerless 401 under the spec defaults", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer({ effectiveAuth: "oauth" });
    const tool = wrap(
      () => {
        throw http401(null);
      },
      auth,
      writer,
    );
    const thrown = await tool.execute({}, call).catch((e: unknown) => e);
    expect(isScopeStepUpSuspendSignal(thrown)).toBe(true);
    expect(chunks[0]?.data).toMatchObject({
      action: "prompt",
      effectiveAuth: "oauth",
    });
    expect(isAuthRequiredDataPart(chunks[0])).toBe(true);
  });

  it("suspends an honored `_meta` challenge (oauth2 scheme, error params)", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer({ policy: { toolResultAuthChallenge: "prompt" } });
    const tool = wrap(() => metaChallengedResult(), auth, writer);

    const thrown = await tool.execute({}, call).catch((e: unknown) => e);
    expect(isScopeStepUpSuspendSignal(thrown)).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toMatchObject({
      continuationId: "cont-1",
      source: "tool_result_meta",
      action: "prompt",
    });
    expect(isAuthRequiredDataPart(chunks[0])).toBe(true);
  });

  it("passes a `_meta` challenge through by default, with a notice", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer();
    const result = metaChallengedResult();
    const tool = wrap(() => result, auth, writer);

    await expect(tool.execute({}, call)).resolves.toBe(result);
    expect(auth.createContinuation).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
      data: {
        kind: "auth_challenge_notice",
        action: "passthrough",
        reason: "not-honored",
        source: "tool_result_meta",
        effectiveAuth: "discover",
      },
    });
    expect(isAuthChallengeNoticeDataPart(chunks[0])).toBe(true);
  });

  it("explains a `_meta` challenge the host would not honor for this tool", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer({
      policy: { toolResultAuthChallenge: "prompt" },
      securitySchemesFor: () => ({
        schemes: [{ type: "noauth" }],
        source: "tool",
      }),
    });
    const result = metaChallengedResult();
    const tool = wrap(() => result, auth, writer);

    await expect(tool.execute({}, call)).resolves.toBe(result);
    expect(chunks.map((chunk) => chunk.data.reason)).toEqual([
      "missing-oauth2-scheme",
    ]);
  });

  it("passes a 401 through under a passthrough host", async () => {
    const { chunks, writer } = makeWriter();
    const error = http401();
    const tool = wrap(
      () => {
        throw error;
      },
      observer({ policy: { unauthorizedChallenge: "passthrough" } }),
      writer,
    );

    await expect(tool.execute({}, call)).rejects.toBe(error);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
      data: { action: "passthrough", reason: "not-honored" },
    });
  });

  it("answers a notify host with the sign-in text and a card that does not replay", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer({ policy: { unauthorizedChallenge: "notify" } });
    const tool = wrap(
      () => {
        throw http401();
      },
      auth,
      writer,
    );

    const result = await tool.execute({}, call);
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            'MCP server "Orders" needs you to sign in',
          ),
        },
      ],
    });
    expect(auth.createContinuation).not.toHaveBeenCalled();
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
      AUTH_REQUIRED_DATA_PART_TYPE,
    ]);
    expect(chunks[0]?.data).toMatchObject({
      action: "notify",
      reason: "honored",
    });
    expect(chunks[1]?.data).toMatchObject({ action: "notify" });
    expect(chunks[1]?.data).not.toHaveProperty("continuationId");
    expect(isAuthRequiredDataPart(chunks[1])).toBe(true);
  });

  it.each(["none", "bearer", "xaa", undefined] as const)(
    "never offers sign-in under %s (prompt is blocked by the auth method)",
    async (effectiveAuth) => {
      const { chunks, writer } = makeWriter();
      const auth = observer({ effectiveAuthFor: () => effectiveAuth } as any);
      const error = http401();
      const tool = wrap(
        () => {
          throw error;
        },
        auth,
        writer,
      );

      await expect(tool.execute({}, call)).rejects.toBe(error);
      expect(auth.createContinuation).not.toHaveBeenCalled();
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
        data: { action: "prompt", reason: "auth-method-blocked" },
      });
      expect(isAuthChallengeNoticeDataPart(chunks[0])).toBe(true);
      if (effectiveAuth) {
        expect(chunks[0]?.data.effectiveAuth).toBe(effectiveAuth);
      } else {
        expect(chunks[0]?.data).not.toHaveProperty("effectiveAuth");
      }
    },
  );

  it("does not offer the notify card under a method that cannot sign in", async () => {
    const { chunks, writer } = makeWriter();
    const tool = wrap(
      () => {
        throw http401();
      },
      observer({
        effectiveAuth: "bearer",
        policy: { unauthorizedChallenge: "notify" },
      }),
      writer,
    );

    await expect(tool.execute({}, call)).resolves.toMatchObject({
      isError: true,
    });
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
    ]);
  });

  it("answers a repeat challenge after sign-in with the repeat copy and no card", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer({ hasRecentSignIn: () => true });
    const tool = wrap(
      () => {
        throw http401();
      },
      auth,
      writer,
    );

    await expect(tool.execute({}, call)).resolves.toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: authChallengeRepeatText("Orders", "get_my_orders"),
        },
      ],
    });
    expect(auth.createContinuation).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toMatchObject({
      action: "prompt",
      reason: "repeat-after-sign-in",
    });
    expect(isAuthChallengeNoticeDataPart(chunks[0])).toBe(true);
  });

  it("emits a display-only card when the call cannot be saved", async () => {
    const { chunks, writer } = makeWriter();
    const error = http401();
    const tool = wrap(
      () => {
        throw error;
      },
      observer({ createContinuation: undefined }),
      writer,
    );

    await expect(tool.execute({}, call)).rejects.toBe(error);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toMatchObject({ action: "prompt" });
    expect(chunks[0]?.data).not.toHaveProperty("continuationId");
    expect(isAuthRequiredDataPart(chunks[0])).toBe(true);
  });

  it("degrades to a display-only card when saving the call fails", async () => {
    const { chunks, writer } = makeWriter();
    const error = http401();
    const auth = observer({
      createContinuation: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    } as any);
    const tool = wrap(
      () => {
        throw error;
      },
      auth,
      writer,
    );

    await expect(tool.execute({}, call)).rejects.toBe(error);
    expect(auth.onSuspend).not.toHaveBeenCalled();
    expect(chunks[0]?.data).not.toHaveProperty("continuationId");
  });

  it("never offers a card to scenario and share-link visitors", async () => {
    const { chunks, writer } = makeWriter();
    const error = http401();
    const auth = observer({ interactive: false });
    const tool = wrap(
      () => {
        throw error;
      },
      auth,
      writer,
    );

    await expect(tool.execute({}, call)).rejects.toBe(error);
    expect(auth.createContinuation).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(0);
  });

  it("leaves a 401 untouched without an observer (harness and other surfaces)", async () => {
    const { chunks, writer } = makeWriter();
    const error = http401();
    const tool = wrap(
      () => {
        throw error;
      },
      undefined,
      writer,
    );

    await expect(tool.execute({}, call)).rejects.toBe(error);
    expect(chunks).toHaveLength(0);
  });

  it("keeps a 403 step-up on the step-up path", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer();
    const createStepUp = vi.fn(() => ({
      version: 1 as const,
      kind: "scope_step_up_required" as const,
      continuationId: "step-up-1",
      serverId: "orders",
      toolCallId: "call-1",
      operation: { method: "tools/call" as const, operation: "get_my_orders" },
      requiredScope: "orders:write",
      expiresAt: 1,
    }));
    const tool = wrap(
      () => {
        throw new InsufficientScopeError({ requiredScope: "orders:write" });
      },
      auth,
      writer,
      { createContinuation: createStepUp },
    );

    const thrown = await tool.execute({}, call).catch((e: unknown) => e);
    expect(isScopeStepUpSuspendSignal(thrown)).toBe(true);
    expect(createStepUp).toHaveBeenCalledTimes(1);
    expect(auth.createContinuation).not.toHaveBeenCalled();
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      SCOPE_STEP_UP_DATA_PART_TYPE,
    ]);
  });

  it("never treats a scope-less 403 as a sign-in", async () => {
    const { chunks, writer } = makeWriter();
    const auth = observer();
    const error = new InsufficientScopeError({
      errorDescription: "More access is required",
    });
    const tool = wrap(
      () => {
        throw error;
      },
      auth,
      writer,
    );

    await expect(tool.execute({}, call)).rejects.toBe(error);
    expect(auth.createContinuation).not.toHaveBeenCalled();
    // Whatever the step-up path does with it, no sign-in part is emitted.
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === AUTH_REQUIRED_DATA_PART_TYPE ||
          chunk.type === AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
      ),
    ).toHaveLength(0);
  });

  it("returns ordinary results unchanged", async () => {
    const { chunks, writer } = makeWriter();
    const result = { content: [{ type: "text", text: "ok" }] };
    const tool = wrap(() => result, observer(), writer);
    await expect(tool.execute({}, call)).resolves.toBe(result);
    expect(chunks).toHaveLength(0);
  });

  it("reads annotations and schemes under the server's own tool name", async () => {
    const { writer } = makeWriter();
    const readOnlyFor = vi.fn(() => false);
    const securitySchemesFor = vi.fn(() => ({
      schemes: [{ type: "oauth2" }],
      source: "tool" as const,
    }));
    const tools = wrapToolsWithScopeStepUp(
      {
        get_my_orders__work: {
          inputSchema: {},
          _serverId: "orders",
          _mcpToolName: "get_my_orders",
          execute: async () => metaChallengedResult(),
        },
      } as any,
      () => writer,
      {
        authChallenge: observer({
          policy: { toolResultAuthChallenge: "prompt" },
          readOnlyFor,
          securitySchemesFor,
        }),
      },
    ) as any;

    await tools.get_my_orders__work.execute({}, call).catch(() => undefined);
    expect(securitySchemesFor).toHaveBeenCalledWith("orders", "get_my_orders");
    expect(readOnlyFor).toHaveBeenCalledWith("orders", "get_my_orders");
  });
});

describe("authChallengeFromMcpProfile", () => {
  it("is absent (spec defaults) without a profile or knobs", () => {
    expect(authChallengeFromMcpProfile(undefined)).toBeUndefined();
    expect(authChallengeFromMcpProfile(null)).toBeUndefined();
    expect(
      authChallengeFromMcpProfile({ mrtrSupport: "none" }),
    ).toBeUndefined();
  });

  it("reads the four knobs and drops unrecognized values", () => {
    expect(
      authChallengeFromMcpProfile({
        unauthorizedChallenge: "notify",
        unauthorizedChallengeTrigger: "bearer-header",
        toolResultAuthChallenge: "prompt",
        toolResultAuthChallengeTrigger: "launch-everything",
      }),
    ).toEqual({
      unauthorizedChallenge: "notify",
      unauthorizedChallengeTrigger: "bearer-header",
      toolResultAuthChallenge: "prompt",
    });
  });

  it("drives the wrapper per turn: a Claude-like trigger passes a headerless 401", async () => {
    const { chunks, writer } = makeWriter();
    const error = http401(null);
    const tool = wrap(
      () => {
        throw error;
      },
      observer({
        policy: authChallengeFromMcpProfile({
          unauthorizedChallengeTrigger: "bearer-header",
        }),
      }),
      writer,
    );
    await expect(tool.execute({}, call)).rejects.toBe(error);
    expect(chunks.map((chunk) => chunk.data.reason)).toEqual([
      "missing-bearer-header",
    ]);
  });
});

describe("signal fixtures", () => {
  it("builds the fixtures this suite relies on", () => {
    const signal: AuthChallengeSignal = parseChallengeHeader(CHALLENGE);
    expect(signal.facets).toMatchObject({
      challengeHeader: "bearer",
      hasErrorParams: true,
    });
  });
});
