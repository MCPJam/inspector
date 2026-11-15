/**
 * The MCPJam API surface the deployment process tests exercise, served from a
 * loopback recorder: just enough of each route for a CLI command or SDK entry
 * point to finish, so a test can assert which server every request went to.
 */
import type { ServerResponse } from "node:http";
import { json, type RecordedRequest, type Route } from "./deployment-fixtures.js";

export const PROJECT_ID = "project_a";
export const ME = { id: "user_a", email: "dev@a.example.test", name: "Dev" };

/** A saved client `runWithClient` can run on the hosted rail. */
const SAVED_CLIENT = {
  id: "client_a",
  name: "client a",
  configId: "config_a",
  versionId: "version_a",
  versionNumber: 1,
  ownerScope: null,
  config: {
    hostStyle: "claude",
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: "Answer briefly.",
    temperature: 0,
    requireToolApproval: false,
    respectToolVisibility: true,
    serverIds: [],
    clientCapabilities: {},
    hostContext: {},
    connectionDefaults: {},
  },
};

const RUN = {
  suiteId: "suite_a",
  runId: "eval_run_a",
  status: "completed",
  result: "passed",
  summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
};

function body(request: RecordedRequest): Record<string, unknown> {
  return request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {};
}

function anthropicMessage(response: ServerResponse): void {
  json(response, 200, {
    id: "msg_a",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: "Hi from A." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
  });
}

/** Project-scoped writes, dispatched on what follows the project id. */
function projectWrite(origin: () => string): Route {
  return (request, response) => {
    const path = new URL(request.path, "http://fixture").pathname;
    const sent = body(request);
    if (path.endsWith("/eval-ingest/start-run")) {
      return json(response, 200, {
        ok: true,
        runStartId: sent.runStartId,
        organizationId: "org_a",
        projectId: PROJECT_ID,
      });
    }
    if (path.endsWith("/eval-ingest/pay-iteration")) {
      return json(response, 200, { ok: true, ...sent, paymentId: sent.iterationKey });
    }
    if (path.endsWith("/eval-ingest/capabilities")) {
      return json(response, 200, { capabilities: {} });
    }
    if (path.endsWith("/eval-ingest/report") || path.endsWith("/eval-ingest/runs/finalize")) {
      return json(response, 200, RUN);
    }
    if (path.endsWith("/eval-ingest/runs/start")) {
      return json(response, 200, { ...RUN, status: "running", result: "pending" });
    }
    if (path.endsWith("/eval-ingest/runs/iterations")) {
      const results = Array.isArray(sent.results) ? sent.results.length : 0;
      return json(response, 200, { inserted: results, skipped: 0, total: results });
    }
    if (path.includes("/conformance-ingest/")) {
      return json(response, 200, { runId: "conformance_run_a" });
    }
    if (path.endsWith("/model-leases/revoke")) {
      return json(response, 200, { ok: true });
    }
    if (path.endsWith("/model-leases")) {
      return json(response, 200, {
        lease: "lease_a",
        protocol: "anthropic",
        proxyBaseUrl: `${origin()}/model-proxy/anthropic`,
        expiresAt: Date.now() + 30 * 60_000,
        runId: "lease_run_a",
      });
    }
    return json(response, 404, { code: "NOT_FOUND", message: `No fixture for ${path}` });
  };
}

/** The routes for one fake MCPJam server whose own origin is `origin()`. */
export function fakeMcpjamRoutes(origin: () => string): Record<string, Route> {
  return {
    "GET /api/v1/me": (_request, response) => json(response, 200, ME),
    "GET /api/v1/projects": (_request, response) =>
      json(response, 200, {
        items: [{ id: PROJECT_ID, name: "Default", organizationId: "org_a", updatedAt: 1 }],
        nextCursor: null,
      }),
    "POST /api/v1/projects/*": projectWrite(origin),
    "GET /api/v1/projects/*": (request, response) =>
      request.path.includes("/clients/")
        ? json(response, 200, SAVED_CLIENT)
        : json(response, 404, { code: "NOT_FOUND", message: "No fixture" }),
    "POST /api/v1/browser-sessions/*": (_request, response) =>
      json(response, 200, { sessions: [] }),
    "POST /model-proxy/anthropic/v1/messages": (_request, response) =>
      anthropicMessage(response),
    "GET /api/cli/auth/config": (_request, response) =>
      json(response, 200, {
        issuer: `${origin()}/issuer`,
        clientId: "client_a",
        authStartUrl: `${origin()}/authorize`,
        tokenEndpoint: `${origin()}/oauth/token`,
        redirectUri: `${origin()}/cli/callback`,
      }),
    "POST /oauth/token": (_request, response) =>
      json(response, 200, {
        access_token: "login-token-a",
        refresh_token: "refresh-a",
        expires_in: 3600,
      }),
  };
}
