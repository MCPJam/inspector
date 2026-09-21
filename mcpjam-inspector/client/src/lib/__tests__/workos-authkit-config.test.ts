import { describe, expect, it } from "vitest";
import {
  resolveWorkosClientOptions,
  WORKOS_DEV_MODE,
} from "../workos-authkit-config";

describe("workos authkit config", () => {
  // Not a tautology: authkit-js defaults `devMode` to true on localhost, so
  // this constant has to stay false and stay explicitly passed, or local dev
  // silently moves the refresh token to localStorage while every deployed
  // environment keeps it in memory behind the AuthKit session cookie.
  it("uses cookie mode on every surface, including local dev", () => {
    expect(WORKOS_DEV_MODE).toBe(false);
  });

  it("proxies AuthKit calls through the local origin on localhost", () => {
    expect(
      resolveWorkosClientOptions(
        { DEV: false },
        { hostname: "127.0.0.1", port: "5173", protocol: "http:" }
      )
    ).toEqual({
      apiHostname: "127.0.0.1",
      https: false,
      port: 5173,
    });
  });

  it("does not proxy AuthKit calls on non-localhost origins", () => {
    expect(
      resolveWorkosClientOptions(
        { DEV: false },
        { hostname: "app.mcpjam.com", port: "", protocol: "https:" }
      )
    ).toEqual({});
  });

  it("proxies AuthKit calls for hosted-mode local QA", () => {
    expect(
      resolveWorkosClientOptions(
        { DEV: true, VITE_MCPJAM_HOSTED_MODE: "true" },
        { hostname: "localhost", port: "5173", protocol: "http:" }
      )
    ).toEqual({
      apiHostname: "localhost",
      https: false,
      port: 5173,
    });
  });

  // The staging regression, as a test. AuthKit's initialize() makes NO network
  // call unless the page's own cookies carry `workos-has-session`, and only a
  // same-origin response can set it — so a hosted deployment without a
  // same-site WorkOS domain has to proxy through itself or every reload reads
  // as signed out and drops the user to a guest.
  it("proxies AuthKit calls through its own origin on a hosted deployment", () => {
    expect(
      resolveWorkosClientOptions(
        { DEV: false },
        { hostname: "staging.mcpjam.com", port: "", protocol: "https:" },
        true
      )
    ).toEqual({
      apiHostname: "staging.mcpjam.com",
      https: true,
    });
  });

  // Every preview gets a different hostname, discovered only after deploy —
  // so this can never come from a build-time variable.
  it("proxies AuthKit calls through a preview's own origin", () => {
    expect(
      resolveWorkosClientOptions(
        { DEV: false },
        {
          hostname: "mcp-inspector-pr-4501.up.railway.app",
          port: "",
          protocol: "https:",
        },
        true
      )
    ).toEqual({
      apiHostname: "mcp-inspector-pr-4501.up.railway.app",
      https: true,
    });
  });

  // Prod pins `auth.mcpjam.com`, which is same-site with the app and needs no
  // proxy. An explicit hostname must keep winning or this change would quietly
  // reroute production sign-in through our own server.
  it("keeps an explicit host override ahead of the hosted same-origin default", () => {
    expect(
      resolveWorkosClientOptions(
        { DEV: false, VITE_WORKOS_API_HOSTNAME: "auth.mcpjam.com" },
        { hostname: "app.mcpjam.com", port: "", protocol: "https:" },
        true
      )
    ).toEqual({ apiHostname: "auth.mcpjam.com" });
  });

  it("allows explicit WorkOS API host overrides", () => {
    expect(
      resolveWorkosClientOptions(
        {
          DEV: true,
          VITE_WORKOS_API_HOSTNAME: "auth.example.com",
        },
        { hostname: "127.0.0.1", port: "5173", protocol: "http:" }
      )
    ).toEqual({ apiHostname: "auth.example.com" });
  });

  it("can disable the local WorkOS proxy", () => {
    expect(
      resolveWorkosClientOptions(
        {
          DEV: true,
          VITE_WORKOS_DISABLE_LOCAL_PROXY: "true",
        },
        { hostname: "127.0.0.1", port: "5173", protocol: "http:" }
      )
    ).toEqual({});
  });
});
