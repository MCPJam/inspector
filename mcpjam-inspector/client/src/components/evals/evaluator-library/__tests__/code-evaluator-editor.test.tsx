import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, within } from "@/test";
import { CodeEvaluatorEditor } from "../code-evaluator-editor";
import type { CodeEvaluator } from "../code-evaluator-model";

const SCRIPT = 'import json, os\nprint("graded")\n';

const SAVED: CodeEvaluator = {
  id: "check_totals",
  name: "Invoice totals add up",
  fileName: "check_totals.py",
  script: "import json\nprint('mine')\n",
  role: "advisory",
  threshold: 0.5,
};

function renderEditor(
  props: Partial<Parameters<typeof CodeEvaluatorEditor>[0]> = {},
) {
  const onSave = vi.fn<(evaluator: CodeEvaluator) => string | undefined>();
  const onCancel = vi.fn();
  renderWithProviders(
    <CodeEvaluatorEditor
      others={[]}
      scripts={undefined}
      onCancel={onCancel}
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave, onCancel };
}

const textbox = (name: string) => screen.getByRole("textbox", { name });
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const type = (name: string, value: string) =>
  fireEvent.change(textbox(name), { target: { value } });
const fill = (name: string, fileName: string) => {
  type("Name", name);
  type("File name", fileName);
  type("Script", SCRIPT);
};

describe("CodeEvaluatorEditor, new", () => {
  it("starts empty and adds to the suite draft", () => {
    renderEditor();
    expect(textbox("Name")).toHaveValue("");
    expect(textbox("File name")).toHaveValue("");
    expect(textbox("Script")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add evaluator" })).toBeEnabled();
    expect(
      screen.getByText("Shown on the result. Never fails the iteration."),
    ).toBeInTheDocument();
  });

  it("says what each field needs before it saves", () => {
    const { onSave } = renderEditor();
    click("Add evaluator");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText("Give the evaluator a name.").length).toBe(2);
    expect(
      screen.getByText("Name the script's file, such as check.py."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Write the script the evaluator runs."),
    ).toBeInTheDocument();
  });

  it("checks the file name as it is typed and names the language", () => {
    renderEditor();
    type("File name", "check totals.py");
    expect(
      screen.getByText(
        "Use only letters, digits, dots, dashes and underscores in the file name.",
      ),
    ).toBeInTheDocument();
    type("File name", "check.rb");
    expect(
      screen.getByText("End the file name in .py, .ts, .js or .sh."),
    ).toBeInTheDocument();
    type("File name", ".check.py");
    expect(
      screen.getByText("Start the file name with a letter or digit."),
    ).toBeInTheDocument();
    type("File name", "check.sh");
    expect(screen.getByText("Runs as Bash")).toBeInTheDocument();
  });

  it("saves an Advisory evaluator with an ID from its file name", () => {
    const { onSave } = renderEditor();
    fill("Calls each tool once", "check_tool_calls.py");
    expect(screen.getByText("Runs as Python")).toBeInTheDocument();
    click("Add evaluator");
    expect(onSave).toHaveBeenCalledWith({
      id: "check_tool_calls",
      name: "Calls each tool once",
      fileName: "check_tool_calls.py",
      script: SCRIPT,
      role: "advisory",
    });
  });

  it("takes the next free ID when another evaluator has the file's", () => {
    const { onSave } = renderEditor({
      others: [{ ...SAVED, id: "check_tool_calls" }],
    });
    fill("Second", "check_tool_calls.py");
    click("Add evaluator");
    expect(onSave.mock.calls[0][0].id).toBe("check_tool_calls-2");
  });

  it("disables Required with the reason when grading can't enforce it", () => {
    renderEditor({
      requiredRefusal:
        "Required needs this suite's grading set to Enforce. Until it is, this evaluator can only be Advisory.",
    });
    const role = within(screen.getByRole("group", { name: "Evaluator role" }));
    expect(role.getByRole("button", { name: "Required" })).toBeDisabled();
    expect(role.getByRole("button", { name: "Advisory" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Required needs this suite's grading set to Enforce.",
    );
  });

  it("saves Required with a passing score when grading enforces it", () => {
    const { onSave } = renderEditor();
    fill("Totals", "totals.sh");
    const role = within(screen.getByRole("group", { name: "Evaluator role" }));
    fireEvent.click(role.getByRole("button", { name: "Required" }));
    expect(
      screen.getByText(
        "If this evaluator fails, the iteration fails. If it errors, the iteration is left out of the pass rate.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Passing score" }),
      { target: { value: "0.8" } },
    );
    click("Add evaluator");
    expect(onSave.mock.calls[0][0]).toMatchObject({
      role: "required",
      threshold: 0.8,
    });
  });

  it("refuses a passing score outside 0 to 1", () => {
    const { onSave } = renderEditor({ evaluator: SAVED });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Passing score" }),
      { target: { value: "1.5" } },
    );
    expect(
      screen.getByText("Set a passing score above 0 and at most 1."),
    ).toBeInTheDocument();
    click("Save");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says when the suite's scripts and evaluators would pass the size cap", () => {
    renderEditor({ scripts: { runSetup: "x".repeat(250 * 1024) } });
    type("Script", "y".repeat(10 * 1024));
    expect(
      screen.getByText(
        "Scripts and code evaluators can total at most 256 KB. These total 260 KB.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the suite's refusal when the draft itself was fine", () => {
    const { onSave } = renderEditor();
    onSave.mockReturnValue("Remove a code evaluator to add another.");
    fill("Totals", "totals.py");
    click("Add evaluator");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Remove a code evaluator to add another.",
    );
  });
});

describe("CodeEvaluatorEditor, editing", () => {
  it("opens on the saved evaluator and keeps its ID", () => {
    const { onSave } = renderEditor({ evaluator: SAVED });
    expect(textbox("Name")).toHaveValue("Invoice totals add up");
    expect(textbox("File name")).toHaveValue("check_totals.py");
    expect(
      screen.getByRole("spinbutton", { name: "Passing score" }),
    ).toHaveValue(0.5);
    type("Name", "Totals match");
    type("File name", "totals.py");
    click("Save");
    expect(onSave).toHaveBeenCalledWith({
      ...SAVED,
      name: "Totals match",
      fileName: "totals.py",
    });
  });

  it("reports a changed draft so the dialog can ask before closing", () => {
    const onDirtyChange = vi.fn();
    renderEditor({ evaluator: SAVED, onDirtyChange });
    type("Name", "Totals match");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    type("Name", SAVED.name ?? "");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
