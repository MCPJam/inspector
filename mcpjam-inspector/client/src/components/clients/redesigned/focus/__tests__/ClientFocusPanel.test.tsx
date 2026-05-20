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
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        onClose={vi.fn()}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bbg-background\b/);
    expect(root.className).not.toMatch(/#09090b|text-zinc-100/);
  });

  it("does not render issue-count badges on focus tabs", () => {
    const { container } = render(
      <ClientFocusPanel
        hostId="host-test"
        tab="behavior"
        onTabChange={vi.fn()}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[
          {
            level: "error",
            tab: "behavior",
            field: "modelId",
            message: "Pick a model",
          },
          {
            level: "warning",
            tab: "behavior",
            field: "systemPrompt",
            message: "Empty prompt",
          },
        ]}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("shows Agent in the header tab bar with neutral icon chrome only", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
        tab="protocol"
        onTabChange={vi.fn()}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        onClose={vi.fn()}
      />,
    );

    const agentTab = screen.getByRole("tab", { name: /^Agent$/ });
    expect(agentTab).toBeInTheDocument();
    expect(within(agentTab).queryByText("AGENT")).toBeNull();
    expect(agentTab.className).not.toMatch(/var\(--primary\)|bg-primary\b/);
  });

  it("shows Apps Extension in the header tab bar without SEP-1865 subtext", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
        tab="protocol"
        onTabChange={vi.fn()}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        onClose={vi.fn()}
      />,
    );

    const appsTab = screen.getByRole("tab", { name: /^Apps Extension$/ });
    expect(appsTab).toBeInTheDocument();
    expect(within(appsTab).queryByText(/SEP-1865/)).toBeNull();
    expect(appsTab.className).not.toMatch(/var\(--info|bg-info\b/);
  });

  it("lets MCP Protocol JSON switch from Edit to View (mode toggle is wired)", async () => {
    const user = userEvent.setup();
    render(
      <ClientFocusPanel
        hostId="host-test"
        tab="protocol"
        onTabChange={vi.fn()}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
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
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
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
        hostDisplayName="My Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
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

  it("does not surface a Servers tab in the per-host editor", () => {
    // Servers moved to Project Settings → Servers as part of the
    // project-scoped server config rollout. The per-host editor must
    // not advertise the tab anymore — server selection is project-
    // wide now.
    render(
      <ClientFocusPanel
        hostId="host-test"
        tab="behavior"
        onTabChange={vi.fn()}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tab", { name: /^Servers$/ })).toBeNull();
  });

  it("does not show a placeholder Advanced tab", () => {
    render(
      <ClientFocusPanel
        hostId="host-test"
        tab="behavior"
        onTabChange={vi.fn()}
        hostDisplayName="Test Host"
        onHostDisplayNameChange={vi.fn()}
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tab", { name: /^Advanced$/i })).toBeNull();
  });
});
