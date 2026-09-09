import { useDescribeSurface } from "@/lib/mcpjam-agent/describe-surface";
import { useDescribeFlow } from "@/lib/mcpjam-agent/describe-flow";
import { registerEvalDraft } from "@/lib/mcpjam-agent/eval-workspace";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { McpjamAgentThread } from "../McpjamAgentThread";
import {
  openEvalChat,
  useEvalAgentScopes,
  useEvalPromptQueue,
} from "@/lib/mcpjam-agent/eval-scope";
import {
  registerEvalSuite,
  useEvalGeneration,
  evalSuiteKey,
} from "@/lib/mcpjam-agent/eval-workspace";
import { buildEvalAuthoringTools } from "@/lib/webmcp/groups/eval-authoring";
import { useUiToolsRegistry } from "@/lib/webmcp/ui-tools-registry";
import { __resetAgentChatInstancesForTests } from "@/lib/mcpjam-agent/agent-chat-instances";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { authFetch } from "@/lib/session-token";

vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => selector({ themeMode: "light" }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-hosted-org-model-config", () => ({
  useHostedOrgModelConfig: () => null,
}));
vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({ selectedModelId: null }),
}));
vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModelsFromOrgConfig: () => [
    { id: "gpt-4.1-mini", provider: "openai", name: "Test model" },
  ],
  getDefaultModel: (models: unknown[]) => models[0],
}));
vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getChatHistoryDetail: vi.fn(async () => null),
}));
vi.mock("@/components/chat-v2/thread", () => ({
  Thread: ({ messages }: any) => (
    <div>
      {messages.flatMap((message: any) =>
        message.parts
          .filter((p: any) => p.type === "text")
          .map((p: any, i: number) => <p key={message.id + i}>{p.text}</p>),
      )}
    </div>
  ),
}));

const scope = {
  projectId: "project-chat",
  suiteId: "suite-chat",
  suiteName: "Support",
  caseId: "draft:describe",
};
function stream(parts: unknown[]) {
  return new Response(
    parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
      "data: [DONE]\n\n",
    {
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    },
  );
}
let requests: any[];
let generated: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let unregister: () => void;
let cleanups: Array<() => void>;
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});
beforeEach(() => {
  cleanups = [];
  __resetAgentChatInstancesForTests();
  useAgentPanelStore.getState().setActiveSession(null, null);
  useEvalAgentScopes.setState({ scopes: {} });
  useEvalGeneration.setState({ suites: {} });
  useEvalPromptQueue.setState({ pending: {} });
  useDescribeSurface.setState({
    scope: { ...scope, kind: "evals", version: 1, id: "active" },
  });
  useDescribeFlow.setState({ sessions: {} });
  cleanups.push(
    registerEvalDraft(
      { ...scope, kind: "evals", version: 1, id: "active" },
      {
        read: () => ({
          draft: { title: "", steps: [] },
          revision: "r1",
          tools: [],
        }),
        edit: vi.fn(),
        undo: vi.fn(),
      },
    ),
  );
  requests = [];
  save = vi.fn();
  generated = vi.fn(async (_instructions, stage) => {
    await stage({
      suiteId: scope.suiteId,
      title: "List available records",
      steps: [
        { id: "prompt", kind: "prompt", prompt: "List the available records" },
      ],
    });
  });
  unregister?.();
  unregister = registerEvalSuite(scope, {
    read: () => ({ tools: ["list_records"], cases: [] }),
    generate: generated as any,
    save,
  });
  useUiToolsRegistry.setState({ tools: new Map(), shippedNames: new Set() });
  for (const tool of buildEvalAuthoringTools())
    useUiToolsRegistry.getState().registerUiTool(tool);
  vi.mocked(authFetch).mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    const index = requests.length;
    if (index <= 2)
      return stream([
        { type: "start", messageId: `answer-${index}` },
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: `eval-call-${index}-${body.chatSessionId}`,
          toolName: index === 1 ? "ui_eval_context" : "ui_eval_propose_cases",
          input:
            index === 1
              ? {}
              : {
                  subject: "record listing",
                  summary: "Return available records.",
                  revision: "r1",
                  cases: [
                    {
                      title: "List available records",
                      steps: [
                        { id: "p", kind: "prompt", prompt: "List records" },
                      ],
                    },
                  ],
                },
        },
        { type: "finish-step" },
        { type: "finish", finishReason: "tool-calls" },
      ]);
    return stream([
      { type: "start", messageId: `answer-${index}` },
      { type: "start-step" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Drafts are ready to review." },
      { type: "text-end", id: "text" },
      { type: "finish-step" },
      { type: "finish", finishReason: "stop" },
    ]);
  });
});

