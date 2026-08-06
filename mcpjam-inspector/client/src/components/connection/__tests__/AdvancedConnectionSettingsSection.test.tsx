import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdvancedConnectionSettingsSection } from "../shared/AdvancedConnectionSettingsSection";

const HIDDEN_MASK = "••••••••••••";

/** Covered header rows draw a fixed twelve dots regardless of what they hold,
 * and are read-only because the box is showing a decoy. */
function expectMasked(input: HTMLElement) {
  expect(input).toHaveValue(HIDDEN_MASK);
  expect(input).toHaveAttribute("readonly");
}

function expectUncovered(input: HTMLElement, value: string) {
  expect(input).toHaveValue(value);
  expect(input).not.toHaveAttribute("readonly");
}

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

  describe("header value masking", () => {
    function renderHeaders(
      customHeaders: Array<{ key: string; value: string }>
    ) {
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
        />
      );
      return { onRemoveHeader };
    }

    it("masks header values until the eye is clicked", () => {
      renderHeaders([{ key: "X-API-Key", value: "super-secret" }]);

      expectMasked(screen.getByLabelText("Header 1 value"));

      fireEvent.click(
        screen.getByRole("button", { name: "Show value for X-API-Key" })
      );
      expectUncovered(screen.getByLabelText("Header 1 value"), "super-secret");

      fireEvent.click(
        screen.getByRole("button", { name: "Hide value for X-API-Key" })
      );
      expectMasked(screen.getByLabelText("Header 1 value"));
    });

    it("keeps a stored-header reveal behind an eye affordance", () => {
      const onRevealHeaders = vi.fn();
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
          onRevealHeaders={onRevealHeaders}
        />
      );

      // Stored headers carry bearer tokens, so expanding the section may not
      // decrypt them — the mask is the only thing wired to the fetch.
      expect(onRevealHeaders).not.toHaveBeenCalled();
      // The mask is decorative, so the only name for it is the button's.
      expect(
        screen.getByRole("button", { name: "Reveal saved headers" })
      ).toBeEnabled();

      fireEvent.click(
        screen.getByRole("button", { name: "Reveal saved headers" })
      );
      expect(onRevealHeaders).toHaveBeenCalledTimes(1);
    });

    it("names revealed headers without unmasking them", () => {
      function StoredHeadersHarness() {
        const [customHeaders, setCustomHeaders] = useState<
          Array<{ key: string; value: string }>
        >([]);
        return (
          <AdvancedConnectionSettingsSection
            showConfiguration={true}
            onToggle={vi.fn()}
            requestTimeout="10000"
            onRequestTimeoutChange={vi.fn()}
            inheritedRequestTimeout={10000}
            customHeaders={customHeaders}
            onAddHeader={vi.fn()}
            onRemoveHeader={vi.fn()}
            onUpdateHeader={vi.fn()}
            hasStoredHeaders={customHeaders.length === 0}
            onRevealHeaders={() =>
              setCustomHeaders([{ key: "X-API-Key", value: "super-secret" }])
            }
          />
        );
      }

      render(<StoredHeadersHarness />);

      fireEvent.click(
        screen.getByRole("button", { name: "Reveal saved headers" })
      );

      expect(screen.getByLabelText("Header 1 name")).toHaveValue("X-API-Key");
      expectMasked(screen.getByLabelText("Header 1 value"));
    });

    it("names the stored headers on open without decrypting them", () => {
      const onRequestStoredKeys = vi.fn();
      const onRevealHeaders = vi.fn();
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
          storedHeaderKeys={["X-API-Key", "X-Tenant"]}
          onRequestStoredKeys={onRequestStoredKeys}
          onRevealHeaders={onRevealHeaders}
        />
      );

      expect(onRequestStoredKeys).toHaveBeenCalledTimes(1);
      // The names came without the values — the bearer token these rows may
      // hide is still on the server.
      expect(onRevealHeaders).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Header 1 name")).toHaveValue("X-API-Key");
      expect(screen.getByLabelText("Header 2 name")).toHaveValue("X-Tenant");
      expectMasked(screen.getByLabelText("Header 1 value"));
      expectMasked(screen.getByLabelText("Header 2 value"));

      fireEvent.click(
        screen.getByRole("button", { name: "Show value for X-Tenant" })
      );
      expect(onRevealHeaders).toHaveBeenCalledTimes(1);
    });

    /** The parent owns the rows, so add/remove bookkeeping only runs for real
     * against state. A static array with vi.fn() callbacks would leave the
     * index this component hands the masking hook untested. */
    function HeadersHarness({
      initial = [],
    }: {
      initial?: Array<{ key: string; value: string }>;
    }) {
      const [customHeaders, setCustomHeaders] = useState(initial);
      return (
        <AdvancedConnectionSettingsSection
          showConfiguration={true}
          onToggle={vi.fn()}
          requestTimeout="10000"
          onRequestTimeoutChange={vi.fn()}
          inheritedRequestTimeout={10000}
          customHeaders={customHeaders}
          onAddHeader={() =>
            setCustomHeaders((prev) => [...prev, { key: "", value: "" }])
          }
          onRemoveHeader={(index) =>
            setCustomHeaders((prev) => prev.filter((_, at) => at !== index))
          }
          onUpdateHeader={(index, field, value) =>
            setCustomHeaders((prev) =>
              prev.map((row, at) =>
                at === index ? { ...row, [field]: value } : row
              )
            )
          }
        />
      );
    }

    it("leaves a newly added header unmasked so it can be typed into", () => {
      render(<HeadersHarness />);

      fireEvent.click(screen.getByRole("button", { name: "Add header" }));

      expectUncovered(screen.getByLabelText("Header 1 value"), "");
      expect(
        screen.getByRole("button", { name: "Hide value for header 1" })
      ).toBeInTheDocument();
    });

    it("keeps eye state on the right header after one above it is removed", () => {
      render(
        <HeadersHarness
          initial={[
            { key: "FIRST", value: "one" },
            { key: "SECOND", value: "two" },
            { key: "THIRD", value: "three" },
          ]}
        />
      );

      // Unmask the last row, then delete the row above it. Without re-indexing,
      // the eye state would slide onto SECOND and expose the wrong value.
      fireEvent.click(
        screen.getByRole("button", { name: "Show value for THIRD" })
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove SECOND" }));

      expectMasked(screen.getByLabelText("Header 1 value"));
      expectUncovered(screen.getByLabelText("Header 2 value"), "three");
      expect(
        screen.getByRole("button", { name: "Hide value for THIRD" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Show value for FIRST" })
      ).toBeInTheDocument();
    });
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
