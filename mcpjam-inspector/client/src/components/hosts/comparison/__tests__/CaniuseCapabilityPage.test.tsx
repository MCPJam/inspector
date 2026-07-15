import { render, screen } from "@testing-library/react";
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

describe("CaniuseCapabilityPage", () => {
  it("renders a capability permalink page with definition, statuses, and verified dates", () => {
    render(<CaniuseCapabilityPage capabilitySlug="sampling" />);

    expect(
      screen.getByRole("heading", { name: "Sampling" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Server-initiated LLM calls.")).toBeInTheDocument();
    expect(screen.getByText("/capabilities/sampling")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getAllByText("2026-07-07").length).toBeGreaterThan(0);
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

  it("renders a not-found state for unknown capability slugs", () => {
    render(<CaniuseCapabilityPage capabilitySlug="not-a-capability" />);

    expect(
      screen.getByRole("heading", { name: "Capability not found" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Full matrix" })).toHaveAttribute(
      "href",
      "/embed/host-compare",
    );
  });
});
