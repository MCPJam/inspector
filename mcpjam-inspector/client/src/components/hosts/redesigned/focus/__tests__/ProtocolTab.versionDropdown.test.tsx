import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";

// The heavy CodeMirror editor is irrelevant here and slow to mount; the
// dropdown is the unit under test. Same stub contract as
// ProtocolTab.saveGate.test.tsx.
vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({
    rawContent,
    onRawChange,
  }: {
    rawContent: string;
    onRawChange: (next: string) => void;
  }) => (
    <textarea
      aria-label="json"
      value={rawContent}
      onChange={(e) => onRawChange(e.target.value)}
    />
  ),
}));

vi.mock("sonner", () => ({
  toast: { warning: vi.fn() },
}));

import { ProtocolTab } from "../ProtocolTab";
import { buildHostCompatProfiles } from "@/lib/host-compat/profiles";

function Harness({ initial }: { initial: HostConfigInputV2 }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div>
      <div data-testid="pin">
        {draft.mcpProfile?.mcpProtocolVersion ?? "<undefined>"}
      </div>
      <div data-testid="advertised">
        {draft.mcpProfile?.initialize?.supportedProtocolVersions?.join(",") ??
          "<undefined>"}
      </div>
      <ProtocolTab
        draft={draft}
        onDraftChange={(updater) => setDraft((prev) => updater(prev))}
        attention={[]}
      />
    </div>
  );
}

/**
 * The host-level protocol dropdown must NOT advertise a version number for
 * its unpinned state.
 *
 * `undefined` means "the SDK chooses at connect time". Latest always labels
 * the newest concrete wire revision; Automatic remains the unpinned option.
 */
describe("ProtocolTab protocol-version dropdown", () => {
  it("offers Automatic plus every known protocol version, newest first", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );

    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toEqual([
      "Automatic",
      "Latest (2026-07-28)",
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
    ]);
  });

  it("pins 'Latest' to the newest known protocol version", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );

    // Exactly one option may carry the Latest marker, and it must be the
    // newest entry in MCP_PROTOCOL_VERSIONS.
    const latest = screen
      .getAllByRole("option")
      .filter((o) => /^Latest \(/.test(o.textContent ?? ""));
    expect(latest).toHaveLength(1);
    expect(latest[0].textContent).toBe("Latest (2026-07-28)");
  });

  it("writes the exact literal for a non-RC version", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2025-11-25" }));

    // A stateful pin is not cosmetic: it narrows the initialize accept-list.
    expect(screen.getByTestId("pin").textContent).toBe("2025-11-25");

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2025-06-18" }));
    expect(screen.getByTestId("pin").textContent).toBe("2025-06-18");
  });

  it("renders a legacy unpinned host as Automatic without rewriting it", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);

    expect(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    ).toHaveTextContent("Automatic");
    expect(screen.getByTestId("pin").textContent).toBe("<undefined>");
  });

  it("selecting Latest pins 2026-07-28; returning to Automatic stores auto", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: /Latest/i }));
    expect(screen.getByTestId("pin").textContent).toBe("2026-07-28");

    // Automatic is an explicit selection policy, not a wire protocol literal.
    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "Automatic" }));
    expect(screen.getByTestId("pin").textContent).toBe("auto");
  });

  it("shows a stored legacy pin as itself instead of collapsing it", () => {
    const initial = emptyHostConfigInputV2({
      mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-06-18" },
    } as Partial<HostConfigInputV2>);
    render(<Harness initial={initial} />);

    // Previously every non-RC literal rendered as the single unpinned entry,
    // so a genuinely pinned host misreported itself as unpinned.
    expect(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    ).toHaveTextContent("2025-06-18");
  });

  it("falls back to Automatic only for values outside the known set", () => {
    const initial = emptyHostConfigInputV2({
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "DRAFT-2027-zzz",
      },
    } as unknown as Partial<HostConfigInputV2>);
    render(<Harness initial={initial} />);

    // No option exists for an unknown literal; Radix would render a blank
    // trigger if we handed it an unmatched value.
    expect(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    ).toHaveTextContent("Automatic");
  });
});

