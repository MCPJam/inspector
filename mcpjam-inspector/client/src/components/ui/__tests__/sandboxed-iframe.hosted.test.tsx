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
 *   - An origin EQUAL to the app's own counts as unset. It produces the same
 *     same-origin iframe, and the renderer used to walk straight through it
 *     while the client boot guard called the same condition a fault
 *     (INSPECTOR-CLIENT-247) — two definitions of one invariant, disagreeing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { SandboxedIframe } from "@/components/ui/sandboxed-iframe";

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
  vi.restoreAllMocks();
});

// Post-3d-ii-c the component reads `hostedMode` / `sandboxOrigin` as props
// (supplied by `host.surface.*`) instead of importing the inspector
// `@/lib/config` flags, so these contracts are exercised by passing the props
// directly rather than mocking the config module.
describe("SandboxedIframe — hosted-mode sandbox origin", () => {
  beforeEach(() => {
    setLocation("https://app.mcpjam.test");
  });

  it("uses the configured sandboxOrigin, not window.location.origin", async () => {
    const { container } = render(
      <SandboxedIframe
        html={null}
        onMessage={() => {}}
        hostedMode
        sandboxOrigin="https://sandbox.mcpjam.test"
      />
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute("src")!;
    const srcUrl = new URL(src);
    expect(srcUrl.origin).toBe("https://sandbox.mcpjam.test");
    expect(srcUrl.origin).not.toBe(window.location.origin);
    expect(srcUrl.pathname).toBe("/api/web/apps/mcp-apps/sandbox-proxy");
  });

  it("treats an origin equal to the app's own as unset: warns and falls back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(
      <SandboxedIframe
        html={null}
        onMessage={() => {}}
        hostedMode
        sandboxOrigin="https://app.mcpjam.test"
      />
    );
    const srcOrigin = new URL(
      container.querySelector("iframe")!.getAttribute("src")!
    ).origin;
    expect(srcOrigin).toBe(window.location.origin);
    const warnings = warn.mock.calls.map((args) => args.join(" "));
    expect(
      warnings.some((line) => line.includes("VITE_MCPJAM_SANDBOX_ORIGIN"))
    ).toBe(true);
  });

  it("falls back to same-origin and logs a security warning when sandboxOrigin is unset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(
      <SandboxedIframe
        html={null}
        onMessage={() => {}}
        hostedMode
        sandboxOrigin=""
      />
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const srcOrigin = new URL(iframe!.getAttribute("src")!).origin;
    expect(srcOrigin).toBe(window.location.origin);
    expect(warn).toHaveBeenCalled();
    const warnings = warn.mock.calls.map((args) => args.join(" "));
    expect(
      warnings.some((line) => line.includes("VITE_MCPJAM_SANDBOX_ORIGIN"))
    ).toBe(true);
  });
});

describe("SandboxedIframe — local dev origin separation", () => {
  it("keeps the localhost -> 127.0.0.1 swap, port and all", () => {
    setLocation("http://localhost:5173");

    const { container } = render(
      <SandboxedIframe html={null} onMessage={() => {}} />
    );
    const src = new URL(
      container.querySelector("iframe")!.getAttribute("src")!
    );
    expect(src.host).toBe("127.0.0.1:5173");
    expect(src.pathname).toBe("/api/apps/mcp-apps/sandbox-proxy");
    expect(src.searchParams.get("v")).toBeTruthy();
  });

  it("swaps back the other way from 127.0.0.1", () => {
    setLocation("http://127.0.0.1:5173");

    const { container } = render(
      <SandboxedIframe html={null} onMessage={() => {}} />
    );
    const src = new URL(
      container.querySelector("iframe")!.getAttribute("src")!
    );
    expect(src.host).toBe("localhost:5173");
  });
});
