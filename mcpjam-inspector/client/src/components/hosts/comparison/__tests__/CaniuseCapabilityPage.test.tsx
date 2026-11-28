import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CaniuseCapabilityPage } from "../CaniuseCapabilityPage";

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  return { useHostCatalog: () => ({ catalog: bundledHostCompatCatalog() }) };
});

vi.mock("../caniuse-report-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../caniuse-report-card")>()),
  drawCaniuseReportCard: vi.fn().mockResolvedValue(undefined),
}));

function renderCapability(slug: string, search = "") {
  return render(
    <MemoryRouter initialEntries={[`/capabilities/${slug}${search}`]}>
      <CaniuseCapabilityPage capabilitySlug={slug} />
    </MemoryRouter>,
  );
}

describe("CaniuseCapabilityPage", () => {
  it("shows the Client map and catalog dates on old reference links", () => {
    renderCapability("sampling", "?view=reference");
    expect(screen.getByRole("heading", { name: "Sampling" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Client map" })).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("link", { name: "Test this capability" })).toHaveAttribute(
      "href",
      "https://app.mcpjam.com/playground",
    );
    expect(
      screen.getAllByLabelText(/Last checked \d{4}-\d{2}-\d{2}/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Compare" })).toHaveAttribute(
      "href",
      "/compare",
    );
  });

  it("shows Events support and published results among probed clients", () => {
    renderCapability("event-delivery");
    expect(screen.getByRole("link", { name: "Test this capability" })).toHaveAttribute(
      "href",
      "https://app.mcpjam.com/events?fallback=playground",
    );
    const score = within(
      screen.getByRole("region", { name: "Support among probed clients" }),
    );
    expect(
      score.getByText(/probed clients have confirmed support for at least one delivery mode/),
    ).toBeVisible();
    expect(
      score.getByText("Published results"),
    ).toBeVisible();
    expect(score.queryByText(/with no published result/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Supports at least one delivery mode" }),
    ).toBeVisible();
  });

  it("filters the sidebar and exposes matches from collapsed groups", () => {
    renderCapability("event-delivery");
    const nav = within(screen.getByRole("navigation", { name: "Browse capabilities" }));
    const search = nav.getByRole("searchbox", { name: "Search capabilities" });
    expect(nav.getByRole("link", { name: "MCP Events" })).toHaveAttribute("aria-current", "page");
    fireEvent.change(search, { target: { value: "Sampling" } });
    expect(nav.getByRole("link", { name: "Sampling" })).toHaveAttribute("href", "/capabilities/sampling");
    expect(nav.queryByText("MCP Events")).not.toBeInTheDocument();
    const sampling = nav.getByRole("link", { name: "Sampling" });
    sampling.focus();
    fireEvent.click(sampling);
    expect(sampling).toHaveFocus();
    expect(search).toHaveValue("Sampling");
    fireEvent.click(nav.getByRole("button", { name: "Clear search" }));
    expect(nav.getByRole("link", { name: "MCP Events" })).toHaveAttribute("aria-current", "page");
  });

  it("restores a mode from the URL, shares the same mode and prepares the PNG", async () => {
    renderCapability("event-delivery", "?slice=poll&view=reference");
    expect(screen.getByRole("button", { name: /poll/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("region", { name: "Client map" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const download = await screen.findByRole("button", { name: "Download image" });
    await vi.waitFor(() => expect(download).toBeEnabled());

    const url = "https://caniuse.dev/capabilities/event-delivery?slice=poll";
    for (const name of ["Post to X", "Post to LinkedIn"]) {
      const href = screen.getByRole<HTMLAnchorElement>("link", { name }).href;
      expect(new URL(href).searchParams.get("url")).toBe(url);
    }
    const x = screen.getByRole<HTMLAnchorElement>("link", { name: "Post to X" });
    expect(new URL(x.href).searchParams.get("text")).toMatch(
      /probed clients have confirmed support for poll delivery/,
    );
  });

  it("uses the protocol version from a matrix link to scope the Client map", () => {
    renderCapability("supported-protocol-versions", "?slice=2026-07-28");
    expect(screen.getByRole("button", { name: "2026-07-28" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const supported = screen.getByRole("region", { name: "Supported", exact: true });
    const unsupported = screen.getByRole("region", { name: "Not supported" });
    expect(within(supported).getByRole("img", { name: /^Claude\./ })).toBeVisible();
    expect(within(unsupported).getByRole("img", { name: /^Cursor\./ })).toBeVisible();
  });

  it("shows Tasks without claiming any published results", () => {
    renderCapability("mcp-tasks");
    expect(
      screen.getByRole("heading", { name: "MCP Tasks" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No published client results yet."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Not supported" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const x = screen.getByRole<HTMLAnchorElement>("link", { name: "Post to X" });
    expect(new URL(x.href).searchParams.get("text")).toContain("No published client results yet");
    expect(screen.getByRole("img", { name: /No published client results yet/ })).toBeInTheDocument();
  });

  it("opens verification details on the first tap and dismisses them on the second", async () => {
    renderCapability("event-delivery", "?slice=poll");
    const tile = screen.getByRole("img", { name: /^ChatGPT\. Last checked/ });
    function tap(focus = false) {
      fireEvent.pointerDown(tile, { pointerType: "touch" });
      fireEvent.pointerUp(tile, { pointerType: "touch" });
      if (focus) fireEvent.focus(tile);
      fireEvent(
        tile,
        new PointerEvent("click", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
        }),
      );
    }

    tap(true);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/Last checked/);
    tap();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("retains navigation on a missing capability", () => {
    renderCapability("not-a-capability");
    expect(
      screen.getByRole("heading", { name: "Capability not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Compare" }),
    ).toHaveAttribute("href", "/compare");
  });
});
