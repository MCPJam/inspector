/**
 * Attempt ladder, completion-safe redirects, and the headless preflight runner
 * (HP-43 step 5).
 */
import { deriveOAuthEmulation } from "../../src/oauth/emulation/derive.js";
import { runEmulatedOAuthPreflight } from "../../src/oauth/emulation/preflight.js";
import {
  isInvalidRedirectUriRejection,
  planCompletionSafeRedirects,
} from "../../src/oauth/emulation/redirects.js";
import type { DerivedOAuthEmulation } from "../../src/oauth/emulation/derive.js";
import type { HostConfigOAuthProfileV2 } from "../../src/host-config/internal";
import {
  autoConsent,
  createMockOAuthServer,
} from "../support/mock-oauth-as.js";
import { verified } from "../support/oauth-profiles.js";

const SERVER_URL = "https://mcp-server.example.com/mcp";
const CALLBACK = "http://127.0.0.1:41234/callback";

const profile = (
  fields: Omit<HostConfigOAuthProfileV2, "profileVersion">
): HostConfigOAuthProfileV2 => ({ profileVersion: 2, ...fields });

const derive = (fields: Omit<HostConfigOAuthProfileV2, "profileVersion">) =>
  deriveOAuthEmulation(profile(fields));

describe("attempt ladder derivation", () => {
  it("collapses consecutive oauth2-* entries into one attempt, preserving order", () => {
    const out = derive({
      authModel: verified(["oauth2-cimd", "oauth2-dcr", "oauth2-preregistered"]),
    });
    expect(out.authAttempts).toEqual([
      {
        kind: "oauth",
        registrationPreference: ["cimd", "dcr", "preregistered"],
      },
    ]);
    expect(out.coverage.authModel).toBe("modeled");
  });

  it("keeps api-key in position — static credential first, OAuth after", () => {
    const out = derive({ authModel: verified(["api-key", "oauth2-dcr"]) });
    expect(out.authAttempts).toEqual([
      { kind: "api-key" },
      { kind: "oauth", registrationPreference: ["dcr"] },
    ]);
  });

  it("models a no-auth client as a single `none` rung", () => {
    expect(derive({ authModel: verified(["none"]) }).authAttempts).toEqual([
      { kind: "none" },
    ]);
  });

  it("without authModel evidence falls back to one preference-free oauth attempt", () => {
    const out = derive({});
    expect(out.authAttempts).toEqual([
      { kind: "oauth", registrationPreference: [] },
    ]);
    expect(out.coverage.authModel).toBe("not_modeled");
  });

  it("an empty authModel list never compiles to an empty ladder", () => {
    // The canonicalizer rejects `[]`, but the type cannot say so. Compiling
    // one would produce a run with NO attempts, reported as blocked with
    // nothing to explain it.
    const out = derive({ authModel: verified([] as never) });
    expect(out.authAttempts).toEqual([
      { kind: "oauth", registrationPreference: [] },
    ]);
    expect(out.coverage.authModel).toBe("not_modeled");
  });
});

