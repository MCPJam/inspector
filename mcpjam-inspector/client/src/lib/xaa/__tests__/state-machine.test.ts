import { describe, expect, it, vi } from "vitest";
import { createXAAStateMachine } from "../state-machine";
import { createInitialXAAFlowState, type XAAFlowState } from "../types";

function encodePart(value: Record<string, any>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(
  payload: Record<string, any>,
  header: Record<string, any> = {
    alg: "RS256",
    typ: "oauth-id-jag+jwt",
    kid: "xaa-idp-1",
  },
): string {
  return `${encodePart(header)}.${encodePart(payload)}.signature`;
}

describe("createXAAStateMachine", () => {
  it("walks the full happy path to completion", async () => {
    let state: XAAFlowState = createInitialXAAFlowState({
      serverUrl: "https://mcp.example.com",
      clientId: "mcpjam-debugger",
      userId: "user-12345",
      email: "demo.user@example.com",
      scope: "read:tools",
    });

    const idToken = makeJwt(
      {
        iss: "https://issuer.example/api/web/xaa",
        sub: "user-12345",
        email: "demo.user@example.com",
      },
      { alg: "RS256", typ: "JWT", kid: "xaa-idp-1" },
    );
    const idJag = makeJwt({
      iss: "https://issuer.example/api/web/xaa",
      sub: "user-12345",
      aud: "https://auth.example.com",
      resource: "https://mcp.example.com",
      client_id: "mcpjam-debugger",
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: "read:tools",
    });

    const executor = {
      externalRequest: vi.fn(async (url: string) => {
        if (url.includes(".well-known/oauth-protected-resource")) {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: {
              resource: "https://mcp.example.com",
              authorization_servers: ["https://auth.example.com"],
            },
            ok: true,
          };
        }

        if (url.includes(".well-known/oauth-authorization-server")) {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: {
              issuer: "https://auth.example.com",
              token_endpoint: "https://auth.example.com/oauth/token",
            },
            ok: true,
          };
        }

        return {
          status: 200,
          statusText: "OK",
          headers: {},
          body: { result: { serverInfo: { name: "demo" } } },
          ok: true,
        };
      }),
      internalRequest: vi.fn(async (path: string) => {
        if (path === "/authenticate") {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { id_token: idToken },
            ok: true,
          };
        }

        if (path === "/token-exchange") {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { id_jag: idJag },
            ok: true,
          };
        }

        return {
          status: 200,
          statusText: "OK",
          headers: {},
          body: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: {
              access_token: "access-token",
              token_type: "Bearer",
              expires_in: 300,
            },
          },
          ok: true,
        };
      }),
    };

    const machine = createXAAStateMachine({
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: "https://mcp.example.com",
      issuerBaseUrl: "https://issuer.example/api/web/xaa",
      requestExecutor: executor,
      clientId: "mcpjam-debugger",
      userId: "user-12345",
      email: "demo.user@example.com",
      scope: "read:tools",
    });

    for (let index = 0; index < 7; index += 1) {
      await machine.proceedToNextStep();
    }

    expect(state.currentStep).toBe("complete");
    expect(state.accessToken).toBe("access-token");
    expect(state.idJagDecoded?.issues).toHaveLength(0);
    expect(executor.internalRequest).toHaveBeenCalledWith(
      "/proxy/token",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("passes the configured negative test mode to token exchange and flags the issue during inspection", async () => {
    let state: XAAFlowState = createInitialXAAFlowState({
      serverUrl: "https://mcp.example.com",
      authzServerIssuer: "https://auth.example.com",
      clientId: "mcpjam-debugger",
      userId: "user-12345",
      email: "demo.user@example.com",
      negativeTestMode: "unknown_kid",
    });

    const idToken = makeJwt(
      {
        iss: "https://issuer.example/api/web/xaa",
        sub: "user-12345",
      },
      { alg: "RS256", typ: "JWT", kid: "xaa-idp-1" },
    );
    const idJag = makeJwt(
      {
        iss: "https://issuer.example/api/web/xaa",
        sub: "user-12345",
        aud: "https://auth.example.com",
        resource: "https://mcp.example.com",
        client_id: "mcpjam-debugger",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      { alg: "RS256", typ: "oauth-id-jag+jwt", kid: "nonexistent-key-id" },
    );

    const executor = {
      externalRequest: vi.fn(async (url: string) => {
        if (url.includes(".well-known/oauth-protected-resource")) {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: {
              resource: "https://mcp.example.com",
              authorization_servers: ["https://auth.example.com"],
            },
            ok: true,
          };
        }

        return {
          status: 200,
          statusText: "OK",
          headers: {},
          body: {
            issuer: "https://auth.example.com",
            token_endpoint: "https://auth.example.com/oauth/token",
          },
          ok: true,
        };
      }),
      internalRequest: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/authenticate") {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { id_token: idToken },
            ok: true,
          };
        }

        if (path === "/token-exchange") {
          const parsedBody = JSON.parse(String(init?.body));
          expect(parsedBody.negativeTestMode).toBe("unknown_kid");
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { id_jag: idJag },
            ok: true,
          };
        }

        throw new Error("proxy/token should not run in this test");
      }),
    };

    const machine = createXAAStateMachine({
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: "https://mcp.example.com",
      issuerBaseUrl: "https://issuer.example/api/web/xaa",
      requestExecutor: executor,
      clientId: "mcpjam-debugger",
      userId: "user-12345",
      email: "demo.user@example.com",
      negativeTestMode: "unknown_kid",
      authzServerIssuer: "https://auth.example.com",
    });

    for (let index = 0; index < 5; index += 1) {
      await machine.proceedToNextStep();
    }

    expect(state.currentStep).toBe("inspect_id_jag");
    expect(state.idJagDecoded?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "kid",
        }),
      ]),
    );
  });
});
