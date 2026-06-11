import { describe, it, expect, afterEach } from "vitest";
import {
  registerTunnelDomain,
  unregisterTunnelDomain,
  getActiveTunnelDomains,
  isActiveTunnelDomain,
  getServerIdForTunnelDomain,
} from "../tunnel-registry.js";

describe("tunnel-registry", () => {
  afterEach(() => {
    for (const d of getActiveTunnelDomains()) {
      unregisterTunnelDomain(d);
    }
  });

  it("registers and resolves a per-server domain binding", () => {
    registerTunnelDomain("Alpha.ngrok.app", "alpha");
    expect(isActiveTunnelDomain("alpha.ngrok.app")).toBe(true);
    // Case-insensitive and port-tolerant lookups.
    expect(isActiveTunnelDomain("ALPHA.ngrok.app:443")).toBe(true);
    expect(getServerIdForTunnelDomain("alpha.ngrok.app")).toBe("alpha");
  });

  it("returns null serverId for the shared (unbound) tunnel", () => {
    registerTunnelDomain("shared.ngrok.app", null);
    expect(isActiveTunnelDomain("shared.ngrok.app")).toBe(true);
    expect(getServerIdForTunnelDomain("shared.ngrok.app")).toBeNull();
  });

  it("unregisters a domain", () => {
    registerTunnelDomain("beta.ngrok.app", "beta");
    unregisterTunnelDomain("beta.ngrok.app:8080");
    expect(isActiveTunnelDomain("beta.ngrok.app")).toBe(false);
  });

  it("handles IPv6 hosts without mangling the address", () => {
    // Bracketed IPv6 with a port normalizes to the bare address.
    registerTunnelDomain("[::1]", "v6");
    expect(isActiveTunnelDomain("[::1]:6274")).toBe(true);
    expect(getServerIdForTunnelDomain("[::1]")).toBe("v6");

    // A bare IPv6 address (multiple colons, no port) is preserved intact.
    registerTunnelDomain("2001:db8::1", "v6bare");
    expect(isActiveTunnelDomain("2001:db8::1")).toBe(true);
    expect(getServerIdForTunnelDomain("2001:db8::1")).toBe("v6bare");
  });

  it("does not match unknown domains", () => {
    expect(isActiveTunnelDomain("nope.ngrok.app")).toBe(false);
    expect(getServerIdForTunnelDomain(undefined)).toBeNull();
  });
});
