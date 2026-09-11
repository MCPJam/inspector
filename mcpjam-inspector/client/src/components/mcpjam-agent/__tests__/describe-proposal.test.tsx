import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DescribeProposal } from "../DescribeProposal";
import {
  beginDescribe,
  askDescribeQuestion,
  proposeDescribeCases,
  useDescribeFlow,
} from "@/lib/mcpjam-agent/describe-flow";
import { registerEvalDraft } from "@/lib/mcpjam-agent/eval-workspace";
import { useDescribeSurface } from "@/lib/mcpjam-agent/describe-surface";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
const scope: EvalAgentScope = {
  kind: "evals",
  version: 1,
  id: "s",
  projectId: "p",
  suiteId: "suite",
  suiteName: "Suite",
  caseId: "draft:describe",
};
const edit = vi.fn();
beforeEach(() => {
  edit.mockReset();
  useDescribeFlow.setState({ sessions: {} });
  useDescribeSurface.setState({ scope });
  registerEvalDraft(scope, {
    read: () => ({ draft: { title: "", steps: [] }, revision: "r", tools: [] }),
    edit,
    undo: vi.fn(),
  });
  beginDescribe("s", "Search issues");
  proposeDescribeCases("s", scope, {
    subject: "issue search",
    summary: "Return matching issues.",
    revision: "r",
    cases: [
      {
        title: "Search",
        steps: [{ id: "p", kind: "prompt", prompt: "Search issues" }],
      },
    ],
  });
});
it("shows the exact create action and applies only after clicking", () => {
  render(<DescribeProposal sessionId="s" scope={scope} busy={false} />);
  expect(edit).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Create 1 test for issue search" }),
  );
  expect(edit).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Created 1 unsaved test/)).toBeVisible();
});
it("disables Create while a turn is still streaming", () => {
  render(<DescribeProposal sessionId="s" scope={scope} busy />);
  expect(
    screen.getByRole("button", { name: "Create 1 test for issue search" }),
  ).toBeDisabled();
});

it("clearly identifies a follow-up as awaiting the user's answer", () => {
  beginDescribe("question-session", "Fetch issues");
  askDescribeQuestion(
    "question-session",
    "What would you like the result to be?",
  );
  render(
    <DescribeProposal
      sessionId="question-session"
      scope={scope}
      busy={false}
    />,
  );
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("Your input needed");
  expect(status).toHaveTextContent("What would you like the result to be?");
  expect(status).toHaveTextContent("Reply in the message box below.");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("disables Create while metadata is being refreshed", () => {
  registerEvalDraft(scope, {
    read: () => ({
      draft: { title: "", steps: [] },
      revision: "r",
      tools: [],
      metadata: {
        environmentKey: "v1",
        tools: [],
        servers: [
          { serverId: "server", status: "loading", tools: [], updatedAt: 1 },
        ],
      },
    }),
    edit,
    undo: vi.fn(),
  });
  render(<DescribeProposal sessionId="s" scope={scope} busy={false} />);
  expect(
    screen.getByRole("button", { name: "Create 1 test for issue search" }),
  ).toBeDisabled();
});
