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

// The setup gear is gated on the xaa-registration flag (plus hosted + org).
let registrationFlag: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => registrationFlag,
}));

const navigateMock = vi.fn();
vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return {
    ...actual,
    useAppNavigate: () => navigateMock,
  };
});

describe("XAAIdpCard", () => {
  // jsdom serves the suite from a fixed origin; derive the expected URLs from
  // it rather than forcing a cross-origin replaceState (which jsdom rejects).
  const issuer = `${window.location.origin}/api/web/xaa`;

  beforeEach(() => {
    copyToClipboard.mockClear();
    navigateMock.mockClear();
    registrationFlag = true;
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
      screen.getByText(/scoped to your organization/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("anonymous-issuer-note")
    ).not.toBeInTheDocument();
  });

  it("labels the anonymous test issuer (/g/) for hosted guest sessions", () => {
    render(<XAAIdpCard organizationId="org_guest1" issuerKind="anonymous" />);

    // The advertised issuer lives under the visibly separate /g/ namespace.
    expect(
      screen.getByRole("button", { name: /copy issuer url/i })
    ).toHaveAttribute("title", `${issuer}/g/org_guest1`);
    // The labeling states the trust contract: explicit allowlisting, not
    // enterprise-managed authorization.
    const note = screen.getByTestId("anonymous-issuer-note");
    expect(note).toHaveTextContent(/anonymous test issuer/i);
    expect(note).toHaveTextContent(/must explicitly allowlist/i);
    expect(
      screen.queryByText(/scoped to your organization/i)
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

  it("shows the setup gear for org members and navigates to the setup center", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard organizationId="org_a1B2" />);

    await user.click(screen.getByRole("button", { name: /open xaa setup/i }));
    expect(navigateMock).toHaveBeenCalledWith("/xaa-flow/setup");
  });

  it("hides the setup gear without an org or without the registration flag", () => {
    const { unmount } = render(<XAAIdpCard />);
    expect(
      screen.queryByRole("button", { name: /open xaa setup/i })
    ).toBeNull();
    unmount();

    registrationFlag = false;
    render(<XAAIdpCard organizationId="org_a1B2" />);
    expect(
      screen.queryByRole("button", { name: /open xaa setup/i })
    ).toBeNull();
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

    render(<LocalIdpCard />);

    expect(
      screen.getByText(/Expose\s+MCPJam with a public tunnel/i)
    ).toBeInTheDocument();
  });

  it("badges the hosted-issuer toggle for guest sessions (anonymous kind)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ HOSTED_MODE: false }));
    vi.doMock("@/lib/clipboard", () => ({
      copyToClipboard: async () => true,
    }));
    const { XAAIdpCard: LocalIdpCard } = await import("../XAAIdpCard");

    render(
      <LocalIdpCard
        organizationId="org_guest1"
        issuerMode="hosted"
        onIssuerModeChange={() => {}}
        canUseHostedIssuer
        issuerKind="anonymous"
      />
    );

    expect(screen.getByTestId("anonymous-issuer-badge")).toHaveTextContent(
      /anonymous test issuer/i
    );
    expect(screen.getByText(/must explicitly allowlist/i)).toBeInTheDocument();
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
