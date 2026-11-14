/**
 * The test plan on Claude's Test & launch step: what is saved and by whom,
 * what keeps it from running, the edits a person makes before saving, and
 * the refused saves.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  type DirectoryTestPlan,
} from "@mcpjam/sdk/browser";
import type { DirectoryTestPlanSession } from "@/hooks/use-directory-test-plan";
import { TestPlanSection } from "../TestPlanSection";
import { ISSUES, PLAN, planSession, savedPlan } from "./test-plan-fixtures";

vi.mock("@/hooks/use-task-owner-id", () => ({
  useTaskOwnerId: () => "user_1",
}));

const step = (id: string) =>
  CLAUDE_CONNECTOR_FLOW.steps.find((entry) => entry.id === id)!;

function show(session: DirectoryTestPlanSession, stepId = "testLaunch") {
  return render(
    <TestPlanSection
      flow={CLAUDE_CONNECTOR_FLOW}
      step={step(stepId)}
      session={session}
    />,
  );
}

/** The plan the person's last edit made, from the change it handed the session. */
function edited(
  session: DirectoryTestPlanSession,
  from: DirectoryTestPlan = PLAN,
) {
  const edit = vi.mocked(session.edit);
  const change = edit.mock.calls.at(-1)?.[0];
  if (!change) throw new Error("No edit was made");
  return change(from);
}

describe("TestPlanSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows only on the step that asks about testing", () => {
    const { container } = show(planSession(), "listing");
    expect(container).toBeEmptyDOMElement();
  });

  it("says plainly that runs call no tool without a saved plan, and drafts one", async () => {
    const session = planSession({ saved: null });
    show(session);
    expect(
      screen.getByText(
        /^No test plan is saved, so runs call none of this server's tools\./,
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Draft a plan" }));
    expect(session.draft).toHaveBeenCalled();
    expect(session.save).not.toHaveBeenCalled();
  });

  it("names the saved revision, who saved it and what a run authorizes", () => {
    show(planSession());
    expect(
      screen.getByText(
        /^Revision 3, saved by you about 2 hours ago\. Run checks uses it, and starting a run authorizes every call in it\.$/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/^Checked against the tool list MCPJam stored/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save plan" })).toBeNull();
  });

  it("lists every tool with its effect and permitted writes, destructive cases last", () => {
    show(planSession());
    const tools = screen
      .getAllByRole("listitem")
      .filter((item) => item.querySelector(".font-mono"));
    expect(
      tools.map((item) => item.querySelector(".font-mono")?.textContent),
    ).toEqual(["create_note", "search_docs", "delete_note", "list_projects"]);
    const remove = within(tools[2]);
    expect(remove.getByText("Can destroy data")).toBeVisible();
    expect(remove.getByText("Permitted writes: note")).toBeVisible();
    expect(
      remove.getByText("delete_note#valid, valid input, runs 4 of 4"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "note, created by the plan: A note the plan creates and removes",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("After the cases, delete_note removes note."),
    ).toBeVisible();
  });

  it("puts each issue on the case or tool it names, and the rest on the plan", () => {
    show(planSession({ issues: ISSUES }));
    expect(
      screen.getByText(/^2 issues keep this plan from running/),
    ).toBeVisible();
    const create = screen.getByText(
      "create_note#valid, valid input, runs 1 of 4",
    ).parentElement as HTMLElement;
    expect(within(create).getByText(ISSUES[0].message)).toBeVisible();
    const budget = screen.getByRole("group", { name: "Budget" });
    expect(within(budget).getByText(ISSUES[1].message)).toBeVisible();
  });

  it("keeps edited arguments once they read as a JSON object", async () => {
    const session = planSession();
    show(session);
    const box = screen.getByLabelText("Arguments, as JSON", {
      selector: "#test-plan-case-create_note\\#valid-arguments",
    });
    fireEvent.change(box, { target: { value: "{ not json" } });
    fireEvent.blur(box);
    expect(screen.getByText(/^Arguments must be a JSON object/)).toBeVisible();
    expect(session.edit).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '{"title": "Sample note"}' } });
    fireEvent.blur(box);
    const next = edited(session);
    expect(next.cases[0]).toMatchObject({
      id: "create_note#valid",
      arguments: { title: "Sample note" },
    });
  });

  it("excludes a tool with its cases, and edits the budget", async () => {
    const session = planSession();
    show(session);
    const row = screen
      .getByText("search_docs", { selector: "p" })
      .closest("li");
    await userEvent.click(
      within(row as HTMLElement).getByRole("combobox", { name: "In the plan" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Excluded" }));
    const next = edited(session);
    expect(
      next.tools.find((entry) => entry.tool === "search_docs")?.action,
    ).toBe("excluded");
    expect(next.cases.some((entry) => entry.tool === "search_docs")).toBe(
      false,
    );

    const calls = screen.getByLabelText("Calls per run");
    fireEvent.change(calls, { target: { value: "12" } });
    fireEvent.blur(calls);
    expect(edited(session).budget).toEqual({ ...PLAN.budget, maxCalls: 12 });
  });

  it("saves changes, and offers to load a revision saved in another session", async () => {
    const session = planSession({
      edited: { ...PLAN, budget: { ...PLAN.budget, maxCalls: 9 } },
    });
    const { rerender } = show(session);
    expect(
      screen.getByText(/^Your changes to revision 3 are not saved/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(session.save).toHaveBeenCalled();

    const refused = { ...session, conflict: 4 };
    rerender(
      <TestPlanSection
        flow={CLAUDE_CONNECTOR_FLOW}
        step={step("testLaunch")}
        session={refused}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /^Revision 4 was saved in another session, so your changes were not saved\./,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Load revision 4" }),
    );
    expect(session.discard).toHaveBeenCalled();
  });

  it("says how to get a tool list when MCPJam has none for the server", () => {
    show(
      planSession({
        catalog: null,
        issues: null,
        saved: { ...savedPlan(), issues: null, catalog: null },
      }),
    );
    expect(
      screen.getByText(/Connect the server in MCPJam to store its tools\.$/),
    ).toBeVisible();
  });
});
