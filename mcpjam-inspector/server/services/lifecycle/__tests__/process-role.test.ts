import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerCanRunClaims,
  resolveProcessRole,
} from "../process-role.js";

describe("resolveProcessRole", () => {
  it("does both halves when unset", () => {
    expect(resolveProcessRole({})).toBe("all");
    expect(resolveProcessRole({ MCPJAM_PROCESS_ROLE: "  " })).toBe("all");
  });

  it.each([
    ["web", "web"],
    [" Worker ", "worker"],
    ["ALL", "all"],
  ])("reads %j as %s", (value, role) => {
    expect(resolveProcessRole({ MCPJAM_PROCESS_ROLE: value })).toBe(role);
  });

  it("fails the boot on a role it does not know", () => {
    expect(() => resolveProcessRole({ MCPJAM_PROCESS_ROLE: "wroker" })).toThrow(
      'MCPJAM_PROCESS_ROLE must be one of all, web, worker; got "wroker".',
    );
  });
});

describe("assertWorkerCanRunClaims", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "https://app.mcpjam.com");
    vi.stubEnv("BASE_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts a hosted worker that can claim and reach the public origin", () => {
    expect(() => assertWorkerCanRunClaims(true)).not.toThrow();
  });

  it("names everything a hosted worker is missing", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", " ");
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "");

    expect(() => assertWorkerCanRunClaims(true)).toThrow(
      "MCPJAM_PROCESS_ROLE=worker needs CONVEX_HTTP_URL, INSPECTOR_SERVICE_TOKEN, MCPJAM_INSPECTOR_PUBLIC_URL set to the web tier's public https origin.",
    );
  });

  it.each(["http://app.mcpjam.com", "https://10.0.0.5", "https://localhost"])(
    "refuses a hosted worker whose public origin is %s",
    (origin) => {
      vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", origin);

      expect(() => assertWorkerCanRunClaims(true)).toThrow(
        /public https origin/,
      );
    },
  );

  it("lets a self-hosted worker relay to its own listener", () => {
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "");

    expect(() => assertWorkerCanRunClaims(false)).not.toThrow();
  });
});
