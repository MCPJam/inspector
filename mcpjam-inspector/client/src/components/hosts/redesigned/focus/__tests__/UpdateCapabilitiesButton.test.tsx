import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  bundledHostCompatCatalog,
  getTemplateMcpAppsCapabilities,
} from "@mcpjam/sdk/host-compat";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { UpdateCapabilitiesButton } from "../UpdateCapabilitiesButton";

const liveCatalog = bundledHostCompatCatalog();

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const sdk = await vi.importActual<typeof import("@mcpjam/sdk/host-compat")>(
    "@mcpjam/sdk/host-compat"
  );
  return {
    useHostCatalog: () => ({
      status: "live",
      catalog: sdk.bundledHostCompatCatalog(),
      version: 1,
      source: "live",
    }),
  };
});

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn() },
}));

function renderButton(initialDraft: HostConfigInputV2) {
  const draftRef: { current: HostConfigInputV2 } = { current: initialDraft };

  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    draftRef.current = draft;
    return (
      <UpdateCapabilitiesButton
        draft={draft}
        onDraftChange={(updater) =>
          setDraft((prev) => {
            const next = updater(prev);
            draftRef.current = next;
            return next;
          })
        }
      />
    );
  }

  const utils = render(<Harness />);
  return { draftRef, ...utils };
}

describe("UpdateCapabilitiesButton", () => {
  it("writes a catalog capability snapshot when the draft has no saved override", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderButton(
      emptyHostConfigInputV2({ hostStyle: "claude" })
    );

    const button = screen.getByRole("button", {
      name: /update capabilities from catalog/i,
    });
    expect(button).toBeEnabled();

    await user.click(button);

    expect(draftRef.current.mcpProfile?.apps?.mcpAppsOverrides).toEqual(
      getTemplateMcpAppsCapabilities(liveCatalog, "claude")
    );
    expect(draftRef.current.hostCapabilitiesOverride).toBeUndefined();
  });

  it("writes a catalog capability snapshot from legacy template capabilities", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderButton(
      emptyHostConfigInputV2({ hostStyle: "mcpjam" })
    );

    const button = screen.getByRole("button", {
      name: /update capabilities from catalog/i,
    });
    expect(button).toBeEnabled();

    await user.click(button);

    expect(draftRef.current.mcpProfile?.apps?.mcpAppsOverrides).toEqual(
      getTemplateMcpAppsCapabilities(liveCatalog, "mcpjam")
    );
    expect(draftRef.current.hostCapabilitiesOverride).toBeUndefined();
  });

  it("disables after the saved capability snapshot matches the live catalog", () => {
    const latest = getTemplateMcpAppsCapabilities(liveCatalog, "claude");
    renderButton(
      emptyHostConfigInputV2({
        hostStyle: "claude",
        mcpProfile: {
          profileVersion: 1,
          apps: { mcpAppsOverrides: latest },
        },
      })
    );

    expect(
      screen.getByRole("button", {
        name: /update capabilities from catalog/i,
      })
    ).toBeDisabled();
  });
});
