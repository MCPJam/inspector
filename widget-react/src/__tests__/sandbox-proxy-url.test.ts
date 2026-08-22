/**
 * The distinct-origin check in front of the sandbox iframe.
 *
 * The check is only worth what its comparison is worth: `location.origin` is
 * canonical, so a configured value that spells the same origin differently —
 * a trailing slash, an upper-case host, an explicit default port — has to be
 * canonicalized before it is compared, and before it is spliced into the proxy
 * URL. Every miss here is a same-origin "sandbox" that looks configured.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveSandboxProxyUrl } from "../sandboxed-iframe";

const APP_ORIGIN = "https://app.mcpjam.test";
const PROXY_PATH = "/api/web/apps/mcp-apps/sandbox-proxy";

function locationOf(origin: string) {
  const url = new URL(origin);
  return {
    hostname: url.hostname,
    port: url.port,
    protocol: url.protocol,
    origin: url.origin,
  };
}

function resolve(sandboxOrigin: string, appOrigin = APP_ORIGIN): string {
  return resolveSandboxProxyUrl({
    hostedMode: true,
    sandboxOrigin,
    location: locationOf(appOrigin),
  });
}

describe("resolveSandboxProxyUrl — a distinct origin", () => {
  it("uses it as given", () => {
    const url = new URL(resolve("https://sandbox.mcpjam.test"));
    expect(url.origin).toBe("https://sandbox.mcpjam.test");
    expect(url.pathname).toBe(PROXY_PATH);
  });

  it("canonicalizes it, so a trailing slash does not double up the path", () => {
    const url = new URL(resolve("https://sandbox.mcpjam.test/"));
    expect(url.origin).toBe("https://sandbox.mcpjam.test");
    expect(url.pathname).toBe(PROXY_PATH);
  });
});

describe("resolveSandboxProxyUrl — the app's own origin, however spelled", () => {
  it.each([
    ["exactly", APP_ORIGIN],
    ["with a trailing slash", `${APP_ORIGIN}/`],
    ["in mixed case", "https://App.MCPJam.test"],
    ["with the default port spelled out", "https://app.mcpjam.test:443"],
  ])("counts as unset when written %s", (_label, sandboxOrigin) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(new URL(resolve(sandboxOrigin)).origin).toBe(APP_ORIGIN);
    expect(
      warn.mock.calls
        .map((args) => args.join(" "))
        .some((line) => line.includes("VITE_MCPJAM_SANDBOX_ORIGIN"))
    ).toBe(true);

    warn.mockRestore();
  });
});

describe("resolveSandboxProxyUrl — a value that is no origin at all", () => {
  it.each([
    ["unparseable", "sandbox.mcpjam.test"],
    ["a scheme no iframe can load", "javascript:void 0"],
    ["empty", ""],
  ])("falls back with the warning when it is %s", (_label, sandboxOrigin) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(new URL(resolve(sandboxOrigin)).origin).toBe(APP_ORIGIN);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});

describe("resolveSandboxProxyUrl — local dev", () => {
  it("keeps the localhost <-> 127.0.0.1 swap, port and all", () => {
    const url = new URL(
      resolveSandboxProxyUrl({
        hostedMode: false,
        sandboxOrigin: "",
        location: locationOf("http://localhost:5173"),
      })
    );
    expect(url.host).toBe("127.0.0.1:5173");
    expect(url.pathname).toBe("/api/apps/mcp-apps/sandbox-proxy");
  });
});
