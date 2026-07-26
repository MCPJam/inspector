import { describe, expect, it } from "vitest";
import { resolveHostedOAuthProtocolSelection } from "../use-hosted-oauth-gate";

describe("resolveHostedOAuthProtocolSelection", () => {
  it("honors a saved wire pin for hosted Auto OAuth", () => {
    expect(
      resolveHostedOAuthProtocolSelection({
        oauthProtocolMode: "auto",
        oauthProtocolVersion: "2025-11-25",
        wireProtocolVersion: "2026-07-28",
      })
    ).toEqual({
      mode: "auto",
      protocolVersion: "2026-07-28",
      source: "wire_pin",
    });
  });

  it("uses the compatibility fallback when Auto has no MCP evidence", () => {
    expect(
      resolveHostedOAuthProtocolSelection({
        oauthProtocolMode: "auto",
      })
    ).toEqual({
      mode: "auto",
      protocolVersion: "2025-11-25",
      source: "auth_gated_fallback",
    });
  });
});
