import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IdJagInspector } from "../IdJagInspector";
import type { XAADecodedJwt } from "@/lib/xaa/types";

vi.mock("@/components/ui/json-editor", () => ({
  ScrollableJsonView: ({ value }: { value: unknown }) => (
    <pre data-testid="json-view">{JSON.stringify(value)}</pre>
  ),
}));

const NOW = Math.floor(Date.now() / 1000);

function buildDecoded(
  overrides: {
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  } = {},
): XAADecodedJwt {
  return {
    header: {
      alg: "RS256",
      typ: "oauth-id-jag+jwt",
      kid: "xaa-idp-1",
      ...overrides.header,
    },
    payload: {
      iss: "https://idp.example.com",
      sub: "user-12345",
      aud: "https://as.example.com",
      resource: "https://mcp.example.com",
      client_id: "client-abc",
      jti: "jti-1",
      iat: NOW,
      exp: NOW + 300,
      ...overrides.payload,
    },
    signature: "signature-bytes",
    issues: [],
  };
}

describe("IdJagInspector claim lint", () => {
  it("renders a passing verdict per claim with spec citations", () => {
    render(
      <IdJagInspector
        rawJwt="aaa.bbb.ccc"
        decoded={buildDecoded()}
        negativeTestMode="valid"
        lintContext={{
          expectedAudience: "https://as.example.com",
          expectedResource: "https://mcp.example.com",
          expectedClientId: "client-abc",
        }}
      />,
    );

    expect(screen.getByText("Claim lint")).toBeInTheDocument();
    expect(screen.getByText("All claims pass")).toBeInTheDocument();
    const typRow = screen.getByTestId("idjag-lint-typ");
    expect(typRow).toHaveTextContent("typ header");
    expect(typRow).toHaveTextContent("ID-JAG draft");
  });

  it("flags an expired assertion and an audience mismatch", () => {
    render(
      <IdJagInspector
        rawJwt="aaa.bbb.ccc"
        decoded={buildDecoded({
          payload: {
            aud: "https://wrong-audience.example.com",
            exp: NOW - 3600,
          },
        })}
        negativeTestMode="valid"
        lintContext={{ expectedAudience: "https://as.example.com" }}
      />,
    );

    expect(screen.getByText(/2 failing/)).toBeInTheDocument();
    expect(screen.getByTestId("idjag-lint-aud")).toHaveTextContent(
      "exactly match",
    );
    expect(screen.getByTestId("idjag-lint-exp")).toHaveTextContent("expired");
  });
});
