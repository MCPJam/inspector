import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XAAIdpCard } from "../XAAIdpCard";

const copyToClipboard = vi.fn(async () => true);
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (value: string) => copyToClipboard(value),
}));

// HOSTED_MODE drives the issuer base path (/api/web/xaa vs /api/mcp/xaa).
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

describe("XAAIdpCard", () => {
  // jsdom serves the suite from a fixed origin; derive the expected URLs from
  // it rather than forcing a cross-origin replaceState (which jsdom rejects).
  const issuer = `${window.location.origin}/api/web/xaa`;

  beforeEach(() => {
    copyToClipboard.mockClear();
  });

  // Only unstub globals (e.g. the fetch stub) — NOT restoreAllMocks, which
  // would also reset the shared ResizeObserver mock from test setup that
  // floating-ui (radix HoverCard) depends on, breaking the hover test.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the new title and both URLs inline (no expand step)", () => {
    render(<XAAIdpCard />);

    expect(
      screen.getByText("MCPJam is your identity provider")
    ).toBeInTheDocument();
    // The chips show only a label; the full URL lives in the title attribute
    // (and is copied on click) to keep the bar compact.
    expect(
      screen.getByRole("button", { name: /copy issuer url/i })
    ).toHaveAttribute("title", issuer);
    expect(
      screen.getByRole("button", { name: /copy jwks url/i })
    ).toHaveAttribute("title", `${issuer}/.well-known/jwks.json`);
  });

  it("copies a URL and shows inline confirmation", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(screen.getByRole("button", { name: /copy issuer url/i }));

    expect(copyToClipboard).toHaveBeenCalledWith(issuer);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("opens the setup guidance in a dialog", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(screen.getByRole("button", { name: /how it works/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /trust mcpjam's identity provider/i,
      })
    ).toBeInTheDocument();
  });

  // On mount the card reads the server's OpenID config to resolve the real
  // issuer + jwks_uri (the displayed values).
  const mockIdpFetch = (serverIssuer: string) =>
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issuer: serverIssuer,
            jwks_uri: `${serverIssuer}/.well-known/jwks.json`,
          }),
          { status: 200 }
        )
      )
    );

  it("prefers the issuer advertised by the server over the browser origin", async () => {
    // The jsdom browser origin is not localhost:6274 — simulate the dev-proxy
    // skew where the backend mints a different-origin `iss`.
    const serverIssuer = "http://localhost:6274/api/web/xaa";
    vi.stubGlobal("fetch", mockIdpFetch(serverIssuer));

    render(<XAAIdpCard />);

    // The card swaps in the server-advertised issuer once discovery resolves;
    // the URL surfaces via the chip's title attribute.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copy issuer url/i })
      ).toHaveAttribute("title", serverIssuer);
    });
    expect(
      screen.getByRole("button", { name: /copy jwks url/i })
    ).toHaveAttribute("title", `${serverIssuer}/.well-known/jwks.json`);
  });

  it("shows the org-scoped issuer for signed-in org members", () => {
    render(<XAAIdpCard organizationId="org_a1B2" />);

    expect(
      screen.getByRole("button", { name: /copy issuer url/i })
    ).toHaveAttribute("title", `${issuer}/o/org_a1B2`);
    expect(
      screen.getByRole("button", { name: /copy jwks url/i })
    ).toHaveAttribute("title", `${issuer}/o/org_a1B2/.well-known/jwks.json`);
    expect(
      screen.queryByTestId("anonymous-issuer-note")
    ).not.toBeInTheDocument();
  });

  it("shows the /g/ issuer without an extra guest explanation", () => {
    render(<XAAIdpCard organizationId="org_guest1" issuerKind="anonymous" />);

    expect(
      screen.getByRole("button", { name: /copy issuer url/i })
    ).toHaveAttribute("title", `${issuer}/g/org_guest1`);
    expect(
      screen.queryByTestId("anonymous-issuer-note")
    ).not.toBeInTheDocument();
  });

  it("keeps the /g/ issuer after async discovery resolves (does not fall back to /o/)", async () => {
    // Capture the discovery URL the card fetches, and reply with a /g/ issuer.
    // Before the fix, fetchXaaIdpUrls dropped issuerKind and fetched /o/,
    // overwriting the initial /g/ display after resolution.
    const requestedUrls: string[] = [];
    const anonIssuer = `${issuer}/g/org_guest1`;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: anonIssuer,
              jwks_uri: `${anonIssuer}/.well-known/jwks.json`,
            }),
            { status: 200 }
          )
        );
      })
    );

    render(<XAAIdpCard organizationId="org_guest1" issuerKind="anonymous" />);

    // Discovery targets the /g/ well-known endpoint (issuerKind was threaded).
    await waitFor(() => {
      expect(
        requestedUrls.some((url) =>
          url.includes("/g/org_guest1/.well-known/openid-configuration")
        )
      ).toBe(true);
    });
    // None of the fetches hit the /o/ discovery endpoint.
    expect(requestedUrls.some((url) => url.includes("/o/org_guest1"))).toBe(
      false
    );
    // After resolution the copy field still advertises the /g/ issuer.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copy issuer url/i })
      ).toHaveAttribute("title", anonIssuer);
    });
  });

  // ── Identity-assertion (OIDC/SAML) header control ────────────────────
  // Renders only when the flow tab wires a persistence handler; other card
  // consumers (setup center) omit it and see no control.

  it("hides the identity-assertion control without a change handler", () => {
    render(<XAAIdpCard identityAssertionFormat="oidc" />);
    expect(
      screen.queryByTestId("identity-assertion-toggle")
    ).not.toBeInTheDocument();
  });

  it("renders the OIDC/SAML control and fires the change handler", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <XAAIdpCard
        identityAssertionFormat="oidc"
        onIdentityAssertionFormatChange={onChange}
      />
    );

    const toggle = screen.getByTestId("identity-assertion-toggle");
    expect(toggle).toHaveTextContent("Identity assertion");
    // OIDC is the active option; SAML is offered.
    expect(screen.getByRole("button", { name: "OIDC" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "SAML" }));
    expect(onChange).toHaveBeenCalledWith("saml");
  });

  it("disables the control with the reason as its tooltip", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <XAAIdpCard
        identityAssertionFormat="oidc"
        onIdentityAssertionFormatChange={onChange}
        identityAssertionFormatDisabledReason="Wait for the current run to finish."
      />
    );

    expect(screen.getByTestId("identity-assertion-toggle")).toHaveAttribute(
      "title",
      "Wait for the current run to finish."
    );
    const samlButton = screen.getByRole("button", { name: "SAML" });
    expect(samlButton).toBeDisabled();
    await user.click(samlButton);
    expect(onChange).not.toHaveBeenCalled();
  });

});

