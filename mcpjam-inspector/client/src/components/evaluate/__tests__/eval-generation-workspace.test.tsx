import { StrictMode } from "react";
import { act, fireEvent } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import {
  useEvalGeneration,
  evalSuiteKey,
  registerEvalSuite,
} from "@/lib/mcpjam-agent/eval-workspace";
import { EvalGenerationWorkspace } from "../eval-generation-workspace";
import {
  NO_READ_ONLY_CASES_MESSAGE,
  NO_READ_ONLY_TOOLS_MESSAGE,
} from "@/shared/eval-generation-errors";
import { authoringRequest } from "@/lib/apis/eval-authoring-api";

// Generation starts the shared authoring job, so "did it start?" is a request
// on the wire rather than a call into the suite bridge. The poller that
// follows the job is the module's own, so its read has to answer too.
vi.mock("@/lib/apis/eval-authoring-api", async (original) => ({
  ...(await original<object>()),
  authoringRequest: vi.fn(async () => ({ jobId: "job-1" })),
  readAuthoringJob: vi.fn(async () => ({
    jobId: "job-1",
    status: "pending",
    phase: "draft",
    error: null,
    warnings: [],
    drafts: [],
  })),
}));
const started = vi.mocked(authoringRequest);
/** The options a start carried, which is all these tests assert about it. */
function startedOptions(call: number) {
  return (started.mock.calls[call][0] as { input: { options?: unknown } }).input
    .options;
}

