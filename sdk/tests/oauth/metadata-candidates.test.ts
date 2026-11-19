import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadataUrls,
  findMetadataDocument,
  MCP_AUTHORIZATION_SERVER_METADATA_FORMS,
  mcpAuthorizationServerMetadataForms,
  protectedResourceMetadataUrls,
} from "../../src/oauth/metadata-candidates.js";

const urls = (issuer: string, forms: Parameters<typeof authorizationServerMetadataUrls>[1]) =>
  authorizationServerMetadataUrls(issuer, forms).map(({ url }) => url);

describe("protectedResourceMetadataUrls", () => {
  it("puts the path-suffixed form first and drops one trailing slash and the query", () => {
    expect(protectedResourceMetadataUrls("https://host.example/mcp/?a=1")).toEqual([
      "https://host.example/.well-known/oauth-protected-resource/mcp",
      "https://host.example/.well-known/oauth-protected-resource",
    ]);
  });

  it("returns the root twice for a resource at the origin root", () => {
    expect(protectedResourceMetadataUrls("https://host.example/")).toEqual([
      "https://host.example/.well-known/oauth-protected-resource",
      "https://host.example/.well-known/oauth-protected-resource",
    ]);
  });
});

describe("authorizationServerMetadataUrls", () => {
  it("follows the current MCP order for a path issuer, with no root fallback", () => {
    expect(
      authorizationServerMetadataUrls(
        "https://auth.example/tenant/",
        mcpAuthorizationServerMetadataForms("2026-07-28")
      )
    ).toEqual([
      {
        url: "https://auth.example/.well-known/oauth-authorization-server/tenant",
        kind: "oauth",
      },
      {
        url: "https://auth.example/.well-known/openid-configuration/tenant",
        kind: "oidc",
      },
      {
        url: "https://auth.example/tenant/.well-known/openid-configuration",
        kind: "oidc",
      },
    ]);
  });

  it("collapses a root issuer to one URL per document type", () => {
    expect(
      urls("https://auth.example", MCP_AUTHORIZATION_SERVER_METADATA_FORMS.current)
    ).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server",
      "https://auth.example/.well-known/openid-configuration",
    ]);
    expect(
      urls("https://auth.example/", mcpAuthorizationServerMetadataForms("2025-06-18"))
    ).toEqual(["https://auth.example/.well-known/oauth-authorization-server"]);
  });

  it("keeps the RFC 8414 root fallback for 2025-03-26 and 2025-06-18", () => {
    expect(
      urls("https://auth.example/tenant", mcpAuthorizationServerMetadataForms("2025-03-26"))
    ).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server/tenant",
      "https://auth.example/.well-known/oauth-authorization-server",
    ]);
  });

  it("follows a caller's own order", () => {
    expect(
      urls("https://idp.example/realms/a", [
        "oidc-insert",
        "oauth-insert",
        "oidc-append",
        "oidc-root",
      ])
    ).toEqual([
      "https://idp.example/.well-known/openid-configuration/realms/a",
      "https://idp.example/.well-known/oauth-authorization-server/realms/a",
      "https://idp.example/realms/a/.well-known/openid-configuration",
      "https://idp.example/.well-known/openid-configuration",
    ]);
  });

  it("stays on the issuer's host when the path starts with two slashes", () => {
    expect(urls("https://auth.example//evil.example/x", ["oidc-append"])).toEqual([
      "https://auth.example//evil.example/x/.well-known/openid-configuration",
    ]);
  });

  it("throws on an unparseable issuer", () => {
    expect(() => urls("not a url", ["oauth-insert"])).toThrow();
  });
});

describe("findMetadataDocument", () => {
  it("stops at the first document and reports the last error on a miss", async () => {
    const seen: string[] = [];
    const found = await findMetadataDocument(["a", "b", "c"], async (url) => {
      seen.push(url);
      return url === "b" ? { document: { url } } : { error: `${url} failed` };
    });
    expect(found).toEqual({ found: true, candidate: "b", document: { url: "b" } });
    expect(seen).toEqual(["a", "b"]);

    const missed = await findMetadataDocument(["a", "b"], async (url) => ({
      error: `${url} failed`,
      answered: false,
    }));
    expect(missed).toEqual({ found: false, lastError: "b failed", answered: false });
  });

  it("lets a candidate end the walk by throwing", async () => {
    await expect(
      findMetadataDocument(["a", "b"], async () => {
        throw new Error("HTTP 500");
      })
    ).rejects.toThrow("HTTP 500");
  });
});
