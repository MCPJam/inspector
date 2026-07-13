import { describe, expect, it } from "vitest";
import {
  buildJwtBearerBody,
  buildJwtBearerRequest,
} from "../../src/xaa/mint/jwt-bearer.js";

describe("buildJwtBearerRequest", () => {
  const args = {
    assertion: "the-id-jag",
    clientId: "client id!",
    clientSecret: "secret (with)~chars",
    scope: "read",
    resource: "https://mcp.example.com/mcp",
  };

  it("keeps credentials in the body for client_secret_post", () => {
    const request = buildJwtBearerRequest({
      ...args,
      tokenEndpointAuthMethod: "client_secret_post",
    });

    expect(request.headers).toEqual({});
    expect(request.body).toEqual(buildJwtBearerBody(args));
  });

  it("uses RFC 6749 Basic encoding and removes credentials from the body", () => {
    const request = buildJwtBearerRequest({
      ...args,
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    const encoded = request.headers.Authorization.replace(/^Basic /, "");

    expect(Buffer.from(encoded, "base64").toString()).toBe(
      "client+id%21:secret+%28with%29%7Echars"
    );
    expect(request.body.client_id).toBeUndefined();
    expect(request.body.client_secret).toBeUndefined();
    expect(request.body.assertion).toBe(args.assertion);
  });

  it("never sends a secret for public clients", () => {
    const request = buildJwtBearerRequest({
      ...args,
      tokenEndpointAuthMethod: "none",
    });

    expect(request.headers).toEqual({});
    expect(request.body.client_id).toBe(args.clientId);
    expect(request.body.client_secret).toBeUndefined();
  });

  it("carries the grant type, scope, and resource for every method", () => {
    for (const method of [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ] as const) {
      const request = buildJwtBearerRequest({
        ...args,
        tokenEndpointAuthMethod: method,
      });
      expect(request.body.grant_type).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
      );
      expect(request.body.assertion).toBe(args.assertion);
      expect(request.body.scope).toBe("read");
      expect(request.body.resource).toBe("https://mcp.example.com/mcp");
    }
  });

  it("defaults (no method) to credentials in the body, no headers", () => {
    const request = buildJwtBearerRequest(args);
    expect(request.headers).toEqual({});
    expect(request.body).toEqual(buildJwtBearerBody(args));
  });

  it("requires both credentials for client_secret_basic and _post", () => {
    for (const method of ["client_secret_basic", "client_secret_post"] as const) {
      expect(() =>
        buildJwtBearerRequest({
          assertion: "a",
          clientId: "c",
          tokenEndpointAuthMethod: method,
        })
      ).toThrow(new RegExp(method));
      expect(() =>
        buildJwtBearerRequest({
          assertion: "a",
          clientSecret: "s",
          tokenEndpointAuthMethod: method,
        })
      ).toThrow(new RegExp(method));
    }
  });

  it("requires a client_id for a public (none) client", () => {
    expect(() =>
      buildJwtBearerRequest({
        assertion: "a",
        tokenEndpointAuthMethod: "none",
      })
    ).toThrow(/none.*client_id|client_id/i);
  });
});
