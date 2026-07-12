import { describe, expect, it, vi } from "vitest";
import { XAA_DEBUG_CLIENT_ID_METADATA_URL } from "@mcpjam/sdk/browser";
import { CLIENT_SECRET_MASK, createXAAStateMachine } from "../state-machine";
import {
  createInitialXAAFlowState,
  type XaaEphemeralDcrCredentials,
  type XAAFlowState,
} from "../types";

function encodePart(value: Record<string, any>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(
  payload: Record<string, any>,
  header: Record<string, any> = {
    alg: "RS256",
    typ: "oauth-id-jag+jwt",
    kid: "xaa-idp-1",
  }
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
      { alg: "RS256", typ: "JWT", kid: "xaa-idp-1" }
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
      })
    );
  });

  it("authenticates with the live config identity, not a stale flow snapshot", async () => {
    // The flow was built with user-12345 but the simulated identity was later
    // edited to john; the machine config carries the fresh value. The auth
    // request must send john, otherwise the ID-JAG mints the wrong sub.
    let state: XAAFlowState = createInitialXAAFlowState({
      serverUrl: "https://mcp.example.com",
      authzServerIssuer: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "mcpjam-debugger",
      userId: "user-12345",
      email: "stale@example.com",
      currentStep: "received_authz_metadata",
    });

    const authBodies: any[] = [];
    const executor = {
      externalRequest: vi.fn(),
      internalRequest: vi.fn(async (path: string, init?: any) => {
        if (path === "/authenticate") {
          authBodies.push(JSON.parse(init.body));
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { id_token: "id-token" },
            ok: true,
          };
        }
        return { status: 200, statusText: "OK", headers: {}, body: {}, ok: true };
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
      userId: "john",
      email: "john@mcpjam.com",
      scope: "read:tools",
    });

    await machine.proceedToNextStep();

    expect(authBodies).toHaveLength(1);
    expect(authBodies[0].userId).toBe("john");
    expect(authBodies[0].email).toBe("john@mcpjam.com");
    const assertionLog = state.infoLogs?.find(
      (log) => log.id === "xaa-identity-assertion"
    );
    expect(assertionLog?.data).toMatchObject({
      userId: "john",
      email: "john@mcpjam.com",
    });
  });

  it("sends a configured client secret to /proxy/token but masks it in the logged request", async () => {
    let state: XAAFlowState = createInitialXAAFlowState({
      serverUrl: "https://mcp.example.com",
      authzServerIssuer: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "mcpjam-debugger",
      clientSecret: "test-secret-123",
      userId: "user-12345",
      email: "demo.user@example.com",
      currentStep: "inspect_id_jag",
      idJag: makeJwt({
        iss: "https://issuer.example/api/web/xaa",
        sub: "user-12345",
        aud: "https://auth.example.com",
        resource: "https://mcp.example.com",
        client_id: "mcpjam-debugger",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    });

    const executor = {
      externalRequest: vi.fn(),
      internalRequest: vi.fn(async () => ({
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
      })),
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
    });

    // Advance once: inspect_id_jag -> jwt_bearer_request.
    await machine.proceedToNextStep();

    // The wire request carries the real secret...
    const [, init] = executor.internalRequest.mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.clientSecret).toBe("test-secret-123");

    // ...but no logged copy of the flow state contains it.
    const jwtBearerEntry = (state.httpHistory || []).find(
      (entry) => entry.step === "jwt_bearer_request"
    );
    expect(jwtBearerEntry?.request.body.clientSecret).toBe(CLIENT_SECRET_MASK);
    expect(JSON.stringify(state.httpHistory)).not.toContain("test-secret-123");
    expect(JSON.stringify(state.infoLogs)).not.toContain("test-secret-123");
    expect(JSON.stringify(state.lastRequest)).not.toContain("test-secret-123");
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
      { alg: "RS256", typ: "JWT", kid: "xaa-idp-1" }
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
      { alg: "RS256", typ: "oauth-id-jag+jwt", kid: "nonexistent-key-id" }
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
      ])
    );
  });

  describe("runner mode (runAll)", () => {
    function buildRunnerHarness(options: {
      registrationId?: string;
      failTokenProxy?: boolean;
      negativeTestMode?: XAAFlowState["negativeTestMode"];
    }) {
      let state: XAAFlowState = createInitialXAAFlowState({
        serverUrl: "https://mcp.example.com",
        clientId: "mcpjam-debugger",
        userId: "user-12345",
        email: "demo.user@example.com",
        scope: "read:tools",
        negativeTestMode: options.negativeTestMode,
      });

      const idToken = makeJwt(
        {
          iss: "https://issuer.example/api/web/xaa",
          sub: "user-12345",
          email: "demo.user@example.com",
        },
        { alg: "RS256", typ: "JWT", kid: "xaa-idp-1" }
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

      const tokenProxyBodies: any[] = [];

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
            return {
              status: 200,
              statusText: "OK",
              headers: {},
              body: { id_jag: idJag },
              ok: true,
            };
          }

          // /proxy/token
          tokenProxyBodies.push(JSON.parse(String(init?.body)));
          if (options.failTokenProxy) {
            return {
              status: 200,
              statusText: "OK",
              headers: {},
              body: {
                status: 400,
                statusText: "Bad Request",
                headers: {},
                body: { error: "invalid_grant" },
              },
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
        registrationId: options.registrationId,
        negativeTestMode: options.negativeTestMode,
      });

      return {
        machine,
        getStateSnapshot: () => state,
        tokenProxyBodies,
      };
    }

    it("drives a registration-backed run to completion sending only the registration id", async () => {
      const { machine, getStateSnapshot, tokenProxyBodies } =
        buildRunnerHarness({ registrationId: "app_1" });

      await machine.runAll();

      expect(getStateSnapshot().currentStep).toBe("complete");
      expect(getStateSnapshot().accessToken).toBe("access-token");
      expect(tokenProxyBodies).toHaveLength(1);
      expect(tokenProxyBodies[0]).toMatchObject({ registrationId: "app_1" });
      // The secret and endpoint live server-side; the browser never sends
      // either on a registration-backed run.
      expect(tokenProxyBodies[0]).not.toHaveProperty("clientSecret");
      expect(tokenProxyBodies[0]).not.toHaveProperty("tokenEndpoint");
      expect(tokenProxyBodies[0]).not.toHaveProperty("clientId");
    });

    it("drives an inline-profile run to completion sending the token endpoint", async () => {
      const { machine, getStateSnapshot, tokenProxyBodies } =
        buildRunnerHarness({});

      await machine.runAll();

      expect(getStateSnapshot().currentStep).toBe("complete");
      expect(tokenProxyBodies[0]).toMatchObject({
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "mcpjam-debugger",
      });
      expect(tokenProxyBodies[0]).not.toHaveProperty("registrationId");
    });

    it("stops at the failing step and preserves the partial run", async () => {
      const { machine, getStateSnapshot } = buildRunnerHarness({
        registrationId: "app_1",
        failTokenProxy: true,
      });

      await machine.runAll();

      const final = getStateSnapshot();
      expect(final.currentStep).toBe("jwt_bearer_request");
      expect(final.error).toBeTruthy();
      expect(final.accessToken).toBeUndefined();
      // Earlier steps completed and stay recorded — the run is partial,
      // not all-or-nothing.
      expect(final.idJag).toBeTruthy();
      expect(
        (final.httpHistory ?? []).some(
          (entry) => entry.step === "token_exchange_request"
        )
      ).toBe(true);
    });

    it("treats a rejection in a negative-test mode as the expected outcome, not an error", async () => {
      const { machine, getStateSnapshot, tokenProxyBodies } =
        buildRunnerHarness({
          registrationId: "app_1",
          failTokenProxy: true,
          negativeTestMode: "unknown_kid",
        });

      await machine.runAll();

      const final = getStateSnapshot();
      // A rejection is the pass condition here — no flow error.
      expect(final.error).toBeUndefined();
      expect(final.negativeProbe).toEqual({
        outcome: "rejected",
        status: 400,
      });
      expect(final.accessToken).toBeUndefined();
      // The run stops on the outcome instead of re-firing the bearer request.
      expect(tokenProxyBodies).toHaveLength(1);
    });

    it("flags an accepted broken assertion in a negative-test mode as a security risk", async () => {
      const { machine, getStateSnapshot } = buildRunnerHarness({
        registrationId: "app_1",
        failTokenProxy: false,
        negativeTestMode: "unknown_kid",
      });

      await machine.runAll();

      const final = getStateSnapshot();
      expect(final.negativeProbe).toEqual({
        outcome: "accepted",
        status: 200,
      });
      // It stops at the token step — the bad token is never used on the MCP
      // server.
      expect(final.currentStep).toBe("received_access_token");
    });

    it("clears a prior probe outcome on reset", async () => {
      const { machine, getStateSnapshot } = buildRunnerHarness({
        registrationId: "app_1",
        failTokenProxy: true,
        negativeTestMode: "unknown_kid",
      });

      await machine.runAll();
      expect(getStateSnapshot().negativeProbe).toBeDefined();

      machine.resetFlow();

      // Merge-based updates would otherwise retain the stale terminal outcome.
      expect(getStateSnapshot().negativeProbe).toBeUndefined();
      expect(getStateSnapshot().currentStep).toBe("idle");
    });
  });

  describe("discovery is a fallback, not a mandatory step", () => {
    const idToken = makeJwt(
      { iss: "https://issuer.example/api/web/xaa", sub: "user-12345" },
      { alg: "RS256", typ: "JWT", kid: "xaa-idp-1" }
    );
    const idJag = makeJwt({
      iss: "https://issuer.example/api/web/xaa",
      sub: "user-12345",
      aud: "https://auth.example.com",
      resource: "https://mcp.example.com/mcp",
      client_id: "mcpjam-debugger",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    function tokenAndMcpExecutor() {
      const externalUrls: string[] = [];
      const executor = {
        externalRequest: vi.fn(async (url: string) => {
          externalUrls.push(url);
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
      return { executor, externalUrls };
    }

    it("skips resource AND AS discovery for a registration-backed run", async () => {
      let state: XAAFlowState = createInitialXAAFlowState({
        serverUrl: "https://mcp.example.com/mcp",
        authzServerIssuer: "https://auth.example.com",
        clientId: "mcpjam-debugger",
      });
      const { executor, externalUrls } = tokenAndMcpExecutor();
      const machine = createXAAStateMachine({
        getState: () => state,
        updateState: (u) => {
          state = { ...state, ...u };
        },
        serverUrl: "https://mcp.example.com/mcp",
        issuerBaseUrl: "https://issuer.example/api/web/xaa",
        requestExecutor: executor,
        clientId: "mcpjam-debugger",
        authzServerIssuer: "https://auth.example.com",
        registrationId: "app_1",
      });

      await machine.runAll();

      expect(state.currentStep).toBe("complete");
      // No protected-resource or auth-server metadata probe was ever fired.
      expect(
        externalUrls.some((u) => u.includes("oauth-protected-resource"))
      ).toBe(false);
      expect(
        externalUrls.some((u) => u.includes("oauth-authorization-server"))
      ).toBe(false);
    });

    it("skips resource discovery when the issuer is configured but still discovers the token endpoint", async () => {
      let state: XAAFlowState = createInitialXAAFlowState({
        serverUrl: "https://mcp.example.com/mcp",
        authzServerIssuer: "https://auth.example.com",
        clientId: "mcpjam-debugger",
      });
      const externalUrls: string[] = [];
      const executor = {
        externalRequest: vi.fn(async (url: string) => {
          externalUrls.push(url);
          if (url.includes("oauth-authorization-server")) {
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
            body: {},
            ok: true,
          };
        }),
        internalRequest: vi.fn(async () => ({
          status: 200,
          statusText: "OK",
          headers: {},
          body: { id_token: idToken },
          ok: true,
        })),
      };
      const machine = createXAAStateMachine({
        getState: () => state,
        updateState: (u) => {
          state = { ...state, ...u };
        },
        serverUrl: "https://mcp.example.com/mcp",
        issuerBaseUrl: "https://issuer.example/api/web/xaa",
        requestExecutor: executor,
        clientId: "mcpjam-debugger",
        authzServerIssuer: "https://auth.example.com",
      });

      // idle -> (skip resource) -> received_resource_metadata
      await machine.proceedToNextStep();
      expect(state.currentStep).toBe("received_resource_metadata");
      expect(
        externalUrls.some((u) => u.includes("oauth-protected-resource"))
      ).toBe(false);

      // received_resource_metadata -> AS discovery (RFC 8414) actually runs
      await machine.proceedToNextStep();
      expect(state.currentStep).toBe("received_authz_metadata");
      expect(state.tokenEndpoint).toBe("https://auth.example.com/oauth/token");
      expect(
        externalUrls.some((u) => u.includes("oauth-authorization-server"))
      ).toBe(true);
    });

    it("falls back to the root protected-resource form when path-insertion 404s", async () => {
      let state: XAAFlowState = createInitialXAAFlowState({
        serverUrl: "https://mcp.example.com/mcp",
      });
      const externalUrls: string[] = [];
      const executor = {
        externalRequest: vi.fn(async (url: string) => {
          externalUrls.push(url);
          // Path-insertion form 404s; only the root form is served.
          if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
            return {
              status: 404,
              statusText: "Not Found",
              headers: {},
              body: {},
              ok: false,
            };
          }
          if (url.endsWith("/.well-known/oauth-protected-resource")) {
            return {
              status: 200,
              statusText: "OK",
              headers: {},
              body: {
                resource: "https://mcp.example.com/mcp",
                authorization_servers: ["https://auth.example.com"],
              },
              ok: true,
            };
          }
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: {},
            ok: true,
          };
        }),
        internalRequest: vi.fn(),
      };
      const machine = createXAAStateMachine({
        getState: () => state,
        updateState: (u) => {
          state = { ...state, ...u };
        },
        serverUrl: "https://mcp.example.com/mcp",
        issuerBaseUrl: "https://issuer.example/api/web/xaa",
        requestExecutor: executor,
      });

      await machine.proceedToNextStep();

      expect(state.currentStep).toBe("received_resource_metadata");
      expect(state.authzServerIssuer).toBe("https://auth.example.com");
      // Both forms were attempted, path-insertion first.
      expect(externalUrls).toEqual([
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        "https://mcp.example.com/.well-known/oauth-protected-resource",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Dynamic client-identity strategies
// ---------------------------------------------------------------------------

const DCR_SECRET = "dcr-minted-secret-value-123";
const REGISTRATION_ENDPOINT = "https://auth.example.com/oauth/register";

interface DynamicHarnessOptions {
  strategy: "dcr" | "cimd";
  authzMetadataExtras?: Record<string, any>;
  registerResponse?: {
    status: number;
    body: any;
    headers?: Record<string, string>;
  };
  cimdResponse?: {
    status: number;
    body: any;
    headers?: Record<string, string>;
  };
  cache?: Map<string, XaaEphemeralDcrCredentials>;
  registrationId?: string;
}

function createDynamicHarness(options: DynamicHarnessOptions) {
  const cache = options.cache ?? new Map<string, XaaEphemeralDcrCredentials>();
  const cacheSet = vi.fn((key: string, value: XaaEphemeralDcrCredentials) => {
    cache.set(key, value);
  });

  let state: XAAFlowState = createInitialXAAFlowState({
    serverUrl: "https://mcp.example.com",
    userId: "user-12345",
    email: "demo.user@example.com",
    scope: "read:tools",
    registrationStrategy: options.strategy,
  });

  const externalCalls: Array<{ url: string; init?: any }> = [];
  const internalCalls: Array<{ path: string; init?: any }> = [];

  const registerResponse = options.registerResponse ?? {
    status: 201,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: {
      client_id: "minted-client",
      client_secret: DCR_SECRET,
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_post",
      client_name: "MCPJam XAA Debugger",
      grant_types: [
        "urn:ietf:params:oauth:grant-type:token-exchange",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      authorization_grant_profiles_supported: [
        "urn:ietf:params:oauth:grant-profile:id-jag",
      ],
    },
  };

  const cimdResponse = options.cimdResponse ?? {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      client_id: XAA_DEBUG_CLIENT_ID_METADATA_URL,
      client_name: "MCPJam XAA Debugger",
      grant_types: [
        "urn:ietf:params:oauth:grant-type:token-exchange",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      authorization_grant_profiles_supported: [
        "urn:ietf:params:oauth:grant-profile:id-jag",
      ],
      token_endpoint_auth_method: "none",
    },
  };

  const executor = {
    externalRequest: vi.fn(async (url: string, init?: any) => {
      externalCalls.push({ url, init });
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
            registration_endpoint: REGISTRATION_ENDPOINT,
            ...(options.authzMetadataExtras ?? {}),
          },
          ok: true,
        };
      }
      if (url === REGISTRATION_ENDPOINT) {
        return {
          status: registerResponse.status,
          statusText: "",
          headers: registerResponse.headers ?? {},
          body: registerResponse.body,
          ok: registerResponse.status >= 200 && registerResponse.status < 300,
        };
      }
      if (url === XAA_DEBUG_CLIENT_ID_METADATA_URL) {
        return {
          status: cimdResponse.status,
          statusText: "",
          headers: cimdResponse.headers ?? {},
          body: cimdResponse.body,
          ok: cimdResponse.status >= 200 && cimdResponse.status < 300,
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
    internalRequest: vi.fn(async (path: string, init?: any) => {
      internalCalls.push({ path, init });
      if (path === "/authenticate") {
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          body: {
            id_token: makeJwt(
              { iss: "https://issuer.example/api/web/xaa", sub: "user-12345" },
              { alg: "RS256", typ: "JWT", kid: "xaa-idp-1" }
            ),
          },
          ok: true,
        };
      }
      if (path === "/token-exchange") {
        const body = JSON.parse(init.body);
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          body: {
            id_jag: makeJwt({
              iss: "https://issuer.example/api/web/xaa",
              sub: "user-12345",
              aud: "https://auth.example.com",
              resource: "https://mcp.example.com",
              client_id: body.clientId,
              exp: Math.floor(Date.now() / 1000) + 300,
              scope: "read:tools",
            }),
          },
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
    userId: "user-12345",
    email: "demo.user@example.com",
    scope: "read:tools",
    registrationStrategy: options.strategy,
    registrationId: options.registrationId,
    dcrCredentialCache: {
      get: (key) => cache.get(key),
      set: cacheSet,
      delete: (key) => {
        cache.delete(key);
      },
    },
    dcrCacheTargetKey: "target-1",
  });

  return {
    machine,
    getState: () => state,
    executor,
    externalCalls,
    internalCalls,
    cache,
    cacheSet,
    registerCalls: () =>
      externalCalls.filter((call) => call.url === REGISTRATION_ENDPOINT),
    cimdFetches: () =>
      externalCalls.filter(
        (call) => call.url === XAA_DEBUG_CLIENT_ID_METADATA_URL
      ),
    proxyTokenBody: () => {
      const call = internalCalls.find((entry) => entry.path === "/proxy/token");
      return call ? JSON.parse(call.init.body) : undefined;
    },
    tokenExchangeBody: () => {
      const call = internalCalls.find(
        (entry) => entry.path === "/token-exchange"
      );
      return call ? JSON.parse(call.init.body) : undefined;
    },
  };
}

describe("open dcr registration strategy", () => {
  it("registers, then completes the flow with the minted client", async () => {
    const harness = createDynamicHarness({ strategy: "dcr" });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("complete");
    expect(state.clientId).toBe("minted-client");
    expect(state.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(harness.registerCalls()).toHaveLength(1);

    // The ID-JAG mint and the redemption both carry the minted identity.
    expect(harness.tokenExchangeBody().clientId).toBe("minted-client");
    const proxyBody = harness.proxyTokenBody();
    expect(proxyBody.clientId).toBe("minted-client");
    expect(proxyBody.clientSecret).toBe(DCR_SECRET);
    expect(proxyBody.tokenEndpointAuthMethod).toBe("client_secret_post");

    // The raw secret lives ONLY in the session cache and the outbound
    // internal request — never in any serialized flow state surface.
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(DCR_SECRET);
    expect(serialized).not.toContain(DCR_SECRET.substring(0, 10));
    const registrationEntry = (state.httpHistory || []).find(
      (entry) => entry.step === "request_client_registration"
    );
    expect(registrationEntry?.response?.status).toBe(201);
    expect(registrationEntry?.response?.body.client_secret).toBe(
      "***REDACTED***"
    );
    // The logged /proxy/token request masks the secret.
    const proxyEntry = (state.httpHistory || []).find(
      (entry) => entry.step === "jwt_bearer_request"
    );
    expect(proxyEntry?.request.body.clientSecret).toBe(CLIENT_SECRET_MASK);
  });

  it("continues as a public client with a posture warning when the method is none", async () => {
    const harness = createDynamicHarness({
      strategy: "dcr",
      registerResponse: {
        status: 201,
        headers: { "content-type": "application/json" },
        body: {
          client_id: "public-client",
          token_endpoint_auth_method: "none",
        },
      },
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("complete");
    expect(
      state.registrationWarnings?.some((w) => w.code === "public_client")
    ).toBe(true);
    const proxyBody = harness.proxyTokenBody();
    expect(proxyBody.clientSecret).toBeUndefined();
    expect(proxyBody.tokenEndpointAuthMethod).toBe("none");
  });

  it("records echo warnings but continues when metadata is omitted", async () => {
    const harness = createDynamicHarness({
      strategy: "dcr",
      registerResponse: {
        status: 200,
        headers: {},
        body: {
          client_id: "echoless-client",
          client_secret: DCR_SECRET,
          token_endpoint_auth_method: "client_secret_post",
        },
      },
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("complete");
    const codes = (state.registrationWarnings || []).map((w) => w.code);
    expect(codes).toContain("profile_metadata_not_echoed");
    expect(codes).toContain("grant_types_not_echoed");
    expect(codes).toContain("missing_secret_expiry");
    expect(codes).toContain("non_201_success");
  });

  it("parks when grant_types explicitly omits the JWT Bearer grant", async () => {
    const harness = createDynamicHarness({
      strategy: "dcr",
      registerResponse: {
        status: 201,
        headers: { "content-type": "application/json" },
        body: {
          client_id: "no-bearer-client",
          client_secret: DCR_SECRET,
          token_endpoint_auth_method: "client_secret_post",
          grant_types: ["authorization_code"],
        },
      },
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("request_client_registration");
    expect(state.error).toContain("JWT Bearer");
    expect(state.dcrRetryMayCreateDuplicate).toBe(true);
    expect(
      harness.internalCalls.some((c) => c.path === "/authenticate")
    ).toBe(false);
  });

  it("parks on an unusable client-auth method as a debugger limitation", async () => {
    const harness = createDynamicHarness({
      strategy: "dcr",
      registerResponse: {
        status: 201,
        headers: { "content-type": "application/json" },
        body: {
          client_id: "pkjwt-client",
          token_endpoint_auth_method: "private_key_jwt",
        },
      },
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("request_client_registration");
    expect(state.error).toContain("debugger limitation");
  });

  it("parks on refusal and gates the retry behind duplicate-client confirmation", async () => {
    const harness = createDynamicHarness({
      strategy: "dcr",
      registerResponse: {
        status: 403,
        headers: {},
        body: { error: "access_denied" },
      },
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("request_client_registration");
    expect(state.error).toContain("open Dynamic Client Registration");
    expect(state.dcrRetryMayCreateDuplicate).toBe(true);
    expect(harness.registerCalls()).toHaveLength(1);
    expect(
      harness.internalCalls.some((c) => c.path === "/authenticate")
    ).toBe(false);

    // Ordinary Continue must NOT POST again while the flag is set...
    await harness.machine.proceedToNextStep();
    expect(harness.registerCalls()).toHaveLength(1);

    // ...but clearing it (the confirmed "Register another client" path)
    // allows exactly one new POST.
    harness.machine.updateState({
      dcrRetryMayCreateDuplicate: false,
      error: undefined,
    });
    await harness.machine.proceedToNextStep();
    expect(harness.registerCalls()).toHaveLength(2);
  });

  it("parks cleanly when no registration_endpoint is advertised", async () => {
    const harness = createDynamicHarness({
      strategy: "dcr",
      authzMetadataExtras: { registration_endpoint: undefined },
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("request_client_registration");
    expect(state.error).toContain("registration_endpoint");
    expect(harness.registerCalls()).toHaveLength(0);
  });

  it("reuses the session registration instead of POSTing again", async () => {
    const cache = new Map<string, XaaEphemeralDcrCredentials>();
    const first = createDynamicHarness({ strategy: "dcr", cache });
    await first.machine.runAll();
    expect(first.registerCalls()).toHaveLength(1);

    const second = createDynamicHarness({ strategy: "dcr", cache });
    await second.machine.runAll();
    const state = second.getState();

    expect(state.currentStep).toBe("complete");
    expect(state.dcrRegistrationReused).toBe(true);
    expect(second.registerCalls()).toHaveLength(0);
    expect(second.proxyTokenBody().clientSecret).toBe(DCR_SECRET);
  });

  it("discards an expired cached registration and registers again", async () => {
    const cache = new Map<string, XaaEphemeralDcrCredentials>();
    cache.set(`target-1::${REGISTRATION_ENDPOINT}`, {
      clientId: "expired-client",
      clientSecret: "expired-secret",
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecretExpiresAt: Math.floor(Date.now() / 1000) - 60,
      registrationEndpoint: REGISTRATION_ENDPOINT,
    });
    const harness = createDynamicHarness({ strategy: "dcr", cache });
    await harness.machine.runAll();

    expect(harness.registerCalls()).toHaveLength(1);
    expect(harness.getState().clientId).toBe("minted-client");
  });

  it("is forced to pre_registered when a registrationId is present", async () => {
    const harness = createDynamicHarness({
      strategy: "dcr",
      registrationId: "reg-1",
    });
    // Behavior, not just the flag: at received_authz_metadata the machine
    // goes straight to IdP authentication — no registration POST is issued.
    for (let index = 0; index < 3; index += 1) {
      await harness.machine.proceedToNextStep();
    }
    expect(harness.registerCalls()).toHaveLength(0);
    expect(
      harness.internalCalls.some((call) => call.path === "/authenticate")
    ).toBe(true);
  });

  it("parks the token request when the session credentials are gone", async () => {
    const cache = new Map<string, XaaEphemeralDcrCredentials>();
    const harness = createDynamicHarness({ strategy: "dcr", cache });
    // Register, authenticate, exchange, inspect — then wipe the cache before
    // redemption (simulates a lost session cache mid-run).
    for (let index = 0; index < 5; index += 1) {
      await harness.machine.proceedToNextStep();
    }
    cache.clear();
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("jwt_bearer_request");
    expect(state.error).toContain("no longer available");
    expect(
      harness.internalCalls.some((c) => c.path === "/proxy/token")
    ).toBe(false);
  });
});

describe("cimd registration strategy", () => {
  const CIMD_SUPPORTED = { client_id_metadata_document_supported: true };

  it("preflights the hosted document and completes with the URL identity", async () => {
    const harness = createDynamicHarness({
      strategy: "cimd",
      authzMetadataExtras: CIMD_SUPPORTED,
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("complete");
    expect(state.clientId).toBe(XAA_DEBUG_CLIENT_ID_METADATA_URL);
    expect(state.tokenEndpointAuthMethod).toBe("none");
    expect(
      state.registrationWarnings?.some((w) => w.code === "public_client")
    ).toBe(true);

    // Exactly one preflight GET, with manual redirect handling.
    const fetches = harness.cimdFetches();
    expect(fetches).toHaveLength(1);
    expect(fetches[0].init.redirect).toBe("manual");

    // The ID-JAG claim and redemption both carry the exact URL, no secret.
    expect(harness.tokenExchangeBody().clientId).toBe(
      XAA_DEBUG_CLIENT_ID_METADATA_URL
    );
    const proxyBody = harness.proxyTokenBody();
    expect(proxyBody.clientId).toBe(XAA_DEBUG_CLIENT_ID_METADATA_URL);
    expect(proxyBody.clientSecret).toBeUndefined();
    expect(proxyBody.tokenEndpointAuthMethod).toBe("none");

    // CIMD never touches the DCR credential cache.
    expect(harness.cacheSet).not.toHaveBeenCalled();
    expect(harness.getState().dcrRetryMayCreateDuplicate).toBeUndefined();
  });

  it("parks before any fetch when the AS does not advertise CIMD support", async () => {
    const absent = createDynamicHarness({ strategy: "cimd" });
    await absent.machine.runAll();
    expect(absent.getState().currentStep).toBe(
      "fetch_client_metadata_document"
    );
    expect(absent.getState().error).toContain("does not advertise");
    expect(absent.cimdFetches()).toHaveLength(0);

    const explicit = createDynamicHarness({
      strategy: "cimd",
      authzMetadataExtras: { client_id_metadata_document_supported: false },
    });
    await explicit.machine.runAll();
    expect(explicit.getState().error).toContain("explicitly");
    expect(explicit.cimdFetches()).toHaveLength(0);
  });

  it("parks on a redirect and retries freely without a confirmation gate", async () => {
    const harness = createDynamicHarness({
      strategy: "cimd",
      authzMetadataExtras: CIMD_SUPPORTED,
      cimdResponse: {
        status: 302,
        headers: { location: "https://elsewhere.example/doc.json" },
        body: null,
      },
    });
    await harness.machine.runAll();
    const state = harness.getState();

    expect(state.currentStep).toBe("fetch_client_metadata_document");
    expect(state.error).toContain("redirect");
    expect(state.dcrRetryMayCreateDuplicate).toBeUndefined();

    await harness.machine.proceedToNextStep();
    expect(harness.cimdFetches()).toHaveLength(2);
  });

  it("parks when the document's client_id is not exactly the URL", async () => {
    const harness = createDynamicHarness({
      strategy: "cimd",
      authzMetadataExtras: CIMD_SUPPORTED,
      cimdResponse: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          client_id: `${XAA_DEBUG_CLIENT_ID_METADATA_URL}?v=2`,
          grant_types: [
            "urn:ietf:params:oauth:grant-type:token-exchange",
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ],
          authorization_grant_profiles_supported: [
            "urn:ietf:params:oauth:grant-profile:id-jag",
          ],
          token_endpoint_auth_method: "none",
        },
      },
    });
    await harness.machine.runAll();
    expect(harness.getState().error).toContain("exactly equal");
  });

  it("parks on a shared-secret auth method as a malformed document", async () => {
    const harness = createDynamicHarness({
      strategy: "cimd",
      authzMetadataExtras: CIMD_SUPPORTED,
      cimdResponse: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          client_id: XAA_DEBUG_CLIENT_ID_METADATA_URL,
          grant_types: [
            "urn:ietf:params:oauth:grant-type:token-exchange",
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ],
          authorization_grant_profiles_supported: [
            "urn:ietf:params:oauth:grant-profile:id-jag",
          ],
          token_endpoint_auth_method: "client_secret_post",
        },
      },
    });
    await harness.machine.runAll();
    expect(harness.getState().error).toContain("malformed");
  });

  it("parks when the document omits the required grants (no echo tolerance)", async () => {
    const harness = createDynamicHarness({
      strategy: "cimd",
      authzMetadataExtras: CIMD_SUPPORTED,
      cimdResponse: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          client_id: XAA_DEBUG_CLIENT_ID_METADATA_URL,
          token_endpoint_auth_method: "none",
        },
      },
    });
    await harness.machine.runAll();
    expect(harness.getState().error).toContain("insufficient");
  });
});
