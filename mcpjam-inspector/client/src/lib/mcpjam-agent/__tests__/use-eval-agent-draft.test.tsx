import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEvalAgentDraft } from "../use-eval-agent-draft";
import {
  getEvalDraft,
  parseDraftPatch,
  type EvalDraft,
} from "../eval-workspace";

describe("eval draft edits", () => {
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
