import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationModelsSection } from "../OrganizationModelsSection";

const mocks = vi.hoisted(() => ({
  pathname: "/organizations/org_1/models/usage",
  navigate: vi.fn(),
  useQuery: vi.fn(),
  useAction: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: mocks.toastError,
  },
}));

vi.mock("@/lib/app-navigation", () => ({
  useCurrentPathname: () => mocks.pathname,
  useAppNavigate: () => mocks.navigate,
}));

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useAction: mocks.useAction,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("OrganizationModelsSection", () => {
  beforeEach(() => {
    mocks.pathname = "/organizations/org_1/models/usage";
    mocks.navigate.mockClear();
    mocks.useQuery.mockReset();
    mocks.useAction.mockReset();
    mocks.useAction.mockImplementation(() =>
      vi.fn(async () => ({ success: true })),
    );
    mocks.toastError.mockClear();
    mocks.useQuery.mockImplementation((name: string, args: unknown) => {
      if (name === "organizationModelProviders:getVisibleConfig") {
        return { providers: [] };
      }
      if (
        name === "organizationModelProviders:getUsageSummary" &&
        args !== "skip"
      ) {
        return {
          startAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
          endAt: Date.now(),
          rangeDays: 30,
          total: {
            key: "total",
            requestCount: 2,
            inputTokens: 30,
            outputTokens: 12,
            totalTokens: 42,
            knownCostUsd: 0.1234,
            knownCostRequests: 1,
            unknownCostRequests: 1,
          },
          byDate: [],
          byProvider: [
            {
              key: "openai",
              requestCount: 2,
              inputTokens: 30,
              outputTokens: 12,
              totalTokens: 42,
              knownCostUsd: 0.1234,
              knownCostRequests: 1,
              unknownCostRequests: 1,
            },
          ],
          byModel: [
            {
              key: "gpt-4o-mini",
              requestCount: 2,
              inputTokens: 30,
              outputTokens: 12,
              totalTokens: 42,
              knownCostUsd: 0.1234,
              knownCostRequests: 1,
              unknownCostRequests: 1,
            },
          ],
          byProject: [],
          byUser: [],
          recentRecords: [],
        };
      }
      return undefined;
    });
  });

  it("links to usage beside provider actions without loading usage inline", () => {
    mocks.pathname = "/organizations/org_1/models";
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    expect(
      screen.getByRole("button", { name: "Add Custom Provider" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "See usage" }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/organizations/org_1/models/usage",
    );
    expect(mocks.useQuery).not.toHaveBeenCalledWith(
      "organizationModelProviders:getUsageSummary",
      expect.anything(),
    );
    expect(
      screen.queryByRole("heading", { name: "Usage" }),
    ).not.toBeInTheDocument();
  });

  it("shows org BYOK usage to admins", () => {
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("$0.1234")).toBeTruthy();
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThanOrEqual(1);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "organizationModelProviders:getUsageSummary",
      expect.objectContaining({
        organizationId: "org_1",
        rangeDays: 30,
      }),
    );
  });

  it("keeps usage hidden from non-admin members", () => {
    render(
      <OrganizationModelsSection organizationId="org_1" isAdmin={false} />,
    );

    expect(screen.queryByText("Usage")).toBeNull();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "organizationModelProviders:getUsageSummary",
      "skip",
    );
  });

  // The backend puts the reason on `err.data`. `err.message` is the masked
  // "Server Error" line, which tells the admin nothing about what to fix.
  it("shows the server's reason when a save is refused", async () => {
    const refusal = Object.assign(
      new Error(
        "[CONVEX A(organizationModelProviders:upsertProvider)] [Request ID: abc] Server Error",
      ),
      {
        data: {
          code: "INVALID_PROVIDER_CONFIG",
          message: 'A custom provider named "Groq" already exists',
        },
      },
    );
    mocks.useAction.mockImplementation(() =>
      vi.fn(async () => {
        throw refusal;
      }),
    );
    mocks.pathname = "/organizations/org_1/models";
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

    fireEvent.click(
      screen.getByRole("button", { name: "Add Custom Provider" }),
    );
    fireEvent.change(screen.getByPlaceholderText("e.g. groq, together, vllm"), {
      target: { value: "Groq" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("https://api.groq.com/openai/v1"),
      { target: { value: "https://api.groq.com/openai/v1" } },
    );
    fireEvent.change(
      screen.getByPlaceholderText("llama-3.3-70b-versatile, mixtral-8x7b"),
      { target: { value: "llama-3.3-70b-versatile" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'A custom provider named "Groq" already exists',
      ),
    );
  });
});
