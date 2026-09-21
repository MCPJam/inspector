import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import {
  EvalGeneratedDrafts,
  describeEvalDraftError,
} from "../eval-generated-drafts";
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

/**
 * The store keeps the wire message verbatim on purpose, so the shaping has to
 * happen at render — and this list OVERRIDES the Generate screen's own line the
 * moment a draft lands, which is exactly the reported screenshot.
 */
it("explains a model-limit refusal instead of echoing its raw body", () => {
  useEvalGeneration.setState((s) => ({
    suites: {
      [key]: {
        ...s.suites[key],
        status: "error",
        error:
          'Failed to generate test cases: {"ok":false,"code":"user_rate_limit","limitKind":"total","error":"Daily MCPJam model limit reached. Use BYOK or try again tomorrow.","isRetryable":true}',
      },
    },
  }));
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(/Out of MCPJam credits\./);
  expect(alert).not.toHaveTextContent("user_rate_limit");
});

it("turns a write conflict on a draft into a plain retry line", () => {
  useEvalGeneration.setState((s) => ({
    suites: {
      [key]: {
        ...s.suites[key],
        drafts: s.suites[key].drafts.map((draft, index) =>
          index === 0
            ? {
                ...draft,
                error:
                  '[Request ID: abc] Server Error\nUncaught Error: Documents read from or written to the "testSuites" table changed while this mutation was being run and on every subsequent retry. Another call to this mutation changed the document. {"code":"OptimisticConcurrencyControlFailure"}',
              }
            : draft,
        ),
      },
    },
  }));
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "Another change to this suite landed first. Try adding it again.",
  );
  expect(alert).not.toHaveTextContent("OptimisticConcurrencyControlFailure");
});

it("leaves an ordinary draft error verbatim", () => {
  useEvalGeneration.setState((s) => ({
    suites: {
      [key]: {
        ...s.suites[key],
        drafts: s.suites[key].drafts.map((draft, index) =>
          index === 0 ? { ...draft, error: "Save failed. Try again." } : draft,
        ),
      },
    },
  }));
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Save failed. Try again.");
});

/**
 * Every save reads and writes the SAME suite document, so firing them together
 * loses the optimistic-concurrency check and all but one fail. Serializing is
 * the fix, so the ordering is the thing worth pinning.
 */
it("adds drafts one at a time so they cannot collide on the suite", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  save.mockImplementation(async (input: { title: string }) => {
    order.push(`start:${input.title}`);
    if (input.title === "First") await first;
    order.push(`end:${input.title}`);
  });
  renderWithProviders(<EvalGeneratedDrafts {...scope} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Add all to suite" }));
  await waitFor(() => expect(order).toContain("start:First"));
  expect(order).not.toContain("start:Second");
  releaseFirst();
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(order).toEqual([
    "start:First",
    "end:First",
    "start:Second",
    "end:Second",
  ]);
});

it("does not put the model's own contract error on screen", () => {
  // The job retries these itself. A serialized issue array names a field of a
  // contract the reader cannot see and cannot act on.
  expect(
    describeEvalDraftError(
      '[{"code":"invalid_type","expected":"string","received":"undefined","path":["drafts",0,"additions",0,"id"],"message":"Required"}]',
    ),
  ).toBe("The model's reply did not match the case contract. Retrying.");
  // Anything written for a person still reaches them verbatim.
  expect(describeEvalDraftError("You cannot import into this suite.")).toBe(
    "You cannot import into this suite.",
  );
});
