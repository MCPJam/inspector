/**
 * The intrusive gate.
 *
 * These probes register a client at someone's authorization server, spend a
 * refresh token and deliberately burn it, and drive a real tool call. Run by
 * accident — on a schedule, across a directory feed, against a production
 * tenant — they are indistinguishable from an attack. So the gate is the
 * product, and every one of these tests is about a way in that must be closed.
 *
 * The defence is structural rather than conventional: the probes require an
 * armed mode, and an armed mode can only be produced by
 * `resolveClaudeIntrusiveMode`. A call site cannot opt in by passing a flag it
 * invented, and a future surface that forgets to check gets a refusal instead
 * of a silent registration.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  gradeClaudeIntrusiveObservations,
  probeDynamicRegistration,
  probeRefreshRotation,
  probeStepUpChallenge,
  resolveClaudeIntrusiveMode,
  type ClaudeIntrusiveMode,
} from "../../src/claude-readiness/intrusive.js";
import { gatherClaudeReadinessEvidence } from "../../src/claude-readiness/gather.js";
import { gradeClaudeReadiness } from "../../src/claude-readiness/runner.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };
const NO_BORROWED = { hasBorrowedAccessToken: false };

function armed(
  overrides: Parameters<typeof resolveClaudeIntrusiveMode>[0] = {
    enabled: true,
    grantOrigin: "dedicated-test-account",
    testCredentials: { clientId: "test-client" },
  },
): Extract<ClaudeIntrusiveMode, { enabled: true }> {
  const mode = resolveClaudeIntrusiveMode(overrides, NO_BORROWED);
  if (!mode.enabled) throw new Error(`expected an armed mode: ${mode.reason}`);
  return mode;
}

describe("the gate is closed by default", () => {
  it("refuses when no config is supplied at all", () => {
    const mode = resolveClaudeIntrusiveMode(undefined, NO_BORROWED);
    expect(mode.enabled).toBe(false);
  });

  it("refuses a truthy non-boolean `enabled`", () => {
    // `enabled: "false"` out of a YAML file or a query string must not arm
    // client registration against a stranger's server.
    for (const value of ["true", "false", 1, {}] as unknown[]) {
      const mode = resolveClaudeIntrusiveMode(
        { enabled: value as boolean, grantOrigin: "self-acquired" },
        NO_BORROWED,
      );
      expect(mode.enabled).toBe(false);
      if (!mode.enabled) expect(mode.reason).toMatch(/as a boolean/);
    }
  });

  it("refuses without an explicit grant origin", () => {
    const mode = resolveClaudeIntrusiveMode({ enabled: true }, NO_BORROWED);
    expect(mode.enabled).toBe(false);
    if (!mode.enabled) expect(mode.reason).toMatch(/grantOrigin/);
  });

  it("refuses a dedicated-account origin with no client id", () => {
    const mode = resolveClaudeIntrusiveMode(
      { enabled: true, grantOrigin: "dedicated-test-account" },
      NO_BORROWED,
    );
    expect(mode.enabled).toBe(false);
  });
});

describe("borrowed credentials are refused outright", () => {
  it("will not treat a token supplied for ordinary operation as self-acquired", () => {
    // Burning a refresh token that belongs to a live user session logs them out
    // of a product they were using. No readiness grade is worth that.
    const mode = resolveClaudeIntrusiveMode(
      { enabled: true, grantOrigin: "self-acquired" },
      { hasBorrowedAccessToken: true },
    );
    expect(mode.enabled).toBe(false);
    if (!mode.enabled) expect(mode.reason).toMatch(/borrowed grant/);
  });

  it("still allows a dedicated test account alongside a borrowed token", () => {
    // The caller owns those credentials; the borrowed one is simply not used.
    const mode = resolveClaudeIntrusiveMode(
      {
        enabled: true,
        grantOrigin: "dedicated-test-account",
        testCredentials: { clientId: "test-client" },
      },
      { hasBorrowedAccessToken: true },
    );
    expect(mode.enabled).toBe(true);
  });
});

describe("the step-up probe needs a declared target", () => {
  it("refuses a tool name with no expected scopes", () => {
    const mode = resolveClaudeIntrusiveMode(
      {
        enabled: true,
        grantOrigin: "dedicated-test-account",
        testCredentials: { clientId: "c" },
        protectedToolName: "delete_everything",
      },
      NO_BORROWED,
    );
    expect(mode.enabled).toBe(false);
    if (!mode.enabled) expect(mode.reason).toMatch(/expectedScopes/);
  });

  it("never calls a tool that was not declared", () => {
    const findings = gradeClaudeIntrusiveObservations(armed(), {}, STAMP);
    const stepUp = findings.find(
      (f) => f.id === "claude.intrusive.step-up-challenge",
    )!;
    expect(stepUp.status).toBe("not-evaluated");
    expect(stepUp.notEvaluatedReason).toMatch(/arbitrary tool/);
  });
});

describe("a disabled mode grades everything as unevaluated", () => {
  it("reports the refusal reason on every intrusive finding", () => {
    const mode = resolveClaudeIntrusiveMode(undefined, NO_BORROWED);
    const findings = gradeClaudeIntrusiveObservations(mode, {}, STAMP);
    expect(findings).toHaveLength(3);
    for (const finding of findings) {
      expect(finding.status).toBe("not-evaluated");
      expect(finding.notEvaluatedReason).toMatch(/not requested/);
      expect(finding.intrusiveness).toBe("side-effecting");
      expect(finding.requiresCapabilities).toContain("intrusive-probes");
    }
  });
});

describe("the gate is enforced at RUNTIME, not only in the type system", () => {
  // The brand is compile-time only, so it evaporates at the first `as` cast or
  // the first JavaScript caller. Without a runtime comparison, a hand-built
  // object would register an OAuth client at a stranger's server.
  const forged = {
    enabled: true,
    grantOrigin: "dedicated-test-account",
    credentials: { clientId: "c", refreshToken: "rt" },
    cleanup: true,
    authorization: {},
  } as unknown as Extract<ClaudeIntrusiveMode, { enabled: true }>;

  it("refuses a forged mode before registering anything", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      probeDynamicRegistration(forged, {
        fetchFn,
        registrationEndpoint: "https://auth.example.com/register",
        redirectUris: [],
      }),
    ).rejects.toThrow(/resolveClaudeIntrusiveMode/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a forged mode before spending a refresh token", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      probeRefreshRotation(forged, {
        fetchFn,
        tokenEndpoint: "https://auth.example.com/token",
        redirectUris: [],
      }),
    ).rejects.toThrow(/resolveClaudeIntrusiveMode/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a disabled mode cast into the armed shape", async () => {
    const disabled = resolveClaudeIntrusiveMode(undefined, NO_BORROWED);
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      probeDynamicRegistration(
        disabled as Extract<ClaudeIntrusiveMode, { enabled: true }>,
        {
          fetchFn,
          registrationEndpoint: "https://auth.example.com/register",
          redirectUris: [],
        },
      ),
    ).rejects.toThrow(/resolveClaudeIntrusiveMode/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("registration cleanup", () => {
  it("deletes the client through the management URI", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          client_id: "generated",
          registration_client_uri: "https://auth.example.com/register/generated",
          registration_access_token: "rat",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const observation = await probeDynamicRegistration(armed(), {
      fetchFn,
      registrationEndpoint: "https://auth.example.com/register",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });

    expect(observation.cleanedUp).toBe(true);
    expect(calls[1]).toMatchObject({
      url: "https://auth.example.com/register/generated",
      method: "DELETE",
    });
  });

  it("reports a client it could not remove rather than hiding it", async () => {
    // A registration we cannot delete is a client left behind on someone
    // else's server. Silence there would make this tool a slow leak.
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ client_id: "generated" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    const observation = await probeDynamicRegistration(armed(), {
      fetchFn,
      registrationEndpoint: "https://auth.example.com/register",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });

    expect(observation.cleanedUp).toBe(false);
    expect(observation.cleanupError).toMatch(/registration_client_uri/);

    const finding = gradeClaudeIntrusiveObservations(
      armed(),
      { registration: observation },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.dynamic-registration")!;
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/Delete it manually/);
  });

  it("skips cleanup only when the caller turned it off", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            client_id: "generated",
            registration_client_uri: "https://auth.example.com/register/generated",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );

    await probeDynamicRegistration(
      armed({
        enabled: true,
        grantOrigin: "dedicated-test-account",
        testCredentials: { clientId: "c" },
        cleanup: false,
      }),
      {
        fetchFn,
        registrationEndpoint: "https://auth.example.com/register",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not attempt registration when there is no endpoint", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const observation = await probeDynamicRegistration(armed(), {
      fetchFn,
      redirectUris: [],
    });
    expect(observation.attempted).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("refresh rotation and replay", () => {
  const withRefresh = () =>
    armed({
      enabled: true,
      grantOrigin: "dedicated-test-account",
      testCredentials: { clientId: "c", refreshToken: "old-token" },
    });

  it("never runs without a refresh token the run owns", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const observation = await probeRefreshRotation(armed(), {
      fetchFn,
      tokenEndpoint: "https://auth.example.com/token",
      redirectUris: [],
    });
    expect(observation.attempted).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts extra fields alongside error=invalid_grant", async () => {
    // A server that returns `error_description` and `error_uri` beside the
    // code is being informative, not non-conforming.
    const findings = gradeClaudeIntrusiveObservations(
      withRefresh(),
      {
        refresh: {
          attempted: true,
          rotated: true,
          replayStatus: 400,
          replayError: "invalid_grant",
          replayBody: {
            error: "invalid_grant",
            error_description: "token already used",
            error_uri: "https://auth.example.com/errors/invalid_grant",
          },
        },
      },
      STAMP,
    );
    const finding = findings.find(
      (f) => f.id === "claude.intrusive.refresh-rotation",
    )!;
    expect(finding.status).toBe("satisfied");
    expect(finding.details).toMatchObject({
      extraFields: ["error_description", "error_uri"],
    });
  });

  it("requires HTTP 400, not merely an error body", async () => {
    const finding = gradeClaudeIntrusiveObservations(
      withRefresh(),
      {
        refresh: {
          attempted: true,
          rotated: true,
          replayStatus: 200,
          replayError: "invalid_grant",
        },
      },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.refresh-rotation")!;
    expect(finding.status).toBe("violated");
  });

  it("fails a server that never rotates", async () => {
    const finding = gradeClaudeIntrusiveObservations(
      withRefresh(),
      { refresh: { attempted: true, rotated: false, refreshStatus: 200 } },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.refresh-rotation")!;
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/rotation/);
  });

  it("does not blame the server when the probe's own request was rejected", async () => {
    // A confidential client probed without its secret gets `401
    // invalid_client` and no new token — identical on the wire to a server
    // that does not rotate. Grading that as a rotation defect reports a
    // required violation the submitter cannot act on, because it is ours.
    const finding = gradeClaudeIntrusiveObservations(
      withRefresh(),
      {
        refresh: {
          attempted: true,
          rotated: false,
          refreshStatus: 401,
          refreshError: "invalid_client",
        },
      },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.refresh-rotation")!;
    expect(finding.status).toBe("not-evaluated");
    expect(finding.notEvaluatedReason).toMatch(/401/);
    expect(finding.notEvaluatedReason).toMatch(/invalid_client/);
  });

  it("still grades evidence captured before the status was recorded", async () => {
    // An observation with no `refreshStatus` predates the field; treating
    // "not known to have failed" as a failure would silently reclassify old
    // evidence.
    const finding = gradeClaudeIntrusiveObservations(
      withRefresh(),
      { refresh: { attempted: true, rotated: false } },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.refresh-rotation")!;
    expect(finding.status).toBe("violated");
  });

  it("replays the OLD token, which is what proves it was invalidated", async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({ access_token: "a", refresh_token: "new-token" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    const observation = await probeRefreshRotation(withRefresh(), {
      fetchFn,
      tokenEndpoint: "https://auth.example.com/token",
      redirectUris: [],
    });

    expect(observation.rotated).toBe(true);
    expect(observation.replayStatus).toBe(400);
    expect(bodies[0]).toContain("refresh_token=old-token");
    expect(bodies[1]).toContain("refresh_token=old-token");
  });

  it("does not replay when the server did not rotate", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ access_token: "a", refresh_token: "old-token" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await probeRefreshRotation(withRefresh(), {
      fetchFn,
      tokenEndpoint: "https://auth.example.com/token",
      redirectUris: [],
    });
    // Replaying a token the server still considers live would burn a working
    // grant to learn nothing.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("step-up grading", () => {
  const withTool = () =>
    armed({
      enabled: true,
      grantOrigin: "dedicated-test-account",
      testCredentials: { clientId: "c" },
      protectedToolName: "read_private",
      expectedScopes: ["private:read"],
    });

  it("passes a 403 insufficient_scope challenge", () => {
    const finding = gradeClaudeIntrusiveObservations(
      withTool(),
      {
        stepUp: {
          attempted: true,
          toolName: "read_private",
          status: 403,
          wwwAuthenticate: 'Bearer error="insufficient_scope"',
        },
      },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.step-up-challenge")!;
    expect(finding.status).toBe("satisfied");
  });

  it("records the challenged scopes against the ones the run expected", () => {
    // `expectedScopes` is required alongside `protectedToolName` so the run
    // states what it asserts — but nothing compared it, so the requirement
    // produced a config error and no evidence.
    const finding = gradeClaudeIntrusiveObservations(
      withTool(),
      {
        stepUp: {
          attempted: true,
          toolName: "read_private",
          status: 403,
          wwwAuthenticate:
            'Bearer error="insufficient_scope", scope="private:read other:write"',
        },
      },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.step-up-challenge")!;
    expect(finding.details).toMatchObject({
      expectedScopes: ["private:read"],
      challengedScopes: ["private:read", "other:write"],
      scopesOverlapExpectation: true,
    });
  });

  it("does not call an omitted scope a mismatch", () => {
    // `scope` is OPTIONAL on an insufficient_scope challenge; Claude selects
    // from discovery when it is absent. Reporting `false` would read as the
    // server contradicting the run, which it never did.
    const finding = gradeClaudeIntrusiveObservations(
      withTool(),
      {
        stepUp: {
          attempted: true,
          toolName: "read_private",
          status: 403,
          wwwAuthenticate: 'Bearer error="insufficient_scope"',
        },
      },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.step-up-challenge")!;
    expect(finding.status).toBe("satisfied");
    expect(finding.details).toMatchObject({ challengedScopes: [] });
    expect(
      (finding.details as Record<string, unknown>).scopesOverlapExpectation,
    ).toBeUndefined();
  });

  it("fails a bare 403 with no challenge", () => {
    const finding = gradeClaudeIntrusiveObservations(
      withTool(),
      { stepUp: { attempted: true, toolName: "read_private", status: 403 } },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.step-up-challenge")!;
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/insufficient_scope/);
  });

  it("does not fail a server when the supplied token already held the scope", () => {
    // The server was never asked the question: a 2xx means the token was not
    // missing anything, which is a probe misconfiguration and not a defect.
    const finding = gradeClaudeIntrusiveObservations(
      withTool(),
      { stepUp: { attempted: true, toolName: "read_private", status: 200 } },
      STAMP,
    ).find((f) => f.id === "claude.intrusive.step-up-challenge")!;
    expect(finding.status).toBe("not-evaluated");
    expect(finding.notEvaluatedReason).toMatch(/lacks the tool's scope/);
  });
});

describe("the step-up probe, against a real server", () => {
  const LOW_SCOPE = "Bearer low-scope-token";

  async function startScopedServer(): Promise<{
    url: string;
    calls: Array<{ tool?: string; authorization?: string }>;
    close: () => Promise<void>;
  }> {
    const calls: Array<{ tool?: string; authorization?: string }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const send = (status: number, payload: unknown, headers = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== "POST") return send(405, {});
        if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (body.method === "initialize") {
          return send(200, {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s" } },
          });
        }
        if (body.method === "tools/list") {
          return send(200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                { name: "read_private", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
                { name: "wipe_private", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
              ],
            },
          });
        }
        if (body.method === "tools/call") {
          calls.push({ tool: body.params?.name, authorization: req.headers.authorization });
          return send(
            403,
            { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "forbidden" } },
            { "www-authenticate": 'Bearer error="insufficient_scope", scope="private:read"' },
          );
        }
        return send(200, { jsonrpc: "2.0", id: body.id, result: { resources: [] } });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return {
      url,
      calls,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  it("calls the declared read-only tool once with the supplied token and grades the challenge", async () => {
    const server = await startScopedServer();
    try {
      const evidence = await gatherClaudeReadinessEvidence({
        enteredUrl: server.url,
        fetchFn: fetch,
        mcpHeaders: { authorization: LOW_SCOPE },
        capabilities: ["intrusive-probes"],
        intrusive: {
          enabled: true,
          grantOrigin: "dedicated-test-account",
          testCredentials: { clientId: "c" },
          protectedToolName: "read_private",
          expectedScopes: ["private:read"],
        },
      });
      expect(server.calls).toEqual([
        { tool: "read_private", authorization: LOW_SCOPE },
      ]);
      const result = gradeClaudeReadiness(evidence);
      const stepUp = result.findings.find(
        (f) => f.id === "claude.intrusive.step-up-challenge",
      )!;
      expect(stepUp.status).toBe("satisfied");
      expect(stepUp.details).toMatchObject({ scopesOverlapExpectation: true });
      // The same challenge is what the shape check grades.
      expect(
        result.findings.find(
          (f) => f.id === "claude.auth.insufficient-scope-challenge-shape",
        )?.status,
      ).toBe("satisfied");
    } finally {
      await server.close();
    }
  });

  it("refuses a declared tool that is not annotated read-only, calling nothing", async () => {
    const server = await startScopedServer();
    try {
      const observed = await probeStepUpChallenge(
        armed({
          enabled: true,
          grantOrigin: "dedicated-test-account",
          testCredentials: { clientId: "c" },
          protectedToolName: "wipe_private",
          expectedScopes: ["private:write"],
        }),
        { enteredUrl: server.url, fetchFn: fetch, mcpHeaders: { authorization: LOW_SCOPE } },
      );
      expect(observed.attempted).toBe(false);
      expect(observed.error).toMatch(/readOnlyHint: true/);
      expect(server.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("refuses to run without a token to call with", async () => {
    const observed = await probeStepUpChallenge(
      armed({
        enabled: true,
        grantOrigin: "dedicated-test-account",
        testCredentials: { clientId: "c" },
        protectedToolName: "read_private",
        expectedScopes: ["private:read"],
      }),
      { enteredUrl: "http://127.0.0.1:1/mcp", fetchFn: vi.fn() as unknown as typeof fetch, mcpHeaders: {} },
    );
    expect(observed.attempted).toBe(false);
    expect(observed.error).toMatch(/no(ne)? .*supplied/);
  });
});
