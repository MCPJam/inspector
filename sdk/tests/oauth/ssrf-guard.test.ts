import {
  assertOutboundOAuthUrlAllowed,
  isDisallowedIpAddress,
  isPrivateHost,
  OAuthOutboundUrlBlockedError,
} from "../../src/oauth/ssrf-guard.js";
import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type { OAuthFlowState } from "../../src/oauth/state-machines/types.js";

describe("isDisallowedIpAddress / isPrivateHost (RFC 6890)", () => {
  it("flags the classic SSRF and private/reserved literals", () => {
    for (const ip of [
      "169.254.169.254", // cloud metadata (link-local)
      "10.0.0.1",
      "192.168.1.1",
      "172.16.5.5",
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1", // IPv6 link-local
      "fc00::1", // IPv6 unique-local
      "::ffff:169.254.169.254", // IPv4-mapped bypass
      "::ffff:7f00:1", // ::ffff:127.0.0.1 hex bypass
      "64:ff9b:1::a00:1", // NAT64 local-use /48 embedding 10.0.0.1
      "64:ff9b::a00:1", // NAT64 well-known /96 embedding 10.0.0.1
    ]) {
      expect(isDisallowedIpAddress(ip)).toBe(true);
    }
  });

  it("allows public unicast addresses", () => {
    expect(isDisallowedIpAddress("8.8.8.8")).toBe(false);
    expect(isDisallowedIpAddress("2606:4700:4700::1111")).toBe(false);
    // NAT64 well-known prefix embedding a PUBLIC IPv4 (8.8.8.8) stays allowed.
    expect(isDisallowedIpAddress("64:ff9b::808:808")).toBe(false);
  });

  it("treats localhost names as private", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("api.localhost")).toBe(true);
    expect(isPrivateHost("mcp.example.com")).toBe(false);
  });
});

describe("assertOutboundOAuthUrlAllowed", () => {
  it("allows a public https URL", () => {
    expect(() =>
      assertOutboundOAuthUrlAllowed("https://auth.example.com/register"),
    ).not.toThrow();
  });

  it("blocks cloud-metadata and LAN destinations", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/",
      "http://10.0.0.1/register",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      expect(() => assertOutboundOAuthUrlAllowed(url)).toThrow(
        OAuthOutboundUrlBlockedError,
      );
    }
  });

  it("rejects non-http(s) schemes and malformed URLs", () => {
    expect(() => assertOutboundOAuthUrlAllowed("ftp://evil.example.com")).toThrow(
      /http\(s\)/,
    );
    expect(() => assertOutboundOAuthUrlAllowed("not a url")).toThrow(
      OAuthOutboundUrlBlockedError,
    );
  });

  it("carves out loopback only under an explicit opt-in", () => {
    expect(() =>
      assertOutboundOAuthUrlAllowed("http://localhost:8080/register", {
        allowLoopback: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertOutboundOAuthUrlAllowed("http://127.0.0.1:8080/register", {
        allowLoopback: true,
      }),
    ).not.toThrow();
    // Loopback opt-in never relaxes the guard for a LAN address.
    expect(() =>
      assertOutboundOAuthUrlAllowed("http://10.0.0.1/register", {
        allowLoopback: true,
      }),
    ).toThrow(OAuthOutboundUrlBlockedError);
    // Without the opt-in, loopback is blocked too.
    expect(() =>
      assertOutboundOAuthUrlAllowed("http://localhost/register"),
    ).toThrow(OAuthOutboundUrlBlockedError);
  });

  it("treats IPv4-mapped loopback consistently with plain loopback", () => {
    // Mapped loopback is allowed under the opt-in, like 127.0.0.1 / ::1 …
    for (const url of [
      "http://[::ffff:127.0.0.1]/register",
      "http://[::ffff:7f00:1]/register",
    ]) {
      expect(() =>
        assertOutboundOAuthUrlAllowed(url, { allowLoopback: true }),
      ).not.toThrow();
      // … and blocked without it.
      expect(() => assertOutboundOAuthUrlAllowed(url)).toThrow(
        OAuthOutboundUrlBlockedError,
      );
    }
    // The carve-out is loopback-only: mapped LAN stays blocked even with opt-in.
    expect(() =>
      assertOutboundOAuthUrlAllowed("http://[::ffff:10.0.0.1]/register", {
        allowLoopback: true,
      }),
    ).toThrow(OAuthOutboundUrlBlockedError);
  });
});

describe("factory wraps every machine's executor with the SSRF guard", () => {
  const REDIRECT_URI = "http://127.0.0.1:3333/callback";
  const SERVER_URL = "https://mcp.example.com/mcp";

  const buildAtRegistration = (registrationEndpoint: string) => {
    const inner = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: { client_id: "generated" },
    });
    let state: OAuthFlowState = {
      ...EMPTY_OAUTH_FLOW_STATE,
      serverUrl: SERVER_URL,
      currentStep: "received_authorization_server_metadata",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: registrationEndpoint,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
    };
    const machine = createOAuthStateMachine({
      protocolVersion: "2026-07-28",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: inner,
      dynamicRegistration: { client_name: "Test Client" },
    });
    return { machine, inner };
  };

  // The registration fetch fires a step after `received_authorization_server_metadata`,
  // so advance a few steps (swallowing any downstream throw) to reach it.
  const advance = async (machine: {
    proceedToNextStep: () => Promise<void>;
  }) => {
    for (let i = 0; i < 3; i++) {
      await machine.proceedToNextStep().catch(() => {});
    }
  };

  it("blocks a DCR registration fetch aimed at cloud metadata", async () => {
    const { machine, inner } = buildAtRegistration(
      "http://169.254.169.254/register",
    );
    await advance(machine);
    // The guard intercepts before the real executor ever runs.
    expect(inner).not.toHaveBeenCalled();
  });

  it("passes a public registration fetch through to the executor", async () => {
    const { machine, inner } = buildAtRegistration(
      "https://auth.example.com/register",
    );
    await advance(machine);
    const urls = inner.mock.calls.map((c) => c[0].url);
    expect(urls).toContain("https://auth.example.com/register");
  });

  it("blocks a loopback registration fetch by default (no opt-in)", async () => {
    const { machine, inner } = buildAtRegistration(
      "http://127.0.0.1:8080/register",
    );
    await advance(machine);
    // allowLoopbackMetadataFetch defaults to false → the hostile-loopback
    // fetch never reaches the executor.
    expect(inner).not.toHaveBeenCalled();
  });
});
