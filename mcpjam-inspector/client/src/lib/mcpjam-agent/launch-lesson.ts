import { generateId } from "ai";
import type { GuidedTourConcept } from "@/components/lifecycle/learning-concepts";
import { appendRecentMcpjamAgentSession } from "@/components/mcpjam-agent/recent-sessions";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { track } from "@/lib/analytics";
import { writePendingAgentPrompt } from "./pending-prompt";

/**
 * Launches a Learning-tab guided tour: mints a fresh agent chat session seeded
 * with the tour's prompt and opens the always-mounted agent side panel to it.
 * `McpjamAgentThread` consumes the seeded prompt and autosubmits it on mount,
 * so the agent begins the tour on its own.
 *
 * This deliberately replicates the side panel's own session-start
 * (`AgentSidePanel.handleSessionStart`) and the home→panel handoff
 * (`maybeHandoffToPanel`) rather than routing anywhere: the same
 * pending-prompt write + `setActiveSession` + `setOpen` sequence, in the same
 * order (the write must precede `setActiveSession`, which is what mounts the
 * thread whose optimistic-bubble initializer peeks the key synchronously).
 *
 * Returns `true` if a session was launched or refocused, `false` if it was
 * skipped (no project id).
 */

interface LaunchLessonOptions {
  tour: GuidedTourConcept;
  /**
   * The active project id, from `useAppRouteContext().activeProjectId`. Guests
   * get a non-null synthetic id, so this is populated for them too; it must be
   * the same value the panel is scoped to (`AgentSidePanel`'s `projectId`
   * prop), or the panel's project-match gate would show the empty hero instead
   * of the seeded thread.
   */
  projectId: string | null;
}

// Remembers the most recent launch so a double-click (or re-clicking the same
// tour while its session is still active) refocuses that session instead of
// minting a duplicate — a duplicate would burn a fresh model turn re-running
// the tour. Clicking a *different* tour intentionally mints a new session; the
// previous chat instance survives in the hoisted instance map and is
// recoverable from Recent Chats.
let lastLaunch: { tourId: string; sessionId: string } | null = null;

export function launchLessonSession({
  tour,
  projectId,
}: LaunchLessonOptions): boolean {
  if (!projectId) {
    // Without a project id the panel-mount GC (AgentSidePanelMount) would clear
    // the session pointer immediately — same rationale as maybeHandoffToPanel's
    // null-project skip. Rare in practice: guests have a synthetic id.
    track("mcpjam_agent_tour_launch_skipped", {
      location: "learning_tab",
      tour_id: tour.id,
      reason: "no_project_id",
    });
    return false;
  }

  const panel = useAgentPanelStore.getState();

  if (
    lastLaunch?.tourId === tour.id &&
    panel.activeSessionId === lastLaunch.sessionId
  ) {
    // Same tour, session still active — just bring the panel back into view.
    panel.setOpen(true);
    return true;
  }

  const sessionId = generateId();

  // Order matters: write the pending prompt BEFORE setActiveSession (which
  // mounts the thread) so the thread's synchronous optimistic-bubble peek sees
  // it, then setActiveSession before setOpen to match the handoff and avoid a
  // one-frame hero flash in the opening panel.
  writePendingAgentPrompt(sessionId, tour.agentPrompt);

  // Pre-seed the recents title so the Recent Chats pill reads "Tour: <title>"
  // instead of the first 50 chars of the lesson prompt (the thread's submit
  // keeps an existing title when present).
  appendRecentMcpjamAgentSession({
    id: sessionId,
    title: `Tour: ${tour.title}`,
    ts: Date.now(),
  });

  panel.setActiveSession(sessionId, projectId);
  panel.setOpen(true);

  track("mcpjam_agent_tour_launched", {
    location: "learning_tab",
    tour_id: tour.id,
    session_id: sessionId,
    estimated_minutes: tour.estimatedMinutes,
    prompt_length: tour.agentPrompt.length,
  });

  lastLaunch = { tourId: tour.id, sessionId };
  return true;
}

/** Test-only: clears the same-tour refocus memory between cases. */
export function __resetLaunchLessonForTests(): void {
  lastLaunch = null;
}
