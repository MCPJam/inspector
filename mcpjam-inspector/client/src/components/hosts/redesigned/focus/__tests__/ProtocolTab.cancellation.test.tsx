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
        {String(draft.mcpProfile?.toolCallCancellation ?? "<undefined>")}
      </div>
      <ProtocolTab
        draft={draft}
        onDraftChange={(updater) => setDraft((prev) => updater(prev))}
        attention={[]}
      />
    </div>
  );
}

function draftPinnedTo(version: string | undefined): HostConfigInputV2 {
  return {
    ...emptyHostConfigInputV2(),
    mcpProfile: {
      profileVersion: 1,
      ...(version ? { mcpProtocolVersion: version } : {}),
    },
  } as HostConfigInputV2;
}

/**
 * The row is ONE knob whose label names the era, because the era picks the
 * mechanism and nothing else: closing the response stream on 2026-07-28
 * Streamable HTTP, `notifications/cancelled` on 2025 and on stdio. Splitting
 * it into two fields would imply a host could answer them differently, which
 * the spec does not allow — the negotiated revision decides.
 */
describe("ProtocolTab tool-cancellation control", () => {
  it("names the 2026 era when the host is pinned to a 2026 revision", () => {
    render(<Harness initial={draftPinnedTo("2026-07-28")} />);
    expect(
      screen.getByRole("combobox", { name: "Tool cancellation (2026)" })
    ).toBeInTheDocument();
  });

  it("names the 2025 era when the host is pinned to a 2025 revision", () => {
    render(<Harness initial={draftPinnedTo("2025-11-25")} />);
    expect(
      screen.getByRole("combobox", { name: "Tool cancellation (2025)" })
    ).toBeInTheDocument();
  });

  it("names both eras when the version is unpinned", () => {
    // Auto negotiates at connect time and can land on either, so the label
    // states both rather than guessing one and being wrong half the time.
    render(<Harness initial={emptyHostConfigInputV2()} />);
    expect(
      screen.getByRole("combobox", { name: "Tool cancellation (2025 + 2026)" })
    ).toBeInTheDocument();
  });

  it("stores 'none' for a host that never tells the server", async () => {
    const user = userEvent.setup();
    render(<Harness initial={draftPinnedTo("2026-07-28")} />);

    await user.click(
      screen.getByRole("combobox", { name: "Tool cancellation (2026)" })
    );
    await user.click(await screen.findByRole("option", { name: "Not supported" }));

    expect(screen.getByTestId("cancellation").textContent).toBe("false");
  });

  it("writes ABSENCE when switched back, so an untouched host keeps its hash", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={
          {
            ...emptyHostConfigInputV2(),
            mcpProfile: { profileVersion: 1, toolCallCancellation: false },
          } as HostConfigInputV2
        }
      />
    );
    expect(screen.getByTestId("cancellation").textContent).toBe("false");

    await user.click(
      screen.getByRole("combobox", { name: "Tool cancellation (2025 + 2026)" })
    );
    await user.click(
      await screen.findByRole("option", { name: "Supported (default)" })
    );

    expect(screen.getByTestId("cancellation").textContent).toBe("<undefined>");
  });
});
