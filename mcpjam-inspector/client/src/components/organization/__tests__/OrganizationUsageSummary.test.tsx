import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationUsageSummary } from "../OrganizationUsageSummary";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("convex/react", () => ({ useQuery: query }));

describe("Organization usage summary", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("uses the selected organization's Home metrics and returned time windows", () => {
    query.mockImplementation((name, args) =>
      name === "home:getOrgHomeData"
        ? {
            memberCount: 2,
            projects: [{}],
            totalServerCount: 3,
            evalSuiteCount: 27,
          }
        : {
            value: args.metric === "tool_executions_30d" ? 1421 : 778,
            windowDays: 14,
          },
    );
    render(<OrganizationUsageSummary organizationId="org-1" />);
    expect(screen.getByText((1421).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText("778")).toBeInTheDocument();
    expect(screen.getAllByText("Last 14 days")).toHaveLength(2);
    for (const value of ["2", "1", "3", "27"]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(query).toHaveBeenCalledWith("home:getOrgHomeData", {
      organizationId: "org-1",
    });
    for (const metric of ["tool_executions_30d", "messages_sent_30d"]) {
      expect(query).toHaveBeenCalledWith("orgMetrics:getOrgMetric", {
        organizationId: "org-1",
        metric,
      });
    }
  });

  it("keeps pending metrics distinct from real zero counts", () => {
    query.mockImplementation((name) =>
      name === "home:getOrgHomeData"
        ? {
            memberCount: 0,
            projects: [],
            totalServerCount: 0,
            evalSuiteCount: 0,
          }
        : undefined,
    );
    render(<OrganizationUsageSummary organizationId="org-1" />);
    expect(screen.getAllByText("0")).toHaveLength(4);
    expect(screen.getByText("Loading tool executions")).toBeInTheDocument();
    expect(screen.getByText("Loading messages sent")).toBeInTheDocument();
  });
});
