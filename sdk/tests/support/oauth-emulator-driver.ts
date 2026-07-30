/**
 * HP-44 — drive the emulator over real HTTP.
 *
 * Runs MCPJam's OAuth state machine against a real server via
 * `runOAuthStateMachine`, with a real `fetch` executor, and returns the flow
 * record `captureEmulatorTraceFromFlow` consumes.
 *
 * Why not `OAuthConformanceTest`: it does not plumb `allowLoopbackMetadataFetch`
 * through to the state-machine factory, so it cannot talk to a loopback test
 * server at all — the SSRF guard refuses every metadata fetch. That is a real gap
 * for HP-39's "test MCP server in CI" story and is recorded in the coverage doc.
 * The inspector client already opts in the same way (`allowLoopbackMetadataFetch:
 * isLoopbackOAuthUrl(serverUrl)`), so the fix has a precedent to follow.
 *
 * Driving the machine directly is also the shape HP-43 will use: a per-host
 * emulator configured from a host profile has no reason to route through the
 * conformance runner.
 */

import { runOAuthStateMachine } from "../../src/oauth/state-machines/runner.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type { OAuthFlowState } from "../../src/oauth/state-machines/types.js";
import type { EmulatorFlowRecord } from "../../src/oauth-golden-trace/index.js";
import type { CaptureServer } from "./oauth-capture-server.js";

/** A real `fetch`-backed request executor. */
export async function fetchExecutor(request: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  redirect?: "follow" | "manual";
}) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body != null
      ? {
          body:
            typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body),
        }
      : {}),
    redirect: request.redirect === "manual" ? "manual" : "follow",
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON passes through as text; the trace records it as opaque.
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
  };
}

export type RunEmulatorOptions = {
  /** Overrides the DCR body, e.g. to reproduce another host's identity. */
  dynamicRegistration?: Record<string, unknown>;
  redirectUrl?: string;
  serverName?: string;
  protocolVersion?: "2025-03-26" | "2025-06-18" | "2025-11-25" | "2026-07-28";
  registrationStrategy?: "dcr" | "cimd" | "preregistered";
  scopes?: string;
};

export type RunEmulatorResult = {
  flow: EmulatorFlowRecord;
  completed: boolean;
  finalStep: string;
  error?: string;
};

/** Run a full OAuth dance against `server`, following the 302 in place of a browser. */
export async function runEmulatorAgainst(
  server: CaptureServer,
  options: RunEmulatorOptions = {},
): Promise<RunEmulatorResult> {
  const redirectUrl = options.redirectUrl ?? "http://127.0.0.1:33418/callback";
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    serverUrl: server.mcpUrl,
  };

  const run = await runOAuthStateMachine({
    protocolVersion: options.protocolVersion ?? "2025-11-25",
    registrationStrategy: options.registrationStrategy ?? "dcr",
    serverUrl: server.mcpUrl,
    serverName: options.serverName ?? "hp44capture",
    redirectUrl,
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    // `client_name` is mandatory for the DCR strategy — the machine throws
    // without it — so a default stands in when the caller isn't reproducing
    // another host's identity.
    dynamicRegistration: (options.dynamicRegistration ?? {
      client_name: "MCPJam HP-44 Capture",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }) as never,
    ...(options.scopes ? { customScopes: options.scopes } : {}),
    authMode: "headless",
    // The test server IS loopback; without this every metadata fetch is refused.
    allowLoopbackMetadataFetch: true,
    requestExecutor: fetchExecutor,
    onAuthorizationRequest: async ({ authorizationUrl }) => {
      // Stand in for the browser: follow the 302 and read the code off it.
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      const code = location ? new URL(location).searchParams.get("code") : null;
      if (!code) throw new Error(`no authorization code in redirect: ${location}`);
      return { type: "authorization_code", authorizationCode: code };
    },
  });

  return {
    flow: {
      httpHistory: state.httpHistory ?? [],
      ...(run.authorizationUrl ? { authorizationUrl: run.authorizationUrl } : {}),
    },
    completed: run.completed,
    finalStep: state.currentStep,
    ...(run.error ? { error: run.error.message } : {}),
  };
}
