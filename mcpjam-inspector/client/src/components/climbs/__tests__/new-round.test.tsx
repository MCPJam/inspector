import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const draftChange = vi.fn();
const readMockDefinition = vi.fn();
const saveMockDefinition = vi.fn();
const submitRound = vi.fn();
vi.mock("@/lib/apis/climbs-api", () => ({
  draftChange: (...a: unknown[]) => draftChange(...a),
  readMockDefinition: (...a: unknown[]) => readMockDefinition(...a),
  saveMockDefinition: (...a: unknown[]) => saveMockDefinition(...a),
  submitRound: (...a: unknown[]) => submitRound(...a),
}));

import { NewRound } from "../new-round";
import { makeClimb } from "./fixtures";

const entry = (over: object = {}, where: object = {}) => ({
  rank: 1,
  where: { kind: "tool", tool: "list_projects", field: "description", mockPath: "tools.list_projects.description", ...where },
  current: "List projects.",
  readBy: [
    { client: "mcpjam", reads: "reads" },
    { client: "claude-code", reads: "reads" },
    { client: "codex", reads: "ignores" },
  ],
  readByAnyClient: true,
  failedIterations: 4,
  failedRuns: [],
  tried: [{ round: 2, verdict: "kept" }],
  ...over,
});

function climbWith(entries: unknown[], extra: object = {}) {
  return makeClimb({
    state: "ready",
    best: { serverId: "mock_1", serverVersion: "2", roundNumber: 1 },
    groups: { steering: 2, validation: 1, confirmation: 0, steeringCases: [{ key: "c1", tool: "list_projects" }], steeringToolsWithoutValidation: [] },
    whatCanChange: entries as never,
    ...extra,
  });
}

function show(climb = climbWith([entry()]), onSubmitted = vi.fn(), optionId: string | undefined = "tool_descriptions") {
  render(<NewRound climb={climb} optionId={optionId} optionLabel="Tool descriptions" onSubmitted={onSubmitted} />);
  return onSubmitted;
}

beforeEach(() => {
  [draftChange, readMockDefinition, saveMockDefinition, submitRound].forEach((fn) => fn.mockReset());
});

