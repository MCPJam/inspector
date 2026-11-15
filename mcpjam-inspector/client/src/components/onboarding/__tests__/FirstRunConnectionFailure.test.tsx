import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError } from "@mcpjam/sdk/browser";

const hostedState = vi.hoisted(() => ({ hosted: false }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn() }));

vi.mock("framer-motion", () => ({ useReducedMotion: () => true }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  get HOSTED_MODE() {
    return hostedState.hosted;
  },
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: clipboard.copy }));
vi.mock("@/lib/first-run-onboarding-analytics", () => ({
  trackFirstRunConnectionFailed: vi.fn(),
  trackFirstRunOnboardingEntered: vi.fn(),
  trackFirstRunOnboardingScreenViewed: vi.fn(),
  trackFirstRunSetupLater: vi.fn(),
}));

import {
  FirstRunOnboardingOverlay,
  type FirstRunConnectionState,
} from "../FirstRunOnboardingOverlay";

function renderOverlay() {
  const onConnectOwnServer = vi.fn();
  const props = {
    open: true,
    skipWelcome: true,
    onConnectOwnServer,
    onConnectDemo: vi.fn(),
    onAuthorizeConnection: vi.fn(),
    onCancelConnection: vi.fn(),
    onReturnToChoice: vi.fn(),
    onOpenPlayground: vi.fn(),
    onWelcomeShown: vi.fn(),
    onSkip: vi.fn(),
  };
  const view = render(
    <FirstRunOnboardingOverlay {...props} connectionState={{ status: "idle" }} />,
  );
  const fail = (
    error: string,
    extra: Partial<Extract<FirstRunConnectionState, { status: "failed" }>> = {},
  ) =>
    view.rerender(
      <FirstRunOnboardingOverlay
        {...props}
        connectionState={{
          status: "failed",
          serverName: "Example",
          serverKind: "personal",
          error,
          ...extra,
        }}
      />,
    );
  const submit = (value: string) => {
    fireEvent.change(screen.getByLabelText(/^Server URL/), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  };
  return { onConnectOwnServer, fail, submit };
}

afterEach(() => {
  cleanup();
  hostedState.hosted = false;
  clipboard.copy.mockReset();
});

describe("first-run connection failure card", () => {
  it("opens a 401 on its catalog reason and steps, with the raw error behind Technical details", () => {
    const { fail, submit, onConnectOwnServer } = renderOverlay();
    submit("https://mcp.example.com/mcp");
    const raw = "Streamable HTTP error: Error POSTing to endpoint (HTTP 401)";
    fail(raw, {
      normalized: describeError(Object.assign(new Error(raw), { code: 401 })),
    });

    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("Unauthorized (401)");
    expect(card).toHaveTextContent(
      "The server requires authentication that wasn't provided or is no longer valid.",
    );
    expect(
      screen.getByText("If using OAuth, run through the OAuth flow again from Servers."),
    ).toBeVisible();
    expect(screen.queryByText(raw)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("error-card-technical-toggle"));
    expect(screen.getByText(raw, { exact: false })).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy error" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Start OAuth" }));
    expect(onConnectOwnServer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transport: "http",
        urlOrCommand: "https://mcp.example.com/mcp",
        authentication: "oauth",
      }),
    );
  });

  it("shows an unknown failure's raw message as the reason and reconnects", () => {
    const { fail, submit, onConnectOwnServer } = renderOverlay();
    submit("https://mcp.example.com/mcp");
    fail("Upstream said no in an unfamiliar way");

    expect(screen.getByRole("alert")).toHaveTextContent("Connection failed");
    expect(
      screen.getByText("Upstream said no in an unfamiliar way"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy error" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onConnectOwnServer).toHaveBeenCalledTimes(2);
    expect(onConnectOwnServer).toHaveBeenLastCalledWith(
      expect.objectContaining({ urlOrCommand: "https://mcp.example.com/mcp" }),
    );
  });

  it("focuses the URL when the fix is to edit it", () => {
    const { fail, submit } = renderOverlay();
    submit("https://mcp.example.com/mcp");
    fail("connect ECONNREFUSED 127.0.0.1:3000");

    fireEvent.click(screen.getByRole("button", { name: "Edit URL" }));
    expect(screen.getByLabelText("Server URL or command")).toHaveFocus();
  });
});

describe("hosted input check", () => {
  it.each([
    ["npx -y @acme/mcp", "The web app cannot run local commands", "npx -y @acme/mcp"],
    [
      "http://localhost:3000/mcp",
      "The web app cannot reach localhost",
      "npx @mcpjam/inspector@latest",
    ],
  ])("blocks %s and offers the desktop app and a command", async (input, title, command) => {
    hostedState.hosted = true;
    clipboard.copy.mockResolvedValue(true);
    const { submit, onConnectOwnServer } = renderOverlay();
    submit(input);

    expect(onConnectOwnServer).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(title);
    expect(
      screen.getByRole("link", { name: "Download desktop app" }),
    ).toHaveAttribute("href", "https://github.com/MCPJam/inspector/releases/latest");
    fireEvent.click(screen.getByRole("button", { name: "Copy npx command" }));
    expect(clipboard.copy).toHaveBeenCalledWith(command);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();

    submit(input);
    expect(onConnectOwnServer).not.toHaveBeenCalled();
  });

  it("warns once about a private address, then connects", () => {
    hostedState.hosted = true;
    const { submit, onConnectOwnServer } = renderOverlay();
    submit("http://192.168.1.20:8080/mcp");
    expect(screen.getByRole("alert")).toHaveTextContent("private network");
    expect(onConnectOwnServer).not.toHaveBeenCalled();

    submit("http://192.168.1.20:8080/mcp");
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "http" }),
    );
  });

  it("reads a bare host as an HTTP URL instead of a command", () => {
    hostedState.hosted = true;
    const { submit, onConnectOwnServer } = renderOverlay();
    submit("mcp.example.com/mcp");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "http",
        urlOrCommand: "mcp.example.com/mcp",
      }),
    );
  });
});
