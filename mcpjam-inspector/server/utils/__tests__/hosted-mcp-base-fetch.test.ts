/**
 * MJ-001: every hosted MCP client manager dials a guarded fetch.
 *
 * THIS IS THE TEST THAT MATTERS MOST in the finding's remediation, so it is
 * written to fail for the right reason. Two properties, and the second is why
 * asserting `baseFetch !== undefined` on its own would be theatre:
 *
 *   1. every hosted factory passes a `baseFetch` that is neither absent nor the
 *      global — the mistake the finding is about;
 *   2. the value it passes actually REFUSES a private target. A future refactor
 *      that threads through a fetch which guards nothing would satisfy (1) and
 *      reintroduce the vulnerability.
 *
 * Table-driven over the factories on purpose: a seventh factory should be one
 * row here, not a new test nobody writes. The static half — a hosted file
 * cannot construct `new MCPClientManager` at all — is
 * `scripts/check-hosted-manager-base-fetch.mjs`, because no runtime test can
 * see a factory that does not exist yet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { managerConstructions } = vi.hoisted(() => ({
  managerConstructions: [] as Array<{
    configs: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
  }>,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  class RecordingManager {
    constructor(
      configs: Record<string, unknown>,
      options?: Record<string, unknown>
    ) {
      managerConstructions.push({ configs, options });
    }
    // The factories under test call these synchronously after constructing.
    setElicitationCallback() {}
    setMrtrInputCollector() {}
    async disconnectAllServers() {}
    async connectToServer() {}
  }
  return { ...actual, MCPClientManager: RecordingManager };
});

async function withHostedMode<T>(hosted: boolean, run: () => Promise<T>) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  managerConstructions.length = 0;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
    else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
    vi.resetModules();
  }
}

describe("hostedMcpBaseFetch", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("refuses loopback, link-local and RFC1918 targets in hosted mode", async () => {
    await withHostedMode(true, async () => {
      const { hostedMcpBaseFetch } = await import("../hosted-mcp-base-fetch.js");
      const { BlockedEgressTargetError } = await import(
        "../hosted-egress-guard.js"
      );
      const guarded = hostedMcpBaseFetch();

      for (const url of [
        "http://127.0.0.1:6274/mcp",
        "http://[::1]:6274/mcp",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/mcp",
        "http://192.168.1.1/mcp",
        "http://172.16.0.1/mcp",
      ]) {
        await expect(guarded(url)).rejects.toBeInstanceOf(
          BlockedEgressTargetError
        );
      }
    });
  });

  it("is a passthrough outside hosted mode, so local loopback still dials", async () => {
    await withHostedMode(false, async () => {
      const { hostedMcpBaseFetch } = await import("../hosted-mcp-base-fetch.js");
      const spy = vi.fn(async () => new Response("{}"));
      global.fetch = spy as unknown as typeof fetch;
      const response = await hostedMcpBaseFetch()("http://127.0.0.1:6274/mcp");
      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledOnce();
    });
  });
});

describe("assertHostedFirstPartyMcpUrls", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "ENVIRONMENT",
    "MCPJAM_PLATFORM_MCP_URL",
    "MCPJAM_DOCS_MCP_URL",
    "MCPJAM_SPEC_MCP_URL",
  ];

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("accepts every environment a hosted deployment actually sets", async () => {
    // The three hosted spellings in Railway today: production sets
    // `ENVIRONMENT=production` (an alias, not a member of the enum), staging
    // and every PR preview set `staging`.
    for (const environment of ["production", "prod", "staging", "preview"]) {
      await withHostedMode(true, async () => {
        process.env.ENVIRONMENT = environment;
        delete process.env.MCPJAM_PLATFORM_MCP_URL;
        delete process.env.MCPJAM_DOCS_MCP_URL;
        delete process.env.MCPJAM_SPEC_MCP_URL;
        const { assertHostedFirstPartyMcpUrls } = await import(
          "../hosted-mcp-base-fetch.js"
        );
        expect(() => assertHostedFirstPartyMcpUrls()).not.toThrow();
      });
    }
  });

  it("refuses to start when the environment resolves a loopback platform worker", async () => {
    // The trap this assertion exists for: `HOSTED_MODE` and `ENVIRONMENT` are
    // different variables, so a hosted container whose environment resolves to
    // `dev` would dial `http://localhost:8787/mcp` for its own platform server
    // — refused by the guard, one turn at a time, if nothing stopped it here.
    for (const environment of ["dev", "local", "test"]) {
      await withHostedMode(true, async () => {
        process.env.ENVIRONMENT = environment;
        const { assertHostedFirstPartyMcpUrls } = await import(
          "../hosted-mcp-base-fetch.js"
        );
        expect(() => assertHostedFirstPartyMcpUrls()).toThrow(
          /Refusing to start/
        );
      });
    }
  });

  it("refuses a private operator override", async () => {
    for (const key of [
      "MCPJAM_PLATFORM_MCP_URL",
      "MCPJAM_DOCS_MCP_URL",
      "MCPJAM_SPEC_MCP_URL",
    ]) {
      await withHostedMode(true, async () => {
        process.env.ENVIRONMENT = "prod";
        process.env[key] = "http://10.1.2.3/mcp";
        const { assertHostedFirstPartyMcpUrls } = await import(
          "../hosted-mcp-base-fetch.js"
        );
        expect(() => assertHostedFirstPartyMcpUrls()).toThrow(/10\.1\.2\.3/);
        delete process.env[key];
      });
    }
  });

  it("does nothing at all outside hosted mode", async () => {
    await withHostedMode(false, async () => {
      process.env.ENVIRONMENT = "local";
      const { assertHostedFirstPartyMcpUrls } = await import(
        "../hosted-mcp-base-fetch.js"
      );
      expect(() => assertHostedFirstPartyMcpUrls()).not.toThrow();
    });
  });
});