const target = { projectId: "p", suiteId: "s", suiteName: "Suite" };
const key = evalSuiteKey(target);
const draft = (id: string) => ({
  id,
  revision: "r1",
  input: { suiteId: "s", title: id, steps: [] } as any,
});
function seed(
  status: "ready" | "running" | "error",
  ids: string[],
  error?: string,
) {
  useEvalGeneration.setState({
    suites: { [key]: { status, drafts: ids.map(draft), error } },
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  started.mockClear();
  useEvalGeneration.setState({ suites: {} });
});
afterEach(() => vi.useRealTimers());
it("starts generation directly once and closes the chat even in Strict Mode", () => {
  const unregister = registerEvalSuite(target, {
    read: () => ({}),
    save: vi.fn(),
  });
  useAgentPanelStore.setState({ isOpen: true });
  renderWithProviders(
    <StrictMode>
      <EvalGenerationWorkspace {...target} />
    </StrictMode>,
  );
  expect(started).toHaveBeenCalledTimes(1);
  expect(useAgentPanelStore.getState().isOpen).toBe(false);
  expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(8);
  unregister();
});
it("replaces skeletons one by one when all cases arrive together", () => {
  seed("running", []);
  renderWithProviders(
    <EvalGenerationWorkspace {...target} autoStart={false} />,
  );
  act(() => seed("ready", ["First case", "Second case", "Third case"]));
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(3);
  expect(screen.queryByText("First case")).toBeNull();
  act(() => vi.advanceTimersByTime(180));
  expect(screen.getByText("First case")).toBeVisible();
  expect(screen.queryByText("Second case")).toBeNull();
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(2);
  expect(
    screen.getByRole("button", { name: "Add all to suite" }),
  ).toBeDisabled();
  act(() => vi.advanceTimersByTime(180));
  expect(screen.getByText("Second case")).toBeVisible();
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(1);
  act(() => vi.advanceTimersByTime(180));
  expect(screen.getByText("Third case")).toBeVisible();
  expect(screen.queryByTestId("generating-case-skeleton")).toBeNull();
  // The corner status line is gone: the drafts panel below carries the state,
  // and saying "Generating cases…" in both places said it twice.
  expect(screen.queryByText("Generation complete")).toBeNull();
  expect(screen.getByText(/3 cases written/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Add all to suite" }),
  ).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Refine with chat" })).toBeNull();
});
it("reveals streamed cases while retaining placeholders for the remaining cases", () => {
  seed("running", ["Existing case"]);
  renderWithProviders(
    <EvalGenerationWorkspace {...target} autoStart={false} />,
  );
  expect(screen.getByText("Existing case")).toBeVisible();
  act(() => seed("running", ["Existing case", "New case"]));
  act(() => vi.advanceTimersByTime(180));
  expect(screen.getByText("New case")).toBeVisible();
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(7);
  act(() => seed("ready", ["Existing case", "New case"]));
  expect(screen.queryByTestId("generating-case-skeleton")).toBeNull();
});
it("retains drafts and exposes errors without endless skeletons", () => {
  seed("error", ["Retained case"], "Generation failed");
  renderWithProviders(
    <EvalGenerationWorkspace {...target} autoStart={false} />,
  );
  expect(screen.getByText("Retained case")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("Generation failed");
  expect(screen.queryByTestId("generating-case-skeleton")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Retry generation" }),
  ).toBeEnabled();
});
/**
 * A scope no server can satisfy fails identically on every attempt, so the
 * retry button was an offer that could not be met. The way out is the setting
 * the message names.
 */
it("offers the settings, not a retry, when retrying cannot succeed", () => {
  const unregister = registerEvalSuite(target, {
    read: () => ({}),
    save: vi.fn(),
  });
  const onChangeSettings = vi.fn();
  seed("error", [], NO_READ_ONLY_TOOLS_MESSAGE);
  renderWithProviders(
    <EvalGenerationWorkspace
      {...target}
      autoStart={false}
      onChangeSettings={onChangeSettings}
    />,
  );
  expect(screen.queryByRole("button", { name: "Retry generation" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Change generation settings" }),
  );
  expect(onChangeSettings).toHaveBeenCalledTimes(1);
  expect(started).not.toHaveBeenCalled();
  unregister();
});

/** The sibling scope failure IS model-dependent, so the retry stands. */
it("keeps the retry when a fresh attempt could still succeed", () => {
  seed("error", [], NO_READ_ONLY_CASES_MESSAGE);
  renderWithProviders(
    <EvalGenerationWorkspace
      {...target}
      autoStart={false}
      onChangeSettings={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Retry generation" })).toBeEnabled();
});

/**
 * The list empties as drafts are saved or discarded, so "no drafts" is
 * normally the END of the work rather than a generation that produced
 * nothing — and the page said the opposite of what had happened.
 */
it("says the work is finished once every draft has been reviewed", () => {
  const onDone = vi.fn();
  seed("ready", ["Reviewed case"]);
  const view = renderWithProviders(
    <EvalGenerationWorkspace {...target} autoStart={false} onDone={onDone} />,
  );
  act(() => seed("ready", []));
  view.rerender(
    <EvalGenerationWorkspace {...target} autoStart={false} onDone={onDone} />,
  );
  expect(
    screen.getByText("Every generated case has been reviewed."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Back to/ }));
  expect(onDone).toHaveBeenCalledTimes(1);
});

/** A run that genuinely produced nothing must not claim a review happened. */
it("says nothing was generated when no draft ever arrived", () => {
  seed("ready", []);
  renderWithProviders(
    <EvalGenerationWorkspace {...target} autoStart={false} onDone={vi.fn()} />,
  );
  expect(screen.getByText("No cases were generated.")).toBeVisible();
});

it("shows startup failures and retries directly", () => {
  renderWithProviders(<EvalGenerationWorkspace {...target} />);
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.queryByTestId("generating-case-skeleton")).toBeNull();
  const unregister = registerEvalSuite(target, {
    read: () => ({}),
    save: vi.fn(),
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));
  expect(started).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(8);
  unregister();
});

it("keeps the confirmed options for retries even if stored preferences change", () => {
  const unregister = registerEvalSuite(target, { read: () => ({}), save: vi.fn() });
  const config = { simple: 5, multiTool: 5, multiTurn: 3, complex: 3, negative: 4, varyUserStyles: false, toolCoverage: "read-write" as const };
  renderWithProviders(<EvalGenerationWorkspace {...target} config={config} />);
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(20);
  expect(startedOptions(0)).toEqual({
    caseMix: { simple: 5, multiTool: 5, multiTurn: 3, complex: 3, negative: 4 },
    varyUserStyles: false,
    toolCoverage: "read-write",
  });
  localStorage.clear();
  act(() => seed("error", [], "Try again"));
  fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));
  expect(startedOptions(1)).toEqual(startedOptions(0));
  unregister();
});

it("explains a model-limit refusal instead of echoing its raw body", () => {
  seed(
    "error",
    [],
    'Failed to generate test cases: {"ok":false,"code":"user_rate_limit","limitKind":"total","error":"Daily MCPJam model limit reached. Use BYOK or try again tomorrow.","isRetryable":true}',
  );
  renderWithProviders(
    <EvalGenerationWorkspace {...target} autoStart={false} />,
  );
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(/Out of MCPJam credits\./);
  expect(alert).not.toHaveTextContent("user_rate_limit");
  expect(
    screen.getByRole("button", { name: "Retry generation" }),
  ).toBeEnabled();
});
