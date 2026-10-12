import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, userEvent } from "@/test";
import { GenerateCasesDialog } from "../generate-cases-dialog";
import { SuiteDetailOverview } from "../suite-detail-overview";
import { metricsByRunFromIterations } from "../../evals/run-metrics";
import { authoringRequest } from "@/lib/apis/eval-authoring-api";
import type { EvalSuite } from "../../evals/types";
import {
  loadGenerateConfig,
  totalCases,
} from "@/lib/evals/eval-generation-config";

const auth = vi.hoisted(() => ({
  member: true as boolean | undefined,
  signIn: vi.fn(),
}));

vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => auth.member,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "signed-in-user" }, signIn: auth.signIn }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));
vi.mock("@/lib/apis/eval-authoring-api", async (original) => ({
  ...(await original<object>()),
  authoringRequest: vi.fn(),
}));

const suite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u1",
  name: "Checkout",
  description: "",
  configRevision: "1",
  environment: { servers: ["payments"] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
  defaultPassCriteria: { minimumPassRate: 80 },
};

beforeEach(() => {
  localStorage.clear();
  auth.member = true;
  auth.signIn.mockClear();
});

it("offers sign-in instead of configuration for a guest actor, even while WorkOS reports a user", async () => {
  auth.member = false;
  const onGenerate = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={onClose} />,
  );
  expect(screen.getByText("Sign in to generate test cases.")).toBeVisible();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect(onGenerate).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("waits for the actor before showing generation or a sign-in prompt", () => {
  auth.member = undefined;
  const onGenerate = vi.fn();
  const view = renderWithProviders(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading account…");
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
  expect(onGenerate).not.toHaveBeenCalled();
  auth.member = true;
  view.rerender(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "Generate cases" })).toBeEnabled();
});

it("stops offering generation when the actor becomes a guest", () => {
  const onGenerate = vi.fn();
  const view = renderWithProviders(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );
  auth.member = false;
  view.rerender(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
  expect(onGenerate).not.toHaveBeenCalled();
});

it("gates a project-backed guest before authoring while keeping manual case creation available", async () => {
  auth.member = false;
  const started = vi.mocked(authoringRequest);
  started.mockClear();
  const onEditCases = vi.fn();
  const onGenerateTestCases = vi.fn();
  renderWithProviders(
    <SuiteDetailOverview
      projectId="project-1"
      suite={suite}
      cases={[]}
      runs={[]}
      runsLoading={false}
      metricsByRun={metricsByRunFromIterations([])}
      hostNamesById={new Map()}
      onRerun={vi.fn()}
      onEditSuite={vi.fn()}
      onEditCases={onEditCases}
      onGenerateTestCases={onGenerateTestCases}
      canGenerateTestCases
      onImportCases={vi.fn()}
      onRunClick={vi.fn()}
      onTestCaseClick={vi.fn()}
      rerunningSuiteId={null}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByTestId("suite-empty-action-generate"));
  expect(screen.getByText("Sign in to generate test cases.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
  expect(screen.queryByTestId("suite-case-generation-workspace")).toBeNull();
  expect(started).not.toHaveBeenCalled();
  expect(onGenerateTestCases).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByTestId("suite-empty-action-describe"));
  expect(onEditCases).toHaveBeenCalledOnce();
});

it("defaults to quick and read-only without generating on open or cancel", async () => {
  const onGenerate = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole("radio", { name: /Quick set/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Read-only/ })).toBeChecked();
  expect(screen.queryByText(/Suite default assertions/)).toBeNull();
  expect(screen.getByText("5–10 cases")).toBeVisible();
  expect(screen.getByText("20 cases")).toBeVisible();
  expect(screen.queryByText(/depends/i)).toBeNull();
  expect(onGenerate).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(onGenerate).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it("submits and remembers comprehensive read/write settings only on confirmation", async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  const view = renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("radio", { name: /Comprehensive/ }));
  await user.click(screen.getByRole("radio", { name: /Read and write/ }));
  expect(onGenerate).not.toHaveBeenCalled();
  expect(loadGenerateConfig("s").testSet).toBeUndefined();
  await user.click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate).toHaveBeenCalledOnce();
  const config = onGenerate.mock.calls[0][0];
  expect(config).toMatchObject({
    testSet: "comprehensive",
    toolCoverage: "read-write",
  });
  expect(totalCases(config)).toBe(20);
  view.unmount();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Comprehensive/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Read and write/ })).toBeChecked();
});

it("requires a mixed suite to pick the environment it generates for", async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  const choices = [
    {
      environmentId: "env-a",
      hostName: "Claude",
      modelId: "opus",
      serverNames: ["billing"],
      pluginVersionCount: 0,
    },
    {
      environmentId: "env-b",
      name: "Search box",
      hostName: "Cursor",
      serverNames: ["search"],
      pluginVersionCount: 1,
    },
  ];
  const view = renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      environmentChoices={choices}
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("search + 1 plugin")).toBeVisible();
  const generate = screen.getByRole("button", { name: "Generate cases" });
  expect(generate).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: /Search box/ }));
  await user.click(generate);
  expect(onGenerate).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId: "env-b" }),
  );
  expect(loadGenerateConfig("s").environmentId).toBe("env-b");

  // The pick is remembered for the next batch.
  view.unmount();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      environmentChoices={choices}
      onGenerate={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Search box/ })).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Generate cases" }),
  ).not.toBeDisabled();
});

it("sends no environment for a suite with nothing to pick", async () => {
  const onGenerate = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate.mock.calls[0][0]).not.toHaveProperty("environmentId");
});
