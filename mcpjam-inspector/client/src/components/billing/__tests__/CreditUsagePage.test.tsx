import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect } from "vitest";
import { CreditUsagePage } from "../CreditUsagePage";
const query = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({useQuery: query}));
vi.mock("react-router", () => ({useParams: () => ({orgId: "org-1"})}));
vi.mock("@/contexts/db-user-ready-context", () => ({useDbUserReady: () => true}));
it("shows recorded daily and feature totals and scopes period changes", async () => {
 query.mockReturnValue({totalCredits: 12, daily: [{date:"2026-09-12",credits:12}], features:[{name:"Model usage",credits:12}],truncated:false});
 render(<CreditUsagePage />);
 expect(screen.getByText("Model usage")).toBeInTheDocument();
 expect(screen.getByText("12 credits")).toBeInTheDocument();
 await userEvent.selectOptions(screen.getByLabelText("Usage period"), "7");
 expect(query).toHaveBeenLastCalledWith("billing/creditUsage:getOrganizationCreditUsage", {organizationId:"org-1",days:7});
});
it("distinguishes loading from empty usage", () => {
 query.mockReturnValue(undefined);
 const {rerender} = render(<CreditUsagePage />);
 expect(screen.getByRole("status")).toHaveTextContent("Loading");
 query.mockReturnValue({totalCredits:0,daily:[],features:[],truncated:false});
 rerender(<CreditUsagePage />);
 expect(screen.getByText("No credit consumption in this period.")).toBeInTheDocument();
});
