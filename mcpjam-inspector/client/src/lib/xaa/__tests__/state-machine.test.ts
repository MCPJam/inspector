import { describe, expect, it, vi } from "vitest";
import { CLIENT_SECRET_MASK, createXAAStateMachine } from "../state-machine";
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
