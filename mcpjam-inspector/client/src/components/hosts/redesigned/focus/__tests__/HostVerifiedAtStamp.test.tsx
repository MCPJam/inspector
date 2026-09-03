import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HostVerifiedAtStamp } from "../HostVerifiedAtStamp";

const CATALOG_VERIFIED_AT = Date.UTC(2026, 8, 2); // 2026-09-02

vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => ({
    status: "live",
    catalog: {},
    version: 1,
    source: "live",
  }),
}));

vi.mock("@mcpjam/sdk/host-compat", () => ({
  getCatalogHost: (_catalog: unknown, hostId: string) =>
    hostId === "unverified"
      ? { id: hostId }
      : hostId === "missing"
        ? undefined
        : { id: hostId, verifiedAt: CATALOG_VERIFIED_AT },
}));

afterEach(() => {
  vi.useRealTimers();
});

function renderAt(now: number, hostStyle = "cursor") {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  render(<HostVerifiedAtStamp hostStyle={hostStyle} />);
}

describe("HostVerifiedAtStamp", () => {
  it("prints the verification date while it is fresh", () => {
    renderAt(CATALOG_VERIFIED_AT + 5 * 24 * 60 * 60 * 1000);
    expect(screen.getByTestId("host-verified-at-stamp")).toHaveTextContent(
      "Last checked 2026-09-02",
    );
  });

  it("swaps the date for the compare matrix's staleness wording past 30 days", () => {
    renderAt(CATALOG_VERIFIED_AT + 31 * 24 * 60 * 60 * 1000);
    const stamp = screen.getByTestId("host-verified-at-stamp");
    expect(stamp).toHaveTextContent("Last checked over 30 days ago");
    // The exact date stays reachable on hover.
    expect(stamp).toHaveAttribute("title", "Last checked 2026-09-02");
  });

  it("renders nothing for a catalog host we have never verified", () => {
    renderAt(CATALOG_VERIFIED_AT, "unverified");
    expect(screen.queryByTestId("host-verified-at-stamp")).toBeNull();
  });

  it("renders nothing for a client with no catalog row", () => {
    renderAt(CATALOG_VERIFIED_AT, "missing");
    expect(screen.queryByTestId("host-verified-at-stamp")).toBeNull();
  });
});
