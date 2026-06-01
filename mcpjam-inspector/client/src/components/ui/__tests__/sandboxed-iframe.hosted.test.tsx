/**
 * Pins the hosted-mode sandbox-origin contract on SandboxedIframe (the
 * load-bearing renderer post-consolidation — both MCP-Apps and ChatGPT-Apps
 * widgets flow through it via the window.openai compat shim).
 *
 *   - When `SANDBOX_ORIGIN` is configured, the iframe MUST point at that
 *     distinct origin, NOT at `window.location.origin`. This is the
 *     isolation property — without it the sandbox shares cookies and
 *     storage with the host app despite `allow-same-origin`.
 *   - When `SANDBOX_ORIGIN` is unset, hosted mode falls back to same-origin
 *     and MUST log a clear security warning. The fallback exists only as
 *     a soft-fail for misconfigured deploys; the warning is the signal that
 *     prevents silent regression.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const ORIGINAL_LOCATION = window.location;

function setLocation(origin: string): void {
  const url = new URL(origin);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...ORIGINAL_LOCATION,
      hostname: url.hostname,
      port: url.port,
      protocol: url.protocol,
      origin: url.origin,
      href: `${url.origin}/`,
    },
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: ORIGINAL_LOCATION,
  });
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/config");
});

describe("SandboxedIframe — hosted-mode sandbox origin", () => {
  beforeEach(() => {
    setLocation("https://app.mcpjam.test");
  });

  it("uses the configured SANDBOX_ORIGIN, not window.location.origin", async () => {
    vi.doMock("@/lib/config", () => ({
      HOSTED_MODE: true,
      SANDBOX_ORIGIN: "https://sandbox.mcpjam.test",
      SANITIZE_OAUTH_TRACES: true,
      NON_PROD_LOCKDOWN: false,
      EMPLOYEE_EMAIL_DOMAINS: [],
      isAllowedEmployeeEmail: () => false,
    }));
    const { SandboxedIframe } = await import(
      "@/components/ui/sandboxed-iframe"
    );

    const { container } = render(
      <SandboxedIframe html={null} onMessage={() => {}} />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute("src")!;
    const srcUrl = new URL(src);
    expect(srcUrl.origin).toBe("https://sandbox.mcpjam.test");
    expect(srcUrl.origin).not.toBe(window.location.origin);
    expect(srcUrl.pathname).toBe("/api/web/apps/mcp-apps/sandbox-proxy");
  });

  it("falls back to same-origin and logs a security warning when SANDBOX_ORIGIN is unset", async () => {
    vi.doMock("@/lib/config", () => ({
      HOSTED_MODE: true,
      SANDBOX_ORIGIN: null,
      SANITIZE_OAUTH_TRACES: true,
      NON_PROD_LOCKDOWN: false,
      EMPLOYEE_EMAIL_DOMAINS: [],
      isAllowedEmployeeEmail: () => false,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { SandboxedIframe } = await import(
      "@/components/ui/sandboxed-iframe"
    );

    const { container } = render(
      <SandboxedIframe html={null} onMessage={() => {}} />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const srcOrigin = new URL(iframe!.getAttribute("src")!).origin;
    expect(srcOrigin).toBe(window.location.origin);
    expect(warn).toHaveBeenCalled();
    const warnings = warn.mock.calls.map((args) => args.join(" "));
    expect(
      warnings.some((line) => line.includes("VITE_MCPJAM_SANDBOX_ORIGIN")),
    ).toBe(true);
  });
});
