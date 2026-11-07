import { describe, expect, it } from "vitest";
import { resolveServerConnectionSettings } from "@/lib/client-connection-resolve";
import type { HostConfigConnectionDefaults } from "@/lib/client-config-v2";

/**
 * `connectionDefaults.requestTimeout` is a REQUIRED number on the host config,
 * so it is never nullish. Any precedence rule that reads it before the server's
 * own timeout makes that server timeout unreachable — which is exactly how
 * issue #3671 escaped: the per-server "Connection overrides" timeout was stored,
 * echoed back in the form, and then silently discarded on every connect.
 */
const HOST_DEFAULTS: HostConfigConnectionDefaults = {
  headers: {},
  requestTimeout: 10_000,
};

describe("resolveServerConnectionSettings — timeout precedence", () => {
  it("prefers the server's own timeout over the host-wide default", () => {
    const resolved = resolveServerConnectionSettings(
      { timeout: 120_000 },
      HOST_DEFAULTS,
      undefined,
    );

    expect(resolved.timeout).toBe(120_000);
  });

  it("prefers a per-server requestTimeoutOverride over the server's own timeout", () => {
    const resolved = resolveServerConnectionSettings(
      { timeout: 120_000 },
      HOST_DEFAULTS,
      { requestTimeoutOverride: 45_000 },
    );

    expect(resolved.timeout).toBe(45_000);
  });

  it("falls back to the host-wide default when the server sets no timeout", () => {
    const resolved = resolveServerConnectionSettings(
      {},
      { headers: {}, requestTimeout: 30_000 },
      undefined,
    );

    expect(resolved.timeout).toBe(30_000);
  });
});

describe("resolveServerConnectionSettings — header precedence", () => {
  it("layers server headers under host defaults under the per-server override", () => {
    const resolved = resolveServerConnectionSettings(
      { headers: { "X-Server": "server", "X-Shared": "server" } },
      { headers: { "X-Host": "host", "X-Shared": "host" }, requestTimeout: 10_000 },
      { headersOverride: { "X-Override": "override", "X-Shared": "override" } },
    );

    expect(resolved.headers).toEqual({
      "X-Server": "server",
      "X-Host": "host",
      "X-Override": "override",
      "X-Shared": "override",
    });
  });

  it("deduplicates colliding header names case-insensitively with higher precedence layers winning", () => {
    const resolved = resolveServerConnectionSettings(
      { headers: { "x-shared": "server", "X-Server-Only": "server" } },
      {
        headers: { "X-Shared": "host", "x-host-colliding": "host-lower" },
        requestTimeout: 10_000,
      },
      { headersOverride: { "X-Host-Colliding": "override-upper" } },
    );

    expect(resolved.headers).toEqual({
      "X-Server-Only": "server",
      "X-Shared": "host",
      "X-Host-Colliding": "override-upper",
    });
    expect(new Headers(resolved.headers).get("x-shared")).toBe("host");
    expect(new Headers(resolved.headers).get("x-host-colliding")).toBe(
      "override-upper",
    );
  });
});
