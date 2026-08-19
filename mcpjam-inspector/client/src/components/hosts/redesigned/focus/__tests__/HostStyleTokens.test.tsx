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

describe("HostStyleTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClipboard.writeText.mockResolvedValue(undefined);
  });

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
