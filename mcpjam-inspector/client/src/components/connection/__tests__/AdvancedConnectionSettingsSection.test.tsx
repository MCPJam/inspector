import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdvancedConnectionSettingsSection } from "../shared/AdvancedConnectionSettingsSection";

describe("AdvancedConnectionSettingsSection", () => {
  it("shows summary chips for configured headers and timeout", () => {
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
      />,
    );

    expect(screen.getByText("Connection Overrides")).toBeInTheDocument();
    expect(screen.getByText("1 header configured")).toBeInTheDocument();
    expect(screen.getByText("Timeout: 30000ms")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /connection overrides/i }),
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
      />,
    );

    expect(screen.getByText("Custom Headers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add header/i })).toBeInTheDocument();
    expect(screen.getByText("Request Timeout")).toBeInTheDocument();
    expect(
      screen.getByText("Client Capabilities Override"),
    ).toBeInTheDocument();
  });
});
