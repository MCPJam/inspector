import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { CLAUDE_HOST_STYLE } from "@/lib/client-styles";
import { HostStyleTokens } from "../HostStyleTokens";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.assign(navigator, { clipboard: mockClipboard });

function draftWith(patch: Partial<HostConfigInputV2>): HostConfigInputV2 {
  return { ...emptyHostConfigInputV2(), ...patch };
}

function expandTokens() {
  fireEvent.click(screen.getByRole("button", { name: /style tokens/i }));
}

// File-level, not per-describe: a `mockRejectedValue` set by the failure test
// otherwise leaks into every describe below it, silently running their
// success paths through the catch branch.
beforeEach(() => {
  vi.clearAllMocks();
  mockClipboard.writeText.mockResolvedValue(undefined);
});

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
    // The glyph chip previews the property the token drives.
    expect(within(row as HTMLElement).getByText("Aa")).toHaveStyle({
      fontWeight: light["--font-weight-bold"] as string,
    });
    const monoRow = screen.getByText("--font-mono").closest("button");
    expect(within(monoRow as HTMLElement).getByText("Aa")).toHaveStyle({
      fontFamily: light["--font-mono"] as string,
    });
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
  it("says so when the host sends neither variables nor font CSS", () => {
    const draft = draftWith({
      hostStyle: "claude",
      chatUiOverride: {
        styleVariables: { light: {}, dark: {} },
        fontCss: "",
      },
    } as Partial<HostConfigInputV2>);
    render(<HostStyleTokens draft={draft} />);
    expandTokens();

    expect(screen.getByText(/sends no style variables/i)).toBeInTheDocument();
    expect(screen.getByText(/no font css/i)).toBeInTheDocument();
  });

  it("counts the union of both themes and shows a one-theme token alone", () => {
    const draft = draftWith({
      hostStyle: "claude",
      chatUiOverride: {
        styleVariables: {
          // Light drops the secondary token entirely, so a listing built
          // from either theme alone would under-report by one.
          light: { "--color-text-primary": "#111111" },
          dark: {
            "--color-text-primary": "#eeeeee",
            "--color-text-secondary": "#222222",
          },
        },
      },
    } as Partial<HostConfigInputV2>);
    render(<HostStyleTokens draft={draft} />);
    // Union, not the smaller theme: 2 tokens travel over the wire.
    expect(screen.getByText("2")).toBeInTheDocument();

    expandTokens();
    const row = screen.getByText("--color-text-secondary").closest("button");
    expect(row).not.toBeNull();
    // One theme only — rendered bare, not as a light-dark() pair.
    expect(within(row as HTMLElement).getByText("#222222")).toBeInTheDocument();
    expect(screen.queryByText(/light-dark\(#222222/)).toBeNull();
  });

  it("previews a token the host sends in dark only", () => {
    const draft = draftWith({
      hostStyle: "claude",
      chatUiOverride: {
        styleVariables: {
          // Nothing in light: the preview has only the dark value to read.
          light: {},
          dark: {
            "--font-mono": "Menlo, monospace",
            "--font-weight-bold": "800",
            "--border-radius-lg": "9px",
          },
        },
      },
    } as Partial<HostConfigInputV2>);
    render(<HostStyleTokens draft={draft} />);
    expandTokens();

    const monoRow = screen.getByText("--font-mono").closest("button");
    expect(within(monoRow as HTMLElement).getByText("Aa")).toHaveStyle({
      fontFamily: "Menlo, monospace",
    });
    const boldRow = screen.getByText("--font-weight-bold").closest("button");
    expect(within(boldRow as HTMLElement).getByText("Aa")).toHaveStyle({
      fontWeight: "800",
    });
    // Same fallback in the non-type previews.
    const radiusRow = screen.getByText("--border-radius-lg").closest("button");
    expect(
      (radiusRow as HTMLElement).querySelector('[style*="border-radius: 9px"]')
    ).not.toBeNull();
  });

  it("reports a clipboard failure instead of claiming a copy", async () => {
    mockClipboard.writeText.mockRejectedValue(new Error("denied"));
    render(<HostStyleTokens draft={draftWith({ hostStyle: "claude" })} />);
    expandTokens();

    fireEvent.click(
      screen.getByText("--color-text-primary").closest("button") as HTMLElement
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("HostStyleTokens per-row copy", () => {
  it("copies var(--token) from the row and confirms on that row alone", async () => {
    render(<HostStyleTokens draft={draftWith({ hostStyle: "claude" })} />);
    expandTokens();

    fireEvent.click(
      screen.getByRole("button", { name: "Copy var(--color-text-primary)" })
    );

    await waitFor(() =>
      expect(mockClipboard.writeText).toHaveBeenCalledWith(
        "var(--color-text-primary)"
      )
    );
    // The row's own icon confirms; a toast per copy would be noise down 76 rows.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    // That confirmation is the check mark, and only on the row that copied.
    const row = screen
      .getByText("--color-text-primary")
      .closest("button") as HTMLElement;
    await waitFor(() =>
      expect(row.querySelector(".lucide-check")).not.toBeNull()
    );
    const other = screen
      .getByText("--color-text-secondary")
      .closest("button") as HTMLElement;
    expect(other.querySelector(".lucide-check")).toBeNull();
  });

  it("labels every row with the value it puts on the clipboard", () => {
    render(<HostStyleTokens draft={draftWith({ hostStyle: "claude" })} />);
    expandTokens();

    // The row IS the button, so its accessible name has to say what clicking
    // does — the token name alone would announce as an unexplained control.
    const row = screen.getByText("--font-mono").closest("button");
    expect(row).toHaveAttribute("aria-label", "Copy var(--font-mono)");
  });
});
