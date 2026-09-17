import { afterEach, describe, expect, it, vi } from "vitest";
import { guestIpForwardHeaders } from "../guest-spend-ip.js";

describe("guestIpForwardHeaders", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends the hash with the service token that proves it", () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "secret");
    expect(guestIpForwardHeaders("abc")).toEqual({
      "x-mcpjam-guest-ip-hash": "abc",
      "x-inspector-service-token": "secret",
    });
  });

  it("sends nothing without a token, since Convex would ignore the hash", () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    expect(guestIpForwardHeaders("abc")).toEqual({});
  });

  it("sends nothing without a hash when strict attestation is not configured", () => {
    vi.stubEnv("MCPJAM_EDGE_SECRET", "");
    vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "secret");
    expect(guestIpForwardHeaders(null)).toEqual({});
  });
  it("pools unknown guests only after attestation is configured", () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service");
    vi.stubEnv("MCPJAM_EDGE_SECRET", "edge");
    expect(guestIpForwardHeaders(null)).toEqual({
      "x-mcpjam-guest-ip-hash": "_unattested",
      "x-inspector-service-token": "service",
    });
  });
});
