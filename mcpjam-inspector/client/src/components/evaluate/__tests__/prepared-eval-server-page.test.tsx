import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreparedEvalServerPage } from "../prepared-eval-server-page";

const mocks = vi.hoisted(() => ({
  preparation: null as any,
  review: null as any,
  ensure: vi.fn(async () => "job"),
  save: vi.fn(async () => 1),
  refine: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useAction: () => mocks.refine,
  useQuery: (name: string) =>
    name.endsWith(":getReview") ? mocks.review : mocks.preparation,
  useMutation: (name: string) =>
    name.endsWith(":ensure") ? mocks.ensure : mocks.save,
}));
vi.mock("../suite-detail-overview", () => ({ SuiteEmptyCasesHero: () => null }));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-1", name: "Configured client" }],
    isLoading: false,
  }),
}));
const suite = {
  id: "suite",
  title: "Actual server capabilities",
  description: "From metadata",
  cases: [
    {
      id: "case",
      title: "Read available drawings",
      prompt: "List drawings",
      expectedOutput: "Available drawings",
      steps: [{ id: "p", kind: "prompt", prompt: "List drawings" }],
    },
  ],
};
const props = {
  projectId: "project",
  server: { id: "server", name: "Drawing server" },
  onBack: vi.fn(),
  onOpenCase: vi.fn(),
  onRun: vi.fn(async () => {}),
};
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.preparation = null;
  mocks.review = null;
});

describe("prepared server entry", () => {
  it("opens the shared split workspace and iterates on its existing cases through chat", async () => {
    mocks.preparation = { status: "ready", suites: [suite], dueAt: 0 };
    const refinedCase = {
      ...suite.cases[0],
      id: "refined",
      title: "Empty search results",
    };
    mocks.refine.mockResolvedValue({
      revision: 2,
      draft: {
        version: 1,
        serverId: "server",
        suites: [{ ...suite, cases: [...suite.cases, refinedCase] }],
        step: "suites",
        openSuiteIds: [],
        clients: [{ id: "host-1", name: "Configured client" }],
        iterationsPerCase: 1,
        chatHistory: [
          { id: 1, role: "user", text: "Add an empty search case" },
          {
            id: 2,
            role: "assistant",
            text: "Added a case for empty search results.",
          },
        ],
      },
    });
    render(<PreparedEvalServerPage {...props} />);
    await screen.findByText("Read available drawings");
    expect(screen.getByTestId("suite-case-generation-workspace")).toBeTruthy();
    expect(screen.getByText("Refine with AI")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Describe test case refinements"), {
      target: { value: "Add an empty search case" },
    });
    fireEvent.click(screen.getByLabelText("Send refinement"));
    await screen.findByText("Empty search results");
    expect(screen.getByText("Read available drawings")).toBeTruthy();
    expect(
      screen.getByText("Added a case for empty search results."),
    ).toBeTruthy();
    expect(mocks.refine).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        serverId: "server",
        expectedRevision: 1,
        instruction: "Add an empty search case",
      }),
    );
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Confirm run", { selector: "h1" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("eval-server-preview-back"));
    expect(
      screen.getByText("Added a case for empty search results."),
    ).toBeTruthy();
  });

  it("ensures generation on entry and explains a missing snapshot without fixture cases", async () => {
    render(<PreparedEvalServerPage {...props} />);
    await waitFor(() =>
      expect(mocks.ensure).toHaveBeenCalledWith({
        projectId: "project",
        serverId: "server",
      }),
    );
    expect(screen.getByText(/Reconnect this server once/)).toBeTruthy();
    expect(screen.queryByText("Create and assign work")).toBeNull();
  });
  it("shows background progress, then uses the saved cases and actual configured clients", async () => {
    mocks.preparation = { status: "running", suites: [], dueAt: 0 };
    const view = render(<PreparedEvalServerPage {...props} />);
    expect(screen.getByText(/Preparing test cases/)).toBeTruthy();
    mocks.preparation = { status: "ready", suites: [suite], dueAt: 0 };
    view.rerender(<PreparedEvalServerPage {...props} />);
    await screen.findByText(/Actual server capabilities/);
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Configured client")).toBeTruthy();
    expect(screen.queryByText("ChatGPT")).toBeNull();
    fireEvent.click(screen.getByText("Run first evals"));
    await waitFor(() =>
      expect(props.onRun).toHaveBeenCalledWith(
        expect.objectContaining({
          suites: [suite],
          clients: [{ id: "host-1", name: "Configured client" }],
        }),
      ),
    );
  });
  it("preserves an edited review when a newer generation arrives", async () => {
    mocks.preparation = { status: "ready", suites: [suite], dueAt: 0 };
    mocks.review = {
      revision: 2,
      draft: {
        version: 1,
        serverId: "server",
        suites: [{ ...suite, title: "My edited suite" }],
        openSuiteIds: [],
        step: "suites",
        clients: [],
        iterationsPerCase: 1,
      },
    };
    const view = render(<PreparedEvalServerPage {...props} />);
    await screen.findByText(/My edited suite/);
    mocks.preparation = {
      status: "ready",
      suites: [{ ...suite, title: "Updated suggestion" }],
      dueAt: 0,
    };
    view.rerender(<PreparedEvalServerPage {...props} />);
    expect(screen.getByText(/My edited suite/)).toBeTruthy();
    expect(screen.queryByText(/Updated suggestion/)).toBeNull();
  });
  it("leaves cases with uncertain side effects unselected", async () => {
    mocks.preparation = {
      status: "ready",
      suites: [
        {
          ...suite,
          cases: [{ ...suite.cases[0], requiresSetup: true, selected: false }],
        },
      ],
      dueAt: 0,
    };
    render(<PreparedEvalServerPage {...props} />);
    await screen.findByText(/Actual server capabilities/);
    expect(screen.getByText("Continue")).toBeDisabled();

    expect(screen.getByText(/Needs a test environment/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Include Read available drawings"));
    expect(screen.getByText("Continue")).not.toBeDisabled();
  });
});
