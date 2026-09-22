import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  SessionQuestionEditor,
  SessionQuestionFlow,
} from "../SessionQuestionFlow";
import {
  selectionForNode,
  selectionForLink,
  layoutSankey,
} from "../insights-sankey";
import {
  serializeSelectionParam,
  parseSelectionParam,
  selectionChips,
  chipKey,
  type SelectionRef,
} from "@/hooks/scenario-usage-filters";
import {
  toServerFilters,
  type InsightsSankey,
  type UsageBreakdown,
} from "@/hooks/useUsageInsights";
const mocks = vi.hoisted(() => ({
  catalog: undefined as unknown,
  mutation: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: () => mocks.catalog,
  useMutation: () => mocks.mutation,
}));
beforeEach(() => {
  mocks.catalog = undefined;
  mocks.mutation.mockReset();
});

const q = {
  id: "question:q1:yes",
  stage: "question:q1" as const,
  key: "yes",
  label: "Yes",
  count: 2,
  clickable: true,
  questionVersion: 2,
};
const sentiment = {
  id: "sentiment:s",
  stage: "sentiment" as const,
  key: "s",
  label: "Happy",
  count: 2,
  clickable: true,
};
const sankey: InsightsSankey = {
  nodes: [sentiment, q],
  links: [{ source: sentiment.id, target: q.id, count: 2, discordantCount: 0 }],
  foldedGoalCount: 0,
  stages: [
    { id: "sentiment", label: "Sentiment" },
    { id: "question:q1", label: "Auth wall", questionId: "q1", version: 2 },
  ],
};
const props = {
  breakdown: { sankey, totalSessions: 2 } as UsageBreakdown,
  selection: null,
  onSelectNode: vi.fn(),
  onSelectLink: vi.fn(),
  onRebuild: vi.fn(),
  rebuildBusy: false,
};

describe("question columns", () => {
  it("selects booleans and mixed links with versioned server predicates", () => {
    const selection = selectionForLink(sentiment, q)!;
    expect(selection.themes).toHaveLength(1);
    expect(selection.questions).toEqual([
      { questionId: "q1", version: 2, value: true, label: "Yes" },
    ]);
    expect(
      toServerFilters({ preset: "all", chips: selectionChips(selection) })
        .chips,
    ).toContainEqual({
      kind: "question",
      questionId: "q1",
      version: 2,
      value: true,
    });
    expect(
      selectionForNode({ ...q, key: "__unanswered__", clickable: false }),
    ).toBeNull();
    expect(
      chipKey({ kind: "question", questionId: "q1", version: 1, value: true }),
    ).not.toBe(
      chipKey({ kind: "question", questionId: "q1", version: 2, value: true }),
    );
  });
  it("round-trips mixed selections and retains legacy URLs", () => {
    const refs: SelectionRef[] = [
      { dimension: "sentiment", clusterId: "s" },
      { questionId: "opaque:question", version: 2, value: false },
    ];
    expect(parseSelectionParam(serializeSelectionParam(refs))).toEqual(refs);
    expect(parseSelectionParam("goal:legacy")).toEqual([
      { dimension: "goal", clusterId: "legacy" },
    ]);
    expect(
      parseSelectionParam('v2:[{"questionId":"q","version":0,"value":true}]'),
    ).toBeNull();
  });
  it("lays out colon-containing stages and preserves their connecting band", () => {
    const layout = layoutSankey(
      sankey,
      600,
      400,
      [40, 300],
      ["sentiment", "question:q1"],
    );
    expect(layout.links).toHaveLength(1);
    expect(layout.links[0].target.stage).toBe("question:q1");
  });
  it("submits both fields atomically and never on focus movement", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    render(<SessionQuestionEditor onSave={save} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText("Column label"), "Auth wall");
    await user.tab();
    expect(save).not.toHaveBeenCalled();
    await user.type(
      screen.getByLabelText("Yes/no question"),
      "Did login fail?{Enter}",
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      label: "Auth wall",
      question: "Did login fail?",
    });
  });
  it("keeps failed drafts editable and Escape cancels", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    render(
      <SessionQuestionEditor
        initial={{ label: "Auth", question: "Did login fail?" }}
        onSave={vi.fn().mockRejectedValue(new Error("Try again"))}
        onCancel={cancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
    expect(screen.getByLabelText("Yes/no question")).toHaveValue(
      "Did login fail?",
    );
    await user.type(screen.getByLabelText("Column label"), "{Escape}");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects empty fields and prevents duplicate in-flight submits", async () => {
    let resolve!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(<SessionQuestionEditor onSave={save} onCancel={vi.fn()} />);
    const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
    fireEvent.submit(form);
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Column label"), {
      target: { value: "Auth" },
    });
    fireEvent.change(screen.getByLabelText("Yes/no question"), {
      target: { value: "Did login fail?" },
    });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(save).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
  });
  it("reopens both fields from the header, and label-only saves preserve wording", async () => {
    const user = userEvent.setup();
    mocks.catalog = {
      questions: [
        {
          id: "q1",
          version: 2,
          label: "Auth wall",
          question: "Did login fail?",
          createdAt: 1,
        },
      ],
      cap: 3,
      canEdit: true,
    };
    render(
      <SessionQuestionFlow
        {...props}
        scope={{ kind: "scenario", scenarioId: "s" }}
        testId="questions"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Auth wall" }));
    expect(screen.getByLabelText("Yes/no question")).toHaveValue(
      "Did login fail?",
    );
    await user.clear(screen.getByLabelText("Column label"));
    await user.type(screen.getByLabelText("Column label"), "Login{Enter}");
    await waitFor(() =>
      expect(mocks.mutation).toHaveBeenCalledWith({
        scenarioId: "s",
        questionId: "q1",
        label: "Login",
        question: "Did login fail?",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Remove Auth wall column" }),
    ).toHaveAttribute("type", "button");
  });
  it("readers get no authoring controls", () => {
    mocks.catalog = {
      questions: [
        {
          id: "q1",
          label: "Auth wall",
          question: "Did login fail?",
          version: 2,
        },
      ],
      cap: 3,
      canEdit: false,
    };
    render(
      <SessionQuestionFlow
        {...props}
        scope={{ kind: "scenario", scenarioId: "s" }}
        testId="questions"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Add question column" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Auth wall" })).toBeDisabled();
  });
});
