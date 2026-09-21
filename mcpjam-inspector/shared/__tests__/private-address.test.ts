import { describe, expect, it } from "vitest";
import { isPrivateNetworkUrl } from "../private-address";

describe("isPrivateNetworkUrl", () => {
  it.each([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://127.8.4.2/auth",
    "https://myserver.localhost/tenant",
    "http://[::1]:9000",
    "http://10.0.0.5",
    "http://192.168.1.20:3000",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://169.254.10.10",
    "http://0.0.0.0:8080",
    "https://printer.local",
    "https://auth.internal",
    "http://[fd12:3456:789a::1]",
    "http://[fe80::1]",
    // A terminal dot is the same NAME to a resolver, and `new URL()` rewrites
    // an IPv4-mapped IPv6 literal into hex (`[::ffff:127.0.0.1]` →
    // `[::ffff:7f00:1]`). Both used to read as public, so an ordinary
    // localhost server was refused for "not being on a private address".
    "http://localhost.",
    "http://localhost.:8001",
    "http://127.0.0.1.",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:192.168.1.1]",
  ])("classifies %s as private", (url) => {
    expect(isPrivateNetworkUrl(url)).toBe(true);
  });

  it.each([
    "https://auth.example.com",
    "https://tenant.auth-provider.example/resources/res_123",
    "http://172.15.0.1", // just below the RFC 1918 172.16/12 block
    "http://172.32.0.1", // just above it
    "http://11.0.0.1",
    "https://mylocal.host.example.com",
    "https://localhost.example.com", // "localhost" label but public domain
    "http://[2001:db8::1]",
    // Stripping the terminal dot must not turn a public name private.
    "https://auth.example.com.",
    "http://[::ffff:8.8.8.8]",
  ])("classifies %s as public", (url) => {
    expect(isPrivateNetworkUrl(url)).toBe(false);
  });

  it("returns false for unparseable input", () => {
    expect(isPrivateNetworkUrl("not a url")).toBe(false);
    expect(isPrivateNetworkUrl("")).toBe(false);
  });
});
