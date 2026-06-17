import { render, screen } from "@testing-library/react";
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
    expect(screen.getByText(issuer)).toBeInTheDocument();
    expect(
      screen.getByText(`${issuer}/.well-known/jwks.json`)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy issuer url/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy jwks url/i })
    ).toBeInTheDocument();
  });

  it("copies a URL and shows inline confirmation", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(screen.getByRole("button", { name: /copy issuer url/i }));

    expect(copyToClipboard).toHaveBeenCalledWith(issuer);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("keeps the long-form detail behind the info icon until hovered", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    expect(
      screen.queryByText(/the Client ID you set in Configure Server to Test/i)
    ).not.toBeInTheDocument();

    await user.hover(
      screen.getByRole("button", {
        name: /how mcpjam acts as your identity provider/i,
      })
    );

    expect(
      await screen.findByText(
        /the Client ID you set in Configure Server to Test/i
      )
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

    expect(await screen.findByText(serverIssuer)).toBeInTheDocument();
    expect(
      screen.getByText(`${serverIssuer}/.well-known/jwks.json`)
    ).toBeInTheDocument();
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
      screen.getByText(/Expose the\s+inspector with a public tunnel/i)
    ).toBeInTheDocument();
  });
});