/**
 * The backend (`canonicalizeMcpProfile`) refuses to store a concrete pin that
 * is absent from `initialize.supportedProtocolVersions` —
 * `ConflictingProtocolVersionPin`. Preset-backed clients carry that list, so
 * offering the full set on them produced choices that failed at Save with an
 * opaque "Server Error". Offer only what saves.
 */
const NARROW_HOST_STYLE = "notion";
const NARROW_HOST_LABEL = "Notion";

describe("ProtocolTab dropdown vs. the client's advertised versions", () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear();
  });

  // Every case below assumes the chosen host is catalogued at exactly
  // 2025-11-25. When that stops being true the seven assertions fail with
  // opaque option-list diffs; this one fails saying what actually changed.
  it("uses a host still catalogued at a single version", () => {
    // Same source the component reads, so this cannot drift from it.
    const profile = buildHostCompatProfiles().find(
      (item) => item.id === NARROW_HOST_STYLE,
    );
    expect(profile?.supportedProtocolVersions).toEqual(["2025-11-25"]);
  });

  // Needs a host whose catalog row is a SINGLE version, so the dropdown is
  // constrained by the row and not by the draft. That premise is asserted
  // above — this file has now had to move twice as rows widened (ChatGPT ->
  // Cursor after the 2026-08-19 ladder probe, Cursor -> Notion after the
  // 2026-09-02 sweep), which is why the premise is a test rather than a
  // comment.
  it("warns, but still switches, for an old client not verified for the chosen version", async () => {
    const user = userEvent.setup();
    const initial = emptyHostConfigInputV2({
      hostStyle: NARROW_HOST_STYLE,
    } as Partial<HostConfigInputV2>);
    render(<Harness initial={initial} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2025-03-26" }));

    expect(toast.warning).toHaveBeenCalledWith(
      `${NARROW_HOST_LABEL} is not verified to support 2025-03-26.`,
    );
    expect(screen.getByTestId("pin")).toHaveTextContent("2025-03-26");
  });

  it("does not warn for an updated client that advertises its supported versions", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withAdvertised(["2025-11-25"])} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2025-11-25" }));

    expect(toast.warning).not.toHaveBeenCalled();
  });

  function withAdvertised(
    supportedProtocolVersions: string[],
    mcpProtocolVersion?: string,
  ): HostConfigInputV2 {
    return emptyHostConfigInputV2({
      // The row lists only 2025-11-25, so the advertised list is the only
      // thing constraining the dropdown here. A client whose catalog row spans
      // both eras (Claude) would widen it on purpose.
      hostStyle: NARROW_HOST_STYLE,
      mcpProfile: {
        profileVersion: 1,
        initialize: { supportedProtocolVersions },
        ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
      },
    } as unknown as Partial<HostConfigInputV2>);
  }

  it("hides stateful versions the client does not advertise", async () => {
    const user = userEvent.setup();
    // The VS Code preset's real list — the case that produced the bug report.
    render(<Harness initial={withAdvertised(["2025-11-25"])} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );

    // Both are stateful and unadvertised, so pinning either could only ever
    // fail at Save.
    const labels = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(labels).not.toContain("2025-06-18");
    expect(labels).not.toContain("2025-03-26");
  });

  it("hides an unadvertised stateless version too", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withAdvertised(["2025-11-25"])} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );

    // Every concrete pin is constrained by the advertised support list,
    // including the stateless 2026 revision. Automatic remains available as
    // the negotiation policy.
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toEqual(["Automatic", "2025-11-25"]);
  });

  it("offers a stateless version when the client does advertise it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withAdvertised(["2025-11-25", "2026-07-28"])} />);

    // Listing the revision IS how a client declares it speaks it — there is no
    // separate stateless-support flag.
    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toEqual(["Automatic", "Latest (2026-07-28)", "2025-11-25"]);
  });

  it("offers every version when the client advertises no list", async () => {
    const user = userEvent.setup();
    // MCPJam's own preset sets no list; the runtime proposes the pin without
    // persisting an allow-list, so the full set stays selectable.
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );

    expect(await screen.findAllByRole("option")).toHaveLength(5);
  });

  it("keeps MCPJam unrestricted and clears a legacy derived list", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={emptyHostConfigInputV2({
          hostStyle: "mcpjam",
          mcpProfile: {
            profileVersion: 1,
            mcpProtocolVersion: "2025-11-25",
            initialize: { supportedProtocolVersions: ["2025-11-25"] },
          },
        } as Partial<HostConfigInputV2>)}
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    expect(await screen.findAllByRole("option")).toHaveLength(5);
    await user.click(screen.getByRole("option", { name: "2025-06-18" }));

    expect(screen.getByTestId("pin")).toHaveTextContent("2025-06-18");
    expect(screen.getByTestId("advertised")).toHaveTextContent("<undefined>");
  });

  it("still renders a stored pin that falls outside the advertised list", async () => {
    const user = userEvent.setup();
    // Rows saved before this filter existed. Dropping the option would blank
    // the trigger and strand the user with a pin they can neither see nor
    // change.
    render(<Harness initial={withAdvertised(["2025-11-25"], "2025-03-26")} />);

    expect(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    ).toHaveTextContent("2025-03-26");

    await user.click(
      screen.getByRole("combobox", { name: "MCP protocol version" }),
    );
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toContain("2025-03-26");
  });

  it("explains the restriction and where to lift it", () => {
    render(<Harness initial={withAdvertised(["2025-11-25"])} />);

    // A short dropdown with no explanation reads as a broken control — the
    // list doing the filtering is invisible unless the JSON editor is open.
    expect(
      screen.getByText(/This client advertises 2025-11-25/),
    ).toBeInTheDocument();
  });

  it("says nothing when the advertised list removes nothing", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);

    expect(screen.queryByText(/This client advertises/)).toBeNull();
  });

  it("warns about an unadvertised stored pin even when the option count is full", () => {
    // Three advertised revisions + the preserved pin 2025-03-26 pads the list
    // back to all five options, so the count-based restriction note stays
    // silent — but saving this draft still throws
    // ConflictingProtocolVersionPin. The warning must not depend on the count.
    render(
      <Harness
        initial={withAdvertised(
          ["2025-11-25", "2025-06-18", "2026-07-28"],
          "2025-03-26",
        )}
      />,
    );

    expect(screen.queryByText(/This client advertises/)).toBeNull();
    expect(
      screen.getByText(
        /Pinned to 2025-03-26, which this client does not advertise/,
      ),
    ).toBeInTheDocument();
  });

  it("warns on an unadvertised pin alongside the restriction note", () => {
    render(<Harness initial={withAdvertised(["2025-11-25"], "2025-03-26")} />);

    expect(
      screen.getByText(
        /Pinned to 2025-03-26, which this client does not advertise/,
      ),
    ).toBeInTheDocument();
  });

  it("does not warn on an advertised or stateless pin", () => {
    // Advertised pin: fine.
    const { unmount } = render(
      <Harness initial={withAdvertised(["2025-11-25"], "2025-11-25")} />,
    );
    expect(screen.queryByText(/does not advertise/)).toBeNull();
    unmount();

    // A stateless pin skips `initialize`, so it never has to appear in that
    // accept-list — both canonicalizers save this shape. Warning here would
    // promise a failure that never comes.
    const second = render(
      <Harness initial={withAdvertised(["2025-11-25"], "2026-07-28")} />,
    );
    expect(screen.queryByText(/does not advertise/)).toBeNull();
    second.unmount();

    // A stateful pin outside the list still throws at Save, so it still warns.
    render(<Harness initial={withAdvertised(["2025-11-25"], "2025-06-18")} />);
    expect(screen.getByText(/does not advertise/)).toBeInTheDocument();
  });
});
