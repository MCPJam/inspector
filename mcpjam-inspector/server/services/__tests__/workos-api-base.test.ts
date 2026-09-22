/**
 * The guard on `WORKOS_API_BASE_URL`.
 *
 * Two properties, both load-bearing: unset yields NO sdk options, so every
 * caller constructs exactly what it constructed before; and a non-loopback
 * value throws rather than pointing an admin-key-bearing client at another
 * host. The second matters more here than in the backend — Railway previews
 * are duplicated from staging wholesale and the deploy script cannot unset a
 * variable, so a value set once would propagate with no way to withdraw it.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKOS_API_BASE_URL,
  resolveWorkosApiBaseUrl,
} from "../workos-api-base.js";

const resolve = (value?: string) =>
  resolveWorkosApiBaseUrl(
    value === undefined ? {} : { WORKOS_API_BASE_URL: value },
  );

describe("resolveWorkosApiBaseUrl — unset", () => {
  it("defaults to the real API and asks for no SDK options", () => {
    expect(resolve()).toEqual({ baseUrl: DEFAULT_WORKOS_API_BASE_URL });
    expect(resolve().sdkOptions).toBeUndefined();
  });

  it("treats empty and whitespace-only values as unset", () => {
    // A deploy tool that writes `KEY=` must read as "not configured", not take
    // the service down on a parse failure.
    expect(resolve("")).toEqual({ baseUrl: DEFAULT_WORKOS_API_BASE_URL });
    expect(resolve("   ")).toEqual({ baseUrl: DEFAULT_WORKOS_API_BASE_URL });
  });
});

describe("resolveWorkosApiBaseUrl — accepted loopback origins", () => {
  it("splits a loopback origin into SDK host options", () => {
    expect(resolve("http://127.0.0.1:4820")).toEqual({
      baseUrl: "http://127.0.0.1:4820",
      sdkOptions: { apiHostname: "127.0.0.1", https: false, port: 4820 },
    });
  });

  it("normalizes a trailing slash away from baseUrl", () => {
    // Callers build `${baseUrl}${path}`; a kept slash yields `//user_management`.
    expect(resolve("http://localhost:4820/").baseUrl).toBe(
      "http://localhost:4820",
    );
  });

  it("omits the port when the URL uses the protocol default", () => {
    // `Number('')` is 0, which the SDK would append as `:0`.
    expect(resolve("https://localhost").sdkOptions).toEqual({
      apiHostname: "localhost",
      https: true,
      port: undefined,
    });
  });

  it("keeps the brackets on an IPv6 loopback host", () => {
    expect(resolve("http://[::1]:4820").sdkOptions?.apiHostname).toBe("[::1]");
  });
});

describe("resolveWorkosApiBaseUrl — rejected values", () => {
  it.each([
    ["a remote host", "https://api.workos.com"],
    ["a staging host", "http://staging.example.com:8080"],
    [
      "a host that merely starts with a loopback label",
      "http://127.0.0.1.evil.com",
    ],
    ["a lookalike subdomain", "https://localhost.evil.com"],
    ["a non-http scheme", "ftp://127.0.0.1"],
    ["a bare hostname with no scheme", "127.0.0.1:4820"],
    ["unparseable text", "not a url"],
    ["a path callers would double", "http://127.0.0.1:4820/v1"],
    ["a query the SDK would drop", "http://127.0.0.1:4820/?x=1"],
    ["embedded credentials", "http://user:pass@127.0.0.1:4820"],
  ])("rejects %s", (_label, value) => {
    expect(() => resolve(value)).toThrow(
      /WORKOS_API_BASE_URL must be a loopback/,
    );
  });

  it("names the offending value so the misconfiguration is diagnosable", () => {
    expect(() => resolve("https://api.workos.com")).toThrow(
      /\(got "https:\/\/api\.workos\.com"\)/,
    );
  });
});
