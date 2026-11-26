import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CaniuseCapabilityPage } from "../CaniuseCapabilityPage";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  return {
    useHostCatalog: () => ({
      status: "live",
      catalog: bundledHostCompatCatalog(),
      version: 1,
      source: "live",
    }),
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

function renderCapability(slug: string, search = "") {
  render(
    <MemoryRouter initialEntries={[`/capabilities/${slug}${search}`]}>
      <CaniuseCapabilityPage capabilitySlug={slug} />
    </MemoryRouter>,
  );
}

describe("CaniuseCapabilityPage", () => {
  it("renders a capability permalink page with definition, statuses, and verified dates", () => {
    renderCapability("sampling");

    expect(
      screen.getByRole("heading", { name: "Sampling" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Server-initiated LLM calls.")).toBeInTheDocument();
    expect(screen.getByText("/capabilities/sampling")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getAllByText("2026-08-14").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Supported|Partial|Not supported/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Verify against your server" }),
    ).toHaveAttribute("href", "https://app.mcpjam.com");
    expect(screen.getByRole("link", { name: "Full matrix" })).toHaveAttribute(
      "href",
      "/embed/host-compare",
    );
  });

  it("shows the flag-gated hosts — the flags gate creation, not this page", () => {
    // `useFeatureFlagEnabled` is mocked false above: the anonymous-visitor
    // case, and the one that used to hide these two from caniuse entirely.
    renderCapability("sampling");

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("renders a not-found state for unknown capability slugs", () => {
    renderCapability("not-a-capability");

    expect(
      screen.getByRole("heading", { name: "Capability not found" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Full matrix" })).toHaveAttribute(
      "href",
      "/embed/host-compare",
    );
  });

  it("uses the protocol version from a matrix link to scope support", () => {
    const query = "?slice=2026-07-28";
    renderCapability("supported-protocol-versions", query);
    expect(screen.getByText(`/capabilities/supported-protocol-versions${query}`)).toBeVisible();
    const cursor = screen.getByText("Cursor").parentElement?.parentElement;
    const claude = screen.getByText("Claude").parentElement?.parentElement;
    expect(screen.getByText("MCPJam")).toBeVisible();
    expect(within(cursor!).getByText("Not supported")).toBeVisible();
    expect(within(claude!).getByText("Supported")).toBeVisible();
  });
});
