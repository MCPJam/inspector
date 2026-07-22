import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cable } from "lucide-react";
import type { GuidedTourConcept } from "@/components/lifecycle/learning-concepts";

// generateId: deterministic, incrementing so each real launch gets a distinct
// session id (and we can assert it was NOT called again on a refocus). The
// counter is reset per test so each starts at sess-1.
const { generateIdMock, idCounter } = vi.hoisted(() => {
  const idCounter = { n: 0 };
  return {
    generateIdMock: vi.fn(() => `sess-${++idCounter.n}`),
    idCounter,
  };
});
vi.mock("ai", () => ({ generateId: generateIdMock }));

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));

import {
  __resetLaunchLessonForTests,
  launchLessonSession,
} from "../launch-lesson";
import { pendingAgentPromptKey } from "../pending-prompt";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { loadRecentMcpjamAgentSessions } from "@/components/mcpjam-agent/recent-sessions";

const TOUR: GuidedTourConcept = {
  kind: "guided",
  id: "tour-eval-suite",
  title: "Create and run an eval suite",
  description: "desc",
  icon: Cable,
  category: "Guided tour",
  estimatedMinutes: 5,
  agentPrompt: "Give me a tour of evals.",
};

beforeEach(() => {
  __resetLaunchLessonForTests();
  idCounter.n = 0;
  generateIdMock.mockClear();
  window.sessionStorage.clear();
  window.localStorage.clear();
  useAgentPanelStore.setState({
    isOpen: false,
    activeSessionId: null,
    activeSessionProjectId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("launchLessonSession", () => {
  it("seeds the prompt and opens the panel to a fresh session", () => {
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    expect(ok).toBe(true);

    const raw = window.sessionStorage.getItem(pendingAgentPromptKey("sess-1"));
    expect(JSON.parse(raw as string)).toEqual({
      text: TOUR.agentPrompt,
      fresh: true,
    });

    const state = useAgentPanelStore.getState();
    expect(state.activeSessionId).toBe("sess-1");
    expect(state.activeSessionProjectId).toBe("proj-1");
    expect(state.isOpen).toBe(true);

    expect(loadRecentMcpjamAgentSessions()[0]).toMatchObject({
      id: "sess-1",
      title: "Tour: Create and run an eval suite",
    });

    expect(trackMock).toHaveBeenCalledWith(
      "mcpjam_agent_tour_launched",
      expect.objectContaining({
        location: "learning_tab",
        tour_id: "tour-eval-suite",
        session_id: "sess-1",
      }),
    );
  });

  it("writes the pending prompt BEFORE activating the session", () => {
    // The thread's optimistic-bubble initializer peeks the pending key
    // synchronously the moment setActiveSession mounts it — so the key must
    // already be present when setActiveSession fires.
    let pendingAtActivation: string | null = "UNSET";
    const real = useAgentPanelStore.getState().setActiveSession;
    vi.spyOn(useAgentPanelStore.getState(), "setActiveSession").mockImplementation(
      (id, projectId) => {
        pendingAtActivation = id
          ? window.sessionStorage.getItem(pendingAgentPromptKey(id))
          : null;
        real(id, projectId);
      },
    );

    launchLessonSession({ tour: TOUR, projectId: "proj-1" });

    expect(pendingAtActivation).not.toBeNull();
    expect(pendingAtActivation).not.toBe("UNSET");
    expect(JSON.parse(pendingAtActivation as string)).toEqual({
      text: TOUR.agentPrompt,
      fresh: true,
    });
  });

  it("skips (with telemetry) when there is no project id", () => {
    const ok = launchLessonSession({ tour: TOUR, projectId: null });
    expect(ok).toBe(false);
    expect(generateIdMock).not.toHaveBeenCalled();
    expect(useAgentPanelStore.getState().activeSessionId).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    expect(trackMock).toHaveBeenCalledWith(
      "mcpjam_agent_tour_launch_skipped",
      expect.objectContaining({ tour_id: "tour-eval-suite", reason: "no_project_id" }),
    );
  });

  it("treats the \"none\" sentinel as no project (skips, no session scoped to it)", () => {
    const ok = launchLessonSession({ tour: TOUR, projectId: "none" });
    expect(ok).toBe(false);
    expect(generateIdMock).not.toHaveBeenCalled();
    expect(useAgentPanelStore.getState().activeSessionId).toBeNull();
    expect(trackMock).toHaveBeenCalledWith(
      "mcpjam_agent_tour_launch_skipped",
      expect.objectContaining({ reason: "no_project_id" }),
    );
  });

  it("mints a fresh session when the same tour is re-clicked under a different project", () => {
    launchLessonSession({ tour: TOUR, projectId: "proj-A" });
    // Project switched since the first launch.
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-B" });

    expect(ok).toBe(true);
    expect(generateIdMock).toHaveBeenCalledTimes(2); // NOT a refocus
    const state = useAgentPanelStore.getState();
    expect(state.activeSessionId).toBe("sess-2");
    expect(state.activeSessionProjectId).toBe("proj-B");
  });

  it("refocuses (no duplicate session) when the same tour is re-clicked while active", () => {
    launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    useAgentPanelStore.setState({ isOpen: false }); // user closed the panel
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });

    expect(ok).toBe(true);
    expect(generateIdMock).toHaveBeenCalledTimes(1); // no new session minted
    const state = useAgentPanelStore.getState();
    expect(state.activeSessionId).toBe("sess-1");
    expect(state.isOpen).toBe(true); // re-opened
  });

  it("persists the last-launch record so dedup survives a reload", () => {
    launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    // The refocus guard reads from localStorage, not a module var, so a reload
    // (module re-eval, other tab) that keeps the panel's persisted
    // activeSessionId still dedups.
    expect(
      window.localStorage.getItem("mcpjam:agent-tour-last-launch:v1"),
    ).not.toBeNull();

    // Simulate a reload: the panel store still holds the persisted session,
    // but there is no in-memory launch state to rely on.
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    expect(ok).toBe(true);
    expect(generateIdMock).toHaveBeenCalledTimes(1); // still no duplicate
    expect(useAgentPanelStore.getState().activeSessionId).toBe("sess-1");
  });

  // NOTE: jsdom's window.localStorage/sessionStorage do NOT route through
  // Storage.prototype, so spying the prototype is a no-op. Spy the instances.

  it("still activates the session when sessionStorage.setItem throws", () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    expect(ok).toBe(true);
    expect(useAgentPanelStore.getState().activeSessionId).toBe("sess-1");
  });

  it("dedups a same-tab repeat click when localStorage cannot persist", () => {
    // Quota-full / write-disabled: the persisted layer reads empty and can't
    // write, so dedup must come from the in-memory fallback.
    vi.spyOn(window.localStorage, "getItem").mockReturnValue(null);
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });

    expect(ok).toBe(true);
    expect(generateIdMock).toHaveBeenCalledTimes(1); // no duplicate session
    expect(useAgentPanelStore.getState().activeSessionId).toBe("sess-1");
  });

  it("refocuses via the in-memory record when a stale persisted record lingers (writes failing)", () => {
    // A prior record is readable in localStorage, but writes now fail — so the
    // fresh launch only updates the in-memory record. Re-clicking must refocus
    // via in-memory rather than trust the stale persisted record and duplicate.
    window.localStorage.setItem(
      "mcpjam:agent-tour-last-launch:v1",
      JSON.stringify({ tourId: TOUR.id, sessionId: "stale", projectId: "proj-1" }),
    );
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    launchLessonSession({ tour: TOUR, projectId: "proj-1" }); // mints sess-1
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });

    expect(ok).toBe(true);
    expect(generateIdMock).toHaveBeenCalledTimes(1); // refocused, not duplicated
    expect(useAgentPanelStore.getState().activeSessionId).toBe("sess-1");
  });

  it("still launches when localStorage access throws (denied/privacy mode)", () => {
    // Every localStorage op throws — including the unguarded getItem inside
    // loadRecentMcpjamAgentSessions. The launch must survive it.
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    expect(ok).toBe(true);
    expect(useAgentPanelStore.getState().activeSessionId).toBe("sess-1");
  });
});
