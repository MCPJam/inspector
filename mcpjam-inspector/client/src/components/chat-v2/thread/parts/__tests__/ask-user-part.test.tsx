/**
 * The three states of the clarifying-question card, and the one rule that
 * matters most: the free-text escape hatch is always there, so a closed set
 * of model-authored choices can never trap a user whose intent isn't listed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { AskUserPart } from "../ask-user-part";
import {
  registerAskUserQuestion,
  __resetAskUserStoreForTests,
} from "@/lib/webmcp/ask-user-store";

const OPTIONS = [
  { label: "Connect to a local MCP server", value: "local" },
  { label: "Connect to a remote MCP server", value: "remote" },
];

const INPUT = { question: "What are you trying to do?", options: OPTIONS };

/** A settled tool output, shaped exactly as `okResult` produces it. */
function output(data: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
  };
}

describe("AskUserPart", () => {
  beforeEach(() => {
    __resetAskUserStoreForTests();
  });

  it("renders the parked question with an always-present escape hatch", async () => {
    const answer = registerAskUserQuestion({
      toolCallId: "call-1",
      question: "What are you trying to do?",
      options: OPTIONS,
    });
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={undefined}
        hasOutput={false}
      />,
    );

    expect(screen.getByText("What are you trying to do?")).toBeInTheDocument();
    expect(
      screen.getByText("Connect to a local MCP server"),
    ).toBeInTheDocument();
    // The model is told NOT to author an "other" option because this row is
    // guaranteed by the renderer instead.
    await userEvent.click(screen.getByText("Something else"));
    await userEvent.type(
      screen.getByLabelText("Answer in your own words"),
      "neither, I want to debug OAuth",
    );
    await userEvent.click(screen.getByText("Send"));

    await expect(answer).resolves.toEqual({
      kind: "freeText",
      text: "neither, I want to debug OAuth",
    });
  });

  it("resolves with the chosen option's value", async () => {
    const answer = registerAskUserQuestion({
      toolCallId: "call-1",
      question: "What are you trying to do?",
      options: OPTIONS,
    });
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={undefined}
        hasOutput={false}
      />,
    );
    await userEvent.click(screen.getByText("Connect to a remote MCP server"));
    await expect(answer).resolves.toEqual({
      kind: "selected",
      value: "remote",
      label: "Connect to a remote MCP server",
    });
  });

  it("shows the recorded choice once the part has an output", () => {
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={output({
          kind: "selected",
          value: "remote",
          label: "Connect to a remote MCP server",
        })}
        hasOutput
      />,
    );
    expect(screen.getByTestId("ask-user-answer")).toHaveTextContent(
      "Connect to a remote MCP server",
    );
    // Settled: no live buttons to re-answer a question the turn moved past.
    expect(screen.queryByText("Something else")).not.toBeInTheDocument();
  });

  it("renders a dismissal as 'no answer', not as a failure", () => {
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={output({ kind: "dismissed" })}
        hasOutput
      />,
    );
    expect(screen.getByTestId("ask-user-answer")).toHaveTextContent(
      "No answer",
    );
  });

  it("degrades to 'answered' when the output can't be parsed", () => {
    // Never throw inside a thread render over a payload shape we didn't
    // expect — a transcript from an older build, say.
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={{ content: [{ type: "text", text: "not json" }] }}
        hasOutput
      />,
    );
    expect(screen.getByTestId("ask-user-answer")).toHaveTextContent("Answered");
  });

  it("marks the question expired when nothing is parked and no output exists", () => {
    // The post-reload case: the paused turn died with the previous page, so
    // clickable options would be a lie.
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={undefined}
        hasOutput={false}
      />,
    );
    expect(screen.getByTestId("ask-user-card")).toHaveTextContent(
      "This question expired",
    );
    expect(screen.queryByText("Something else")).not.toBeInTheDocument();
  });

  it("shows a parked question read-only rather than expired", () => {
    registerAskUserQuestion({
      toolCallId: "call-1",
      question: "What are you trying to do?",
      options: OPTIONS,
    });
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={undefined}
        hasOutput={false}
        interactive={false}
      />,
    );
    // Eval replays and shared transcripts must never let a viewer answer on
    // someone else's behalf...
    expect(screen.queryByText("Something else")).not.toBeInTheDocument();
    // ...but the question is LIVE, so calling it expired would be false, and
    // dropping the options would lose what was actually asked.
    expect(screen.getByTestId("ask-user-readonly")).toBeInTheDocument();
    expect(
      screen.getByText("Connect to a local MCP server"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();
  });

  it("never flashes 'expired' between the click and the tool result", async () => {
    // The store drops the pending entry the instant the promise settles, which
    // is one or more renders BEFORE `addToolOutput` produces the part's
    // output. Without the answered latch, that gap paints the expiry copy over
    // a question the user just successfully answered.
    registerAskUserQuestion({
      toolCallId: "call-1",
      question: "What are you trying to do?",
      options: OPTIONS,
    });
    render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={undefined}
        hasOutput={false}
      />,
    );
    await userEvent.click(screen.getByText("Connect to a remote MCP server"));

    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("ask-user-resolving")).toBeInTheDocument();
  });

  it("a settled output supersedes the local resolving state", async () => {
    registerAskUserQuestion({
      toolCallId: "call-1",
      question: "What are you trying to do?",
      options: OPTIONS,
    });
    const { rerender } = render(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={undefined}
        hasOutput={false}
      />,
    );
    await userEvent.click(screen.getByText("Connect to a remote MCP server"));
    rerender(
      <AskUserPart
        toolCallId="call-1"
        input={INPUT}
        output={output({
          kind: "selected",
          value: "remote",
          label: "Connect to a remote MCP server",
        })}
        hasOutput
      />,
    );
    expect(screen.queryByTestId("ask-user-resolving")).not.toBeInTheDocument();
    expect(screen.getByTestId("ask-user-answer")).toHaveTextContent(
      "Connect to a remote MCP server",
    );
  });
});
