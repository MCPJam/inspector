import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { ScoreRunnerView } from "../ScoreRunnerView";
import type { ScoreRunnerPhase } from "../score-runner-view-model";

function renderView(
  overrides: Partial<ComponentProps<typeof ScoreRunnerView>> = {},
) {
  const props = {
    urlInput: "",
    onUrlChange: vi.fn(),
    onSubmit: vi.fn((event: FormEvent) => event.preventDefault()),
    emailInput: "",
    onEmailChange: vi.fn(),
    onEmailSubmit: vi.fn((event: FormEvent) => event.preventDefault()),
    phase: "form" as ScoreRunnerPhase,
    error: null,
    busy: false,
    formDisabled: false,
    appReadyMessage: null,
    resultUrl: null,
    showAuthorize: false,
    onAuthorize: vi.fn(),
    authorizeBusy: false,
    ...overrides,
  };
  return { ...render(<ScoreRunnerView {...props} />), props };
}

describe("ScoreRunnerView", () => {
  it("renders the Paper landing state", () => {
    renderView();
    expect(
      screen.getByRole("heading", {
        name: "Know where your MCP server stands.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("MCP server URL")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Score this server" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Featured scores")).toBeInTheDocument();
    expect(screen.getByText("mcp.monday.com")).toBeInTheDocument();
    expect(screen.getByText("https://demo.mcpjam.com/mcp")).toBeInTheDocument();
    expect(screen.getByText("https://mcp.linear.app/mcp")).toBeInTheDocument();
    expect(screen.getByText(/we email a scorecard/i)).toBeInTheDocument();
    expect(
      screen.getByText("Public URL. No login. About 15 minutes."),
    ).toBeInTheDocument();
    expect(screen.getByText("Reliability")).toBeInTheDocument();
    expect(
      screen.getByText("113 checks. 63 passed, 8 failed, 27 not applicable."),
    ).toBeInTheDocument();
  });

  it("passes the full featured MCP endpoint into the URL field", async () => {
    const user = userEvent.setup();
    const onUrlChange = vi.fn();
    renderView({ onUrlChange });

    await user.click(
      screen.getByRole("button", {
        name: "Use https://mcp.linear.app/mcp",
      }),
    );

    expect(onUrlChange).toHaveBeenCalledWith("https://mcp.linear.app/mcp");
  });

  it("renders the Paper email state after URL submission", () => {
    renderView({ phase: "email" });

    expect(
      screen.getByRole("heading", {
        name: "Where should we send the scorecard?",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("MCP server URL")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Scorecard email")).toHaveAttribute(
      "placeholder",
      "you@acme.com",
    );
    expect(
      screen.getByRole("button", { name: "Email the scorecard" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Featured scores")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Use https://mcp.linear.app/mcp",
      }),
    ).not.toBeInTheDocument();
  });

  it("submits the entered scorecard email", async () => {
    const user = userEvent.setup();
    const onEmailChange = vi.fn();
    const onEmailSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    renderView({ phase: "email", onEmailChange, onEmailSubmit });

    await user.type(screen.getByLabelText("Scorecard email"), "dev@acme.com");
    await user.click(
      screen.getByRole("button", { name: "Email the scorecard" }),
    );

    expect(onEmailChange).toHaveBeenCalled();
    expect(onEmailSubmit).toHaveBeenCalledOnce();
  });

  it("shows an invalid-URL error without losing the entered value", () => {
    renderView({
      urlInput: "not-a-url",
      error: "Enter a valid http(s) MCP server URL.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid http(s) MCP server URL.",
    );
    expect(screen.getByLabelText("MCP server URL")).toHaveValue("not-a-url");
  });

  it("disables the form and announces busy labels", () => {
    renderView({
      phase: "preparing",
      busy: true,
      formDisabled: true,
      urlInput: "https://mcp.acme.com/mcp",
    });
    expect(
      screen.getByRole("heading", { name: "Scanning your MCP server" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Preparing your results shortly."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preparing…" })).toBeDisabled();
    expect(screen.getByLabelText("MCP server URL")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing…");
  });

  it("shows Scanning… while the suites run", () => {
    renderView({ phase: "running", busy: true, formDisabled: true });
    expect(screen.getByRole("button", { name: "Scanning…" })).toBeDisabled();
  });

  it("shows Saving… after the suites settle", () => {
    renderView({ phase: "saving", busy: true, formDisabled: true });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("renders the auth-required CTA without client-secret fields", () => {
    const onAuthorize = vi.fn();
    renderView({
      phase: "authorizing",
      showAuthorize: true,
      onAuthorize,
    });
    expect(
      screen.getByRole("heading", {
        name: "This server requires authentication.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("MCP server URL")).not.toBeInTheDocument();
    expect(screen.queryByText(/client id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/client secret/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize and continue" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Featured scores")).not.toBeInTheDocument();
    expect(screen.queryByText("Reliability")).not.toBeInTheDocument();
  });

  it("shows the ready-state actions", () => {
    renderView({
      phase: "done",
      resultUrl: "https://score.mcpjam.com/results/tok_1",
    });
    expect(
      screen.getByRole("heading", { name: "Your scorecard is on its way." }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Find it in your inbox, or open the hosted report in the browser.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View in browser" })).toHaveAttribute(
      "href",
      "https://score.mcpjam.com/results/tok_1",
    );
    expect(screen.getByRole("link", { name: "View in browser" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: "View in browser" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(
      screen.getByRole("link", { name: "Debug in MCPJam" }),
    ).toHaveAttribute("href", "https://app.mcpjam.com/servers");
    expect(screen.queryByText("84")).not.toBeInTheDocument();
    expect(screen.queryByTestId("score-preview-plane")).not.toBeInTheDocument();
    expect(screen.queryByText("Reliability")).not.toBeInTheDocument();
  });

  it("shows a copy-failure alert on the ready state", () => {
    renderView({
      phase: "done",
      resultUrl: "https://score.mcpjam.com/results/tok_1",
      error: "Could not copy the link. Copy it manually.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not copy the link. Copy it manually.",
    );
  });

  it("keeps a save-failure alert and the entered URL", () => {
    renderView({
      phase: "done",
      urlInput: "https://mcp.acme.com/mcp",
      error: "Scan finished, but the shareable link could not be saved.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Scan finished, but the shareable link could not be saved.",
    );
  });
});
