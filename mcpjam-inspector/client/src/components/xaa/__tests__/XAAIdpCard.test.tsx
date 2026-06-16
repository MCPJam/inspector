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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders collapsed with the hosted endpoints hidden until expanded", () => {
    render(<XAAIdpCard />);

    expect(screen.getByText("Use MCPJam as your test IdP")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText("Issuer URL")).not.toBeInTheDocument();
  });

  it("reveals the hosted issuer/OpenID/JWKS URLs when expanded", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i })
    );

    expect(screen.getByText(issuer)).toBeInTheDocument();
    expect(
      screen.getByText(`${issuer}/.well-known/jwks.json`)
    ).toBeInTheDocument();
    // The OpenID configuration URL row was removed (derivable from the issuer).
    expect(
      screen.queryByText(`${issuer}/.well-known/openid-configuration`)
    ).not.toBeInTheDocument();
  });

  it("names the Configure Target Client ID in the registration steps", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i })
    );

    expect(
      screen.getByText(/the Client ID you set in Configure Target/i)
    ).toBeInTheDocument();
  });

  it("copies a URL and shows inline confirmation", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i })
    );
    await user.click(screen.getByRole("button", { name: /copy issuer url/i }));

    expect(copyToClipboard).toHaveBeenCalledWith(issuer);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  // On expand the card reads the server's OpenID config to resolve the real
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

    const user = userEvent.setup();
    render(<XAAIdpCard />);
    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i })
    );

    expect(await screen.findByText(serverIssuer)).toBeInTheDocument();
    expect(
      screen.getByText(`${serverIssuer}/.well-known/jwks.json`)
    ).toBeInTheDocument();
    // OpenID config URL is no longer shown as its own row.
    expect(
      screen.queryByText(`${serverIssuer}/.well-known/openid-configuration`)
    ).not.toBeInTheDocument();
  });
});

describe("XAAIdpCard (non-hosted mode)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("warns that local URLs need a public tunnel when expanded", async () => {
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ HOSTED_MODE: false }));
    vi.doMock("@/lib/clipboard", () => ({
      copyToClipboard: async () => true,
    }));
    const { XAAIdpCard: LocalIdpCard } = await import("../XAAIdpCard");

    const user = userEvent.setup();
    render(<LocalIdpCard />);

    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i })
    );

    expect(
      screen.getByText(/Expose the\s+inspector with a public tunnel/i)
    ).toBeInTheDocument();
  });
});
