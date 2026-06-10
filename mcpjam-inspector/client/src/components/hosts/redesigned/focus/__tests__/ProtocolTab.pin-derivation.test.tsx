import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";

// The protocol-version dropdown is gated on `stateless-mcp-enabled`.
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
}));

import { ProtocolTab } from "../ProtocolTab";

/**
 * Switching the host-default pin must undo the canonicalizer's stateful
 * derivation (`initialize.supportedProtocolVersions: [pin]`). A stale
 * derived list surviving a switch to Auto would keep constraining the
 * legacy fallback's initialize accept-list to the old version — the exact
 * "Auto fallback keeps stale accept list" failure flagged on the PR.
 * Hand-written lists (anything that isn't exactly `[old stateful pin]`)
 * must pass through untouched.
 */
describe("ProtocolTab — pin change vs derived supportedProtocolVersions", () => {
  function renderWithDraft(draft: HostConfigInputV2) {
    let current = draft;
    const onDraftChange = vi.fn(
      (updater: (prev: HostConfigInputV2) => HostConfigInputV2) => {
        current = updater(current);
      }
    );
    render(
      <ProtocolTab draft={draft} onDraftChange={onDraftChange} attention={[]} />
    );
    return { getDraft: () => current };
  }

  async function pickOption(label: string) {
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: label }));
  }

  it("drops the derived [stateful pin] list when switching to Auto", async () => {
    const { getDraft } = renderWithDraft({
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-06-18",
        // Exactly what canonicalizeMcpProfile materializes for the pin.
        initialize: { supportedProtocolVersions: ["2025-06-18"] },
      },
    });

    await pickOption("Auto (detect per server)");

    expect(getDraft().mcpProfile?.mcpProtocolVersion).toBe("auto");
    expect(getDraft().mcpProfile?.initialize).toBeUndefined();
  });

  it("keeps a hand-written multi-version list across a pin change", async () => {
    const { getDraft } = renderWithDraft({
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-06-18",
        initialize: {
          supportedProtocolVersions: ["2025-06-18", "2025-03-26"],
        },
      },
    });

    await pickOption("Auto (detect per server)");

    expect(getDraft().mcpProfile?.mcpProtocolVersion).toBe("auto");
    expect(
      getDraft().mcpProfile?.initialize?.supportedProtocolVersions
    ).toEqual(["2025-06-18", "2025-03-26"]);
  });

  it("preserves clientInfo when only the derived list is dropped", async () => {
    const { getDraft } = renderWithDraft({
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-11-25",
        initialize: {
          clientInfo: { name: "my-host", version: "1.0.0" },
          supportedProtocolVersions: ["2025-11-25"],
        },
      },
    });

    await pickOption("Auto (detect per server)");

    expect(getDraft().mcpProfile?.initialize).toEqual({
      clientInfo: { name: "my-host", version: "1.0.0" },
    });
  });
});
