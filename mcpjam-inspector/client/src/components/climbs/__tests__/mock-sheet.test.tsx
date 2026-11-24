import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const readMockSheet = vi.fn();
const saveMockDefinition = vi.fn();
// A plain function for the failing case: the runner counts a spy's rejected copy as unhandled.
let refusal: Error | undefined;
vi.mock("@/lib/apis/climbs-api", () => ({
  readMockSheet: async (...a: unknown[]) => {
    const answer = readMockSheet(...a);
    if (refusal) throw refusal;
    return answer;
  },
  saveMockDefinition: async (...a: unknown[]) => saveMockDefinition(...a),
}));

import { MockSheet } from "../mock-sheet";

const mock = (over: object = {}) => ({
  id: "m1",
  address: "https://app.test/api/web/mock-mcp/m1",
  version: 3,
  headVersion: 3,
  definition: {},
  unmatchedCalls: [],
  realServer: { status: "read", tools: [] },
  changes: [
    { target: "tool", name: "list_projects", kind: "changed", summary: 'Changed the description of "list_projects"', details: [{ path: "description", kind: "changed", before: "List projects.", after: "Lists the projects you can open.", summary: "Changed the description" }] },
  ],
  ...over,
});

const show = () => render(<MockSheet projectId="p" mockId="m1" name="mcpjam-mcp climb" open onOpenChange={vi.fn()} />);

beforeEach(() => {
  readMockSheet.mockReset();
  saveMockDefinition.mockReset();
  refusal = undefined;
});

describe("MockSheet", () => {
  it("shows the address with a copy button, and each edit with its before and after", async () => {
    readMockSheet.mockResolvedValue(mock());
    show();
    expect(await screen.findByDisplayValue("https://app.test/api/web/mock-mcp/m1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument();
    expect(screen.getByText("Mock")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /list_projects/ }));
    expect(screen.getByText("Lists the projects you can open.")).toBeInTheDocument();
    // Reads the head, then what changed since the first version.
    expect(readMockSheet).toHaveBeenLastCalledWith({ projectId: "p", mockId: "m1", sinceVersion: 1 }, expect.anything());
  });
  it("says a mock with no edits answers as the real server does, and when it has no public address", async () => {
    readMockSheet.mockResolvedValue(mock({ headVersion: 1, version: 1, changes: undefined, address: null }));
    show();
    expect(await screen.findByText(/answers exactly as the real server does/)).toBeInTheDocument();
    expect(screen.getByText(/no public address for mock servers/)).toBeInTheDocument();
  });
  it("says when the real server could not be read", async () => {
    readMockSheet.mockResolvedValue(mock({ realServer: { status: "unreachable", message: "The real server did not answer.", tools: [] } }));
    show();
    expect(await screen.findByText("The real server did not answer.")).toBeInTheDocument();
  });
  it("says it is loading while the mock is read", () => {
    readMockSheet.mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the mock server.");
  });
  it("says why it did not load", async () => {
    refusal = new Error("This mock does not exist.");
    show();
    expect(await screen.findByText("The mock server did not load")).toBeInTheDocument();
  });
  it("reads nothing while closed", () => {
    render(<MockSheet projectId="p" mockId="m1" name="x" open={false} onOpenChange={vi.fn()} />);
    expect(readMockSheet).not.toHaveBeenCalled();
  });
});

const entry = (tool: string, field: string, current: unknown) => ({
  rank: 1,
  where: { kind: "tool", tool, field, mockPath: `tools.${tool}.${field}` },
  current,
  readBy: [],
  readByAnyClient: true,
  failedIterations: 0,
  failedRuns: [],
  tried: [],
});

const withTools = (over: object = {}) =>
  mock({
    definition: { tools: { get_run: { description: "Returns one run by id." } } },
    whatCanChange: [
      entry("list_projects", "description", "List projects."),
      entry("list_projects", "inputSchema", { type: "object", properties: {} }),
      entry("get_run", "description", "Gets a run."),
      entry("get_run", "inputSchema", { type: "object", properties: { runId: { type: "string" } } }),
    ],
    changes: [],
    ...over,
  });

const openTool = async (name: string) => {
  await screen.findByText("Tools");
  await userEvent.click(screen.getByRole("button", { name }));
};

