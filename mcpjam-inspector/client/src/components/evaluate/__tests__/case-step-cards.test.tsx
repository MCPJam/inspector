import { Wrench } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import { ActionCard, PromptBox } from "../case-steps/case-step-body";
import { RoleControl, StepRow } from "../case-steps/case-step-parts";
import { RemoveStepDialog } from "../case-steps/remove-step-dialog";

const prompt: Extract<TestStep, { kind: "prompt" }> = {
  id: "p1",
  kind: "prompt",
  prompt: "List my workspaces",
};

describe("PromptBox", () => {
  it("names the first prompt and any follow-up", () => {
    const { unmount } = renderWithProviders(
      <PromptBox step={prompt} first readOnly={false} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText("What does the user ask?")).toHaveValue(
      "List my workspaces",
    );
    unmount();
    renderWithProviders(
      <PromptBox
        step={prompt}
        first={false}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Follow-up prompt")).toBeInTheDocument();
  });

  it("sends the edited prompt", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <PromptBox
        step={{ ...prompt, prompt: "" }}
        first
        readOnly={false}
        onChange={onChange}
      />,
    );
    await userEvent.setup().type(screen.getByRole("textbox"), "H");
    expect(onChange).toHaveBeenLastCalledWith({ ...prompt, prompt: "H" });
  });
});

describe("ActionCard", () => {
  const common = {
    open: false,
    readOnly: false,
    availableTools: [],
    suiteServers: ["accounts"],
    onChange: vi.fn(),
  };

  it("names a tool call and its server, and toggles open", async () => {
    const onToggle = vi.fn();
    renderWithProviders(
      <ActionCard
        {...common}
        onToggle={onToggle}
        step={{
          id: "t1",
          kind: "toolCall",
          serverName: "accounts",
          toolName: "get_me",
          arguments: {},
        }}
      />,
    );
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveTextContent("get_me");
    expect(toggle).toHaveTextContent("on accounts");
    await userEvent.setup().click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("asks for a view on an Interact step with none", () => {
    renderWithProviders(
      <ActionCard
        {...common}
        onToggle={vi.fn()}
        step={{
          id: "i1",
          kind: "interact",
          toolName: " ",
          action: { kind: "key", key: "Enter" },
        }}
      />,
    );
    expect(screen.getByText("Pick a view")).toBeInTheDocument();
  });
});

describe("StepRow", () => {
  function renderRow(open: boolean, onToggle = vi.fn()) {
    renderWithProviders(
      <ul>
        <StepRow
          anchor="check:a1"
          Icon={Wrench}
          iconClass=""
          label="Tool was called with"
          missing="Pick a tool"
          open={open}
          onToggle={onToggle}
        >
          <p>Fields</p>
        </StepRow>
      </ul>,
    );
    return onToggle;
  }

  it("shows its fields only while open", () => {
    renderRow(false);
    expect(screen.queryByText("Fields")).toBeNull();
    expect(screen.getByText("Pick a tool")).toBeInTheDocument();
  });

  it("opens from its line", async () => {
    const onToggle = renderRow(true);
    expect(screen.getByText("Fields")).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Tool was called with/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("RemoveStepDialog", () => {
  const plan = {
    needsConfirm: true,
    reparentTo: { ordinal: 1, stepId: "p1" },
    movedChecks: 2,
    movedFollowers: 0,
    becomesLeading: false,
  };

  it("says where the assertions go and removes either way", async () => {
    const onRemove = vi.fn();
    renderWithProviders(
      <RemoveStepDialog pending={plan} onClose={vi.fn()} onRemove={onRemove} />,
    );
    expect(
      screen.getByText(
        "Its 2 assertions will move under step 1 and be graded after it instead.",
      ),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove step" }));
    await user.click(
      screen.getByRole("button", { name: "Remove step and its assertions" }),
    );
    expect(onRemove.mock.calls).toEqual([[false], [true]]);
  });

  it("says the assertions move before the first step when none is left", () => {
    renderWithProviders(
      <RemoveStepDialog
        pending={{
          ...plan,
          reparentTo: null,
          movedChecks: 1,
          becomesLeading: true,
        }}
        onClose={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Its 1 assertion would be graded before the first step.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove step and its assertion" }),
    ).toBeInTheDocument();
  });

  it("counts assertions later in the turn and offers only Remove step when the step has none", () => {
    renderWithProviders(
      <RemoveStepDialog
        pending={{ ...plan, movedChecks: 0, movedFollowers: 1 }}
        onClose={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Its 1 assertion will move under step 1 and be graded after it instead.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove step and its/ }),
    ).toBeNull();
  });
});

describe("RoleControl", () => {
  const assertion = {
    type: "toolCalledAtLeastOnce",
    toolName: "create_view",
  } as Predicate;

  it.each([
    [assertion, "Blocking"],
    [{ ...assertion, role: "advisory" } as Predicate, "Non-blocking"],
  ])("selects the stored role (%#)", (predicate, selected) => {
    renderWithProviders(
      <RoleControl predicate={predicate} readOnly={false} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: selected })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("switches a blocking assertion to non-blocking", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <RoleControl
        predicate={assertion}
        readOnly={false}
        onChange={onChange}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Non-blocking" }));
    expect(onChange).toHaveBeenCalledWith({ ...assertion, role: "advisory" });
  });
});
