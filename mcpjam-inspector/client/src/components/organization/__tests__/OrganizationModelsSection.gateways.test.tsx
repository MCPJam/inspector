import { getFunctionName, type FunctionReference } from "convex/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationModelsSection } from "../OrganizationModelsSection";

const mocks = vi.hoisted(() => ({
  flag: false as boolean | undefined,
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
      ? { providers: [] }
      : undefined,
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useAction: (ref: string | FunctionReference<"action">) =>
    (typeof ref === "string" ? ref : getFunctionName(ref)) ===
    "organizationModelProviders:testProviderConnection"
      ? mocks.testProviderConnection
      : vi.fn(async () => ({ success: true })),
}));

vi.mock("../OrganizationAiCards", () => ({ OrganizationAiCards: () => null }));

describe("OrganizationModelsSection gateway editor flag", () => {
  beforeEach(() => mocks.testProviderConnection.mockClear());

  it("keeps today's Add Custom Provider dialog with the flag off", () => {
    mocks.flag = false;
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Add Custom Provider" }));
    expect(screen.getByRole("dialog", { name: "Add Custom Provider" })).toBeInTheDocument();
    expect(screen.getByText("Protocol")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a gateway" })).not.toBeInTheDocument();
  });

  it("treats a flag that hasn't loaded as off", () => {
    mocks.flag = undefined;
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    expect(screen.getByRole("button", { name: "Add Custom Provider" })).toBeInTheDocument();
  });

  it("opens the gateway editor with the flag on, testing from MCPJam's servers", async () => {
    mocks.flag = true;
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Add a gateway" }));
    expect(screen.getByRole("dialog", { name: "Add a gateway" })).toBeInTheDocument();
    fireEvent.change(document.getElementById("gateway-base-url") as HTMLElement, {
      target: { value: "https://litellm.acme.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(mocks.testProviderConnection).toHaveBeenCalledWith({
      organizationId: "org_1",
      baseUrl: "https://litellm.acme.example",
    });
  });
});
