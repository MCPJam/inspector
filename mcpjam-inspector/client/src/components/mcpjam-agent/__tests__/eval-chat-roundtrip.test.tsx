import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  __resetAgentChatInstancesForTests();
  useAgentPanelStore.getState().setActiveSession(null, null);
  useEvalAgentScopes.setState({ scopes: {} });
  useEvalGeneration.setState({ suites: {} });
  useEvalPromptQueue.setState({ pending: {} });
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
          toolName: index === 1 ? "ui_eval_context" : "ui_eval_generate_cases",
          input:
            index === 1 ? {} : { instructions: "Generate one read-only case" },
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

describe("eval composer → transport → browser generation tool", () => {
  it("submits a typed prompt, stages real tool output, and accepts a follow-up", async () => {
    const sessionId = openEvalChat(scope);
    renderWithProviders(
      <McpjamAgentThread
        sessionId={sessionId}
        projectId={scope.projectId}
        organizationId={null}
        variant="sidebar"
      />,
    );
    const user = userEvent.setup();
    const composer = await screen.findByPlaceholderText(
      "Describe the coverage you want…",
    );
    await user.type(composer, "Generate a read-only test case");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send", exact: true }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(generated).toHaveBeenCalledOnce());
    await waitFor(() => expect(requests.length).toBe(3));
    expect(
      useEvalGeneration.getState().suites[evalSuiteKey(scope)].drafts[0].input
        .title,
    ).toBe("List available records");
    expect(save).not.toHaveBeenCalled();
    expect(requests[0].evalScope.suiteId).toBe(scope.suiteId);
    expect(
      requests[0].uiTools.some((tool: any) => tool.name === "ui_navigate"),
    ).toBe(false);
    await user.type(composer, "Make the expected outcome clearer{Enter}");
    await waitFor(() => expect(requests.length).toBe(4));
  });

  it("consumes Generate's queued prompt once, including a subsequent prompt in the mounted chat", async () => {
    const sessionId = openEvalChat(scope);
    useEvalPromptQueue.getState().enqueue(sessionId, "Generate test cases");
    const { rerender } = renderWithProviders(
      <McpjamAgentThread
        sessionId={sessionId}
        projectId={scope.projectId}
        organizationId={null}
        variant="sidebar"
      />,
    );
    await waitFor(() => expect(generated).toHaveBeenCalledOnce());
    await waitFor(() => expect(requests.length).toBe(3));
    rerender(
      <McpjamAgentThread
        sessionId={sessionId}
        projectId={scope.projectId}
        organizationId={null}
        variant="sidebar"
      />,
    );
    expect(generated).toHaveBeenCalledOnce();
    act(() =>
      useEvalPromptQueue
        .getState()
        .enqueue(sessionId, "Refine the existing draft"),
    );
    await waitFor(() => expect(requests.length).toBe(4));
  });
});

it("keeps transcripts and outgoing history separate when moving between cases", async () => {
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
  await user.type(
    screen.getByPlaceholderText("Describe a change to this case…"),
    "Help with case B",
  );
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

it("renders Describe guidance immediately and switches to refinement as the draft gains content", async () => {
  const sessionId = openEvalChat({ ...scope, caseId: "draft:describe", hasCaseContent: false });
  renderWithProviders(<McpjamAgentThread sessionId={sessionId} projectId={scope.projectId} organizationId={null} surface="side-panel" variant="sidebar" />);
  expect(screen.queryByText("What behavior should this case verify?")).toBeNull();
  expect(screen.getByTestId("eval-chat-guidance")).toBeVisible();
  expect(document.querySelector("[data-eval-composer=true]")).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Help me choose a behavior" }));
  expect((screen.getByPlaceholderText("Describe a behavior and the expected outcome…") as HTMLTextAreaElement).value).toContain("help me choose");
  expect(requests).toHaveLength(0);
  act(() => {
    const current = useEvalAgentScopes.getState().scopes[sessionId];
    useEvalAgentScopes.getState().set(sessionId, { ...current, hasCaseContent: true });
  });
  expect(screen.queryByText("What would you like to improve?")).toBeNull();
  expect(screen.getByRole("button", { name: "Make checks more precise" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Help me choose a behavior" })).toBeNull();
});
