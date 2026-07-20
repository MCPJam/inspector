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

  it("still activates the session when sessionStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const ok = launchLessonSession({ tour: TOUR, projectId: "proj-1" });
    expect(ok).toBe(true);
    expect(useAgentPanelStore.getState().activeSessionId).toBe("sess-1");
  });
});
