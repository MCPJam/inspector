import { describe, expect, it } from "vitest";
import {
  resolveWorkosClientOptions,
  resolveWorkosDevMode,
} from "../workos-authkit-config";

describe("workos authkit config", () => {
  it("uses cookie mode by default, including local dev", () => {
    expect(resolveWorkosDevMode({ DEV: true })).toBe(false);
    expect(resolveWorkosDevMode({ DEV: false })).toBe(false);
  });

  it("keeps the explicit dev mode escape hatch", () => {
    expect(resolveWorkosDevMode({ VITE_WORKOS_DEV_MODE: "true" })).toBe(true);
    expect(resolveWorkosDevMode({ VITE_WORKOS_DEV_MODE: "false" })).toBe(false);
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
