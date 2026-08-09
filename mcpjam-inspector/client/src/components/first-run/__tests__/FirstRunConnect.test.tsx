import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstRunConnect } from "../FirstRunConnect";
import type { FirstRunPhase } from "@/hooks/use-first-run-connect";

function renderScreen(
  phase: FirstRunPhase,
  overrides: Partial<Parameters<typeof FirstRunConnect>[0]> = {}
) {
  const props = {
    phase,
    inputError: null,
    onConnectOwnServer: vi.fn(),
    onConnectDemoServer: vi.fn(),
    onRetry: vi.fn(),
    onAuthorize: vi.fn(),
    onBackToChoosing: vi.fn(),
    onClearInputError: vi.fn(),
    ...overrides,
  };
  render(<FirstRunConnect {...props} />);
  return props;
}

describe("FirstRunConnect", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("choosing", () => {
    it("leads with the user's own server, not the demo", () => {
      renderScreen({ kind: "choosing" });

      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading).toHaveTextContent("Point MCPJam at a server");
      expect(
        screen.getByRole("button", { name: "Connect" })
      ).toBeInTheDocument();
    });

    it("submits the typed server on Connect", async () => {
      const user = userEvent.setup();
      const props = renderScreen({ kind: "choosing" });

      await user.type(
        screen.getByLabelText(/server url/i),
        "https://mcp.acme.com/mcp"
      );
      await user.click(screen.getByRole("button", { name: "Connect" }));

      expect(props.onConnectOwnServer).toHaveBeenCalledWith(
        "https://mcp.acme.com/mcp"
      );
    });

    it("submits on Enter without a full page reload", async () => {
      const user = userEvent.setup();
      const props = renderScreen({ kind: "choosing" });

      await user.type(
        screen.getByLabelText(/server url/i),
        "https://mcp.acme.com/mcp{Enter}"
      );

      expect(props.onConnectOwnServer).toHaveBeenCalledWith(
        "https://mcp.acme.com/mcp"
      );
    });

    it("offers the demo server as an explicit choice", async () => {
      const user = userEvent.setup();
      const props = renderScreen({ kind: "choosing" });

      expect(screen.getByText("Excalidraw")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try it" }));

      expect(props.onConnectDemoServer).toHaveBeenCalled();
    });

    it("shows an input error as an alert and marks the field invalid", () => {
      renderScreen(
        { kind: "choosing" },
        { inputError: "Enter a server URL or command." }
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enter a server URL or command."
      );
      expect(screen.getByLabelText(/server url/i)).toHaveAttribute(
        "aria-invalid",
        "true"
      );
    });

    it("clears a stale input error as soon as the user edits", async () => {
      const user = userEvent.setup();
      const props = renderScreen(
        { kind: "choosing" },
        { inputError: "Enter a server URL or command." }
      );

      await user.type(screen.getByLabelText(/server url/i), "h");

      expect(props.onClearInputError).toHaveBeenCalled();
    });
  });

  describe("connecting", () => {
    it("names the server it is connecting to", () => {
      renderScreen({
        kind: "connecting",
        serverName: "Excalidraw",
        source: "demo",
      });

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Connecting to Excalidraw"
      );
      expect(screen.getByText("Reaching the server")).toBeInTheDocument();
    });

    it("offers no dead-end: the step list is live for screen readers", () => {
      renderScreen({
        kind: "connecting",
        serverName: "Acme",
        source: "own",
      });

      expect(screen.getByTestId("first-run-connecting")).toBeInTheDocument();
      expect(screen.getByRole("list")).toHaveAttribute("aria-live", "polite");
    });
  });

  describe("failure", () => {
    const failure: FirstRunPhase = {
      kind: "error",
      reason: "failed",
      message: "ECONNREFUSED 127.0.0.1:9000",
      serverName: "Localhost",
      source: "own",
    };

    it("renders the real failure reason in place", () => {
      renderScreen(failure);

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Couldn't reach Localhost"
      );
      expect(
        screen.getByText("ECONNREFUSED 127.0.0.1:9000")
      ).toBeInTheDocument();
    });

    it("always offers a way forward", async () => {
      const user = userEvent.setup();
      const props = renderScreen(failure);

      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(props.onRetry).toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Edit server" }));
      expect(props.onBackToChoosing).toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: /demo server/i }));
      expect(props.onConnectDemoServer).toHaveBeenCalled();
    });

    it("offers Authorize rather than Try again when the server wants OAuth", async () => {
      const user = userEvent.setup();
      const props = renderScreen({
        kind: "error",
        reason: "reauth",
        message: "401 Unauthorized",
        serverName: "Acme",
        source: "own",
      });

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Acme needs authorization"
      );
      expect(
        screen.queryByRole("button", { name: "Try again" })
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Authorize" }));
      expect(props.onAuthorize).toHaveBeenCalled();
    });

    it("does not suggest the demo when the demo is what failed", () => {
      renderScreen({
        kind: "error",
        reason: "failed",
        message: "503",
        serverName: "Excalidraw (App)",
        source: "demo",
      });

      expect(
        screen.queryByRole("button", { name: /demo server instead/i })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Use another server" })
      ).toBeInTheDocument();
    });
  });
});
