import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioModelEditor } from "../ScenarioModelEditor";

const mocks = vi.hoisted(() => ({
  status: {
    modelId: "openai/gpt-4o-mini",
    readiness: { ready: false },
    canEdit: true,
  },
  repair: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
const model = {
  id: "anthropic/claude-sonnet-4.5",
  name: "Sonnet",
  provider: "anthropic",
  hosted: false,
  orgProvider: { id: "org-connection", providerKey: "anthropic" },
};
vi.mock("convex/react", () => ({
  useQuery: () => mocks.status,
  useMutation: () => mocks.repair,
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [model],
    pending: false,
    onAddProvider: null,
  }),
}));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  ModelSelector: ({
    onModelChange,
  }: {
    onModelChange: (model: unknown) => void;
  }) => <button onClick={() => onModelChange(model)}>Choose Sonnet</button>,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.canEdit = true;
  mocks.repair.mockResolvedValue({ saved: true });
});
describe("study model editor", () => {
  it("requires an explicit choice and save, retaining its connection", async () => {
    render(<ScenarioModelEditor scenarioId="study" projectId="project" />);
    expect(screen.getByText("Save model")).toBeDisabled();
    expect(mocks.repair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Choose Sonnet"));
    expect(mocks.repair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Save model"));
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    expect(mocks.repair).toHaveBeenCalledWith({
      scenarioId: "study",
      selection: expect.objectContaining({
        source: "org",
        connectionRef: { kind: "orgProvider", id: "org-connection" },
      }),
    });
  });
  it("shows the explanation without repair controls to a viewer", () => {
    mocks.status.canEdit = false;
    render(<ScenarioModelEditor scenarioId="study" projectId="project" />);
    expect(
      screen.getByText(/An owner or editor must choose/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Save model")).not.toBeInTheDocument();
  });
  it("reports a failed save without claiming the model changed", async () => {
    mocks.repair.mockRejectedValue(new Error("Choose another model."));
    render(<ScenarioModelEditor scenarioId="study" projectId="project" />);
    fireEvent.click(screen.getByText("Choose Sonnet"));
    fireEvent.click(screen.getByText("Save model"));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Choose another model."),
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
