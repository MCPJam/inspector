import { beforeEach, describe, expect, it, vi } from "vitest";
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
// The active project's organization handoff, for pickers no caller wired one into.
const active = vi.hoisted(() => ({
  appState: null as null | {
    activeProjectId: string;
    projects: Record<string, { id: string; organizationId: string }>;
  },
  handoff: undefined as (() => void) | undefined,
  orgId: vi.fn(),
}));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => active.appState,
}));
vi.mock("@/hooks/use-org-models-handoff", () => ({
  useOrgModelsHandoff: (organizationId: string | null) => {
    active.orgId(organizationId);
    return active.handoff;
  },
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
      {...props}
    />,
  );
  await user.click(screen.getByTestId("model-selector-trigger"));
  await user.type(screen.getByPlaceholderText("Search models"), query);
  return user;
}

describe("ModelSelector — a search with no match", () => {
  beforeEach(() => {
    active.appState = null;
    active.handoff = undefined;
    active.orgId.mockClear();
  });

  it("offers Add a provider from the active project's organization when the picker passes none", async () => {
    const handoff = vi.fn();
    active.appState = {
      activeProjectId: "p1",
      projects: { p1: { id: "p1", organizationId: "org_1" } },
    };
    active.handoff = handoff;
    const user = await searchFor("mixtral");

    await user.click(
      await screen.findByRole("button", { name: "Add a provider" }),
    );
    expect(active.orgId).toHaveBeenCalledWith("org_1");
    expect(handoff).toHaveBeenCalledTimes(1);
    // The menu closes before handing off, like the picker's other links.
    expect(
      screen.queryByPlaceholderText("Search models"),
    ).not.toBeInTheDocument();
  });

  it("prefers the handoff the picker passes over the active project's", async () => {
    const onAddProvider = vi.fn();
    active.appState = {
      activeProjectId: "p1",
      projects: { p1: { id: "p1", organizationId: "org_1" } },
    };
    active.handoff = vi.fn();
    const user = await searchFor("mixtral", { onAddProvider });

    await user.click(
      await screen.findByRole("button", { name: "Add a provider" }),
    );
    expect(onAddProvider).toHaveBeenCalledTimes(1);
    expect(active.handoff).not.toHaveBeenCalled();
  });

  it("says why the model isn't listed and offers to add its provider", async () => {
    const onAddProvider = vi.fn();
    const user = await searchFor("mixtral", { onAddProvider });

    expect(
      await screen.findByText('No models match "mixtral".'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only models MCPJam runs and models from your organization's providers are listed.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a provider" }));
    expect(onAddProvider).toHaveBeenCalledTimes(1);
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

  it("only explains when it can't tell whether the viewer can add providers", async () => {
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