describe("MockSheet editing", () => {
  it("lists each tool, with its description, schema and how it answers", async () => {
    readMockSheet.mockResolvedValue(withTools());
    show();
    await openTool("get_run");
    expect(screen.getByRole("button", { name: "list_projects" })).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toHaveValue("Returns one run by id.");
    expect(screen.getByText("As your server lists it")).toBeInTheDocument();
    expect(screen.getByText(/"runId"/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Your server" })).toBeChecked();
  });
  it("does not offer your server for a tool only the mock lists", async () => {
    readMockSheet.mockResolvedValue(
      withTools({ definition: { tools: { extra: { description: "Added.", answer: { from: "model" } } } } }),
    );
    show();
    await openTool("extra");
    expect(screen.getByRole("radio", { name: "A model" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Your server" })).not.toBeInTheDocument();
  });
  it("shows what the real server says on request", async () => {
    readMockSheet.mockResolvedValue(withTools());
    show();
    await openTool("get_run");
    await userEvent.click(screen.getByRole("button", { name: "See what your server says" }));
    expect(screen.getByText("Gets a run.")).toBeInTheDocument();
  });
  it("saves an edited description as the next version, then reads the sheet again", async () => {
    readMockSheet.mockResolvedValue(withTools());
    saveMockDefinition.mockResolvedValue({ version: 4, created: true });
    show();
    await openTool("list_projects");
    await userEvent.type(screen.getByLabelText("Description"), " Call it first.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as version 4.")).toBeInTheDocument();
    expect(saveMockDefinition).toHaveBeenCalledWith(
      {
        projectId: "p",
        mockId: "m1",
        expectedVersion: 3,
        definition: {
          tools: {
            get_run: { description: "Returns one run by id." },
            list_projects: { description: "List projects. Call it first." },
          },
        },
      },
    );
    // Reads the sheet again so the Edits list shows the new version.
    await waitFor(() => expect(readMockSheet.mock.calls.length).toBeGreaterThan(2));
  });
  it("writes saved answers: a case with a key, a value and a JSON result", async () => {
    readMockSheet.mockResolvedValue(withTools());
    saveMockDefinition.mockResolvedValue({ version: 4, created: true });
    show();
    await openTool("get_run");
    await userEvent.click(screen.getByRole("radio", { name: "Saved answers" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a case" }));
    await userEvent.type(screen.getByLabelText("Case 1 input name"), "runId");
    await userEvent.type(screen.getByLabelText("Case 1 input value"), "run_41");
    fireEvent.change(screen.getByLabelText("Case 1 saved result"), { target: { value: '{"content":[{"type":"text","text":"ok"}]}' } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved as version 4.");
    expect(saveMockDefinition.mock.calls[0][0].definition.tools.get_run.answer).toEqual({
      from: "saved",
      cases: [{ when: { runId: "run_41" }, result: { content: [{ type: "text", text: "ok" }] } }],
    });
  });
  it("shows stored cases and removes one", async () => {
    const cases = [{ when: { runId: "run_41" }, result: { content: [] } }, { error: { code: -32000, message: "No run." } }];
    readMockSheet.mockResolvedValue(withTools({ definition: { tools: { get_run: { answer: { from: "saved", cases } } } } }));
    show();
    await openTool("get_run");
    expect(screen.getByRole("radio", { name: "Saved answers" })).toBeChecked();
    expect(screen.getByText("runId is run_41")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove case 1" }));
    expect(screen.queryByText("runId is run_41")).not.toBeInTheDocument();
    expect(screen.getByText("any call")).toBeInTheDocument();
  });
  it("refuses a saved result that is not JSON before sending anything", async () => {
    readMockSheet.mockResolvedValue(withTools());
    show();
    await openTool("get_run");
    await userEvent.click(screen.getByRole("radio", { name: "Saved answers" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a case" }));
    fireEvent.change(screen.getByLabelText("Case 1 saved result"), { target: { value: "{nope" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(saveMockDefinition).not.toHaveBeenCalled();
  });
  it("stops a definition the SDK's check refuses, such as saved answers with no case", async () => {
    readMockSheet.mockResolvedValue(withTools());
    show();
    await openTool("get_run");
    await userEvent.click(screen.getByRole("radio", { name: "Saved answers" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/at least one case/)).toBeInTheDocument();
    expect(saveMockDefinition).not.toHaveBeenCalled();
  });
  it("answers from a model with instructions", async () => {
    readMockSheet.mockResolvedValue(withTools());
    saveMockDefinition.mockResolvedValue({ version: 4, created: true });
    show();
    await openTool("get_run");
    await userEvent.click(screen.getByRole("radio", { name: "A model" }));
    await userEvent.type(screen.getByLabelText("Instructions"), "Runs are short.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved as version 4.");
    expect(saveMockDefinition.mock.calls[0][0].definition.tools.get_run.answer).toEqual({
      from: "model",
      instructions: "Runs are short.",
    });
  });
  it("says nothing changed when the save wrote no version", async () => {
    readMockSheet.mockResolvedValue(withTools());
    saveMockDefinition.mockResolvedValue({ version: 3, created: false });
    show();
    await screen.findByText("Tools");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Nothing changed/)).toBeInTheDocument();
  });
  it("offers a reload when the mock changed since it was opened", async () => {
    readMockSheet.mockResolvedValue(withTools());
    saveMockDefinition.mockRejectedValue(Object.assign(new Error("Stale."), { code: "MOCK_VERSION_STALE" }));
    show();
    await screen.findByText("Tools");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This mock changed since you opened it")).toBeInTheDocument();
    const reads = readMockSheet.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(readMockSheet.mock.calls.length).toBeGreaterThan(reads));
  });
  it("shows the server's message when it refuses the definition", async () => {
    readMockSheet.mockResolvedValue(withTools());
    saveMockDefinition.mockRejectedValue(new Error("tools.get_run.description must be text. Write the description."));
    show();
    await screen.findByText("Tools");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/tools.get_run.description must be text/)).toBeInTheDocument();
  });
});
