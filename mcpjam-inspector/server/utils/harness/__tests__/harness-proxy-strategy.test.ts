import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPubliclyReachableUrl } from "../../localhost-check.js";
import { resolveWebAuthorizedHarnessStrategy } from "../harness-proxy-strategy.js";

describe("isPubliclyReachableUrl", () => {
  it("accepts genuinely public origins", () => {
    expect(isPubliclyReachableUrl("https://app.mcpjam.com")).toBe(true);
    expect(isPubliclyReachableUrl("https://x.tunnels.mcpjam.com")).toBe(true);
    expect(isPubliclyReachableUrl("http://8.8.8.8:6274")).toBe(true);
  });

  it("rejects every non-routable host (not just loopback)", () => {
    for (const url of [
      "http://localhost:6274",
      "http://127.0.0.1:6274",
      "http://[::1]:6274",
      "http://0.0.0.0:6274",
      "http://192.168.1.20:6274", // RFC1918
      "http://10.0.0.5:6274", // RFC1918
      "http://172.16.4.4:6274", // RFC1918
      "http://172.31.255.1", // RFC1918 upper bound
      "http://169.254.1.1", // link-local
      "http://100.64.0.1", // CGNAT 100.64/10
      "http://100.127.255.1", // CGNAT upper bound
      "http://198.18.0.1", // benchmarking 198.18/15
      "http://224.0.0.1", // multicast
      "http://240.0.0.1", // reserved
      "http://203.0.113.7", // TEST-NET-3 (documentation)
      "http://192.0.2.5", // TEST-NET-1
      "http://my-box.local", // mDNS
      "not a url",
    ]) {
      expect(isPubliclyReachableUrl(url), url).toBe(false);
    }
  });

  it("does not treat 172.15/172.32 as private (outside 172.16/12)", () => {
    expect(isPubliclyReachableUrl("http://172.15.0.1")).toBe(true);
    expect(isPubliclyReachableUrl("http://172.32.0.1")).toBe(true);
  });
});

describe("resolveWebAuthorizedHarnessStrategy", () => {
  const ENV_KEYS = ["MCPJAM_INSPECTOR_PUBLIC_URL", "BASE_URL"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("DIRECT when a publicly-reachable URL is configured", () => {
    process.env.MCPJAM_INSPECTOR_PUBLIC_URL = "https://app.mcpjam.com";
    expect(resolveWebAuthorizedHarnessStrategy()).toEqual({
      plane: "web-authorized",
      mode: "direct",
      publicBaseUrl: "https://app.mcpjam.com",
    });
  });

  it("RELAY when no URL is configured (private inspector, e.g. dev:hosted)", () => {
    expect(resolveWebAuthorizedHarnessStrategy()).toEqual({
      plane: "web-authorized",
      mode: "relay",
    });
  });

  it("RELAY when the configured URL is loopback (would be unreachable direct)", () => {
    process.env.BASE_URL = "http://localhost:6274";
    expect(resolveWebAuthorizedHarnessStrategy()).toEqual({
      plane: "web-authorized",
      mode: "relay",
    });
  });

  it("RELAY when BASE_URL is a private/RFC1918 address (never wrongly direct)", () => {
    process.env.BASE_URL = "http://192.168.1.50:6274";
    expect(resolveWebAuthorizedHarnessStrategy()).toEqual({
      plane: "web-authorized",
      mode: "relay",
    });
  });
});
