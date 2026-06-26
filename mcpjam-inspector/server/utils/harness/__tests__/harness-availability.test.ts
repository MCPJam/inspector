import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHarnessRuntimeAvailable } from "../harness-availability";

// The preflight that lets the chat-v2 routes fail closed with a clear message
// when a Claude Code harness host can't actually run on this server.

const ENV_KEYS = [
  "CONVEX_HTTP_URL",
  "COMPUTERS_DATA_PLANE_SECRET",
  "E2B_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setFullyAvailable() {
  // Model credential is NOT an env var anymore (resolved from Convex per turn);
  // the preflight only checks the computers data plane + approval mode.
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
  process.env.COMPUTERS_DATA_PLANE_SECRET = "secret";
  process.env.E2B_API_KEY = "e2b-test";
}

describe("checkHarnessRuntimeAvailable", () => {
  it("is ok when the data plane is configured and approval is off", () => {
    setFullyAvailable();
    expect(
      checkHarnessRuntimeAvailable({ requireToolApproval: false })
    ).toEqual({ ok: true });
  });

  it("fails when the computers data plane is not configured", () => {
    setFullyAvailable();
    delete process.env.E2B_API_KEY;
    const r = checkHarnessRuntimeAvailable({ requireToolApproval: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/computers data plane/);
  });

  it("fails when the host requires interactive tool approval", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable({ requireToolApproval: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tool approval/);
  });
});
