import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openEvalChat,
  newEvalChat,
  readEvalScope,
  pinEvalTurn,
  assertEvalToolAllowed,
  useEvalAgentScopes,
  useEvalPromptQueue,
  syncEvalChatContext,
  promoteEvalDraftChat,
} from "../eval-scope";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import {
  handleUiToolCall,
  fulfillApprovedUiToolCall,
  __resetUiToolExecutorForTests,
} from "@/lib/webmcp/ui-tool-executor";
import { useUiToolsRegistry } from "@/lib/webmcp/ui-tools-registry";
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const context = {
  projectId: "project-a",
  suiteId: "suite-a",
  suiteName: "Support",
  caseId: "case-a",
};
beforeEach(() => {
  useAgentPanelStore.setState({
    activeSessionId: null,
    activeSessionProjectId: null,
    isOpen: false,
  });
  useEvalAgentScopes.setState({ scopes: {} });
  useUiToolsRegistry.setState({
    tools: new Map(),
    globalNames: new Set(),
    ownerTokens: new Map(),
    shippedNames: new Set(),
  });
  __resetUiToolExecutorForTests();
});
describe("eval agent capability scope", () => {
  it("reopens the same scoped session and inherits scope in New chat", () => {
    const session = openEvalChat(context);
    const scope = readEvalScope(session)!;
    useAgentPanelStore.getState().setOpen(false);
    expect(openEvalChat(context)).toBe(session);
    expect(readEvalScope(session)?.id).toBe(scope.id);
    const next = newEvalChat(scope);
    expect(next).not.toBe(session);
    expect(readEvalScope(next)?.suiteId).toBe(context.suiteId);
    expect(
      JSON.parse(localStorage.getItem("mcpjam:eval-agent-scopes:v2")!)[next]
        .kind,
    ).toBe("evals");
  });
  it("rejects stale turns and missing scope on resume", () => {
    const session = openEvalChat(context);
    pinEvalTurn(session);
    openEvalChat({ ...context, caseId: "case-b" });
    expect(() => assertEvalToolAllowed(session, "ui_eval_edit_case")).toThrow(
      "context changed",
    );
    expect(() => readEvalScope("eval-missing")).toThrow(
      "context is unavailable",
    );
  });
  it.each([false, true])(
    "blocks navigation at execution (approval=%s)",
    async (approved) => {
      const session = openEvalChat(context);
      pinEvalTurn(session);
      const execute = vi.fn();
      const handoff = vi.fn();
      const addToolOutput = vi.fn();
      useUiToolsRegistry.getState().registerUiTool({
        name: "ui_navigate",
        description: "Navigate",
        readOnly: false,
        mayNavigate: true,
        annotations: { readOnlyHint: false, destructiveHint: false },
        execute,
      });
      const opts = {
        toolName: "ui_navigate",
        toolCallId: `call-${approved}`,
        input: { tab: "playground" },
        telemetryScope: session,
        addToolOutput,
        onNavigationToolCall: handoff,
      };
      await handleUiToolCall({ ...opts, requireToolApproval: approved });
      if (approved) await fulfillApprovedUiToolCall(opts);
      expect(execute).not.toHaveBeenCalled();
      expect(handoff).not.toHaveBeenCalled();
      expect(addToolOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({ isError: true }),
        }),
      );
    },
  );
  it("keeps projects isolated", () => {
    const a = openEvalChat(context);
    const b = openEvalChat({ ...context, projectId: "project-b" });
    expect(a).not.toBe(b);
    expect(readEvalScope(a)?.projectId).toBe("project-a");
  });
});

describe("eval conversation boundaries", () => {
  it("isolates cases, suites, and suite-level generation, and resumes only the matching target", () => {
    const a = openEvalChat(context);
    const b = openEvalChat({ ...context, caseId: "case-b" });
    const suite = openEvalChat({ ...context, caseId: undefined });
    const otherSuite = openEvalChat({ ...context, suiteId: "suite-b" });
    expect(new Set([a, b, suite, otherSuite]).size).toBe(4);
    expect(readEvalScope(a)?.caseId).toBe("case-a");
    expect(readEvalScope(b)?.caseId).toBe("case-b");
    expect(readEvalScope(suite)?.caseId).toBeUndefined();
    expect(
      openEvalChat({
        ...context,
        suiteName: "Renamed",
        caseTitle: "New title",
      }),
    ).toBe(a);
    expect(openEvalChat({ ...context, caseId: "case-b" })).toBe(b);
    expect(openEvalChat({ ...context, caseId: undefined })).toBe(suite);
  });

  it("starts a fresh Describe draft and keeps New chat as the next conversation for that target", () => {
    const target = { ...context, caseId: "draft:describe" };
    const first = openEvalChat(target, { fresh: true });
    expect(openEvalChat(target)).toBe(first);
    const second = openEvalChat(target, { fresh: true });
    expect(second).not.toBe(first);
    expect(openEvalChat(target)).toBe(second);
    const third = newEvalChat(readEvalScope(second)!);
    openEvalChat({ ...context, suiteId: "other" });
    expect(openEvalChat(target)).toBe(third);
  });

  it("drops queued prompts and invalidates delayed edits when switching targets", () => {
    const a = openEvalChat(context);
    pinEvalTurn(a);
    useEvalPromptQueue.getState().enqueue(a, "Generate cases for A");
    openEvalChat({ ...context, suiteId: "suite-b" });
    expect(useEvalPromptQueue.getState().pending[a]).toBeUndefined();
    expect(() => assertEvalToolAllowed(a, "ui_eval_generate_cases")).toThrow(
      "context changed",
    );
    openEvalChat(context);
    // Merely reopening does not authorize a pending call from the abandoned turn.
    expect(() => assertEvalToolAllowed(a, "ui_eval_edit_case")).toThrow(
      "context changed",
    );
    pinEvalTurn(a);
    expect(() => assertEvalToolAllowed(a, "ui_eval_edit_case")).not.toThrow();
  });

  it("follows suite navigation while preserving a closed panel and leaves general chat alone", () => {
    const a = openEvalChat(context);
    useAgentPanelStore.getState().setOpen(false);
    syncEvalChatContext({ ...context, caseId: undefined });
    expect(useAgentPanelStore.getState().activeSessionId).not.toBe(a);
    expect(useAgentPanelStore.getState().isOpen).toBe(false);
    useAgentPanelStore.getState().setActiveSession("general", "project-a");
    syncEvalChatContext(context);
    expect(useAgentPanelStore.getState().activeSessionId).toBe("general");
  });
});


it("continues the same logical case when a Describe draft is saved", () => {
  const draft = { ...context, caseId: "draft:describe" };
  const sessionId = openEvalChat(draft, { fresh: true });
  pinEvalTurn(sessionId);
  promoteEvalDraftChat(draft, "saved-case");
  expect(openEvalChat({ ...context, caseId: "saved-case" })).toBe(sessionId);
  expect(() => assertEvalToolAllowed(sessionId, "ui_eval_edit_case")).toThrow("context changed");
  expect(openEvalChat(draft, { fresh: true })).not.toBe(sessionId);
});

it("replaces a legacy mixed eval conversation instead of importing its history", () => {
  useAgentPanelStore.getState().setActiveSession("eval-legacy-mixed", context.projectId);
  syncEvalChatContext(context);
  const next = useAgentPanelStore.getState().activeSessionId!;
  expect(next).not.toBe("eval-legacy-mixed");
  expect(readEvalScope(next)?.caseId).toBe(context.caseId);
});