describe("XAAIdpCard (non-hosted mode)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("warns that local URLs need a public tunnel", async () => {
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ HOSTED_MODE: false }));
    vi.doMock("@/lib/clipboard", () => ({
      copyToClipboard: async () => true,
    }));
    const { XAAIdpCard: LocalIdpCard } = await import("../XAAIdpCard");
    const user = userEvent.setup();

    render(<LocalIdpCard />);

    await user.hover(
      screen.getByRole("button", { name: /about local issuer urls/i })
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Expose\s+MCPJam with a public tunnel/i
    );
  });

  it("keeps the hosted-issuer toggle usable for guest sessions (anonymous kind)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ HOSTED_MODE: false }));
    vi.doMock("@/lib/clipboard", () => ({
      copyToClipboard: async () => true,
    }));
    const { XAAIdpCard: LocalIdpCard } = await import("../XAAIdpCard");
    const user = userEvent.setup();

    render(
      <LocalIdpCard
        organizationId="org_guest1"
        issuerMode="hosted"
        onIssuerModeChange={() => {}}
        canUseHostedIssuer
        issuerKind="anonymous"
      />
    );

    await user.hover(
      screen.getByRole("button", { name: /about the hosted issuer/i })
    );
    expect(await screen.findByRole("tooltip")).not.toHaveTextContent(
      /anonymous test issuer|must explicitly allowlist/i
    );
    // The toggle itself stays usable for guests with an org.
    expect(
      screen.getByRole("switch", { name: /use hosted issuer/i })
    ).toBeEnabled();
  });

  it("disables the toggle with the waiting reason when no organization resolved", async () => {
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ HOSTED_MODE: false }));
    vi.doMock("@/lib/clipboard", () => ({
      copyToClipboard: async () => true,
    }));
    const { XAAIdpCard: LocalIdpCard } = await import("../XAAIdpCard");

    render(
      <LocalIdpCard
        organizationId={null}
        issuerMode="local"
        onIssuerModeChange={() => {}}
        canUseHostedIssuer={false}
        hostedIssuerDisabledReason="waiting for an organization — sign in or continue as guest to mint through the hosted issuer"
        issuerKind="anonymous"
      />
    );

    expect(
      screen.getByRole("switch", { name: /use hosted issuer/i })
    ).toBeDisabled();
    expect(
      screen.getByText(/waiting for an organization/i)
    ).toBeInTheDocument();
  });
});
