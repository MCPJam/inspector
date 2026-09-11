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
  useEvalGeneration.setState({ suites: {} });
});
afterEach(() => vi.useRealTimers());
it("starts generation directly once and closes the chat even in Strict Mode", () => {
  const generate = vi.fn(() => new Promise<void>(() => {}));
  const unregister = registerEvalSuite(target, {
    read: () => ({}),
    generate,
    save: vi.fn(),
  });
  useAgentPanelStore.setState({ isOpen: true });
  renderWithProviders(
    <StrictMode>
      <EvalGenerationWorkspace {...target} />
    </StrictMode>,
  );
  expect(generate).toHaveBeenCalledTimes(1);
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
  expect(screen.getByText("Generation complete")).toBeVisible();
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
it("shows startup failures and retries directly", () => {
  const generate = vi.fn(() => new Promise<void>(() => {}));
  renderWithProviders(<EvalGenerationWorkspace {...target} />);
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.queryByTestId("generating-case-skeleton")).toBeNull();
  const unregister = registerEvalSuite(target, {
    read: () => ({}),
    generate,
    save: vi.fn(),
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));
  expect(generate).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(8);
  unregister();
});

it("keeps the confirmed options for retries even if stored preferences change", () => {
  const generate = vi.fn(() => new Promise<void>(() => {}));
  const unregister = registerEvalSuite(target, { read: () => ({}), generate, save: vi.fn() });
  const config = { simple: 5, multiTool: 5, multiTurn: 3, complex: 3, negative: 4, varyUserStyles: false, toolCoverage: "read-write" as const };
  renderWithProviders(<EvalGenerationWorkspace {...target} config={config} />);
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(20);
  expect(generate.mock.calls[0]).toEqual([
    expect.any(String), expect.any(Function),
    { caseMix: { simple: 5, multiTool: 5, multiTurn: 3, complex: 3, negative: 4 }, varyUserStyles: false, toolCoverage: "read-write" },
  ]);
  localStorage.clear();
  act(() => seed("error", [], "Try again"));
  fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));
  expect(generate.mock.calls[1]).toEqual(generate.mock.calls[0].map((arg) => typeof arg === "function" ? expect.any(Function) : arg));
  unregister();
});
