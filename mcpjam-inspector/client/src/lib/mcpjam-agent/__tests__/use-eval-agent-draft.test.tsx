import { useEvalAgentScopes } from "../eval-scope";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { getOrCreateAgentChat } from "../agent-chat-instances";
import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEvalAgentDraft } from "../use-eval-agent-draft";
import {
  beginDescribe,
  proposeDescribeCases,
  createDescribeCases,
  useDescribeFlow,
} from "../describe-flow";
import {
  getEvalDraft,
  parseDraftPatch,
  type EvalDraft,
} from "../eval-workspace";

describe("eval draft edits", () => {
  it("starts a fresh chat only after successfully undoing its created draft", () => {
    useDescribeFlow.setState({ sessions: {} });
    const initial = { title: "Initial", steps: [] };
    const { result, unmount } = renderHook(() => {
      const [draft, setDraft] = useState<EvalDraft | null>(initial);
      const agent = useEvalAgentDraft({
        projectId: "p",
        suiteId: "s",
        suiteName: "Suite",
        caseId: "draft:describe",
        draft,
        setDraft,
        tools: [],
        autoOpen: true,
      });
      return { draft, agent };
    });
    const oldSession = useAgentPanelStore.getState().activeSessionId!;
    getOrCreateAgentChat(oldSession).chat.messages = [
      {
        id: "old",
        role: "user",
        parts: [{ type: "text", text: "Find items" }],
      },
    ];
    const scope = result.current.agent.scope;
    const bridge = getEvalDraft(scope);
    act(() => {
      beginDescribe("undo-session", "Find items");
      const proposal = proposeDescribeCases("undo-session", scope, {
        subject: "search",
        summary: "Return items",
        revision: bridge.read().revision,
        cases: [
          {
            title: "Search",
            steps: [{ id: "p", kind: "prompt", prompt: "Find items" }],
          },
        ],
      });
      createDescribeCases("undo-session", scope, proposal);
    });
    const reviewing = useDescribeFlow.getState().sessions["undo-session"];
    expect(reviewing.phase).toBe("reviewing");
    expect(() => bridge.undo("stale-revision")).toThrow("Draft changed");
    expect(useDescribeFlow.getState().sessions["undo-session"]).toBe(reviewing);
    expect(useAgentPanelStore.getState().activeSessionId).toBe(oldSession);
    act(() => {
      bridge.undo(bridge.read().revision);
    });
    expect(result.current.draft).toEqual(initial);
    expect(result.current.agent.canUndo).toBe(false);
    const freshSession = useAgentPanelStore.getState().activeSessionId!;
    expect(freshSession).not.toBe(oldSession);
    expect(useAgentPanelStore.getState().isOpen).toBe(true);
    expect(getOrCreateAgentChat(freshSession).chat.messages).toEqual([]);
    expect(useDescribeFlow.getState().sessions[freshSession]).toBeUndefined();
    act(() => result.current.agent.open());
    expect(useAgentPanelStore.getState().activeSessionId).toBe(freshSession);
    unmount();
  });
  it("uses the latest suite name when undo opens a replacement chat", () => {
    const { result, rerender, unmount } = renderHook(
      ({ suiteName }) => {
        const [draft, setDraft] = useState<EvalDraft | null>({
          title: "Initial",
          steps: [],
        });
        return useEvalAgentDraft({
          projectId: "rename-project",
          suiteId: "s",
          suiteName,
          caseId: "draft:describe",
          draft,
          setDraft,
          tools: [],
          autoOpen: true,
        });
      },
      { initialProps: { suiteName: "Original suite" } },
    );
    const oldSession = useAgentPanelStore.getState().activeSessionId;
    rerender({ suiteName: "Renamed suite" });
    const bridge = getEvalDraft(result.current.scope);
    act(() => {
      bridge.edit(bridge.read().revision, { title: "Updated" });
    });
    act(() => {
      bridge.undo(bridge.read().revision);
    });
    const session = useAgentPanelStore.getState().activeSessionId!;
    expect(session).not.toBe(oldSession);
    expect(useEvalAgentScopes.getState().scopes[session].suiteName).toBe(
      "Renamed suite",
    );
    unmount();
  });
  it("applies structured edits and rejects stale writes and undo after manual edits", () => {
    const { result, unmount } = renderHook(() => {
      const [draft, setDraft] = useState<EvalDraft | null>({
        title: "Initial",
        steps: [{ id: "p1", kind: "prompt", prompt: "Find an item" }],
      });
      const agent = useEvalAgentDraft({
        projectId: "p",
        suiteId: "s",
        suiteName: "Suite",
        caseId: "c",
        draft,
        setDraft,
        tools: [],
        autoOpen: false,
      });
      return { draft, setDraft, agent };
    });
    const bridge = getEvalDraft(result.current.agent.scope);
    const revision = bridge.read().revision;
    act(() => {
      bridge.edit(revision, { title: "Updated" });
    });
    expect(result.current.draft?.title).toBe("Updated");
    expect(() => bridge.edit(revision, { title: "Stale" })).toThrow(
      "Draft changed",
    );
    const after = bridge.read().revision;
    act(() => {
      result.current.setDraft((d) => ({ ...d!, title: "Manual edit" }));
    });
    expect(() => bridge.undo(after)).toThrow("Draft changed");
    expect(result.current.draft?.title).toBe("Manual edit");
    unmount();
    expect(() => getEvalDraft(result.current.agent.scope)).toThrow("Return to");
  });
  it("validates step shape and duplicate step ids", () => {
    expect(() => parseDraftPatch({ steps: [{ kind: "prompt" }] })).toThrow();
    const step = { id: "one", kind: "prompt", prompt: "Find an item" };
    expect(() => parseDraftPatch({ steps: [step, step] })).toThrow("unique");
    expect(() => parseDraftPatch({ title: " " })).toThrow("empty");
  });
});

it("starts a new conversation for a newly mounted empty Describe draft, but keeps close/reopen together", async () => {
  const { useAgentPanelStore } =
    await import("@/stores/agent-panel/agent-panel-store");
  const mount = () =>
    renderHook(() => {
      const [draft, setDraft] = useState<EvalDraft | null>({
        title: "Untitled",
        steps: [],
      });
      return useEvalAgentDraft({
        projectId: "describe-project",
        suiteId: "suite",
        suiteName: "Suite",
        caseId: "draft:describe",
        draft,
        setDraft,
        tools: [],
        autoOpen: true,
      });
    });
  const first = mount();
  const firstSession = useAgentPanelStore.getState().activeSessionId;
  act(() => useAgentPanelStore.getState().setOpen(false));
  act(() => first.result.current.open());
  expect(useAgentPanelStore.getState().activeSessionId).toBe(firstSession);
  first.unmount();
  const second = mount();
  expect(useAgentPanelStore.getState().activeSessionId).not.toBe(firstSession);
  second.unmount();
});
