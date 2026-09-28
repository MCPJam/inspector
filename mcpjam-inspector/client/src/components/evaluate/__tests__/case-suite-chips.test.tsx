import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaseSuiteChips } from "../simple-case/case-suite-chips";

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

describe("CaseSuiteChips", () => {
  it("prevents iteration edits while the controls are disabled", async () => {
    const onTrialsChange = vi.fn();
    render(<CaseSuiteChips models={[]} trials={3} hostLabel="Client" disabled onTrialsChange={onTrialsChange} />);
    const trigger = screen.getByRole("button", { name: "Iterations" });
    expect(trigger).toBeDisabled();
    await userEvent.setup().click(trigger);
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(onTrialsChange).not.toHaveBeenCalled();
  });

  it("renders model labels, not raw values", () => {
    render(
      <CaseSuiteChips
        models={["anthropic/claude-haiku-4.5"]}
        modelLabelByValue={{ "anthropic/claude-haiku-4.5": "Haiku 4.5" }}
        trials={3}
        hostLabel="Claude"
      />,
    );
    expect(screen.getByText("Haiku 4.5")).toBeInTheDocument();
    expect(
      screen.queryByText("anthropic/claude-haiku-4.5"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("selects searchable Playground models and clients and updates iterations", async () => {
    const user = userEvent.setup();
    const onTrialsChange = vi.fn();
    const onHostChange = vi.fn();
    const onModelChange = vi.fn();
    render(
      <CaseSuiteChips
        models={["anthropic/haiku"]}
        modelLabelByValue={{ "anthropic/haiku": "Haiku" }}
        availableModels={[
          { id: "haiku", name: "Haiku", provider: "anthropic" },
          { id: "sonnet", name: "Sonnet", provider: "anthropic" },
        ]}
        onModelChange={onModelChange}
        trials={1}
        onTrialsChange={onTrialsChange}
        hostLabel="Claude"
        hostValue="host-a"
        hostOptions={[
          { value: "host-a", label: "Claude" },
          { value: "host-b", label: "ChatGPT" },
        ]}
        onHostChange={onHostChange}
      />,
    );

    await user.click(screen.getByTestId("model-selector-trigger"));
    await user.type(screen.getByPlaceholderText("Search models"), "Sonnet");
    expect(
      screen.queryByRole("option", { name: /Haiku/ }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /Sonnet/ }));
    expect(onModelChange).toHaveBeenCalledWith("anthropic/sonnet");

    await user.click(screen.getByRole("button", { name: "Iterations" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "3" }));
    expect(onTrialsChange).toHaveBeenCalledWith(3);

    await user.click(screen.getByTestId("client-selector-trigger"));
    await user.type(screen.getByPlaceholderText("Search clients"), "ChatGPT");
    expect(
      screen.queryByRole("option", { name: /Claude/ }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /ChatGPT/ }));
    expect(onHostChange).toHaveBeenCalledWith("host-b");
  });

  it("keeps unavailable selections visible and client defaults read-only", () => {
    render(
      <CaseSuiteChips
        models={["custom/retired/model"]}
        modelLabelByValue={{ "custom/retired/model": "Retired model" }}
        trials={1}
        hostLabel="MCPJam"
      />,
    );
    expect(screen.getByTestId("model-selector-trigger")).toHaveTextContent(
      "Retired model",
    );
    expect(screen.getByTestId("model-selector-trigger")).toBeDisabled();
    expect(screen.getByTestId("client-selector-trigger")).toHaveTextContent(
      "MCPJam",
    );
    expect(screen.getByTestId("client-selector-trigger")).toBeDisabled();
  });

  it("preserves provider-prefixed model IDs", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    render(
      <CaseSuiteChips
        models={["custom/vendor/old"]}
        availableModels={[
          {
            id: "vendor/old",
            name: "Old model",
            provider: "custom",
            customProviderName: "Acme",
          },
          {
            id: "vendor/new",
            name: "New model",
            provider: "custom",
            customProviderName: "Acme",
          },
        ]}
        onModelChange={onModelChange}
        trials={1}
        hostLabel="MCPJam"
      />,
    );
    await user.click(screen.getByTestId("model-selector-trigger"));
    await user.click(await screen.findByRole("option", { name: /New model/ }));
    expect(onModelChange).toHaveBeenCalledWith("custom/vendor/new");
  });

  it("disables pickers during a run and keeps suite settings reachable", async () => {
    const user = userEvent.setup();
    const onOpenSuiteSettings = vi.fn();
    render(
      <CaseSuiteChips
        models={["anthropic/haiku"]}
        availableModels={[
          { id: "haiku", name: "Haiku", provider: "anthropic" },
        ]}
        onModelChange={vi.fn()}
        trials={1}
        hostLabel="Claude"
        hostValue="host-a"
        hostOptions={[{ value: "host-a", label: "Claude" }]}
        onHostChange={vi.fn()}
        onOpenSuiteSettings={onOpenSuiteSettings}
        disabled
      />,
    );
    expect(screen.getByTestId("model-selector-trigger")).toBeDisabled();
    expect(screen.getByTestId("client-selector-trigger")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Suite settings" }));
    expect(onOpenSuiteSettings).toHaveBeenCalledOnce();
  });
});
