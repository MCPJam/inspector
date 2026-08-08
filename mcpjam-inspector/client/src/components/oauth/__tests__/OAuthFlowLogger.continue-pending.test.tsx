import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OAuthFlowLogger } from "../OAuthFlowLogger";
import { EMPTY_OAUTH_FLOW_STATE } from "@/lib/types/oauth-flow-types";

// jsdom has no Element.scrollTo; the logger auto-scrolls its transcript on
// mount. Unrelated to what these tests assert.
beforeAll(() => {
  Element.prototype.scrollTo = vi.fn();
});

function renderLogger(actions: Record<string, unknown>) {
  return render(
    <OAuthFlowLogger
      oauthFlowState={EMPTY_OAUTH_FLOW_STATE}
      onClearLogs={vi.fn()}
      onClearHttpHistory={vi.fn()}
      summary={{ label: "example.test", description: "OAuth debugger" }}
      actions={actions as never}
    />,
  );
}

describe("OAuthFlowLogger — Continue pending state", () => {
  it("shows the idle label and stays clickable when not pending", () => {
    renderLogger({ onContinue: vi.fn(), continueLabel: "Next Step" });

    const button = screen.getByRole("button", { name: "Next Step" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("shows 'Continuing...' and disables while an advance is in flight", () => {
    // Matches the sibling Connect/Refresh convention. Without it the button
    // looked inert for the whole round trip, which is what produced the
    // rageclick hotspot on this surface.
    renderLogger({
      onContinue: vi.fn(),
      continueLabel: "Next Step",
      continuePending: true,
    });

    const button = screen.getByRole("button", { name: "Continuing..." });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Next Step" })).toBeNull();
  });

  it("stays disabled when the flow itself disables Continue", () => {
    renderLogger({
      onContinue: vi.fn(),
      continueLabel: "Next Step",
      continueDisabled: true,
    });

    expect(screen.getByRole("button", { name: "Next Step" })).toBeDisabled();
  });
});
