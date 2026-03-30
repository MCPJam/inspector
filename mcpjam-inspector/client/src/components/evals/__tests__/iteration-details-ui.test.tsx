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
  TraceViewer: (props: {
    chromeDensity?: string;
    expectedToolCalls?: unknown[];
    actualToolCalls?: unknown[];
  }) => (
    <div
      data-testid="mock-trace-viewer"
      data-chrome-density={props.chromeDensity ?? "default"}
      data-expected-tool-count={String(props.expectedToolCalls?.length ?? 0)}
      data-actual-tool-count={String(props.actualToolCalls?.length ?? 0)}
    />
  ),
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

  it("places trace first when layout is full and a blob exists (tool compare lives in TraceViewer)", async () => {
    const { container } = render(
      <IterationDetails
        layoutMode="full"
        iteration={{ ...iteration, blob: "blob-1" }}
        testCase={testCase}
      />,
    );

    const viewer = await screen.findByTestId("mock-trace-viewer");

    expect(viewer).toHaveAttribute("data-chrome-density", "compact");
    expect(viewer).toHaveAttribute("data-expected-tool-count", "1");
    expect(viewer).toHaveAttribute("data-actual-tool-count", "1");

    expect(
      container.querySelector('[data-testid="iteration-tool-calls-section"]'),
    ).toBeNull();

    const ordered = container.querySelectorAll(
      '[data-testid="iteration-trace-section"], [data-testid="iteration-tool-calls-section"]',
    );
    expect(ordered).toHaveLength(1);
    expect(ordered[0]).toHaveAttribute(
      "data-testid",
      "iteration-trace-section",
    );
  });

  it("does not duplicate tool calls below trace in compact layout when a blob exists", async () => {
    const { container } = render(
      <IterationDetails
        iteration={{ ...iteration, blob: "blob-1" }}
        testCase={testCase}
      />,
    );

    const viewer = await screen.findByTestId("mock-trace-viewer");

    expect(viewer).toHaveAttribute("data-chrome-density", "default");
    expect(viewer).toHaveAttribute("data-expected-tool-count", "1");
    expect(viewer).toHaveAttribute("data-actual-tool-count", "1");

    expect(
      container.querySelector('[data-testid="iteration-tool-calls-section"]'),
    ).toBeNull();
  });
});

describe("IterationDetails trace blob load error", () => {
  const convexConnectionLostMessage =
    "[CONVEX A(testSuites:getTestIterationBlob)] Connection lost while action was in flight Called by client";

  beforeEach(() => {
    mockGetBlob.mockReset();
    mockJsonEditor.mockClear();
  });

  it("shows a friendly trace load error, technical details, and retries the blob action", async () => {
    mockGetBlob
      .mockRejectedValueOnce(new Error(convexConnectionLostMessage))
      .mockResolvedValueOnce({ messages: [{ role: "user", content: "hi" }] });

    render(
      <IterationDetails
        layoutMode="full"
        iteration={{ ...iteration, blob: "blob-conn" }}
        testCase={testCase}
      />,
    );

    const panel = await screen.findByTestId("iteration-trace-load-error");
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("Connection interrupted")).toBeInTheDocument();
    expect(
      screen.getByText(
        /We lost contact with the server while loading this trace/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(convexConnectionLostMessage)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /technical details/i }),
    );
    expect(await screen.findByText(convexConnectionLostMessage)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(mockGetBlob).toHaveBeenCalledTimes(2));
    expect(mockGetBlob).toHaveBeenLastCalledWith({ blobId: "blob-conn" });
    await screen.findByTestId("mock-trace-viewer");
  });

  it("shows generic copy for unknown blob load errors", async () => {
    mockGetBlob.mockRejectedValueOnce(new Error("Something weird happened"));

    render(
      <IterationDetails
        layoutMode="full"
        iteration={{ ...iteration, blob: "blob-x" }}
        testCase={testCase}
      />,
    );

    expect(await screen.findByText("Couldn't load trace")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Something went wrong while loading the recorded trace/i,
      ),
    ).toBeInTheDocument();
  });
});
