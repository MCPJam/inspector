import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import { EvalGeneratedDrafts } from "../eval-generated-drafts";
import {
  evalSuiteKey,
  registerEvalSuite,
  useEvalGeneration,
} from "@/lib/mcpjam-agent/eval-workspace";

vi.mock("../../evals/step-list-editor", () => ({ StepListEditor: () => null }));
const scope = { projectId: "project", suiteId: "suite", suiteName: "Suite" };
const key = evalSuiteKey(scope);
const save = vi.fn();
let cleanup: () => void;
beforeEach(() => {
  save.mockReset().mockResolvedValue("saved");
  cleanup = registerEvalSuite(scope, {
    read: () => ({}),
    generate: async () => {},
    save,
  });
  useEvalGeneration.setState({
    suites: {
      [key]: {
        status: "ready",
        drafts: ["First", "Second"].map((title) => ({
          id: title,
          revision: "r1",
          input: {
            suiteId: "suite",
            title,
            query: "Find ticket",
            models: [],
            expectedToolCalls: [],
            runs: 1,
            isNegativeTest: false,
            steps: [
              { id: "prompt", kind: "prompt" as const, prompt: "Find ticket" },
            ],
          },
        })),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  useEvalGeneration.setState({ suites: {} });
});

it("adds all staged cases explicitly and clears the draft section after saving", async () => {
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  expect(screen.getByText("Unsaved generated drafts")).toBeVisible();
  expect(save).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Add all to suite" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Generated case drafts" }),
    ).toBeNull(),
  );
});

it("lets a collapsed draft be added individually", async () => {
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Add First to suite" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ title: "First" }),
  );
  expect(screen.getByText("Second")).toBeVisible();
});

it("retains failed drafts with visible errors and retries only those remaining", async () => {
  save.mockImplementation(async (input) => {
    if (input.title === "Second") throw new Error("Save failed. Try again.");
  });
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add all to suite" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Save failed. Try again.",
  );
  expect(screen.queryByText("First")).toBeNull();
  save.mockResolvedValue("saved");
  await user.click(screen.getByRole("button", { name: "Add all to suite" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  expect(useEvalGeneration.getState().suites[key].drafts).toHaveLength(0);
});

it("disables duplicate saves while requests are pending", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  save.mockReturnValue(pending);
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Add all to suite" }));
  expect(screen.getByRole("button", { name: "Adding cases…" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Add First to suite" }),
  ).toBeDisabled();
  finish();
  await waitFor(() =>
    expect(screen.queryByText("Unsaved generated drafts")).toBeNull(),
  );
});

it("opens the first review card and provides an explicit review action for the next draft", async () => {
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  expect(screen.getByLabelText("Generated case title")).toHaveValue("First");
  await userEvent.setup().click(screen.getByRole("button", { name: "Review case" }));
  expect(screen.getByLabelText("Generated case title")).toHaveValue("Second");
  expect(save).not.toHaveBeenCalled();
});

it("opens the shared chat with a refinement prompt naming the selected draft", async () => {
  const { useAgentPanelStore } = await import("@/stores/agent-panel/agent-panel-store");
  const { useEvalPromptQueue } = await import("@/lib/mcpjam-agent/eval-scope");
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  await userEvent.setup().click(screen.getAllByRole("button", { name: "Refine with chat" })[0]);
  const panel = useAgentPanelStore.getState();
  expect(panel.isOpen).toBe(true);
  expect(useEvalPromptQueue.getState().pending[panel.activeSessionId!].text).toContain('"First"');
  expect(save).not.toHaveBeenCalled();
});
