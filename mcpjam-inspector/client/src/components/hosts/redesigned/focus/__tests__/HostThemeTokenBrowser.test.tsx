import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const copyToClipboard = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

import { HostThemeTokenBrowser } from "../HostThemeTokenBrowser";

describe("HostThemeTokenBrowser", () => {
  beforeEach(() => {
    copyToClipboard.mockClear();
  });

  it("renders grouped tokens from hostContext.styles.variables", () => {
    render(
      <HostThemeTokenBrowser
        hostContext={{
          styles: {
            variables: {
              "--color-background-primary":
                "light-dark(rgba(255, 255, 255, 1), rgba(48, 48, 46, 1))",
              "--font-sans": "Anthropic Sans, sans-serif",
            },
          },
        }}
      />,
    );
    expect(screen.getByTestId("host-theme-token-browser")).toBeInTheDocument();
    expect(screen.getByText("--color-background-primary")).toBeInTheDocument();
    expect(screen.getByText("--font-sans")).toBeInTheDocument();
    expect(screen.getByText("2 tokens this host sends to MCP Apps.")).toBeInTheDocument();
  });

  it("shows an empty state when styles.variables is missing", () => {
    render(<HostThemeTokenBrowser hostContext={{ theme: "light" }} />);
    expect(screen.getByTestId("host-theme-empty")).toBeInTheDocument();
    expect(
      screen.queryByTestId("host-theme-token-browser"),
    ).not.toBeInTheDocument();
  });

  it("shows no prior captures for hosts without a registry", () => {
    render(
      <HostThemeTokenBrowser
        hostStyle="mcpjam"
        hostContext={{
          styles: { variables: { "--border-radius-lg": "10px" } },
        }}
      />,
    );
    expect(screen.getByTestId("host-theme-no-history")).toBeInTheDocument();
    expect(screen.queryByTestId("host-theme-changelog")).not.toBeInTheDocument();
  });

  it("defaults Claude to Tokens and opens Diff against the last capture", async () => {
    const user = userEvent.setup();
    render(
      <HostThemeTokenBrowser
        hostStyle="claude"
        hostContext={{
          styles: {
            variables: {
              "--color-background-primary":
                "light-dark(rgba(255, 255, 255, 1), rgba(48, 48, 46, 1))",
              "--border-radius-lg": "10px",
            },
          },
        }}
      />,
    );
    expect(screen.getByLabelText("Watch host theme")).toBeInTheDocument();
    expect(screen.getByTestId("host-theme-watch-note")).toHaveTextContent(
      "mcpjam hosts diff claude",
    );
    expect(screen.queryByTestId("host-theme-diff")).not.toBeInTheDocument();
    expect(screen.getByText("--color-background-primary")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Diff" }));
    expect(screen.getByTestId("host-theme-diff")).toBeInTheDocument();
    expect(screen.getByTestId("host-theme-changelog")).toHaveTextContent(
      "changed since",
    );
  });

  it("copies CSS when Copy CSS is pressed", async () => {
    const user = userEvent.setup();
    render(
      <HostThemeTokenBrowser
        hostContext={{
          styles: { variables: { "--border-radius-lg": "10px" } },
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Copy CSS" }));
    expect(copyToClipboard).toHaveBeenCalledWith(
      ":root {\n  --border-radius-lg: 10px;\n}\n",
    );
  });
});