describe("completion-safe redirects", () => {
  it("appends our callback to the captured list and declares it", () => {
    const plan = planCompletionSafeRedirects({
      capturedRedirectUris: ["cursor://anysphere.cursor-retrieval/callback"],
      callbackUrl: CALLBACK,
    });
    expect(plan.registrationRedirectUris).toEqual([
      "cursor://anysphere.cursor-retrieval/callback",
      CALLBACK,
    ]);
    expect(plan.authorizationRedirectUri).toBe(CALLBACK);
    expect(plan.divergences).toEqual([
      expect.objectContaining({ kind: "redirect-uri-appended" }),
    ]);
  });

  it("declares nothing when there was no capture to diverge from", () => {
    const plan = planCompletionSafeRedirects({ callbackUrl: CALLBACK });
    expect(plan.registrationRedirectUris).toEqual([CALLBACK]);
    expect(plan.divergences).toEqual([]);
  });

  it("does not duplicate or declare when the capture already contains our callback", () => {
    const plan = planCompletionSafeRedirects({
      capturedRedirectUris: [CALLBACK],
      callbackUrl: CALLBACK,
    });
    expect(plan.registrationRedirectUris).toEqual([CALLBACK]);
    expect(plan.divergences).toEqual([]);
  });

  it("retries only on a structured RFC 7591 invalid_redirect_uri", () => {
    expect(
      isInvalidRedirectUriRejection({
        status: 400,
        body: { error: "invalid_redirect_uri" },
      })
    ).toBe(true);
    // Everything else must NOT trigger a second registration.
    expect(
      isInvalidRedirectUriRejection({
        status: 400,
        body: { error: "invalid_client_metadata" },
      })
    ).toBe(false);
    expect(
      isInvalidRedirectUriRejection({
        status: 400,
        body: { error_description: "invalid_redirect_uri somewhere in prose" },
      })
    ).toBe(false);
    expect(isInvalidRedirectUriRejection({ status: 400, body: null })).toBe(
      false
    );
    expect(
      isInvalidRedirectUriRejection({
        status: 400,
        body: "invalid_redirect_uri",
      })
    ).toBe(false);
    expect(isInvalidRedirectUriRejection({ status: 500, body: { error: "invalid_redirect_uri" } })).toBe(false);
    expect(isInvalidRedirectUriRejection({ status: 0, body: { error: "invalid_redirect_uri" } })).toBe(false);
  });

  it("only HTTP 400 spends the retry — no other 4xx may create a second client", () => {
    // RFC 7591 §3.2.2 defines this error as a 400. An auth, routing, or
    // rate-limit rejection carrying the same word is a different failure.
    for (const status of [401, 403, 404, 409, 429]) {
      expect(
        isInvalidRedirectUriRejection({
          status,
          body: { error: "invalid_redirect_uri" },
        })
      ).toBe(false);
    }
    expect(
      isInvalidRedirectUriRejection({
        status: 400,
        body: { error: "invalid_redirect_uri" },
      })
    ).toBe(true);
  });
});

describe("runEmulatedOAuthPreflight — completion", () => {
  it("completes with a real token AND a valid authenticated JSON-RPC result", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("completed");
    expect(result.credentials?.accessToken).toBe("emulated-access-token");
    expect(result.sideEffects).toEqual({
      dcrRegistrations: 1,
      tokensIssued: 1,
    });
    expect(result.comparison.status).toBe("not_compared");
  });

  it("a token without a valid JSON-RPC result is NOT a completion", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const executor: typeof mock.executor = async (request) => {
      const response = await mock.executor(request);
      // Authenticated MCP call returns 200 with a JSON-RPC error body.
      if (
        request.url === SERVER_URL &&
        request.headers.Authorization?.startsWith("Bearer ")
      ) {
        return {
          ...response,
          body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } },
        };
      }
      return response;
    };

    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("error");
    expect(result.attempts[0].detail).toMatch(/valid JSON-RPC result/);
  });

  it("stops at the redirect and reports the URL when no headless handler is given", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
    });

    expect(result.outcome).toBe("stopped_at_redirect");
    expect(result.authorizationUrl).toContain("/authorize");
    expect(result.sideEffects.tokensIssued).toBe(0);
  });
});

