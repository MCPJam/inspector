import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";

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
      <div data-testid="cancellation">
        {draft.mcpProfile?.toolCallCancellation === undefined
          ? "<undefined>"
          : JSON.stringify(draft.mcpProfile.toolCallCancellation)}
      </div>
      <ProtocolTab
        draft={draft}
        onDraftChange={(updater) => setDraft((prev) => updater(prev))}
        attention={[]}
      />
    </div>
  );
}

const legacySwitch = () =>
  screen.getByRole("switch", { name: "Tool cancellation (2025)" });
const modernSwitch = () =>
  screen.getByRole("switch", { name: "Tool cancellation (2026)" });

const withProfile = (
  toolCallCancellation: Record<string, boolean>,
): HostConfigInputV2 =>
  ({
    ...emptyHostConfigInputV2(),
    mcpProfile: { profileVersion: 1, toolCallCancellation },
  }) as HostConfigInputV2;

/**
 * Two switches rather than one, because a host can cancel correctly on 2025
 * and not at all on 2026 — MCPJam itself did. The eras are separate questions
 * with separate evidence, so neither control may move the other.
 */
describe("ProtocolTab tool-cancellation controls", () => {
  it("shows both eras as cancelling for a host that never configured it", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);
    expect(legacySwitch()).toBeChecked();
    expect(modernSwitch()).toBeChecked();
    expect(screen.getByTestId("cancellation").textContent).toBe("<undefined>");
  });

  it("stores only the era that was turned off", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(modernSwitch());

    // The 2025 leaf must stay absent — absent means "cancels", and writing
    // `legacy: true` would claim a measurement nobody made.
    expect(screen.getByTestId("cancellation").textContent).toBe(
      '{"modern":false}',
    );
    expect(legacySwitch()).toBeChecked();
  });

  it("keeps the two eras independent", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withProfile({ modern: false })} />);
    expect(modernSwitch()).not.toBeChecked();
    expect(legacySwitch()).toBeChecked();

    await user.click(legacySwitch());

    expect(
      JSON.parse(screen.getByTestId("cancellation").textContent ?? "{}"),
    ).toEqual({ legacy: false, modern: false });
  });

  it("writes ABSENCE when the last era is switched back on", async () => {
    // Delete-on-default, collapsing the whole record: an untouched host must
    // keep hashing exactly as it did before the field existed.
    const user = userEvent.setup();
    render(<Harness initial={withProfile({ legacy: false })} />);
    expect(legacySwitch()).not.toBeChecked();

    await user.click(legacySwitch());

    expect(screen.getByTestId("cancellation").textContent).toBe("<undefined>");
  });
});