describe("NewRound", () => {
  it("lists what can change, with the fact behind it and what was tried", () => {
    show();
    expect(screen.getByText("What you can change")).toBeInTheDocument();
    expect(screen.getByText("4 failed iterations point here")).toBeInTheDocument();
    expect(screen.getByText("Round 2, kept")).toBeInTheDocument();
  });

  it("says which clients read it", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /Read by/ }));
    expect(screen.getByText("Read by MCPJam, Claude Code.")).toBeInTheDocument();
  });

  it("will not try a change no client reads", () => {
    show(climbWith([entry({ readByAnyClient: false, readBy: [] })]));
    expect(screen.getByRole("button", { name: /Try it/ })).toBeDisabled();
  });

  it("says why the list is empty", () => {
    show(climbWith([]));
    expect(screen.getByText(/Nothing in this option can change/)).toBeInTheDocument();
    show(climbWith([], { whatCanChange: undefined }));
    expect(screen.getByText(/appears once the baseline has settled/)).toBeInTheDocument();
  });

  it("drafts with a model, shows who drafted it, and does not run anything", async () => {
    draftChange.mockResolvedValue({ description: "Lists the projects you can open.", modelUsed: "openai/gpt-4.1-mini", trialsRead: 3 });
    show();
    await userEvent.click(screen.getByRole("button", { name: /Try it/ }));
    expect(screen.getByLabelText("Change to")).toHaveValue("List projects.");
    await userEvent.click(screen.getByRole("button", { name: /Draft with a model/ }));
    await waitFor(() => expect(screen.getByLabelText("Change to")).toHaveValue("Lists the projects you can open."));
    expect(screen.getByText(/Drafted by openai\/gpt-4.1-mini from 3 failed iterations/)).toBeInTheDocument();
    expect(draftChange).toHaveBeenCalledWith({ projectId: "proj_1", climbId: "climb_1", toolName: "list_projects", includeTitle: false });
    expect(saveMockDefinition).not.toHaveBeenCalled();
    expect(submitRound).not.toHaveBeenCalled();
  });

  it("keeps what was typed and says what to do when the draft is refused", async () => {
    draftChange.mockImplementation(async () => {
      throw new Error("MCPJam's drafting budget for today is spent. Write the change yourself.");
    });
    show();
    await userEvent.click(screen.getByRole("button", { name: /Try it/ }));
    await userEvent.click(screen.getByRole("button", { name: /Draft with a model/ }));
    expect(await screen.findByText(/drafting budget for today is spent/)).toBeInTheDocument();
    expect(screen.getByLabelText("Change to")).toHaveValue("List projects.");
  });

  it("offers no draft for a tool no steering case calls", async () => {
    show(climbWith([entry()], { groups: { steering: 1, validation: 1, confirmation: 0, steeringCases: [{ key: "c1", tool: "other" }], steeringToolsWithoutValidation: [] } }));
    await userEvent.click(screen.getByRole("button", { name: /Try it/ }));
    expect(screen.queryByRole("button", { name: /Draft with a model/ })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing for a model to draft from/)).toBeInTheDocument();
  });

  it("saves the change on the best so far's mock and submits that version", async () => {
    readMockDefinition.mockResolvedValue({ definition: { tools: { list_projects: { title: "T" } } }, headVersion: 3 });
    saveMockDefinition.mockResolvedValue({ version: 4, created: true });
    submitRound.mockResolvedValue({ roundNumber: 2 });
    const onSubmitted = show();
    await userEvent.click(screen.getByRole("button", { name: /Try it/ }));
    await userEvent.clear(screen.getByLabelText("Change to"));
    await userEvent.type(screen.getByLabelText("Change to"), "Lists them.");
    await userEvent.click(screen.getByRole("button", { name: "Run round" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(2));
    expect(readMockDefinition).toHaveBeenCalledWith({ projectId: "proj_1", mockId: "mock_1", version: 2 });
    expect(saveMockDefinition).toHaveBeenCalledWith({
      projectId: "proj_1",
      mockId: "mock_1",
      definition: { tools: { list_projects: { title: "T", description: "Lists them." } } },
      expectedVersion: 3,
    });
    expect(submitRound).toHaveBeenCalledWith(expect.objectContaining({ climbId: "climb_1", serverId: "mock_1", serverVersion: "4" }));
  });

  it("shows the backend's refusal and keeps the form when the round is refused", async () => {
    readMockDefinition.mockResolvedValue({ definition: {}, headVersion: 1 });
    saveMockDefinition.mockResolvedValue({ version: 2, created: true });
    submitRound.mockImplementation(async () => {
      throw new Error("No client of this climb reads this. Change a field MCPJam's client reads.");
    });
    const onSubmitted = show();
    await userEvent.click(screen.getByRole("button", { name: /Try it/ }));
    await userEvent.type(screen.getByLabelText("Change to"), " More.");
    await userEvent.click(screen.getByRole("button", { name: "Run round" }));
    expect(await screen.findByText(/No client of this climb reads this/)).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run round" })).toBeEnabled();
  });

  it("will not run empty text or invalid JSON", async () => {
    show(climbWith([entry({ current: { type: "object" } }, { field: "inputSchema" })]), vi.fn(), "tool_inputs");
    await userEvent.click(screen.getByRole("button", { name: /Try it/ }));
    await userEvent.clear(screen.getByLabelText("Change to"));
    await userEvent.type(screen.getByLabelText("Change to"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Run round" }));
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(readMockDefinition).not.toHaveBeenCalled();
  });

  it("shows the rounds and credits left", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /Try it/ }));
    expect(screen.getByText(/Round 1 of 10\. 3,800 credits left\./)).toBeInTheDocument();
  });
});
