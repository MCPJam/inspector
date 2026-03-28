import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IterationDetails } from "../iteration-details";
import type { EvalCase, EvalIteration } from "../types";

const { mockGetBlob, mockJsonEditor } = vi.hoisted(() => ({
  mockGetBlob: vi.fn(),
  mockJsonEditor: vi.fn((props: any) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  )),
}));

const expectedToolCalls = [
  {
    toolName: "read_me",
    arguments: {},
  },
];

const actualToolCalls = [
  {
    toolName: "read_me",
    arguments: {},
  },
];

vi.mock("convex/react", () => ({
  useAction: () => mockGetBlob,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => mockJsonEditor(props),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(),
}));

vi.mock("../trace-viewer", () => ({
  TraceViewer: () => <div data-testid="mock-trace-viewer" />,
}));

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "eval-read-me",
  query: "read me",
  models: [{ model: "gpt-4o-mini", provider: "openai" }],
  runs: 1,
  expectedToolCalls,
};

const iteration: EvalIteration = {
  _id: "iter-1",
  testCaseId: "case-1",
  createdBy: "user-1",
  createdAt: 0,
  iterationNumber: 1,
  updatedAt: 0,
  status: "completed",
  result: "passed",
  actualToolCalls,
  tokensUsed: 0,
};

describe("IterationDetails raw tool calls", () => {
  beforeEach(() => {
    mockGetBlob.mockReset();
    mockJsonEditor.mockClear();
  });

  it("renders stringified JSON arguments with the shared viewer in formatted mode", () => {
    const formattedTestCase: EvalCase = {
      ...testCase,
      expectedToolCalls: [],
    };
    const formattedIteration: EvalIteration = {
      ...iteration,
      actualToolCalls: [
        {
          toolName: "create_view",
          arguments: {
            elements: '[{"type":"rectangle","id":"r1"}]',
          },
        },
      ],
    };

    render(
      <IterationDetails
        iteration={formattedIteration}
        testCase={formattedTestCase}
      />,
    );

    expect(screen.getAllByTestId("json-editor")).toHaveLength(1);
    expect(mockJsonEditor.mock.calls.map(([props]) => props)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: [{ type: "rectangle", id: "r1" }],
          viewOnly: true,
          collapsible: true,
          defaultExpandDepth: 1,
          collapseStringsAfterLength: 160,
          expandJsonStrings: true,
        }),
      ]),
    );
  });

  it("renders expected and actual tool calls with the shared JSON viewer", () => {
    render(<IterationDetails iteration={iteration} testCase={testCase} />);

    fireEvent.click(screen.getByRole("button", { name: /raw/i }));

    expect(screen.getAllByTestId("json-editor")).toHaveLength(2);

    const jsonEditorProps = mockJsonEditor.mock.calls.map(([props]) => props);

    expect(jsonEditorProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: expectedToolCalls,
          viewOnly: true,
          collapsible: true,
          defaultExpandDepth: 2,
          collapseStringsAfterLength: 160,
        }),
        expect.objectContaining({
          value: actualToolCalls,
          viewOnly: true,
          collapsible: true,
          defaultExpandDepth: 2,
          collapseStringsAfterLength: 160,
        }),
      ]),
    );
  });
});

describe("IterationDetails full layout (trace-first)", () => {
  beforeEach(() => {
    mockGetBlob.mockReset();
    mockJsonEditor.mockClear();
    mockGetBlob.mockResolvedValue({
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("places trace before tool calls when layout is full and a blob exists", async () => {
    const { container } = render(
      <IterationDetails
        layoutMode="full"
        iteration={{ ...iteration, blob: "blob-1" }}
        testCase={testCase}
      />,
    );

    await screen.findByTestId("mock-trace-viewer");

    const ordered = container.querySelectorAll(
      '[data-testid="iteration-trace-section"], [data-testid="iteration-tool-calls-section"]',
    );
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toHaveAttribute(
      "data-testid",
      "iteration-trace-section",
    );
    expect(ordered[1]).toHaveAttribute(
      "data-testid",
      "iteration-tool-calls-section",
    );
  });

  it("places tool calls before trace in compact layout even with a blob", async () => {
    const { container } = render(
      <IterationDetails
        iteration={{ ...iteration, blob: "blob-1" }}
        testCase={testCase}
      />,
    );

    await screen.findByTestId("mock-trace-viewer");

    const ordered = container.querySelectorAll(
      '[data-testid="iteration-tool-calls-section"], [data-testid="iteration-trace-section"]',
    );
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toHaveAttribute(
      "data-testid",
      "iteration-tool-calls-section",
    );
    expect(ordered[1]).toHaveAttribute(
      "data-testid",
      "iteration-trace-section",
    );
  });

  it("starts with tool calls collapsed for passed iterations in full layout", async () => {
    render(
      <IterationDetails
        layoutMode="full"
        iteration={{ ...iteration, result: "passed", blob: "blob-1" }}
        testCase={testCase}
      />,
    );

    await screen.findByTestId("mock-trace-viewer");

    const toolCallsRoot = screen.getByTestId("iteration-tool-calls-section");
    expect(toolCallsRoot.parentElement).toHaveAttribute("data-state", "closed");
    expect(
      screen.getByText(/Expected: read_me · Actual: read_me/),
    ).toBeInTheDocument();
  });

  it("starts with tool calls expanded for failed iterations in full layout", async () => {
    render(
      <IterationDetails
        layoutMode="full"
        iteration={{ ...iteration, result: "failed", blob: "blob-1" }}
        testCase={testCase}
      />,
    );

    await screen.findByTestId("mock-trace-viewer");

    await waitFor(() => {
      expect(screen.getByTestId("iteration-tool-calls-grid")).toBeVisible();
    });
  });
});
