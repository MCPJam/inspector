/**
 * The org agent policy at the HTTP boundary.
 *
 * A malformed 2xx body is not an empty policy. Read that way it becomes
 * "nothing is disabled" — a clean answer the execute route is entitled to
 * spend on, produced by a backend that did not actually answer. It has to
 * surface as unavailability so the route's fail-closed handling applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrgAgentPolicy,
  SlackBackendUnavailable,
} from "../slack-backend.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getOrgAgentPolicy", () => {
  // Restored below: a fake Convex URL left in `process.env` is handed to
  // whichever suite runs next.
  const originalEnv = {
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
  };

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "http://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("rejects a 2xx { ok: false } as an UNAVAILABLE backend, not an empty policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "no_org" }))
    );
    await expect(getOrgAgentPolicy("org_1")).rejects.toBeInstanceOf(
      SlackBackendUnavailable
    );
  });

  it("rejects a malformed disabled-operations list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          disabledOperations: ["run_eval_suite", 42, null, "create_server"],
        })
      )
    );
    await expect(getOrgAgentPolicy("org_1")).rejects.toBeInstanceOf(
      SlackBackendUnavailable
    );
  });

  it("rejects a missing list instead of treating it as empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true }))
    );
    await expect(getOrgAgentPolicy("org_1")).rejects.toBeInstanceOf(
      SlackBackendUnavailable
    );
  });
});
