/**
 * `SANDBOX_ORIGIN` prefers the server's runtime `MCPJAM_SANDBOX_ORIGIN` to the
 * build-time `VITE_MCPJAM_SANDBOX_ORIGIN`, so one image serves every
 * deployment, and the boot guard still fires when neither is set.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function sandboxOriginWith(options: {
  runtime?: unknown;
  build?: string;
}): Promise<string | null> {
  vi.resetModules();
  vi.stubEnv("VITE_MCPJAM_SANDBOX_ORIGIN", options.build ?? "");
  if (options.runtime === undefined) {
    delete window.__MCP_RUNTIME_CONFIG__;
  } else {
    Object.assign(window, {
      __MCP_RUNTIME_CONFIG__: { sandboxOrigin: options.runtime },
    });
  }
  const { SANDBOX_ORIGIN } = await import("../config");
  return SANDBOX_ORIGIN;
}

afterEach(() => {
  delete window.__MCP_RUNTIME_CONFIG__;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("SANDBOX_ORIGIN", () => {
  it("uses the runtime origin over the build-time one", async () => {
    expect(
      await sandboxOriginWith({
        runtime: "https://sandbox.customer.example",
        build: "https://sandbox.mcpjam.com",
      }),
    ).toBe("https://sandbox.customer.example");
  });

  it("reduces the runtime value to its origin", async () => {
    expect(
      await sandboxOriginWith({ runtime: "https://sandbox.customer.example/x?y" }),
    ).toBe("https://sandbox.customer.example");
    expect(
      await sandboxOriginWith({ runtime: "http://sandbox.internal:8080" }),
    ).toBe("http://sandbox.internal:8080");
  });

  it("falls back to the build-time origin when the runtime one is absent", async () => {
    expect(
      await sandboxOriginWith({ build: "https://sandbox.mcpjam.com" }),
    ).toBe("https://sandbox.mcpjam.com");
  });

  it.each([
    "javascript:alert(1)",
    "ftp://sandbox.customer.example",
    "not a url",
    "",
    42,
  ])(
    "ignores a runtime value that is not an http(s) origin (%s) and falls back",
    async (runtime) => {
      expect(
        await sandboxOriginWith({ runtime, build: "https://sandbox.mcpjam.com" }),
      ).toBe("https://sandbox.mcpjam.com");
    },
  );

  it("is null when neither is set, and the sandbox-origin fault still fires", async () => {
    const origin = await sandboxOriginWith({});
    expect(origin).toBeNull();

    const { detectSandboxOriginFault } = await import("../sandbox-origin-fault");
    const fault = detectSandboxOriginFault({
      hostedMode: true,
      sandboxOrigin: origin,
      getStorage: () => ({ getItem: () => null, setItem: () => undefined }),
    });
    expect(fault?.shouldCapture).toBe(true);
    expect(fault?.message).toContain("MCPJAM_SANDBOX_ORIGIN");
    expect(fault?.message).toContain("VITE_MCPJAM_SANDBOX_ORIGIN");
  });

  it("does not fault when only the runtime origin is set", async () => {
    const origin = await sandboxOriginWith({
      runtime: "https://sandbox.customer.example",
    });
    const { detectSandboxOriginFault } = await import("../sandbox-origin-fault");
    expect(
      detectSandboxOriginFault({
        hostedMode: true,
        sandboxOrigin: origin,
        getStorage: () => ({ getItem: () => null, setItem: () => undefined }),
      }),
    ).toBeNull();
  });
});
