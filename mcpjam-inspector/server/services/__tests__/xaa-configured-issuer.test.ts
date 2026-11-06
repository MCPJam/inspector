import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { LOCAL_SERVER_ADDR, MCPJAM_PUBLIC_ORIGIN } from "../../config.js";
import { resolveConfiguredXaaIssuer } from "../xaa-configured-issuer.js";
import {
  resolveXaaIssuer,
  scopeXaaIssuerForAuthorizedProject,
} from "../xaa-mint.js";

/** A request as the TLS-terminating edge hands it to a hosted replica. */
function hostedRequest(url: string): Context {
  return {
    req: {
      url,
      header: (name: string) =>
        name === "x-forwarded-proto" ? "https" : undefined,
    },
  } as unknown as Context;
}

describe("resolveConfiguredXaaIssuer, hosted", () => {
  it("names the web issuer on the configured public origin", () => {
    expect(
      resolveConfiguredXaaIssuer(true, {
        MCPJAM_INSPECTOR_PUBLIC_URL: "https://app.example.com",
      }),
    ).toBe("https://app.example.com/api/web/xaa");
  });

  it("matches the issuer an interactive run derives from its request", () => {
    // Same deployment, same organization: the claim loop and the route must
    // hand the manager builder the same issuer, which it then scopes.
    const fromRequest = resolveXaaIssuer(
      hostedRequest("http://app.example.com/api/web/evals/stream-test-case"),
      true,
    );
    const fromConfig = resolveConfiguredXaaIssuer(true, {
      MCPJAM_INSPECTOR_PUBLIC_URL: "https://app.example.com",
    });
    expect(fromConfig).toBe(fromRequest);
    expect(
      scopeXaaIssuerForAuthorizedProject({
        issuer: fromConfig!,
        organizationId: "org-1",
        isAnonymous: false,
      }),
    ).toBe("https://app.example.com/api/web/xaa/o/org-1");
  });

  it("keeps only the origin, as a request-derived issuer does", () => {
    expect(
      resolveConfiguredXaaIssuer(true, {
        MCPJAM_INSPECTOR_PUBLIC_URL: "  https://app.example.com/inspector/  ",
      }),
    ).toBe("https://app.example.com/api/web/xaa");
  });

  it("reads BASE_URL when the public URL is unset", () => {
    expect(
      resolveConfiguredXaaIssuer(true, { BASE_URL: "https://base.example.com" }),
    ).toBe("https://base.example.com/api/web/xaa");
  });

  it("prefers MCPJAM_INSPECTOR_PUBLIC_URL over BASE_URL", () => {
    expect(
      resolveConfiguredXaaIssuer(true, {
        MCPJAM_INSPECTOR_PUBLIC_URL: "https://app.example.com",
        BASE_URL: "https://base.example.com",
      }),
    ).toBe("https://app.example.com/api/web/xaa");
  });

  it("names no issuer without a configured origin", () => {
    // Neither the hosted default nor localhost: either would sign under a
    // name whose JWKS this deployment does not publish.
    expect(resolveConfiguredXaaIssuer(true, {})).toBeUndefined();
    expect(
      resolveConfiguredXaaIssuer(true, { MCPJAM_INSPECTOR_PUBLIC_URL: "   " }),
    ).toBeUndefined();
  });

  it("names no issuer when the configured URL does not parse", () => {
    expect(
      resolveConfiguredXaaIssuer(true, {
        MCPJAM_INSPECTOR_PUBLIC_URL: "app.example.com",
      }),
    ).toBeUndefined();
  });
});

describe("resolveConfiguredXaaIssuer, off-hosted", () => {
  it("names the local issuer surface on the configured public origin", () => {
    expect(
      resolveConfiguredXaaIssuer(false, {
        MCPJAM_INSPECTOR_PUBLIC_URL: "https://inspector.example.com",
      }),
    ).toBe("https://inspector.example.com/api/mcp/xaa");
  });

  it("falls back to the deployment's own address when none is configured", () => {
    const origin = new URL(MCPJAM_PUBLIC_ORIGIN ?? LOCAL_SERVER_ADDR).origin;
    expect(resolveConfiguredXaaIssuer(false, {})).toBe(`${origin}/api/mcp/xaa`);
  });

  it("does not fall back when the configured URL does not parse", () => {
    expect(
      resolveConfiguredXaaIssuer(false, { BASE_URL: "not a url" }),
    ).toBeUndefined();
  });
});
