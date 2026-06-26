/**
 * Drift guard for the XAA jwt-bearer request body. Both the debugger's
 * `/proxy/token` endpoint and the connect-page mint build their token request
 * via `buildJwtBearerBody`, so this asserts the wire shape stays stable and
 * stays identical regardless of which surface calls it.
 */
import { describe, it, expect } from "vitest";
import { buildJwtBearerBody } from "../xaa-mint.js";

describe("buildJwtBearerBody", () => {
  it("emits the RFC 7523 jwt-bearer grant with only the populated fields", () => {
    expect(
      buildJwtBearerBody({
        assertion: "the-id-jag",
        clientId: "client-1",
        clientSecret: "secret-1",
        scope: "read:tools",
        resource: "https://mcp.example.com",
      })
    ).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "the-id-jag",
      client_id: "client-1",
      client_secret: "secret-1",
      scope: "read:tools",
      resource: "https://mcp.example.com",
    });
  });

  it("omits empty/nullish optional fields (public client, no scope/resource)", () => {
    expect(
      buildJwtBearerBody({
        assertion: "the-id-jag",
        clientId: null,
        clientSecret: undefined,
        scope: "",
        resource: null,
      })
    ).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "the-id-jag",
    });
  });

  it("produces an identical body for the same inputs (connect vs debugger parity)", () => {
    const args = {
      assertion: "jag",
      clientId: "c",
      clientSecret: "s",
      scope: "a b",
      resource: "https://r.example.com",
    };
    expect(buildJwtBearerBody(args)).toEqual(buildJwtBearerBody(args));
  });
});
