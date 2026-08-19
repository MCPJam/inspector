import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { CLAUDE_HOST_STYLE } from "@/lib/client-styles";
import { HostStyleTokens } from "../HostStyleTokens";

function draftWith(patch: Partial<HostConfigInputV2>): HostConfigInputV2 {
  return { ...emptyHostConfigInputV2(), ...patch };
}

function expandTokens() {
  fireEvent.click(screen.getByRole("button", { name: /style tokens/i }));
}

describe("HostStyleTokens", () => {
  it("lists the host preset's tokens, grouped, with the light/dark pair", () => {
    render(<HostStyleTokens draft={draftWith({ hostStyle: "claude" })} />);
    expandTokens();

    const light = CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light");
    const dark = CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("dark");
    // Scoped to the row: distinct tokens can legitimately share a value
    // (Claude's text-primary and background-inverse are the same pair).
    const row = screen.getByText("--color-text-primary").closest("button");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText(
        `light-dark(${light["--color-text-primary"]}, ${dark["--color-text-primary"]})`
      )
    ).toBeInTheDocument();
    // Group headers come from the token prefixes.
    expect(screen.getByText("Background")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("collapses a token whose light and dark values match to a single value", () => {
    render(<HostStyleTokens draft={draftWith({ hostStyle: "claude" })} />);
    expandTokens();

    const light = CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light");
    const row = screen.getByText("--font-weight-bold").closest("button");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText(
        light["--font-weight-bold"] as string
      )
    ).toBeInTheDocument();
  });

  it("renders the config's persisted override instead of the preset", () => {
    const draft = draftWith({
      hostStyle: "claude",
      chatUiOverride: {
        styleVariables: {
          light: { "--color-text-primary": "#111111" },
          dark: { "--color-text-primary": "#eeeeee" },
        },
        fontCss: "@import url(https://example.test/font.css);",
      },
    } as Partial<HostConfigInputV2>);
    render(<HostStyleTokens draft={draft} />);
    expandTokens();

    expect(
      screen.getByText("light-dark(#111111, #eeeeee)")
    ).toBeInTheDocument();
    expect(
      screen.getByText("@import url(https://example.test/font.css);")
    ).toBeInTheDocument();
    // A full replacement, not a merge — the preset's other tokens are gone.
    expect(screen.queryByText("--color-background-primary")).toBeNull();
  });

  it("stays collapsed until asked, and reports the token count", () => {
    render(<HostStyleTokens draft={draftWith({ hostStyle: "claude" })} />);
    expect(screen.queryByText("--color-text-primary")).toBeNull();

    const count = Object.values(
      CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light")
    ).filter((v) => v !== undefined).length;
    expect(screen.getByText(String(count))).toBeInTheDocument();
  });
});
