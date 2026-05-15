import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
import { HostFocusPanel } from "../HostFocusPanel";

describe("HostFocusPanel", () => {
  it("uses global theme shell classes for the panel root", () => {
    const { container } = render(
      <HostFocusPanel
        tab="behavior"
        onTabChange={vi.fn()}
        initialSelectedServerId={null}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        availableServers={[]}
        onAddServer={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bbg-background\b/);
    expect(root.className).not.toMatch(/#09090b|text-zinc-100/);
  });

  it("shows Agent in the header tab bar with neutral icon chrome only", () => {
    render(
      <HostFocusPanel
        tab="protocol"
        onTabChange={vi.fn()}
        initialSelectedServerId={null}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        availableServers={[]}
        onAddServer={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveAttribute("aria-orientation", "horizontal");

    const agentTab = screen.getByRole("tab", { name: /^Agent$/ });
    expect(agentTab).toBeInTheDocument();
    expect(within(agentTab).queryByText("AGENT")).toBeNull();
    const iconWell = agentTab.querySelector(".rounded-md");
    expect(iconWell?.className.includes("var(--primary)")).toBe(false);
  });

  it("shows Apps Extension in the header tab bar without SEP-1865 subtext", () => {
    render(
      <HostFocusPanel
        tab="protocol"
        onTabChange={vi.fn()}
        initialSelectedServerId={null}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        availableServers={[]}
        onAddServer={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const appsTab = screen.getByRole("tab", { name: /^Apps Extension$/ });
    expect(appsTab).toBeInTheDocument();
    expect(within(appsTab).queryByText(/SEP-1865/)).toBeNull();
    const appsIconWell = appsTab.querySelector(".rounded-md");
    expect(appsIconWell?.className.includes("var(--info")).toBe(false);
  });

  it("shows MCP Protocol in the header tab bar without wire subtext", () => {
    render(
      <HostFocusPanel
        tab="apps"
        onTabChange={vi.fn()}
        initialSelectedServerId={null}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        availableServers={[]}
        onAddServer={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const protocolTab = screen.getByRole("tab", {
      name: /^MCP Protocol$/,
    });
    expect(protocolTab).toBeInTheDocument();
    expect(within(protocolTab).queryByText(/^wire$/i)).toBeNull();
  });

  it("includes a General tab in the tab bar", () => {
    render(
      <HostFocusPanel
        tab="general"
        onTabChange={vi.fn()}
        initialSelectedServerId={null}
        hostDisplayName="My Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        availableServers={[]}
        onAddServer={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: /^General$/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Host name" })).toHaveValue(
      "My Host",
    );
  });

  it("does not show a placeholder Advanced tab", () => {
    render(
      <HostFocusPanel
        tab="servers"
        onTabChange={vi.fn()}
        initialSelectedServerId={null}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        availableServers={[]}
        onAddServer={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tab", { name: /^Advanced$/i })).toBeNull();
  });
});