describe("runEmulatedOAuthPreflight — attempt ordering and fallback", () => {
  it("uses the static credential when the server accepts it, and never runs OAuth", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      acceptStaticCredential: { headerName: "X-Acme-Key", value: "s3cret" },
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["api-key", "oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      staticCredential: { headerName: "X-Acme-Key", value: "s3cret" },
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("static_credential_ok");
    expect(result.attempts.map((a) => a.kind)).toEqual(["api-key"]);
    expect(result.sideEffects.dcrRegistrations).toBe(0);
  });

  it("falls through to OAuth on a 401 — the evidence-backed fallback", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["api-key", "oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      staticCredential: { headerName: "X-Acme-Key", value: "wrong" },
      completeAuthorization: autoConsent,
    });

    expect(result.attempts.map((a) => `${a.kind}:${a.status}`)).toEqual([
      "api-key:unauthorized",
      "oauth:ok",
    ]);
    expect(result.outcome).toBe("completed");
  });

  it("does NOT fall through on a non-401 static-credential failure", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      unauthenticatedStatus: 500,
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["api-key", "oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      staticCredential: { headerName: "X-Acme-Key", value: "wrong" },
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("error");
    expect(result.attempts.map((a) => a.kind)).toEqual(["api-key"]);
    expect(result.attempts[0].detail).toMatch(/only a 401/);
  });

  it("skips the api-key rung and declares it when no credential is supplied", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["api-key", "oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.attempts[0]).toMatchObject({
      kind: "api-key",
      status: "skipped",
    });
    expect(result.outcome).toBe("completed");
    expect(result.divergences).toContainEqual(
      expect.objectContaining({ kind: "not-enforced" })
    );
  });

  it("`none` against a server that demands auth is the finding, not a fallback", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["none"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.attempts).toEqual([
      expect.objectContaining({ kind: "none", status: "unauthorized" }),
    ]);
    expect(result.sideEffects.dcrRegistrations).toBe(0);
  });

  it("falls through an unusable preferred strategy before anything is committed", async () => {
    // Client prefers pre-registered, but no credentials are configured, so it
    // must fall through to DCR — exactly as a real client would.
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({
        authModel: verified(["oauth2-preregistered", "oauth2-dcr"]),
      }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("completed");
    expect(result.attempts[0].registrationStrategy).toBe("dcr");
    expect(result.sideEffects.dcrRegistrations).toBe(1);
  });

  it("blocks when no preferred mechanism is usable, without registering", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      supportsDcr: false,
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({
        authModel: verified(["oauth2-preregistered", "oauth2-dcr"]),
      }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.sideEffects.dcrRegistrations).toBe(0);
  });
});

describe("runEmulatedOAuthPreflight — registration replay and retry", () => {
  it("registers the captured redirect_uris in order with our callback appended", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({
        authModel: verified(["oauth2-dcr"]),
        dcrIdentity: verified({
          clientName: "Real Client",
          redirectUris: ["zed://oauth", "https://real.example/cb"],
        }),
      }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(mock.registeredRedirectUris[0]).toEqual([
      "zed://oauth",
      "https://real.example/cb",
      CALLBACK,
    ]);
    expect(mock.registrationBodies[0].client_name).toBe("Real Client");
    expect(result.divergences).toContainEqual(
      expect.objectContaining({ kind: "redirect-uri-appended" })
    );
    // The authorization leg still comes back to us, so the flow completes.
    expect(result.outcome).toBe("completed");
  });

  it("re-registers with our callback alone after a structured invalid_redirect_uri", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      rejectRegistration: { attempt: 1 },
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({
        authModel: verified(["oauth2-dcr"]),
        dcrIdentity: verified({ redirectUris: ["zed://oauth"] }),
      }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(mock.registrationBodies).toHaveLength(2);
    expect(mock.registrationBodies[0].redirect_uris).toEqual([
      "zed://oauth",
      CALLBACK,
    ]);
    expect(mock.registrationBodies[1].redirect_uris).toEqual([CALLBACK]);
    expect(result.divergences).toContainEqual(
      expect.objectContaining({ kind: "dcr-retried" })
    );
    expect(result.outcome).toBe("completed");
    // Disclosed side effect: at most two registrations.
    expect(result.sideEffects.dcrRegistrations).toBe(2);
  });

  it("does NOT retry on a rejection that is not a structured invalid_redirect_uri", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      rejectRegistration: {
        attempt: 1,
        body: { error: "invalid_client_metadata" },
      },
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({
        authModel: verified(["oauth2-dcr"]),
        dcrIdentity: verified({ redirectUris: ["zed://oauth"] }),
      }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(mock.registrationBodies).toHaveLength(1);
    expect(result.divergences).not.toContainEqual(
      expect.objectContaining({ kind: "dcr-retried" })
    );
    expect(result.outcome).not.toBe("completed");
  });
});

