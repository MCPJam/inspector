import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  HOSTED_MODE: true,
}));
vi.mock("@/hooks/use-hosted-oauth-connections", () => ({
  useHostedOAuthConnections: hook,
}));
vi.mock("@/lib/oauth/mcp-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/oauth/mcp-oauth")>()),
  getStoredTokensState: () => ({ tokens: null, isInvalid: false }),
}));
vi.mock("@/lib/apis/hosted-oauth-tokens-api", () => ({
  fetchHostedOAuthTokens: vi.fn(),
}));

import { ServerInfoContent } from "../ServerInfoContent";

const server = {
  name: "Linear",
  useOAuth: true,
  config: { url: new URL("https://mcp.linear.app/mcp") },
  connectionStatus: "connected",
} as never;

function mount() {
  render(
    <ServerInfoContent
      sections="auth"
      server={server}
      projectId="project-1"
      hostedServerId="server-1"
    />,
  );
}

describe("ServerInfoContent's token reveal", () => {
  it.each([
    [
      "a shared server's account",
      {
        connections: [{ connectionId: "p1", isDefault: true }],
        shared: true,
        loaded: true,
      },
    ],
    [
      "an uploaded account",
      {
        connections: [
          { connectionId: "u1", isDefault: true, hostedOnly: true },
        ],
        shared: false,
        loaded: true,
      },
    ],
  ])("is not offered for %s", (_name, state) => {
    hook.mockReturnValue(state);
    mount();
    expect(
      screen.getByText(
        "Tokens of shared and uploaded accounts can't be revealed.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reveal/ })).toBeNull();
  });

  it.each([
    [
      "the list has not loaded",
      { connections: [], shared: true, loaded: false },
    ],
    [
      "the list failed to load",
      {
        connections: [],
        shared: true,
        loaded: false,
        error: "Could not load accounts",
      },
    ],
  ])("is not offered while %s", (_name, state) => {
    hook.mockReturnValue(state);
    mount();
    expect(screen.queryByRole("button", { name: /Reveal/ })).toBeNull();
  });

  it("is offered for the person's own sign-in", () => {
    hook.mockReturnValue({
      connections: [{ connectionId: "c1", isDefault: true }],
      shared: false,
      loaded: true,
    });
    mount();
    expect(screen.getByRole("button", { name: /Reveal/ })).toBeInTheDocument();
  });
});
