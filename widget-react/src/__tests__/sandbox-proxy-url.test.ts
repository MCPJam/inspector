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

describe("resolveSandboxProxyUrl — per-server view origins", () => {
  const LABEL = "0123456789abcdef";
  const CHROME =
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  const SAFARI =
    "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

  function hosted(overrides: Record<string, unknown> = {}) {
    return new URL(
      resolveSandboxProxyUrl({
        hostedMode: true,
        sandboxOrigin: "https://sandbox.mcpjam.test",
        location: locationOf(APP_ORIGIN),
        viewOriginLabel: LABEL,
        viewSubdomainsEnabled: true,
        userAgent: CHROME,
        ...overrides,
      })
    ).origin;
  }

  it("prefixes the sandbox host with the label", () => {
    expect(hosted()).toBe(`https://${LABEL}.sandbox.mcpjam.test`);
  });

  it("stays on the shared origin when the deploy has not enabled it", () => {
    // Off means off: without wildcard DNS and a certificate, a labelled host
    // does not resolve and every widget would fail to load.
    expect(hosted({ viewSubdomainsEnabled: false })).toBe(
      "https://sandbox.mcpjam.test"
    );
  });

  it("stays on the shared origin without a label", () => {
    expect(hosted({ viewOriginLabel: undefined })).toBe(
      "https://sandbox.mcpjam.test"
    );
  });

  it("ignores a label this code did not derive", () => {
    // The label reaches the browser through a server response. Anything but
    // the exact derived shape could name a host we do not control.
    for (const bogus of [
      "evil.example.com",
      "0123456789ABCDEF",
      "0123456789abcde",
      "0123456789abcdef0",
      "../etc",
      "",
    ]) {
      expect(hosted({ viewOriginLabel: bogus })).toBe(
        "https://sandbox.mcpjam.test"
      );
    }
  });

  it("labels *.localhost in local dev, keeping the port", () => {
    const url = new URL(
      resolveSandboxProxyUrl({
        hostedMode: false,
        sandboxOrigin: "",
        location: locationOf("http://localhost:5173"),
        viewOriginLabel: LABEL,
        viewSubdomainsEnabled: true,
        userAgent: CHROME,
      })
    );
    // The local swap lands on 127.0.0.1, which has no subdomains — so the
    // label goes on `localhost`, which Chromium resolves to loopback.
    expect(url.origin).toBe(`http://${LABEL}.localhost:5173`);
  });

  it("keeps the plain host on a browser that will not resolve *.localhost", () => {
    // Safari does not. A view that simply fails to load is worse than one
    // sharing an origin, so local dev degrades instead.
    const url = new URL(
      resolveSandboxProxyUrl({
        hostedMode: false,
        sandboxOrigin: "",
        location: locationOf("http://localhost:5173"),
        viewOriginLabel: LABEL,
        viewSubdomainsEnabled: true,
        userAgent: SAFARI,
      })
    );
    expect(url.origin).toBe("http://127.0.0.1:5173");
  });

  it("still points at the proxy path", () => {
    const url = new URL(
      resolveSandboxProxyUrl({
        hostedMode: true,
        sandboxOrigin: "https://sandbox.mcpjam.test",
        location: locationOf(APP_ORIGIN),
        viewOriginLabel: LABEL,
        viewSubdomainsEnabled: true,
        userAgent: CHROME,
      })
    );
    expect(url.pathname).toBe(PROXY_PATH);
    expect(url.searchParams.get("v")).toBeTruthy();
  });
});
