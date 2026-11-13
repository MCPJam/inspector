import { getFunctionName, type FunctionReference } from "convex/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { OrganizationModelsSection } from "../OrganizationModelsSection";

const mocks = vi.hoisted(() => ({
  flag: false as boolean | undefined,
  providers: [] as unknown[],
  testProviderConnection: vi.fn(async (_args: unknown) => ({
    reachable: true,
    origin: "backend",
    status: 200,
    apis: { chatCompletions: { result: "ok", status: 200 } },
    models: [{ nativeModelId: "gpt-5.5" }],
  })),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "org-model-gateways" ? mocks.flag : undefined,
}));

vi.mock("@/lib/app-navigation", () => ({
  useCurrentPathname: () => "/organizations/org_1/models",
  useAppNavigate: () => vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string) =>
    name === "organizationModelProviders:getVisibleConfig"
      ? { providers: mocks.providers }
      : undefined,
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useAction: (ref: string | FunctionReference<"action">) =>
    (typeof ref === "string" ? ref : getFunctionName(ref)) ===
    "organizationModelProviders:testProviderConnection"
      ? mocks.testProviderConnection
      : vi.fn(async () => ({ success: true })),
}));

vi.mock("../OrganizationAiCards", () => ({ OrganizationAiCards: () => null }));

/** No Responses, and one model not mapped. */
const LITELLM: OrgModelProvider = {
  providerKey: "custom:litellm",
  displayName: "litellm",
  enabled: true,
  hasSecret: true,
  baseUrl: "https://litellm.acme.example/v1",
  runtimeLocation: "cloud",
  apis: ["chatCompletions", "anthropicMessages"],
  models: [
    { nativeModelId: "claude-sonnet-4.5", modelId: "anthropic/claude-sonnet-4.5", mappingSource: "name" },
    { nativeModelId: "claude-opus-4.5", modelId: "anthropic/claude-opus-4.5", mappingSource: "name" },
    { nativeModelId: "team-llama-70b" },
  ],
};

describe("OrganizationModelsSection custom provider flag", () => {
  beforeEach(() => {
    mocks.testProviderConnection.mockClear();
    mocks.providers = [];
  });

  it("keeps today's Add Custom Provider dialog and rows with the flag off", () => {
    mocks.flag = false;
    mocks.providers = [LITELLM];
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    expect(screen.queryByText("litellm.acme.example")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Custom Provider" }));
    expect(screen.getByRole("dialog", { name: "Add Custom Provider" })).toBeInTheDocument();
    expect(screen.getByText("Protocol")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add custom provider" })).not.toBeInTheDocument();
  });

  it("treats a flag that hasn't loaded as off", () => {
    mocks.flag = undefined;
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    expect(screen.getByRole("button", { name: "Add Custom Provider" })).toBeInTheDocument();
  });

  it("opens Add custom provider with the flag on, testing from MCPJam's servers", async () => {
    mocks.flag = true;
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Add custom provider" }));
    expect(screen.getByRole("dialog", { name: "Add custom provider" })).toBeInTheDocument();
    fireEvent.change(document.getElementById("gateway-base-url") as HTMLElement, {
      target: { value: "https://litellm.acme.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Connected. Found 1 model and 1 API.");
    expect(mocks.testProviderConnection).toHaveBeenCalledWith({
      organizationId: "org_1",
      baseUrl: "https://litellm.acme.example",
    });
  });

  it("shows a custom provider's host, models and what needs an admin, and each badge opens the panel", () => {
    mocks.flag = true;
    mocks.providers = [LITELLM];
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    expect(screen.getByText("litellm.acme.example")).toBeInTheDocument();
    expect(screen.getByText("3 models")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3 features unavailable" }));
    const panel = screen.getByRole("dialog", { name: "litellm" });
    expect(panel).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Works with/ })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "1 not mapped" }));
    expect(screen.getByRole("dialog", { name: "litellm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Works with/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the panel from the row's edit button", () => {
    mocks.flag = true;
    mocks.providers = [LITELLM];
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Configure litellm" }));
    expect(screen.getByRole("dialog", { name: "litellm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test again" })).toBeInTheDocument();
  });

  it("shows members the host and models but no badges to act on", () => {
    mocks.flag = true;
    mocks.providers = [LITELLM];
    render(<OrganizationModelsSection organizationId="org_1" isAdmin={false} />);
    expect(screen.getByText("litellm.acme.example")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1 not mapped" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Configure litellm" })).not.toBeInTheDocument();
  });
});
