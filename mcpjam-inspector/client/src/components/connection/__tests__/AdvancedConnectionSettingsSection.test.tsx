import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdvancedConnectionSettingsSection } from "../shared/AdvancedConnectionSettingsSection";

describe("AdvancedConnectionSettingsSection", () => {
  it("renders the collapsed connection overrides toggle", () => {
    const onToggle = vi.fn();

    render(
      <AdvancedConnectionSettingsSection
        showConfiguration={false}
        onToggle={onToggle}
        requestTimeout="30000"
        onRequestTimeoutChange={vi.fn()}
        inheritedRequestTimeout={10000}
        customHeaders={[{ key: "X-API-Key", value: "secret" }]}
        onAddHeader={vi.fn()}
        onRemoveHeader={vi.fn()}
        onUpdateHeader={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: /connection overrides/i })
    ).toHaveTextContent("Connection overrides");
    expect(screen.queryByText("1 header configured")).not.toBeInTheDocument();
    expect(screen.queryByText("Timeout: 30000ms")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /connection overrides/i })
    );

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders custom headers and timeout controls when expanded", () => {
    render(
      <AdvancedConnectionSettingsSection
        showConfiguration={true}
        onToggle={vi.fn()}
        requestTimeout="10000"
        onRequestTimeoutChange={vi.fn()}
        inheritedRequestTimeout={10000}
        customHeaders={[]}
        onAddHeader={vi.fn()}
        onRemoveHeader={vi.fn()}
        onUpdateHeader={vi.fn()}
        clientCapabilitiesOverrideEnabled={true}
        onClientCapabilitiesOverrideEnabledChange={vi.fn()}
        clientCapabilitiesOverrideText={"{}"}
        onClientCapabilitiesOverrideTextChange={vi.fn()}
        clientCapabilitiesOverrideError={null}
      />
    );

    expect(screen.getByText("Headers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
    expect(screen.getByText(/Timeout/)).toBeInTheDocument();
    expect(screen.getByText("Capabilities override")).toBeInTheDocument();
  });

  it("maps Latest and November labels to their exact wire versions", async () => {
    const user = userEvent.setup();
    const onProtocolChange = vi.fn();
    render(
      <AdvancedConnectionSettingsSection
        showConfiguration={true}
        onToggle={vi.fn()}
        requestTimeout="10000"
        onRequestTimeoutChange={vi.fn()}
        showMcpProtocolVersionOverride={true}
        onMcpProtocolVersionOverrideChange={onProtocolChange}
        transportKind="http"
      />
    );

    const protocolSelect = screen.getByRole("combobox", {
      name: /protocol version/i,
    });
    await user.click(protocolSelect);
    await user.click(
      screen.getByRole("option", { name: "Latest (2026-07-28)" })
    );
    expect(onProtocolChange).toHaveBeenLastCalledWith("2026-07-28");

    await user.click(protocolSelect);
    await user.click(
      screen.getByRole("option", { name: "November (2025-11-25)" })
    );
    expect(onProtocolChange).toHaveBeenLastCalledWith("2025-11-25");
  });
});
