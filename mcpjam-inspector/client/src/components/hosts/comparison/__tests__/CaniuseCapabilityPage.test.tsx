import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CaniuseCapabilityPage } from "../CaniuseCapabilityPage";

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  return { useHostCatalog: () => ({ catalog: bundledHostCompatCatalog() }) };
});

function renderCapability(slug: string, search = "") {
  return render(
    <MemoryRouter initialEntries={[`/capabilities/${slug}${search}`]}>
      <CaniuseCapabilityPage capabilitySlug={slug} />
    </MemoryRouter>,
  );
}

describe("CaniuseCapabilityPage", () => {
  it("defaults to Client map and offers the reference table with catalog dates", () => {
    renderCapability("sampling");
    expect(
      screen.getByRole("heading", { name: "Sampling" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Client map" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getAllByLabelText(/Last checked \d{4}-\d{2}-\d{2}/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Compare clients" }),
    ).toHaveAttribute("href", "/compare");

    fireEvent.click(screen.getByRole("button", { name: "Reference table" }));
    const reference = within(screen.getByRole("table"));
    expect(
      reference.getByRole("columnheader", { name: "Last checked" }),
    ).toBeInTheDocument();
    expect(
      reference.getByRole("rowheader", { name: "Claude Code" }),
    ).toBeInTheDocument();
    expect(
      reference.getByRole("rowheader", { name: "Codex" }),
    ).toBeInTheDocument();
  });

  it("restores a mode from the URL and shares the same mode on X and LinkedIn", () => {
    renderCapability("event-delivery", "?slice=poll&view=reference");
    expect(screen.getByRole("button", { name: /poll/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    const url = "https://caniuse.dev/capabilities/event-delivery?slice=poll";
    for (const name of ["Post to X", "Post to LinkedIn"]) {
      const href = screen.getByRole<HTMLAnchorElement>("link", { name }).href;
      expect(new URL(href).searchParams.get("url")).toBe(url);
    }
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
  });

  it("retains navigation on a missing capability", () => {
    renderCapability("not-a-capability");
    expect(
      screen.getByRole("heading", { name: "Capability not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Compare clients" }),
    ).toHaveAttribute("href", "/compare");
  });
});
