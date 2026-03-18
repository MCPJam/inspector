import { createSign, generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
  };
});

vi.mock("@mcpjam/sdk", () => ({
  isMCPAuthError: vi.fn().mockReturnValue(false),
  MCPClientManager: vi.fn().mockImplementation(() => ({
    disconnectAllServers: disconnectAllServersMock,
  })),
}));

vi.mock("../../../utils/chat-v2-orchestration.js", () => ({
  prepareChatV2: prepareChatV2Mock,
}));

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

vi.mock("@/shared/types", async () => {
  const actual =
    await vi.importActual<typeof import("@/shared/types")>("@/shared/types");
  return {
    ...actual,
    isMCPJamProvidedModel: vi.fn().mockReturnValue(true),
    isGuestAllowedModel: vi.fn().mockReturnValue(true),
  };
});

import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";
import {
  initGuestTokenSecret,
  issueGuestToken,
} from "../../../services/guest-token.js";

describe("web routes — chat-v2 guest mode", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHostedGuestJwksUrl = process.env.MCPJAM_GUEST_JWKS_URL;
  const originalLocalSigning = process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING;
  const originalGuestJwtKeyDir = process.env.GUEST_JWT_KEY_DIR;
  const originalFetch = global.fetch;
  let testGuestKeyDir: string;

  const signHostedGuestToken = () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: "guest-1" };
    const payload = {
      iss: "https://api.mcpjam.com/guest",
      sub: "hosted-guest-id",
      iat: now,
      exp: now + 3600,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
      "base64url",
    );
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);

    return {
      token: `${signingInput}.${signer.sign(pair.privateKey, "base64url")}`,
      jwks: {
        keys: [
          {
            ...(pair.publicKey.export({ format: "jwk" }) as JsonWebKey),
            kid: "guest-1",
            alg: "RS256",
            use: "sig",
          },
        ],
      },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    testGuestKeyDir = mkdtempSync(
      path.join(os.tmpdir(), "chat-v2-guest-test-"),
    );
    process.env.GUEST_JWT_KEY_DIR = testGuestKeyDir;
    initGuestTokenSecret();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
      scrubMessages: (messages: unknown) => messages,
    });
    handleMCPJamFreeChatModelMock.mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    disconnectAllServersMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalHostedGuestJwksUrl === undefined) {
      delete process.env.MCPJAM_GUEST_JWKS_URL;
    } else {
      process.env.MCPJAM_GUEST_JWKS_URL = originalHostedGuestJwksUrl;
    }
    if (originalLocalSigning === undefined) {
      delete process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING;
    } else {
      process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING = originalLocalSigning;
    }
    if (originalGuestJwtKeyDir === undefined) {
      delete process.env.GUEST_JWT_KEY_DIR;
    } else {
      process.env.GUEST_JWT_KEY_DIR = originalGuestJwtKeyDir;
    }
    rmSync(testGuestKeyDir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  it("returns 401 when a non-guest bearer token reaches the guest branch", async () => {
    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        model: {
          id: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          name: "Claude Haiku 4.5",
        },
      },
      "non-guest-token",
    );

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
    expect(data.message).toContain("Valid guest token required");
  });

  it("streams hosted guest chat when a valid guest token is present", async () => {
    const { app } = createWebTestApp();
    const { token } = issueGuestToken();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        messages: [{ role: "user", parts: [{ type: "text", text: "hey" }] }],
        model: {
          id: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          name: "Claude Haiku 4.5",
        },
        systemPrompt: "You are helpful",
        temperature: 0.7,
      },
      token,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedServers: [],
        requireToolApproval: undefined,
      }),
    );
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "anthropic/claude-haiku-4.5",
        authHeader: `Bearer ${token}`,
        selectedServers: [],
      }),
    );
  });

  it("accepts a hosted guest token in development when local signing is disabled", async () => {
    process.env.NODE_ENV = "development";
    process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING = "false";
    process.env.MCPJAM_GUEST_JWKS_URL =
      "https://app.mcpjam.com/api/web/guest-jwks";
    const { token, jwks } = signHostedGuestToken();
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        messages: [{ role: "user", parts: [{ type: "text", text: "hey" }] }],
        model: {
          id: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          name: "Claude Haiku 4.5",
        },
      },
      token,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authHeader: `Bearer ${token}`,
      }),
    );
  });
});
