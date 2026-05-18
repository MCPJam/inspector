import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { ClientFocusPanel } from "../ClientFocusPanel";

describe("ClientFocusPanel", () => {
  it("uses global theme shell classes for the panel root", () => {
    const { container } = render(
      <ClientFocusPanel
        hostId="host-test"
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
      <ClientFocusPanel
        hostId="host-test"
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
    // Tab bar is text-only after the icon-well simplification — there
    // should be no primary-tinted decoration on inactive tabs.
    expect(agentTab.className).not.toMatch(/var\(--primary\)|bg-primary\b/);
  });

  it("shows Apps Extension in the header tab bar without SEP-1865 subtext", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
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
    // Tab bar is text-only after the icon-well simplification — there
    // should be no info-tinted decoration on inactive tabs.
    expect(appsTab.className).not.toMatch(/var\(--info|bg-info\b/);
  });

  it("lets MCP Protocol JSON switch from Edit to View (mode toggle is wired)", async () => {
    const user = userEvent.setup();
    render(
      <ClientFocusPanel
        hostId="host-test"
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

    expect(screen.getByText(/^Ln /)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^View$/ }));

    expect(screen.queryByText(/^Ln /)).toBeNull();
  });

  it("shows MCP Protocol in the header tab bar without wire subtext", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
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

  it("does not include a General tab; host name input still lives in the identity header", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
        tab="behavior"
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

    // General tab was removed; Appearance is temporarily hidden (see
    // HOST_FOCUS_TAB_DEFS) — host-wide chrome may return in a later pass.
    expect(screen.queryByRole("tab", { name: /^General$/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /^Appearance$/ })).toBeNull();
    // The host-name textbox lives in the always-visible identity header.
    expect(screen.getByRole("textbox", { name: "Client name" })).toHaveValue(
      "My Host",
    );
  });

  it("does not surface uses client defaults next to the overrides switch", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
        tab="servers"
        onTabChange={vi.fn()}
        initialSelectedServerId="s1"
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        availableServers={[
          { id: "s1", name: "Bench", url: "https://example.com" },
        ]}
        onAddServer={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("uses client defaults")).toBeNull();
    expect(screen.queryByText(/^active$/)).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Enable overrides" }),
    ).toBeInTheDocument();
  });

  it("does not show a placeholder Advanced tab", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
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
