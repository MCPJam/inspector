/**
 * The org agent policy at the HTTP boundary.
 *
 * The interesting case is a 2xx body that says `{ ok: false }`. Read as an
 * empty policy it becomes "nothing is disabled" — a clean answer the execute
 * route is entitled to spend on, produced by a backend that just told us it
 * could not answer. It has to surface as unavailability so the route's
 * fail-closed handling applies, and that difference is invisible in normal
 * operation, so it is pinned here.
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

  it("returns the disabled operations, dropping anything that is not a string", async () => {
    // The list is a wire payload, so the filter has to be a real check: a
    // non-string reaching the disabled set would be compared against tool
    // names and silently match nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          disabledOperations: ["run_eval_suite", 42, null, "create_server"],
        })
      )
    );
    await expect(getOrgAgentPolicy("org_1")).resolves.toEqual({
      disabledOperations: ["run_eval_suite", "create_server"],
    });
  });

  it("treats a missing list as nothing disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true }))
    );
    await expect(getOrgAgentPolicy("org_1")).resolves.toEqual({
      disabledOperations: [],
    });
  });
});