describe("Describe composer → transport → proposal → Create", () => {
  it("prepares real tool output without creating or saving before the click", async () => {
    const sessionId = openEvalChat(scope);
    renderWithProviders(
      <McpjamAgentThread
        sessionId={sessionId}
        projectId={scope.projectId}
        organizationId={null}
        surface="side-panel"
        variant="sidebar"
      />,
    );
    const user = userEvent.setup();
    await user.type(
      await screen.findByPlaceholderText(
        "Describe a user prompt or workflow you'd like to test e.g. find my open tickets and summarize them.",
      ),
      "List records and return their names",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send", exact: true }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    const create = await screen.findByRole("button", {
      name: "Create 1 test for record listing",
    });
    await waitFor(() => expect(create).toBeEnabled());
    expect(requests).toHaveLength(2); // Stop after the proposal tool, without an extra narration turn.
    expect(generated).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(useDescribeFlow.getState().sessions[sessionId].phase).toBe(
      "proposed",
    );
    expect(requests[0].uiTools.map((tool: any) => tool.name).sort()).toEqual([
      "ui_eval_context",
      "ui_eval_propose_cases",
      "ui_eval_question",
    ]);
    await user.click(create);
    expect(screen.getByText(/Created 1 unsaved test/)).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText("Require tool approval"),
    ).not.toBeInTheDocument();
  });
});

it("keeps transcripts and outgoing history separate when moving between cases", async () => {
  useDescribeSurface.setState({
    scope: {
      ...scope,
      kind: "evals",
      version: 1,
      id: "active",
      caseId: "case-a",
    },
  });
  const a = openEvalChat({ ...scope, caseId: "case-a" });
  // Seed a real hoisted Chat with A's history as if the user had already chatted.
  const { getOrCreateAgentChat } =
    await import("@/lib/mcpjam-agent/agent-chat-instances");
  const entry = getOrCreateAgentChat(a);
  entry.config.seeded = true;
  entry.chat.messages = [
    {
      id: "a-user",
      role: "user",
      parts: [{ type: "text", text: "Only case A knows this request" }],
    },
  ];
  const { rerender } = renderWithProviders(
    <McpjamAgentThread
      key={a}
      sessionId={a}
      projectId={scope.projectId}
      organizationId={null}
      variant="sidebar"
    />,
  );
  await screen.findByText("Only case A knows this request");
  let b = "";
  act(() => {
    useDescribeSurface.setState({
      scope: {
        ...scope,
        kind: "evals",
        version: 1,
        id: "active",
        caseId: "case-b",
      },
    });
    b = openEvalChat({ ...scope, caseId: "case-b" });
  });
  rerender(
    <McpjamAgentThread
      key={b}
      sessionId={b}
      projectId={scope.projectId}
      organizationId={null}
      variant="sidebar"
    />,
  );
  expect(
    screen.queryByText("Only case A knows this request"),
  ).not.toBeInTheDocument();
  // This response needs no tool, so test B's outbound history independently.
  vi.mocked(authFetch).mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    return stream([
      { type: "start", messageId: "b-answer" },
      { type: "finish", finishReason: "stop" },
    ]);
  });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "Help with case B");
  expect(
    screen.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled(); // Input can queue while B’s bridge mounts.
  expect(requests).toHaveLength(0);
  act(() => {
    cleanups.push(
      registerEvalDraft(
        { ...scope, caseId: "case-b", kind: "evals", version: 1, id: "b" },
        {
          read: () => ({
            draft: { title: "B", steps: [] },
            revision: "b1",
            tools: [],
          }),
          edit: vi.fn(),
          undo: vi.fn(),
        },
      ),
    );
  });
  expect(screen.getByRole("textbox")).toHaveValue("Help with case B");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Send", exact: true }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Send", exact: true }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].chatSessionId).toBe(b);
  expect(requests[0].evalScope.caseId).toBe("case-b");
  expect(JSON.stringify(requests[0].messages)).not.toContain("Only case A");
  let resumed = "";
  act(() => {
    useDescribeSurface.setState({
      scope: {
        ...scope,
        kind: "evals",
        version: 1,
        id: "active",
        caseId: "case-a",
      },
    });
    resumed = openEvalChat({ ...scope, caseId: "case-a" });
  });
  expect(resumed).toBe(a);
  rerender(
    <McpjamAgentThread
      key={a}
      sessionId={a}
      projectId={scope.projectId}
      organizationId={null}
      variant="sidebar"
    />,
  );
  await screen.findByText("Only case A knows this request");
  expect(screen.queryByText("Help with case B")).not.toBeInTheDocument();
});

