import { fireEvent, render, screen } from "@testing-library/react";
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
      />,
    );

    expect(
      screen.getByRole("button", { name: /connection overrides/i }),
    ).toHaveTextContent("Connection overrides");
    expect(screen.queryByText("1 header configured")).not.toBeInTheDocument();
    expect(screen.queryByText("Timeout: 30000ms")).not.toBeInTheDocument();

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

    expect(screen.getByText("Headers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
    expect(screen.getByText(/Timeout/)).toBeInTheDocument();
    expect(screen.getByText("Capabilities override")).toBeInTheDocument();
  });

  describe("header value masking", () => {
    function renderHeaders(customHeaders: Array<{ key: string; value: string }>) {
      const onRemoveHeader = vi.fn();
      render(
        <AdvancedConnectionSettingsSection
          showConfiguration={true}
          onToggle={vi.fn()}
          requestTimeout="10000"
          onRequestTimeoutChange={vi.fn()}
          inheritedRequestTimeout={10000}
          customHeaders={customHeaders}
          onAddHeader={vi.fn()}
          onRemoveHeader={onRemoveHeader}
          onUpdateHeader={vi.fn()}
        />,
      );
      return { onRemoveHeader };
    }

    it("masks header values until the eye is clicked", () => {
      renderHeaders([{ key: "X-API-Key", value: "super-secret" }]);

      const value = screen.getByLabelText("Header 1 value");
      expect(value).toHaveAttribute("type", "password");

      fireEvent.click(
        screen.getByRole("button", { name: "Show value for X-API-Key" }),
      );
      expect(screen.getByLabelText("Header 1 value")).toHaveAttribute(
        "type",
        "text",
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Hide value for X-API-Key" }),
      );
      expect(screen.getByLabelText("Header 1 value")).toHaveAttribute(
        "type",
        "password",
      );
    });

    it("keeps a stored-header reveal behind an eye affordance", () => {
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
          hasStoredHeaders
          onRevealHeaders={vi.fn()}
        />,
      );

      expect(screen.getByText("Hidden — Reveal to view")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Reveal/ }),
      ).toBeInTheDocument();
    });
  });
});
