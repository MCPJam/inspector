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

// "mcpjam" and "missing" are deliberately absent: a client can name a style
// the catalog we fetched doesn't carry.
const CATALOG_HOSTS: Record<string, { id: string; verifiedAt?: number }> = {
  cursor: { id: "cursor", verifiedAt: CATALOG_VERIFIED_AT },
  unverified: { id: "unverified" },
};

vi.mock("@mcpjam/sdk/host-compat", () => ({
  getCatalogHost: (_catalog: unknown, hostId: string) => CATALOG_HOSTS[hostId],
}));

// Production web stamps this with the deploy time, which only ever applies to
// the MCPJam profile.
vi.mock("@/generated/mcpjam-web-deployed-at", () => ({
  MCPJAM_WEB_DEPLOYED_AT: Date.UTC(2026, 8, 20),
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

  it("renders nothing for MCPJam when the catalog has no row for it", () => {
    // The deploy stamp alone must not stand in for a profile we can't read.
    renderAt(CATALOG_VERIFIED_AT, "mcpjam");
    expect(screen.queryByTestId("host-verified-at-stamp")).toBeNull();
  });
});
