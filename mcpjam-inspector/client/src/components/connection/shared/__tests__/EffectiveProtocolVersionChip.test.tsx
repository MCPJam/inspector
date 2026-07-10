import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EffectiveProtocolVersionChip } from "../EffectiveProtocolVersionChip";

describe("EffectiveProtocolVersionChip", () => {
  it("renders 'Latest' for an unpinned server when the flag is off", () => {
    // Main GA'd the chip un-gated: it always renders. With the flag off,
    // unpinned connections still use the legacy SDK default, so the label
    // stays "Latest" — "Auto" would claim behavior that isn't active.
    render(<EffectiveProtocolVersionChip />);
    expect(screen.getByText("Latest")).toBeInTheDocument();
  });

  it("renders 'Auto' when unpinned (the new host default)", () => {
    render(<EffectiveProtocolVersionChip flagEnabled />);
    expect(screen.getByText("Auto")).toBeInTheDocument();
  });

  it("renders 'Auto' for the explicit auto sentinel", () => {
    render(<EffectiveProtocolVersionChip flagEnabled hostDefault="auto" />);
    expect(screen.getByText("Auto")).toBeInTheDocument();
  });

  it("renders the concrete version for an explicit pin", () => {
    render(
      <EffectiveProtocolVersionChip flagEnabled hostDefault="2026-07-28" />
    );
    expect(screen.getByText("2026-07-28")).toBeInTheDocument();
  });

  it("prefers a per-server override over the host default", () => {
    render(
      <EffectiveProtocolVersionChip
        flagEnabled
        hostDefault="auto"
        serverOverride="2025-11-25"
      />
    );
    expect(screen.getByText("2025-11-25")).toBeInTheDocument();
  });
});
