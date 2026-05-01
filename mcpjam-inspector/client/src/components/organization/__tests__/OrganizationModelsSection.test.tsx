import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationModelsSection } from "../OrganizationModelsSection";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useAction: vi.fn(() => vi.fn(async () => ({ success: true }))),
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
    mocks.useQuery.mockReset();
    mocks.useAction.mockClear();
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
          byWorkspace: [],
          byUser: [],
          recentRecords: [],
        };
      }
      return undefined;
    });
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
      })
    );
  });

  it("keeps usage hidden from non-admin members", () => {
    render(
      <OrganizationModelsSection organizationId="org_1" isAdmin={false} />
    );

    expect(screen.queryByText("Usage")).toBeNull();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "organizationModelProviders:getUsageSummary",
      "skip"
    );
  });
});
