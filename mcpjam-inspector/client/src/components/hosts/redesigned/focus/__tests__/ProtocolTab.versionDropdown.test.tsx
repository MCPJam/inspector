import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

import { ProtocolTab } from "../ProtocolTab";

function Harness({ initial }: { initial: HostConfigInputV2 }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div>
      <div data-testid="pin">
        {draft.mcpProfile?.mcpProtocolVersion ?? "<undefined>"}
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

    await user.click(screen.getByRole("combobox", { name: "MCP protocol version" }));

    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent)
    ).toEqual([
      "Automatic",
      "Latest (2026-07-28)",
      "November (2025-11-25)",
      "2025-06-18",
      "2025-03-26",
    ]);
  });

  it("pins 'Latest' to the newest known protocol version", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(screen.getByRole("combobox", { name: "MCP protocol version" }));

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

    await user.click(screen.getByRole("combobox", { name: "MCP protocol version" }));
    await user.click(
      screen.getByRole("option", { name: "November (2025-11-25)" })
    );

    // A stateful pin is not cosmetic: it narrows the initialize accept-list.
    expect(screen.getByTestId("pin").textContent).toBe("2025-11-25");

    await user.click(screen.getByRole("combobox", { name: "MCP protocol version" }));
    await user.click(screen.getByRole("option", { name: "2025-06-18" }));
    expect(screen.getByTestId("pin").textContent).toBe("2025-06-18");
  });

  it("defaults an unpinned host to Automatic and stores no pin", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);

    expect(screen.getByRole("combobox", { name: "MCP protocol version" })).toHaveTextContent("Automatic");
    expect(screen.getByTestId("pin").textContent).toBe("<undefined>");
  });

  it("selecting Latest pins 2026-07-28; returning to Automatic clears it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(screen.getByRole("combobox", { name: "MCP protocol version" }));
    await user.click(screen.getByRole("option", { name: /Latest/i }));
    expect(screen.getByTestId("pin").textContent).toBe("2026-07-28");

    // Back to Automatic must restore ABSENCE, not a 2025 literal — a stored
    // literal would churn the canonical config hash against every
    // pre-feature row.
    await user.click(screen.getByRole("combobox", { name: "MCP protocol version" }));
    await user.click(screen.getByRole("option", { name: "Automatic" }));
    expect(screen.getByTestId("pin").textContent).toBe("<undefined>");
  });

  it("shows a stored legacy pin as itself instead of collapsing it", () => {
    const initial = emptyHostConfigInputV2({
      mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-06-18" },
    } as Partial<HostConfigInputV2>);
    render(<Harness initial={initial} />);

    // Previously every non-RC literal rendered as the single unpinned entry,
    // so a genuinely pinned host misreported itself as unpinned.
    expect(screen.getByRole("combobox", { name: "MCP protocol version" })).toHaveTextContent("2025-06-18");
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
    expect(screen.getByRole("combobox", { name: "MCP protocol version" })).toHaveTextContent("Automatic");
  });
});