describe("runEmulatedOAuthPreflight — review regressions", () => {
  it("without authModel evidence, follows AUTO precedence: CIMD when advertised", async () => {
    // Not a hardcoded DCR default — `not_modeled` means normal MCPJam
    // behavior, and normal behavior prefers CIMD on a server that offers it.
    const cimdUrl = "https://cimd.example/client-metadata.json";
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      supportsCimd: true,
      supportsDcr: true,
      clientIdMetadataUrl: cimdUrl,
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({}),
      callbackUrl: CALLBACK,
      clientIdMetadataUrl: cimdUrl,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.attempts[0].registrationStrategy).toBe("cimd");
    expect(mock.registrationBodies).toHaveLength(0);
    expect(result.divergences).toContainEqual(
      expect.objectContaining({ kind: "identity-substituted" })
    );
    expect(result.outcome).toBe("completed");
  });

  it("without authModel evidence, falls back to DCR when CIMD is not advertised", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      supportsCimd: false,
      supportsDcr: true,
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({}),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.attempts[0].registrationStrategy).toBe("dcr");
    expect(result.outcome).toBe("completed");
  });

  it("accepts a valid MCP response delivered as text/event-stream", async () => {
    // Streamable-HTTP servers answer with SSE frames, which the hardened
    // proxy buffers as a raw string. That is still a real MCP answer.
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const executor: typeof mock.executor = async (request) => {
      const response = await mock.executor(request);
      if (
        request.url === SERVER_URL &&
        request.headers.Authorization?.startsWith("Bearer ")
      ) {
        return {
          ...response,
          headers: { "content-type": "text/event-stream" },
          body: `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [] },
          })}\n\n`,
        };
      }
      return response;
    };

    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("completed");
  });

  it("an SSE stream carrying a JSON-RPC error is still not a completion", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const executor: typeof mock.executor = async (request) => {
      const response = await mock.executor(request);
      if (
        request.url === SERVER_URL &&
        request.headers.Authorization?.startsWith("Bearer ")
      ) {
        return {
          ...response,
          headers: { "content-type": "text/event-stream" },
          body: `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "nope" },
          })}\n\n`,
        };
      }
      return response;
    };

    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("error");
  });

  it("a transport failure on a direct rung is recorded, not thrown", async () => {
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["none"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: async () => {
        throw new Error("socket hang up");
      },
    });

    expect(result.outcome).toBe("error");
    expect(result.attempts[0]).toMatchObject({
      kind: "none",
      status: "error",
      detail: "socket hang up",
    });
    expect(result.error?.message).toBe("socket hang up");
  });

  it("blocks a private-network target on the direct rungs too", async () => {
    const mock = createMockOAuthServer({
      serverUrl: "http://169.254.169.254/mcp",
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: "http://169.254.169.254/mcp",
      emulation: derive({ authModel: verified(["none"]) }),
      callbackUrl: CALLBACK,
      // Even with a caller-supplied executor that would happily connect.
      requestExecutor: mock.executor,
    });

    expect(result.outcome).toBe("error");
    expect(mock.requests).toHaveLength(0);
  });

  it("keeps the rejected first registration in the retry's diagnostics", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      rejectRegistration: { attempt: 1 },
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({
        authModel: verified(["oauth2-dcr"]),
        dcrIdentity: verified({ redirectUris: ["zed://oauth"] }),
      }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    // The declared `dcr-retried` divergence must be corroborated by the trace
    // it points at: both registrations are present.
    const registrations = (result.attempts[0].httpHistory ?? []).filter(
      (entry) => entry.step === "request_client_registration"
    );
    expect(registrations).toHaveLength(2);
    expect(registrations[0].response?.status).toBe(400);
  });

  it("counts a token the AS issued even when verification later failed", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const executor: typeof mock.executor = async (request) => {
      const response = await mock.executor(request);
      if (
        request.url === SERVER_URL &&
        request.headers.Authorization?.startsWith("Bearer ")
      ) {
        return { ...response, status: 500, ok: false, body: null };
      }
      return response;
    };

    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).not.toBe("completed");
    // The credential exists on the AS regardless of what happened next.
    expect(result.sideEffects.tokensIssued).toBe(1);
  });

  it("a blocked ladder reports why each strategy was abandoned", async () => {
    // CIMD is advertised but its document is unreachable, and DCR is not
    // advertised: both fall through without committing, and the blocked
    // result must explain both rather than reporting a bare "blocked".
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      supportsCimd: true,
      supportsDcr: false,
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({
        authModel: verified(["oauth2-cimd", "oauth2-dcr"]),
      }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("blocked");
    const attempt = result.attempts[0];
    expect(attempt.detail).toMatch(/cimd:/);
    expect(attempt.detail).toMatch(/dcr:/);
    // The trace that explains it survives the fall-through.
    expect(attempt.httpHistory?.length).toBeGreaterThan(0);
    expect(mock.registrationBodies).toHaveLength(0);
  });

  it("declares that a V1 profile cannot supply captured redirect order", () => {
    const v1 = deriveOAuthEmulation({
      profileVersion: 1,
      dcrIdentity: verified({
        redirectUris: ["https://b.example/cb", "https://a.example/cb"],
      }),
    });
    expect(v1.divergences).toContainEqual(
      expect.objectContaining({ kind: "not-enforced" })
    );
    // V2 preserves order and declares nothing.
    const v2out = derive({
      dcrIdentity: verified({
        redirectUris: ["https://b.example/cb", "https://a.example/cb"],
      }),
    });
    expect(v2out.capturedRedirectUris).toEqual([
      "https://b.example/cb",
      "https://a.example/cb",
    ]);
    expect(v2out.divergences).toEqual([]);
  });
});

