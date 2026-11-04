import { describe, expect, it } from "vitest";
import { conformanceVersionRefusal } from "../conformance-version-refusal";

describe("version refusal evidence", () => {
  const error =
    'MCP server "bart" doesn\'t support MCP protocol version 2026-07-28, which this client is pinned to. It offers 2025-06-18.';
  it("reads live errors and saved JSON-safe errors", () => {
    for (const refusal of [
      error,
      { message: error },
      {
        details: {
          errorDetails: {
            name: "ProtocolVersionPinUnsupported",
            protocolVersion: "2026-07-28",
            supportedVersions: ["2025-06-18", "<private>"],
          },
        },
      },
    ]) {
      expect(
        conformanceVersionRefusal(
          [{ id: "completion-complete", status: "failed", error: refusal }],
          "2026-07-28",
        ),
      ).toEqual({
        protocolVersion: "2026-07-28",
        supportedVersions: ["2025-06-18"],
      });
    }
  });
  it("reads explicit old OAuth refusals using the run version", () => {
    const checks = [
      {
        id: "authenticated_mcp_request",
        status: "failed",
        error:
          "Authenticated request failed: 400: Unsupported protocol version (supported versions: 2025-06-18, 2025-03-26)",
      },
    ];
    expect(
      conformanceVersionRefusal(checks, "2026-07-28")?.supportedVersions,
    ).toEqual(["2025-06-18", "2025-03-26"]);
    expect(conformanceVersionRefusal(checks)).toBeUndefined();
    expect(conformanceVersionRefusal(checks, "2025-06-18")).toBeUndefined();
  });
  it("does not blame version negotiation, outages, unrelated versions, or negative tests", () => {
    expect(
      conformanceVersionRefusal(
        [{ id: "modern-unsupported-version-error", status: "failed", error }],
        "2026-07-28",
      ),
    ).toBeUndefined();
    expect(
      conformanceVersionRefusal(
        [{ id: "completion-complete", status: "passed", error }],
        "2026-07-28",
      ),
    ).toBeUndefined();
    expect(
      conformanceVersionRefusal(
        [{ id: "completion-complete", status: "failed", error }],
        "2025-06-18",
      ),
    ).toBeUndefined();
    expect(
      conformanceVersionRefusal(
        [
          {
            id: "completion-complete",
            status: "failed",
            error: "Version negotiation probe failed: fetch failed",
          },
        ],
        "2026-07-28",
      ),
    ).toBeUndefined();
  });
});
