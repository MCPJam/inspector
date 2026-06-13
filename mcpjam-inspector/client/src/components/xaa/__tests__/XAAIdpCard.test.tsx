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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders collapsed with the hosted endpoints hidden until expanded", () => {
    render(<XAAIdpCard />);

    expect(screen.getByText("Use MCPJam as your test IdP")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Issuer URL")).not.toBeInTheDocument();
  });

  it("reveals the hosted issuer/OpenID/JWKS URLs when expanded", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i }),
    );

    expect(screen.getByText(issuer)).toBeInTheDocument();
    expect(
      screen.getByText(`${issuer}/.well-known/openid-configuration`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${issuer}/.well-known/jwks.json`),
    ).toBeInTheDocument();
  });

  it("copies a URL and shows inline confirmation", async () => {
    const user = userEvent.setup();
    render(<XAAIdpCard />);

    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i }),
    );
    await user.click(screen.getByRole("button", { name: /copy issuer url/i }));

    expect(copyToClipboard).toHaveBeenCalledWith(issuer);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  // URL-aware fetch mock: the card first reads the server's OpenID config, then
  // the JWKS. Each call gets its own Response (bodies are single-read).
  const mockIdpFetch = (overrides: { issuer?: string; kid?: string } = {}) => {
    const serverIssuer = overrides.issuer ?? issuer;
    const kid = overrides.kid ?? "key-2026";
    return vi.fn((url: string | URL) => {
      const href = String(url);
      if (href.includes("openid-configuration")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: serverIssuer,
              jwks_uri: `${serverIssuer}/.well-known/jwks.json`,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [{ kid }] }), { status: 200 }),
      );
    });
  };

  it("shows the active signing key id fetched from JWKS once expanded", async () => {
    const fetchMock = mockIdpFetch();
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<XAAIdpCard />);
    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i }),
    );

    await waitFor(() =>
      expect(screen.getByText("kid: key-2026")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${issuer}/.well-known/jwks.json`,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("prefers the issuer advertised by the server over the browser origin", async () => {
    // The jsdom browser origin is not localhost:6274 — simulate the dev-proxy
    // skew where the backend mints a different-origin `iss`.
    const serverIssuer = "http://localhost:6274/api/web/xaa";
    vi.stubGlobal("fetch", mockIdpFetch({ issuer: serverIssuer }));

    const user = userEvent.setup();
    render(<XAAIdpCard />);
    await user.click(
      screen.getByRole("button", { name: /use mcpjam as your test idp/i }),
    );

    expect(await screen.findByText(serverIssuer)).toBeInTheDocument();
    expect(
      screen.getByText(`${serverIssuer}/.well-known/openid-configuration`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${serverIssuer}/.well-known/jwks.json`),
    ).toBeInTheDocument();
  });
});