it("keeps Describe guidance focused when the draft gains content", async () => {
  const sessionId = openEvalChat({
    ...scope,
    caseId: "draft:describe",
    hasCaseContent: false,
  });
  renderWithProviders(
    <McpjamAgentThread
      sessionId={sessionId}
      projectId={scope.projectId}
      organizationId={null}
      surface="side-panel"
      variant="sidebar"
    />,
  );
  expect(
    screen.queryByText("What behavior should this case verify?"),
  ).toBeNull();
  expect(screen.getByTestId("eval-chat-guidance")).toBeVisible();
  expect(document.querySelector("[data-eval-composer=true]")).toBeTruthy();
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: "Help me choose a behavior" }),
  ).toBeNull();
  const suggest = screen.getByRole("button", {
    name: "Suggest a test from my tools",
  });
  await waitFor(() => expect(suggest).toBeEnabled());
  await user.click(suggest);
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  expect(JSON.stringify(requests[0].messages)).toContain("Suggest one focused");
  expect(screen.getByRole("textbox")).toHaveValue("");
  act(() => {
    const current = useEvalAgentScopes.getState().scopes[sessionId];
    useEvalAgentScopes
      .getState()
      .set(sessionId, { ...current, hasCaseContent: true });
  });
  expect(screen.queryByText("What would you like to improve?")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Make checks more precise" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Help me choose a behavior" }),
  ).toBeNull();
});

it("asks before continuing a paused creation", async () => {
  const sessionId = openEvalChat(scope);
  useDescribeFlow.setState({
    sessions: {
      [sessionId]: {
        phase: "describing",
        questionUsed: false,
        needsResume: true,
      },
    },
  });
  renderWithProviders(
    <McpjamAgentThread
      sessionId={sessionId}
      projectId={scope.projectId}
      organizationId={null}
      surface="side-panel"
      variant="sidebar"
    />,
  );
  expect(
    await screen.findByRole("button", { name: "Continue", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Not now" }));
  expect(requests).toHaveLength(0);
  expect(
    screen.queryByRole("button", { name: "Continue", exact: true }),
  ).toBeNull();
});

it("queues a description during tool loading and sends it once when metadata arrives", async () => {
  const sessionId = openEvalChat(scope);
  const currentScope = useEvalAgentScopes.getState().scopes[sessionId];
  const bridge = (ready: boolean) => ({
    read: () => ({
      draft: { title: "", steps: [] },
      revision: "r1",
      tools: [],
      metadata: {
        environmentKey: "v1",
        tools: ready ? [{ name: "search" }] : [],
        servers: [
          {
            serverId: "server",
            status: ready ? ("ready" as const) : ("loading" as const),
            tools: ready ? [{ name: "search" }] : [],
            updatedAt: 1,
          },
        ],
      },
    }),
    edit: vi.fn(),
    undo: vi.fn(),
  });
  cleanups.push(registerEvalDraft(currentScope, bridge(false)));
  // A text-only response makes duplicate user submissions observable.
  vi.mocked(authFetch).mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    return stream([
      { type: "start", messageId: "reply" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Ready" },
      { type: "text-end", id: "text" },
      { type: "finish" },
    ]);
  });
  renderWithProviders(
    <McpjamAgentThread
      sessionId={sessionId}
      projectId={scope.projectId}
      organizationId={null}
      surface="side-panel"
      variant="sidebar"
    />,
  );
  const user = userEvent.setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "Search for matching issues{Enter}");
  await waitFor(() =>
    expect(useEvalPromptQueue.getState().pending[sessionId]?.text).toBe(
      "Search for matching issues",
    ),
  );
  expect(requests).toHaveLength(0);
  expect(input).toHaveValue("Search for matching issues");
  act(() => {
    cleanups.push(registerEvalDraft(currentScope, bridge(true)));
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(input).toHaveValue("");
  expect(useEvalPromptQueue.getState().pending[sessionId]).toBeUndefined();
});
