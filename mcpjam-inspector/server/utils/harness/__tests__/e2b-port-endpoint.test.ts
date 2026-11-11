import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveE2BPortEndpoint } from "../e2b-port-endpoint.js";

const sandbox = {
  sandboxId: "sbx_1",
  getHost: (port: number) => `${port}-sbx_1.e2b.app`,
};
afterEach(() => vi.unstubAllEnvs());

describe("E2B bridge endpoints", () => {
  it("retains hosted URLs without a proxy", () => {
    vi.stubEnv("E2B_SANDBOX_URL", "");
    expect(resolveE2BPortEndpoint(sandbox, 8080, "ws")).toEqual({
      url: "wss://8080-sbx_1.e2b.app",
    });
  });

  it.each([
    ["http://10.0.0.2:3002", "ws://10.0.0.2:3002/"],
    ["https://sandboxes.example.test", "wss://sandboxes.example.test/"],
  ])("routes WebSockets through %s", (proxy, expected) => {
    vi.stubEnv("E2B_SANDBOX_URL", proxy);
    expect(resolveE2BPortEndpoint(sandbox, 8080, "ws")).toEqual({
      url: expected,
      headers: { "E2b-Sandbox-Id": "sbx_1", "E2b-Sandbox-Port": "8080" },
    });
  });

  it.each(["", "https://sandboxes.example.test"])(
    "refuses private endpoints before resolving a route (%s)",
    (proxy) => {
      vi.stubEnv("E2B_SANDBOX_URL", proxy);
      const getHost = vi.fn();
      for (const privateState of [
        { privateAppPorts: true },
        { trafficAccessToken: "traffic-token" },
      ]) {
        for (const protocol of ["https", "ws"]) {
          expect(() =>
            resolveE2BPortEndpoint(
              { ...sandbox, ...privateState, getHost },
              8080,
              protocol,
            ),
          ).toThrow("cannot connect to ports on a private workspace");
        }
      }
      expect(getHost).not.toHaveBeenCalled();
    },
  );

  it("retains HTTP proxy transport for HTTP requests", () => {
    vi.stubEnv("E2B_SANDBOX_URL", "http://10.0.0.2:3002");
    expect(resolveE2BPortEndpoint(sandbox, 8080).url).toBe(
      "http://10.0.0.2:3002/",
    );
  });

  it.each([
    "broken",
    "file:///etc/passwd",
    "https://user:secret@proxy.test",
    "https://proxy.test/?key=secret",
    "https://proxy.test/#secret",
  ])("rejects invalid proxy configuration without reflecting it", (proxy) => {
    vi.stubEnv("E2B_SANDBOX_URL", proxy);
    expect(() => resolveE2BPortEndpoint(sandbox, 8080)).toThrow(
      /^E2B_SANDBOX_URL must be/,
    );
    try {
      resolveE2BPortEndpoint(sandbox, 8080);
    } catch (error) {
      expect(String(error)).not.toContain(proxy);
    }
  });
});
