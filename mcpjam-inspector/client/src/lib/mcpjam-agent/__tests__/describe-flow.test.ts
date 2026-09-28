import { useDescribeSurface } from "../describe-surface";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginDescribe,
  askDescribeQuestion,
  proposeDescribeCases,
  createDescribeCases,
  useDescribeFlow,
} from "../describe-flow";
import {
  registerEvalDraft,
  registerEvalSuite,
  useEvalGeneration,
} from "../eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";

const scope: EvalAgentScope = {
  kind: "evals",
  version: 1,
  id: "s",
  projectId: "p",
  suiteId: "suite",
  suiteName: "Suite",
  caseId: "draft:describe",
};
const draft = {
  title: "Search",
  steps: [{ id: "p", kind: "prompt" as const, prompt: "Search for issues" }],
};
const edit = vi.fn();
let revision = "r1";
const proposal = (count = 1) => ({
  subject: "issue search",
  summary: "Verify matching issues are returned.",
  revision,
  cases: Array.from({ length: count }, (_, i) => ({
    ...draft,
    title: `Search ${i}`,
  })),
});
beforeEach(() => {
  useDescribeFlow.setState({ sessions: {} });
  useEvalGeneration.setState({ suites: {} });
  useDescribeSurface.setState({ scope });
  revision = "r1";
  edit.mockReset();
  registerEvalDraft(scope, {
    read: () => ({ draft, revision, tools: [] }),
    edit,
    undo: vi.fn(),
  });
  registerEvalSuite(scope, {
    read: () => ({}),
    generate: vi.fn(),
    save: vi.fn(),
  });
});
describe("Describe workflow", () => {
  it("allows only one question, even after editing the description", () => {
    beginDescribe("s", "Search issues");
    askDescribeQuestion("s", "What should a successful response do?");
    beginDescribe("s", "Return matching issues");
    expect(() => askDescribeQuestion("s", "Another question?")).toThrow(
      /one follow-up/i,
    );
  });
  it("prepares without editing, then applies exactly once on Create", () => {
    beginDescribe("s", "Search issues and return matches");
    const id = proposeDescribeCases("s", scope, proposal());
    expect(edit).not.toHaveBeenCalled();
    createDescribeCases("s", scope, id);
    createDescribeCases("s", scope, id);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("r1", {
      ...proposal().cases[0],
      expectedOutput: proposal().summary,
    });
  });
  it("stages exactly five drafts without saving or replacing the current case", () => {
    beginDescribe("s", "Create five search tests");
    const id = proposeDescribeCases("s", scope, proposal(5));
    createDescribeCases("s", scope, id);
    expect(edit).not.toHaveBeenCalled();
    expect(
      Object.values(useEvalGeneration.getState().suites)[0].drafts,
    ).toHaveLength(5);
  });
  it("rejects a proposal with a different requested count", () => {
    beginDescribe("s", "Create 5 tests for search");
    expect(() => proposeDescribeCases("s", scope, proposal(1))).toThrow(
      /count/i,
    );
  });
  it("rejects a second proposal until the user changes the request", () => {
    beginDescribe("s", "Search");
    proposeDescribeCases("s", scope, proposal());
    expect(() => proposeDescribeCases("s", scope, proposal())).toThrow();
  });
  it("rejects invalid case content before offering Create", () => {
    beginDescribe("s", "Search");
    expect(() =>
      proposeDescribeCases("s", scope, {
        ...proposal(),
        cases: [{ title: "", steps: [] }],
      }),
    ).toThrow();
  });
  it("rejects stale proposals after input or manual edits", () => {
    beginDescribe("s", "Search");
    const id = proposeDescribeCases("s", scope, proposal());
    revision = "r2";
    expect(() => createDescribeCases("s", scope, id)).toThrow(/changed/i);
    beginDescribe("s", "Different search");
    expect(() => createDescribeCases("s", scope, id)).toThrow();
    expect(edit).not.toHaveBeenCalled();
  });
  it("rejects creation on a different target", () => {
    beginDescribe("s", "Search");
    const id = proposeDescribeCases("s", scope, proposal());
    expect(() =>
      createDescribeCases("s", { ...scope, suiteId: "other" }, id),
    ).toThrow(/target/i);
  });
});

it("blocks creation after the tool environment changes", () => {
  let environmentKey = "v1";
  registerEvalDraft(scope, {
    read: () => ({
      draft,
      revision,
      tools: [],
      metadata: {
        environmentKey,
        tools: [{ name: "search" }],
        servers: [
          {
            serverId: "server",
            status: "ready",
            tools: [{ name: "search" }],
            updatedAt: 1,
          },
        ],
      },
    }),
    edit,
    undo: vi.fn(),
  });
  beginDescribe("s", "Search");
  const id = proposeDescribeCases("s", scope, proposal());
  environmentKey = "v2";
  expect(() => createDescribeCases("s", scope, id)).toThrow(/tools changed/i);
  expect(edit).not.toHaveBeenCalled();
});

it("rejects unavailable tool calls and rechecks used contracts on Create", () => {
  let tools = [
    { name: "search", serverId: "server", inputSchema: { type: "object" } },
  ];
  registerEvalDraft(scope, {
    read: () => ({
      draft,
      revision,
      tools,
      metadata: {
        environmentKey: "v1",
        tools,
        servers: [{ serverId: "server", status: "ready", tools, updatedAt: 1 }],
      },
    }),
    edit,
    undo: vi.fn(),
  });
  const input = {
    ...proposal(),
    cases: [
      {
        ...draft,
        steps: [
          ...draft.steps,
          {
            id: "call",
            kind: "toolCall",
            serverName: "server",
            toolName: "missing",
            arguments: {},
          },
        ],
      },
    ],
  };
  beginDescribe("s", "Search");
  expect(() => proposeDescribeCases("s", scope, input)).toThrow(
    /not available/i,
  );
  input.cases[0].steps[1] = {
    ...input.cases[0].steps[1],
    toolName: "search",
  } as any;
  const id = proposeDescribeCases("s", scope, input);
  tools = [
    { name: "search", serverId: "server", inputSchema: { type: "string" } },
  ];
  expect(() => createDescribeCases("s", scope, id)).toThrow(/tools changed/i);
  expect(edit).not.toHaveBeenCalled();
});
