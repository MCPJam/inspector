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
  expect(screen.queryByText("Draft Test Cases Generated")).toBeNull();
  expect(screen.getByRole("button", { name: "Review Draft Cases" })).toBeVisible();
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
    expect(screen.queryByText("Draft Test Cases Generated")).toBeNull(),
  );
});

it("starts every draft collapsed and opens only the selected draft", async () => {
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  expect(screen.queryByLabelText("Generated case title")).toBeNull();
  expect(screen.queryByText(/waiting to be added/)).toBeNull();
  const buttons = screen.getAllByRole("button", { name: "Review case" });
  expect(buttons).toHaveLength(2);
  expect(buttons[0]).toHaveAttribute("aria-expanded", "false");
  const user = userEvent.setup();
  await user.click(buttons[0]);
  expect(screen.getByLabelText("Generated case title")).toHaveValue("First");
  await user.click(screen.getByRole("button", { name: "Close editor" }));
  expect(screen.queryByLabelText("Generated case title")).toBeNull();
  await user.click(screen.getAllByRole("button", { name: "Review case" })[1]);
  expect(screen.getByLabelText("Generated case title")).toHaveValue("Second");
  expect(save).not.toHaveBeenCalled();
});

it("does not expose refinement chat outside Describe", () => {
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  expect(screen.queryByRole("button", {name:"Refine with chat"})).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("saves only the current Describe batch when other staged drafts exist", async () => {
  const ids = useEvalGeneration.getState().suites[evalSuiteKey(scope)].drafts;
  renderWithProviders(<EvalGeneratedDrafts {...scope} visibleDraftIds={new Set([ids[0].id])} saveVisibleOnly hideChat />);
  await userEvent.setup().click(screen.getByRole("button", {name:"Save all"}));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].title).toBe("First");
  await waitFor(() => expect(screen.getByText("All tests in this batch are saved.")).toBeVisible());
});

it("hides an empty draft section even when a previous generation failed", () => {
  useEvalGeneration.setState({
    suites: {
      [key]: {
        status: "error",
        drafts: [],
        error: "Re-authenticate with Monday to generate test cases.",
      },
    },
  });
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  expect(
    screen.queryByRole("heading", { name: "Draft Test Cases Generated" }),
  ).toBeNull();
  expect(screen.queryByText(/0 drafts/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("saves shared case-body outcome edits without losing generated actions", async () => {
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "Review case" })[0]);
  await user.type(
    screen.getByLabelText("Expected Outcome"),
    "Ticket is displayed",
  );
  await user.click(screen.getByRole("button", { name: "Add First to suite" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOutput: "Ticket is displayed",
        steps: [{ id: "prompt", kind: "prompt", prompt: "Find ticket" }],
      }),
    ),
  );
});

it("keeps retained drafts collapsed on return without losing them", async () => {
  const user = userEvent.setup();
  const view = renderWithProviders(<EvalGeneratedDrafts {...scope} defaultOpen={false} />);
  expect(screen.getByRole("button", { name: "Review Draft Cases" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("article", { name: "Draft: First" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Review Draft Cases" }));
  expect(screen.getByRole("article", { name: "Draft: First" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Review Draft Cases" }));
  expect(screen.queryByRole("article", { name: "Draft: First" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Review Draft Cases" }));
  view.unmount();
  renderWithProviders(<EvalGeneratedDrafts {...scope} defaultOpen={false} />);
  expect(screen.getByRole("button", { name: "Review Draft Cases" })).toHaveAttribute("aria-expanded", "false");
  expect(useEvalGeneration.getState().suites[key].drafts).toHaveLength(2);
  expect(save).not.toHaveBeenCalled();
});

it("removes unwanted drafts without saving and persists the remaining drafts", async () => {
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  expect(screen.queryByText("Draft", { exact: true })).toBeNull();
  expect(screen.queryByText(/steps · .* checks/)).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Remove First" }));
  expect(screen.queryByRole("article", { name: "Draft: First" })).toBeNull();
  expect(screen.getByRole("article", { name: "Draft: Second" })).toBeVisible();
  expect(useEvalGeneration.getState().suites[key].drafts.map((draft) => draft.id)).toEqual(["Second"]);
  expect(JSON.parse(localStorage.getItem("mcpjam:eval-generated-drafts:v1")!)[key].drafts.map((draft: { id: string }) => draft.id)).toEqual(["Second"]);
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Remove Second" }));
  expect(screen.queryByRole("region", { name: "Generated case drafts" })).toBeNull();
});

it("prevents removing a draft while it is being saved", async () => {
  let finish!: () => void;
  save.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Add First to suite" }));
  expect(screen.getByRole("button", { name: "Remove First" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Second" })).toBeEnabled();
  finish();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove First" })).toBeNull());
});
