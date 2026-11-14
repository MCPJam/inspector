import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelector } from "../chat-input/model-selector";
import type { ModelDefinition } from "@/shared/types";

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../chat-input/model/provider-logo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => (
    <span aria-hidden="true">{provider}</span>
  ),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: { themeMode: "light" | "dark" }) => unknown,
  ) => selector({ themeMode: "light" }),
}));

const models: ModelDefinition[] = [
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
];

async function searchFor(
  query: string,
  props: Partial<Parameters<typeof ModelSelector>[0]> = {},
) {
  const user = userEvent.setup();
  render(
    <ModelSelector
      currentModel={models[0]}
      availableModels={models}
      onModelChange={() => {}}
      onAddProvider={null}
      {...props}
    />,
  );
  await user.click(screen.getByTestId("model-selector-trigger"));
  await user.type(screen.getByPlaceholderText("Search models"), query);
  return user;
}

describe("ModelSelector — a search with no match", () => {
  it("says why the model isn't listed and offers to add its provider", async () => {
    const onAddProvider = vi.fn();
    const user = await searchFor("mixtral", { onAddProvider });

    expect(
      await screen.findByText('No models match "mixtral".'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only models MCPJam runs and models from your providers are listed.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a provider" }));
    expect(onAddProvider).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByPlaceholderText("Search models"),
    ).not.toBeInTheDocument();
  });

  it("offers chat's Manage AI providers handoff when the picker passes null", async () => {
    const onManageOrgProviders = vi.fn();
    const user = await searchFor("mixtral", { onManageOrgProviders });

    await user.click(
      await screen.findByRole("button", { name: "Add a provider" }),
    );
    expect(onManageOrgProviders).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByPlaceholderText("Search models"),
    ).not.toBeInTheDocument();
  });

  it("sends a member under the key policy to an admin", async () => {
    await searchFor("mixtral", { requireOrgKeys: true });

    expect(
      await screen.findByText(
        "Only models from your organization's providers are listed.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask an organization admin to add one."),
    ).toBeInTheDocument();
  });

  it("only explains when the picker's organization offers nothing", async () => {
    await searchFor("mixtral");

    expect(
      await screen.findByText('No models match "mixtral".'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add a provider" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Ask an organization admin to add one."),
    ).not.toBeInTheDocument();
  });
});
