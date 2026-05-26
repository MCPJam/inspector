/**
 * Direct unit tests for the per-case hostConfig tweak header.
 *
 * Focus: the contract between the header and its parent state.
 *   - Reading: baseline shows up with no override.
 *   - Writing: tweaks flow through `onChange`; equality with the baseline
 *     collapses the override back to `null`.
 *   - Isolation: nothing the header does touches the global zustand
 *     stores the playground uses — this is the cross-view-leak fix.
 *
 * The HostContext dialog + HostCapabilities override dialog are mocked
 * here to keep tests focused on the header itself; dialog-specific
 * behavior is exercised in their own test files.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { TestCaseClientHeader } from "../TestCaseClientHeader";
import {
  emptyHostConfigInputV2,
  hostConfigInputsEqual,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { seedFromHostTemplate } from "@/lib/client-templates";
import { applyHostStyleToHostConfigInput } from "@/lib/client-config-v2-helpers";

// Mock the dialogs — their internals (JsonEditor, MCP override JSON) are
// out of scope. Tests assert that the buttons mount; dialog content
// behavior is tested separately.
vi.mock("../TestCaseClientContextDialog", () => ({
  TestCaseClientContextDialog: ({
    open,
    value,
  }: {
    open: boolean;
    value: Record<string, unknown>;
  }) =>
    open ? (
      <div data-testid="mock-host-context-dialog">
        {JSON.stringify(value)}
      </div>
    ) : null,
}));

vi.mock("@/components/client-config/ClientCapabilitiesOverrideDialog", () => ({
  ClientCapabilitiesOverrideDialog: ({
    open,
    override,
  }: {
    open: boolean;
    override: Record<string, unknown> | undefined;
  }) =>
    open ? (
      <div data-testid="mock-host-caps-dialog">
        {JSON.stringify(override ?? null)}
      </div>
    ) : null,
}));

function renderHeader(
  props: Partial<React.ComponentProps<typeof TestCaseClientHeader>> = {},
) {
  const baseline: HostConfigInputV2 =
    props.baseline ??
    emptyHostConfigInputV2({
      hostStyle: "mcpjam",
      hostContext: { locale: "en-US", timeZone: "UTC" },
    });
  const onChange = vi.fn();

  const utils = render(
    <PreferencesStoreProvider
      themeMode="light"
      themePreset="default"
      hostStyle="claude"
    >
      <TestCaseClientHeader
        baseline={baseline}
        value={props.value ?? null}
        onChange={props.onChange ?? onChange}
      />
    </PreferencesStoreProvider>,
  );
  return { ...utils, baseline, onChange };
}

describe("TestCaseClientHeader", () => {
  it("renders the baseline values when no override is set", () => {
    const baseline = emptyHostConfigInputV2({
      hostStyle: "claude",
      hostContext: { locale: "ja-JP", timeZone: "Asia/Tokyo" },
    });
    renderHeader({ baseline });

    // Locale pill displays the baseline locale.
    expect(
      screen.getByTestId("test-case-host-locale-trigger"),
    ).toHaveTextContent("ja-JP");

    // Active host style pill is "claude" (from baseline, not from the
    // global preferences store which renderHeader seeds to a different
    // value — that's the cross-view-leak fix).
    expect(
      screen.getByTestId("test-case-host-style-claude"),
    ).toHaveAttribute("data-selected", "true");

    // No Tweaked badge when value === null.
    expect(
      screen.queryByTestId("test-case-host-tweaked-badge"),
    ).not.toBeInTheDocument();
  });

  it("ignores the global preferences-store hostStyle (no cross-view leak)", () => {
    // The provider seeds `usePreferencesStore.hostStyle = "claude"`, but
    // the header should display the baseline's "mcpjam". If this ever
    // regresses, the header is reading global state again.
    const baseline = emptyHostConfigInputV2({ hostStyle: "mcpjam" });
    renderHeader({ baseline });

    expect(
      screen.getByTestId("test-case-host-style-mcpjam"),
    ).toHaveAttribute("data-selected", "true");
    expect(
      screen.getByTestId("test-case-host-style-claude"),
    ).not.toHaveAttribute("data-selected");
  });

  it("commits a host-style click as a host-template snapshot", async () => {
    const user = userEvent.setup();
    const baseline = emptyHostConfigInputV2({ hostStyle: "mcpjam" });
    const onChange = vi.fn();
    renderHeader({ baseline, onChange });

    await user.click(screen.getByTestId("test-case-host-style-chatgpt"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0];
    expect(next).not.toBeNull();
    // The committed value should match `seedFromHostTemplate("chatgpt")`
    // overlaid with hostStyle="chatgpt" — the pure helper's behavior.
    const expected = {
      ...baseline,
      hostStyle: "chatgpt",
      hostContext: seedFromHostTemplate("chatgpt").hostContext,
      mcpProfile: seedFromHostTemplate("chatgpt").mcpProfile,
      hostCapabilitiesOverride: seedFromHostTemplate("chatgpt")
        .hostCapabilitiesOverride,
      chatUiOverride: seedFromHostTemplate("chatgpt").chatUiOverride,
    };
    expect(next.hostStyle).toBe("chatgpt");
    expect(next.hostContext).toEqual(expected.hostContext);
  });

  it("shows the Tweaked badge when value differs from baseline", () => {
    const baseline = emptyHostConfigInputV2({ hostStyle: "mcpjam" });
    const value: HostConfigInputV2 = {
      ...baseline,
      hostStyle: "chatgpt",
    };
    renderHeader({ baseline, value });

    expect(
      screen.getByTestId("test-case-host-tweaked-badge"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("test-case-host-reset")).toBeInTheDocument();
  });

  it("collapses the override to null when a tweak is reverted to the baseline", async () => {
    const user = userEvent.setup();
    // Build both baseline and value via the same helper the header uses
    // on click, so that round-tripping host styles produces structurally
    // identical results. Without this, baseline carries
    // `hostCapabilitiesOverride: undefined` (emptyHostConfigInputV2's
    // default) but applying a host-style click writes the template's
    // non-empty override into the result — and the equality check fails.
    const blank = emptyHostConfigInputV2();
    const baseline = applyHostStyleToHostConfigInput("claude", blank);
    const value = applyHostStyleToHostConfigInput("chatgpt", baseline);
    expect(hostConfigInputsEqual(value, baseline)).toBe(false); // sanity
    const onChange = vi.fn();
    renderHeader({ baseline, value, onChange });

    await user.click(screen.getByTestId("test-case-host-style-claude"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("Reset button calls onChange(null)", async () => {
    const user = userEvent.setup();
    const baseline = emptyHostConfigInputV2({ hostStyle: "mcpjam" });
    const value: HostConfigInputV2 = {
      ...baseline,
      hostStyle: "chatgpt",
    };
    const onChange = vi.fn();
    renderHeader({ baseline, value, onChange });

    await user.click(screen.getByTestId("test-case-host-reset"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("toggles hover/touch capabilities via the icon buttons", async () => {
    const user = userEvent.setup();
    const baseline = emptyHostConfigInputV2({
      hostStyle: "mcpjam",
      hostContext: {
        deviceCapabilities: { hover: true, touch: false },
      },
    });
    const onChange = vi.fn();
    renderHeader({ baseline, onChange });

    await user.click(screen.getByTestId("test-case-host-touch-toggle"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0];
    expect(next.hostContext.deviceCapabilities).toEqual({
      hover: true,
      touch: true,
    });
  });

  it("opens the host-context dialog with the effective hostContext value", async () => {
    const user = userEvent.setup();
    const baseline = emptyHostConfigInputV2({
      hostStyle: "mcpjam",
      hostContext: { locale: "fr-FR", timeZone: "Europe/Paris" },
    });
    renderHeader({ baseline });

    await user.click(screen.getByTestId("test-case-host-context-trigger"));

    const dialog = await screen.findByTestId("mock-host-context-dialog");
    expect(dialog).toHaveTextContent('"locale":"fr-FR"');
    expect(dialog).toHaveTextContent('"timeZone":"Europe/Paris"');
  });

  it("opens the host-capabilities dialog with the effective override payload", async () => {
    const user = userEvent.setup();
    const baseline = emptyHostConfigInputV2({ hostStyle: "mcpjam" });
    const value: HostConfigInputV2 = {
      ...baseline,
      hostCapabilitiesOverride: { foo: "bar" },
    };
    renderHeader({ baseline, value });

    const trigger = screen.getByTestId("test-case-host-capabilities-trigger");
    expect(within(trigger).getByText("Host Capabilities")).toBeInTheDocument();

    await user.click(trigger);

    const dialog = await screen.findByTestId("mock-host-caps-dialog");
    expect(dialog).toHaveTextContent('"foo":"bar"');
  });
});