describe("runEmulatedOAuthPreflight — diagnostics hygiene", () => {
  it("keeps credentials out of diagnostics and returns them separately", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      issuedClientSecret: "registered-secret-value",
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.credentials?.accessToken).toBe("emulated-access-token");
    expect(result.credentials?.clientSecret).toBe("registered-secret-value");

    // Diagnostics must carry none of it.
    const diagnostics = JSON.stringify(result.attempts);
    expect(diagnostics).not.toContain("emulated-access-token");
    expect(diagnostics).not.toContain("emulated-refresh-token");
    expect(diagnostics).not.toContain("registered-secret-value");
    expect(diagnostics).not.toContain("mock-authorization-code");
  });

  it("redacts an unconventional caller-supplied credential header", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["api-key", "oauth2-dcr"]) }),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      // A header name no generic redactor could know about.
      staticCredential: {
        headerName: "X-Acme-Tenant-Token",
        value: "super-secret-tenant-token",
      },
      completeAuthorization: autoConsent,
    });

    const diagnostics = JSON.stringify(result.attempts);
    expect(diagnostics).not.toContain("super-secret-tenant-token");
    expect(diagnostics).toContain("[REDACTED]");
  });

  it("redacts a static credential from a direct-rung transport error", async () => {
    const secret = "super-secret-tenant-token";
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive({ authModel: verified(["api-key"]) }),
      callbackUrl: CALLBACK,
      staticCredential: {
        headerName: "X-Acme-Tenant-Token",
        value: secret,
      },
      requestExecutor: async () => {
        throw new Error(`socket reset while sending X-Acme-Tenant-Token: ${secret}`);
      },
    });

    expect(result.outcome).toBe("error");
    expect(result.attempts[0].detail).toContain("[REDACTED]");
    expect(result.error?.message).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("runEmulatedOAuthPreflight — coverage and parity", () => {
  it("carries partial coverage through, so parity can never be claimed", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const derived: DerivedOAuthEmulation = derive({
      authModel: verified(["oauth2-dcr"]),
    });
    expect(derived.coverageSummary).toBe("partial");

    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derived,
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    // Three independent dimensions: the run completed, coverage is partial,
    // and no comparison has been made.
    expect(result.outcome).toBe("completed");
    expect(result.coverageSummary).toBe("partial");
    expect(result.coverage.scopeRequest).toBe("not_modeled");
    expect(result.comparison.status).toBe("not_compared");
  });
});
