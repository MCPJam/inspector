import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ProtocolVersionBadge,
  ProtocolVersionSelector,
} from "../ProtocolVersionSelector";

describe("ProtocolVersionSelector release status", () => {
  it("marks 2026-07-28 as latest", () => {
    render(<ProtocolVersionSelector value="2026-07-28" onChange={vi.fn()} />);

    expect(screen.getAllByText("Latest").length).toBeGreaterThan(0);
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
  });

  it("marks 2025-11-25 as stable", () => {
    render(<ProtocolVersionBadge value="2025-11-25" />);

    expect(screen.getByText("Stable")).toBeInTheDocument();
    expect(screen.queryByText("Latest")).not.toBeInTheDocument();
  });
});
