import { probeMcpServer } from "../src/server-probe.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("probeMcpServer", () => {
  it("reports a ready streamable HTTP server from a raw initialize request", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url === serverUrl) {
        return jsonResponse({
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "mock-server", version: "1.0.0" },
            capabilities: { tools: {} },
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({ error: "missing" }, 404);
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn,
    });

    expect(result.status).toBe("ready");
    expect(result.transport.selected).toBe("streamable-http");
    expect(result.initialize?.protocolVersion).toBe("2025-11-25");
    expect(result.initialize?.serverInfo).toEqual({
      name: "mock-server",
      version: "1.0.0",
    });
    expect(result.oauth.required).toBe(false);
    expect(result.oauth.optional).toBe(false);
  });

  it("detects OAuth metadata and supported registration methods", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url === serverUrl) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
          scopes_supported: ["openid", "profile", "mcp"],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
        });
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      protocolVersion: "2025-11-25",
      fetchFn,
    });

    expect(result.status).toBe("oauth_required");
    expect(result.oauth.required).toBe(true);
    expect(result.oauth.resourceMetadataUrl).toBe(resourceMetadataUrl);
    expect(result.oauth.authorizationServerMetadataUrl).toBe(
      `${authServerUrl}/.well-known/oauth-authorization-server`
    );
    expect(result.oauth.registrationStrategies).toEqual([
      "preregistered",
      "dcr",
      "cimd",
    ]);
  });

  it("uses modern path-insertion AS discovery (no root fallback) for 2026-07-28 + path issuer", async () => {
    // Regression guard: 2026-07-28 must share the 2025-11-25 AS-metadata
    // discovery (path insertion, NO root fallback for path-containing issuers).
    // Before the fix, 2026 fell through to the older branch that adds a root
    // fallback URL the spec forbids.
    //
    // The metadata succeeds ONLY on a modern-branch-exclusive candidate (the
    // OIDC path-APPENDING URL) and 404s the shared path-insertion URL, so the
    // loop must advance past the first candidate to where the two branches
    // diverge: the modern branch tries path-appending next, the old branch
    // requests the root fallback. This is what makes the guard actually fail
    // on the un-fixed code — succeeding on path-insertion (candidate #1 in
    // BOTH branches) would pass either way and guard nothing.
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com/tenant1"; // path-containing
    const pathInsertionUrl =
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1";
    // Modern-branch-only candidate (OIDC path appending); absent from the old
    // branch, which would reach the root fallback instead.
    const pathAppendOidcUrl =
      "https://auth.example.com/tenant1/.well-known/openid-configuration";
    const rootFallbackUrl =
      "https://auth.example.com/.well-known/oauth-authorization-server";
    const requested: string[] = [];

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === serverUrl) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
        });
      }
      if (url === pathAppendOidcUrl) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      // Everything else (including path-insertion) 404s, forcing the loop to
      // advance to the branch-divergence point.
      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      protocolVersion: "2026-07-28",
      fetchFn,
    });

    // Resolved via the modern path-appending candidate...
    expect(result.oauth.authorizationServerMetadataUrl).toBe(pathAppendOidcUrl);
    // ...and the shared path-insertion candidate was tried first (proving we
    // advanced past candidate #1)...
    expect(requested).toContain(pathInsertionUrl);
    // ...but the root fallback (old-branch candidate #2) was NEVER requested.
    // On the un-fixed code this assertion fails.
    expect(requested).not.toContain(rootFallbackUrl);
  });

  it("retries transient probe failures and preserves attempts across retries", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    let initializeCalls = 0;

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url !== serverUrl) {
        return jsonResponse({ error: "unexpected" }, 404);
      }

      initializeCalls += 1;
      if (initializeCalls === 1) {
        throw Object.assign(new Error("connect timeout"), {
          code: "ETIMEDOUT",
        });
      }

      return jsonResponse(
        {
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "mock-server", version: "1.0.0" },
            capabilities: { tools: {} },
          },
        },
        200,
        {}
      );
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: "token",
      fetchFn,
      retryPolicy: {
        retries: 1,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("ready");
    expect(initializeCalls).toBe(2);
    expect(result.transport.attempts).toHaveLength(2);
    expect(result.transport.attempts[0]?.error).toContain("timeout");
  });

  it("does not retry oauth_required responses", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    let initializeCalls = 0;

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url === serverUrl) {
        initializeCalls += 1;
        return new Response(null, { status: 401 });
      }

      return jsonResponse({ error: "missing" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn,
      retryPolicy: {
        retries: 3,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("oauth_required");
    expect(initializeCalls).toBe(1);
  });

  it("does not retry reachable transport mismatch responses", async () => {
    const serverUrl = "https://mcp.example.com/mcp";

    const fetchFn: typeof fetch = jest.fn(async (_input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonResponse({ error: "unsupported" }, 415);
      }

      return jsonResponse({ error: "missing" }, 404, {
        "Content-Type": "application/json",
      });
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: "token",
      fetchFn,
      retryPolicy: {
        retries: 3,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("reachable");
    expect(result.transport.attempts).toHaveLength(2);
  });

  it("does not retry deterministic probe failures", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const fetchFn: typeof fetch = jest.fn(async () => {
      throw new TypeError("malformed request");
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn,
      retryPolicy: {
        retries: 3,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("error");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.transport.attempts).toHaveLength(1);
  });

  // MCP requires 401 here. A CDN/WAF, and a server treating anonymous access as
  // a scope failure, answer 403 — and the challenge on it names everything
  // discovery needs, so the probe reads it as OAuth rather than a broken server.
  describe("403 carrying a Bearer challenge", () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const buildFetch = (
      initialize: Response,
      onUnexpected: (url: string) => Response = () =>
        jsonResponse({ error: "unexpected" }, 404)
    ): typeof fetch =>
      jest.fn(async (input) => {
        const url = String(input);

        if (url === serverUrl) return initialize.clone();

        if (url === resourceMetadataUrl) {
          return jsonResponse({
            resource: serverUrl,
            authorization_servers: [authServerUrl],
          });
        }

        if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
          return jsonResponse({
            issuer: authServerUrl,
            authorization_endpoint: `${authServerUrl}/authorize`,
            token_endpoint: `${authServerUrl}/token`,
            response_types_supported: ["code"],
          });
        }

        return onUnexpected(url);
      }) as typeof fetch;

    it("reports oauth_required and flags the non-compliant status", async () => {
      const result = await probeMcpServer({
        url: serverUrl,
        fetchFn: buildFetch(
          new Response(null, {
            status: 403,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
            },
          })
        ),
      });

      expect(result.status).toBe("oauth_required");
      expect(result.oauth.required).toBe(true);
      expect(result.oauth.resourceMetadataUrl).toBe(resourceMetadataUrl);
      expect(result.oauth.nonCompliantChallengeStatus).toBe(403);
    });

    it("leaves the status unflagged on a compliant 401", async () => {
      const result = await probeMcpServer({
        url: serverUrl,
        fetchFn: buildFetch(
          new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
            },
          })
        ),
      });

      expect(result.status).toBe("oauth_required");
      expect(result.oauth.nonCompliantChallengeStatus).toBeUndefined();
    });

    it("accepts a Bearer challenge that follows another scheme", async () => {
      const result = await probeMcpServer({
        url: serverUrl,
        fetchFn: buildFetch(
          new Response(null, {
            status: 403,
            headers: {
              "WWW-Authenticate": `Basic realm="x", Bearer resource_metadata="${resourceMetadataUrl}"`,
            },
          })
        ),
      });

      expect(result.status).toBe("oauth_required");
      expect(result.oauth.resourceMetadataUrl).toBe(resourceMetadataUrl);
    });

    it("does not read a resource_metadata belonging to another scheme", async () => {
      const result = await probeMcpServer({
        url: serverUrl,
        fetchFn: buildFetch(
          new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Basic resource_metadata="https://attacker.example.com/prm", Bearer realm="mcp"`,
            },
          })
        ),
      });

      // Falls back to the URL derived from the server, not the Basic pointer.
      expect(result.oauth.resourceMetadataUrl).toBe(resourceMetadataUrl);
    });

    it("does not treat a bare 403 as an auth challenge", async () => {
      const result = await probeMcpServer({
        url: serverUrl,
        fetchFn: buildFetch(jsonResponse({ error: "blocked by WAF" }, 403)),
      });

      expect(result.status).not.toBe("oauth_required");
      expect(result.oauth.required).toBe(false);
    });

    it("does not treat a 403 offering only a non-Bearer scheme as a challenge", async () => {
      const result = await probeMcpServer({
        url: serverUrl,
        fetchFn: buildFetch(
          new Response(null, {
            status: 403,
            headers: { "WWW-Authenticate": 'Basic realm="admin"' },
          })
        ),
      });

      expect(result.status).not.toBe("oauth_required");
    });
  });

  // Both metadata destinations are named by the server under test: the RFC 9728
  // pointer comes from its challenge, and the authorization server comes from
  // the document that pointer reached. The probe runs in MCPJam's hosted
  // backend, so an unguarded hop is an SSRF pivot into the private network.
  describe("metadata destination guard", () => {
    const challenge = (resourceMetadata: string) =>
      new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
        },
      });

    /** Every URL the probe actually requested. */
    const requestedUrls = (fetchFn: unknown) =>
      (fetchFn as jest.Mock).mock.calls.map((call) => String(call[0]));

    it("refuses a challenge pointing at link-local metadata", async () => {
      const serverUrl = "https://mcp.example.com/mcp";
      const internal = "http://169.254.169.254/latest/meta-data/";
      const fetchFn: typeof fetch = jest.fn(async (input) =>
        String(input) === serverUrl
          ? challenge(internal)
          : jsonResponse({ error: "unexpected" }, 404)
      ) as typeof fetch;

      const result = await probeMcpServer({ url: serverUrl, fetchFn });

      expect(result.status).toBe("oauth_required");
      expect(result.oauth.discoveryError).toMatch(/link-local or cloud-metadata/);
      expect(requestedUrls(fetchFn)).not.toContain(internal);
    });

    // `blob:https://host/…` reports the origin of the URL it wraps, so an
    // origin comparison read it as the server's own and skipped the guard.
    it("refuses a blob: pointer wearing the server's origin", async () => {
      const serverUrl = "https://mcp.example.com/mcp";
      const blobUrl = "blob:https://mcp.example.com/8f1d";
      const fetchFn: typeof fetch = jest.fn(async (input) =>
        String(input) === serverUrl
          ? challenge(blobUrl)
          : jsonResponse({ error: "unexpected" }, 404)
      ) as typeof fetch;

      const result = await probeMcpServer({ url: serverUrl, fetchFn });

      expect(result.status).toBe("oauth_required");
      expect(result.oauth.discoveryError).toMatch(/http\(s\)/);
      expect(requestedUrls(fetchFn)).not.toContain(blobUrl);
    });

    it("refuses an authorization server on a private address", async () => {
      const serverUrl = "https://mcp.example.com/mcp";
      const prm =
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
      const fetchFn: typeof fetch = jest.fn(async (input) => {
        const url = String(input);
        if (url === serverUrl) return challenge(prm);
        if (url === prm) {
          return jsonResponse({
            resource: serverUrl,
            authorization_servers: ["http://10.0.0.5/"],
          });
        }
        return jsonResponse({ error: "unexpected" }, 404);
      }) as typeof fetch;

      const result = await probeMcpServer({ url: serverUrl, fetchFn });

      // The document we already fetched is kept; only the second hop is refused.
      expect(result.oauth.resourceMetadata).toBeDefined();
      expect(result.oauth.discoveryError).toMatch(/private\/reserved/);
      expect(
        requestedUrls(fetchFn).some((url) => url.includes("10.0.0.5"))
      ).toBe(false);
    });

    // Following a redirect makes the guard on the requested URL meaningless, so
    // the destination is re-checked against where the response actually landed.
    it("refuses a metadata response redirected to a private address", async () => {
      const serverUrl = "https://mcp.example.com/mcp";
      const prm = "https://metadata.example.com/prm";
      const fetchFn: typeof fetch = jest.fn(async (input) => {
        const url = String(input);
        if (url === serverUrl) return challenge(prm);
        if (url === prm) {
          return new Response(
            JSON.stringify({ resource: serverUrl, authorization_servers: [] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        return jsonResponse({ error: "unexpected" }, 404);
      }) as typeof fetch;

      // Response.url is read-only, so model the redirect the way fetch reports
      // it: the request succeeds but lands on an internal host.
      const redirected: typeof fetch = jest.fn(async (input, init) => {
        const response = await (fetchFn as typeof fetch)(input, init);
        if (String(input) === prm) {
          Object.defineProperty(response, "url", {
            value: "http://192.168.1.10/prm",
          });
        }
        return response;
      }) as typeof fetch;

      const result = await probeMcpServer({
        url: serverUrl,
        fetchFn: redirected,
      });

      expect(result.oauth.discoveryError).toMatch(/private\/reserved/);
      expect(result.oauth.resourceMetadata).toBeUndefined();

      // Refusing to use the document is not enough. `transport.attempts` is
      // returned to the caller — on the hosted API, to whoever called the
      // doctor route — so a recorded response hands over the internal document
      // the guard just rejected.
      const attempt = result.transport.attempts.find(
        (entry) => entry.name === "resource_metadata"
      );
      expect(attempt?.response).toBeUndefined();
      expect(attempt?.error).toMatch(/private\/reserved/);
    });

    it("does not read the body of a response from a refused destination", async () => {
      const serverUrl = "https://mcp.example.com/mcp";
      const prm = "https://metadata.example.com/prm";
      let bodyWasRead = false;

      const fetchFn: typeof fetch = jest.fn(async (input) => {
        const url = String(input);
        if (url === serverUrl) return challenge(prm);
        if (url === prm) {
          const response = jsonResponse({ SECRET: "internal-credentials" });
          const readText = response.text.bind(response);
          Object.defineProperty(response, "text", {
            value: async () => {
              bodyWasRead = true;
              return readText();
            },
          });
          Object.defineProperty(response, "url", {
            value: "http://169.254.169.254/latest/meta-data/",
          });
          return response;
        }
        return jsonResponse({ error: "unexpected" }, 404);
      }) as typeof fetch;

      const result = await probeMcpServer({ url: serverUrl, fetchFn });

      expect(result.oauth.discoveryError).toMatch(/link-local or cloud-metadata/);
      expect(bodyWasRead).toBe(false);
    });

    // The authorization-server loop tries several candidates on one origin, so
    // a refused landing URL must leave every one of them response-less.
    it("records no response for a refused authorization-server hop", async () => {
      const serverUrl = "https://mcp.example.com/mcp";
      const prm =
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
      const authServer = "https://auth.example.com";

      const fetchFn: typeof fetch = jest.fn(async (input) => {
        const url = String(input);
        if (url === serverUrl) return challenge(prm);
        if (url === prm) {
          return jsonResponse({
            resource: serverUrl,
            authorization_servers: [authServer],
          });
        }
        const response = jsonResponse({ issuer: authServer });
        Object.defineProperty(response, "url", {
          value: "http://10.1.2.3/.well-known/oauth-authorization-server",
        });
        return response;
      }) as typeof fetch;

      const result = await probeMcpServer({ url: serverUrl, fetchFn });

      const authAttempts = result.transport.attempts.filter(
        (entry) => entry.name === "authorization_server_metadata"
      );
      expect(authAttempts.length).toBeGreaterThan(0);
      for (const attempt of authAttempts) {
        expect(attempt.response).toBeUndefined();
      }
      expect(result.oauth.authorizationServerMetadata).toBeUndefined();
      // The document already fetched from an allowed origin is still reported.
      expect(result.oauth.resourceMetadata).toBeDefined();
    });

    // The carve-out that keeps the guard from breaking real usage: the origin
    // the caller pointed the probe at is not a pivot, whatever tier it is on.
    it.each([
      ["loopback", "http://127.0.0.1:3000/mcp", "http://127.0.0.1:3000"],
      ["LAN", "http://192.168.1.5:3000/mcp", "http://192.168.1.5:3000"],
    ])(
      "discovers same-origin metadata on a %s server",
      async (_label, serverUrl, origin) => {
        const prm = `${origin}/.well-known/oauth-protected-resource/mcp`;
        const fetchFn: typeof fetch = jest.fn(async (input) => {
          const url = String(input);
          if (url === serverUrl) return challenge(prm);
          if (url === prm) {
            return jsonResponse({
              resource: serverUrl,
              authorization_servers: [origin],
            });
          }
          if (url.startsWith(origin)) {
            return jsonResponse({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              response_types_supported: ["code"],
            });
          }
          return jsonResponse({ error: "unexpected" }, 404);
        }) as typeof fetch;

        const result = await probeMcpServer({ url: serverUrl, fetchFn });

        expect(result.status).toBe("oauth_required");
        expect(result.oauth.resourceMetadataUrl).toBe(prm);
        expect(result.oauth.discoveryError).toBeUndefined();
      }
    );

    // Local dev routinely runs the authorization server on another loopback
    // port. That is cross-origin, so it needs the opt-in the server URL grants.
    it("follows a loopback server to an authorization server on another port", async () => {
      const serverUrl = "http://localhost:3000/mcp";
      const prm =
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp";
      const authServer = "http://localhost:9000";
      const fetchFn: typeof fetch = jest.fn(async (input) => {
        const url = String(input);
        if (url === serverUrl) return challenge(prm);
        if (url === prm) {
          return jsonResponse({
            resource: serverUrl,
            authorization_servers: [authServer],
          });
        }
        if (url.startsWith(authServer)) {
          return jsonResponse({
            issuer: authServer,
            authorization_endpoint: `${authServer}/authorize`,
            token_endpoint: `${authServer}/token`,
            response_types_supported: ["code"],
          });
        }
        return jsonResponse({ error: "unexpected" }, 404);
      }) as typeof fetch;

      const result = await probeMcpServer({ url: serverUrl, fetchFn });

      expect(result.oauth.authorizationServerMetadata).toBeDefined();
      expect(result.oauth.discoveryError).toBeUndefined();
    });

    // A public server must never borrow the loopback opt-in.
    it("refuses a public server steering the probe at loopback", async () => {
      const serverUrl = "https://mcp.example.com/mcp";
      const loopback = "http://127.0.0.1:9000/prm";
      const fetchFn: typeof fetch = jest.fn(async (input) =>
        String(input) === serverUrl
          ? challenge(loopback)
          : jsonResponse({ error: "unexpected" }, 404)
      ) as typeof fetch;

      const result = await probeMcpServer({ url: serverUrl, fetchFn });

      expect(result.oauth.discoveryError).toMatch(/loopback/);
      expect(requestedUrls(fetchFn)).not.toContain(loopback);
    });
  });
});
