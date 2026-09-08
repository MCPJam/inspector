/**
 * MJ-001: the guard itself, and the boot assertion that keeps a hosted
 * deployment from starting with its own first-party servers behind it.
 *
 * SCOPE, since three files share this finding's coverage: this one owns
 * `hostedMcpBaseFetch()`'s behaviour — that it refuses, and that it is inert
 * locally. That every hosted FACTORY threads it is
 * `routes/web/__tests__/hosted-manager-base-fetch.test.ts`; that no hosted file
 * can construct a manager without it is
 * `scripts/check-hosted-manager-base-fetch.mjs`, because no runtime test can
 * see a factory that does not exist yet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function withHostedMode<T>(hosted: boolean, run: () => Promise<T>) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
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

  it("refuses a plaintext override even when its host is public", async () => {
    // Found in review: checking only the hostname let an `http://` override
    // start the process, and the guard then refused every request it made —
    // the "loud at startup" promise, quietly half-kept.
    await withHostedMode(true, async () => {
      process.env.ENVIRONMENT = "prod";
      process.env.MCPJAM_DOCS_MCP_URL = "http://docs.mcpjam.com/mcp";
      const { assertHostedFirstPartyMcpUrls } = await import(
        "../hosted-mcp-base-fetch.js"
      );
      expect(() => assertHostedFirstPartyMcpUrls()).toThrow(/https/);
    });
  });

  it("refuses a whitespace-only override rather than validating the default", async () => {
    // Also from review. The consumers read `process.env.X ?? DEFAULT`, so a
    // whitespace-only value is truthy there and gets dialled verbatim; an
    // assertion that trimmed it to empty and skipped would have been checking
    // a URL the process never uses.
    await withHostedMode(true, async () => {
      process.env.ENVIRONMENT = "prod";
      process.env.MCPJAM_SPEC_MCP_URL = "   ";
      const { assertHostedFirstPartyMcpUrls } = await import(
        "../hosted-mcp-base-fetch.js"
      );
      expect(() => assertHostedFirstPartyMcpUrls()).toThrow(
        /not a valid URL/
      );
    });
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
