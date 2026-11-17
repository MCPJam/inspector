import type { ComponentProps } from "react";
import { Wrench } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { act, renderWithProviders, screen, userEvent } from "@/test";
import type { PinnedToolCallFields } from "@/components/evals/pinned-tool-call-fields";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import {
  ActionCard,
  AssertionEditor,
  PromptBox,
} from "../case-steps/case-step-body";
import { RoleControl, StepRow } from "../case-steps/case-step-parts";
import { RemoveStepDialog } from "../case-steps/remove-step-dialog";

let fields: ComponentProps<typeof PinnedToolCallFields>;
vi.mock("@/components/evals/pinned-tool-call-fields", () => ({
  PinnedToolCallFields: (props: typeof fields) => {
    fields = props;
    return <p>Tool call fields</p>;
  },
}));

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

  const call = {
    id: "t1",
    kind: "toolCall" as const,
    serverId: "server-id",
    serverName: "accounts",
    toolName: "get_me",
    arguments: {},
    renderTimeoutMs: 1000,
  };
  const mountCall = (readOnly = false, open = false) => {
    const onChange = vi.fn();
    renderWithProviders(
      <ActionCard
        {...common}
        open={open}
        readOnly={readOnly}
        onToggle={vi.fn()}
        onChange={onChange}
        step={call}
      />,
    );
    return onChange;
  };

  it("keeps a closed card's fields mounted, hidden", () => {
    mountCall();
    expect(screen.getByText("Tool call fields")).not.toBeVisible();
  });

  it("ignores mount-time normalization in a frozen view", () => {
    const onChange = mountCall(true, true);
    act(() =>
      fields.onChange({
        serverName: "accounts",
        toolName: "get_me",
        arguments: {},
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not write a saved call again when its visible fields normalize", () => {
    const onChange = mountCall();
    act(() =>
      fields.onChange({
        serverName: "accounts",
        toolName: "get_me",
        arguments: {},
        renderTimeoutMs: 1000,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("writes a real edit and keeps the stable server id", () => {
    const onChange = mountCall(false, true);
    act(() =>
      fields.onChange({
        serverName: "accounts",
        toolName: "get_me",
        arguments: { id: 1 },
        renderTimeoutMs: 1000,
      }),
    );
    expect(onChange).toHaveBeenCalledWith({ ...call, arguments: { id: 1 } });
  });

  const interact = {
    id: "i1",
    kind: "interact" as const,
    toolName: "",
    action: { kind: "key" as const, key: "Enter" },
  };

  it("lets an open Interact step type a view when no tools are loaded", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <ActionCard
        {...common}
        open
        onToggle={vi.fn()}
        onChange={onChange}
        step={interact}
      />,
    );
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "View tool" }), "v");
    expect(onChange).toHaveBeenLastCalledWith({ ...interact, toolName: "v" });
  });

  it("offers loaded views to pick from, and freezes in a read-only view", () => {
    renderWithProviders(
      <ActionCard
        {...common}
        open
        readOnly
        availableTools={[{ name: "show_board", inputSchema: {} }] as never}
        onToggle={vi.fn()}
        step={interact}
      />,
    );
    expect(screen.getByRole("combobox", { name: "View tool" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "View tool" })).toBeNull();
  });
});

describe("AssertionEditor", () => {
  const actions = [
    {
      step: prompt,
      index: 0,
      ordinal: 1,
      turnIndex: 0,
      checks: [],
      lastIndex: 0,
    },
  ];
  const assertStep = (assertion: unknown) =>
    ({ id: "a1", kind: "assert", assertion }) as Extract<
      TestStep,
      { kind: "assert" }
    >;
  const mount = (assertion: unknown, checkPolicy = true) => {
    const onChange = vi.fn();
    renderWithProviders(
      <AssertionEditor
        step={assertStep(assertion)}
        actionId="p1"
        actions={actions}
        availableTools={[]}
        readOnly={false}
        checkPolicy={checkPolicy}
        onChange={onChange}
        onMove={vi.fn()}
      />,
    );
    return onChange;
  };

  it("names the step it is graded after", () => {
    mount({ type: "noToolErrors" });
    expect(
      screen.getByRole("combobox", { name: "Graded after" }),
    ).toHaveTextContent("Step 1 · User prompt");
    expect(
      screen.getByText("Passes when no tool reports an error."),
    ).toBeInTheDocument();
  });

  it("writes a role change back into the whole step", async () => {
    const onChange = mount({ type: "toolCalledAtLeastOnce", toolName: "x" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Non-blocking" }));
    expect(onChange).toHaveBeenCalledWith(
      assertStep({
        type: "toolCalledAtLeastOnce",
        toolName: "x",
        role: "advisory",
      }),
    );
  });

  it("has no role control for a widget check, or without check policy", () => {
    mount({ kind: "widgetRendered", toolName: "show_board" });
    expect(screen.getByText(/Always blocking/)).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "If this assertion misses" }),
    ).toBeNull();
  });

  it("hides the role control when the deployment has no check policy", () => {
    mount({ type: "toolCalledAtLeastOnce", toolName: "x" }, false);
    expect(
      screen.queryByRole("group", { name: "If this assertion misses" }),
    ).toBeNull();
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

  it("shows its fields only while open, keeping them mounted", () => {
    renderRow(false);
    expect(screen.getByText("Fields")).not.toBeVisible();
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
        "1 later assertion in its turn will move to step 1's turn.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove step and its/ }),
    ).toBeNull();
  });

  it("names its own assertions and later ones apart, and the button counts its own", () => {
    renderWithProviders(
      <RemoveStepDialog
        pending={{ ...plan, movedChecks: 1, movedFollowers: 2 }}
        onClose={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Its 1 assertion will move under step 1 and be graded after it instead. 2 later assertions in its turn will move to step 1's turn.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove step and its assertion" }),
    ).toBeInTheDocument();
  });

  it("closes on Cancel and on Escape without removing", async () => {
    const onClose = vi.fn();
    const onRemove = vi.fn();
    renderWithProviders(
      <RemoveStepDialog pending={plan} onClose={onClose} onRemove={onRemove} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("stays closed for a plan that needs no confirmation", () => {
    renderWithProviders(
      <RemoveStepDialog
        pending={{ ...plan, needsConfirm: false, movedChecks: 0 }}
        onClose={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
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
    for (const name of ["Blocking", "Non-blocking"])
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-pressed",
        String(name === selected),
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
