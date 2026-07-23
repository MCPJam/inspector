import { generateId } from "ai";
import type { GuidedTourConcept } from "@/components/lifecycle/learning-concepts";
import { appendRecentMcpjamAgentSession } from "@/components/mcpjam-agent/recent-sessions";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { track } from "@/lib/analytics";
import { writePendingAgentPrompt } from "./pending-prompt";
import { writeTourSystemPrompt } from "./tour-session-prompt";

/**
 * Launches a Learning-tab guided tour: mints a fresh agent chat session, stows
 * the tour's instructions in the per-session system-prompt registry, seeds a
 * short "Start the tour: …" first message, and opens the always-mounted agent
 * side panel to it. `McpjamAgentThread` consumes the seeded message and
 * autosubmits it on mount, so the agent begins the tour on its own.
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
   * of the seeded thread. The `"none"` sentinel (and null/empty) count as "no
   * project" and take the skip path.
   */
  projectId: string | null;
}

/** The no-project sentinel `activeProjectId` can carry, alongside null. */
const NO_PROJECT_SENTINEL = "none";

// Remembers the most recent launch so a double-click (or re-clicking the same
// tour while its session is still active) refocuses that session instead of
// minting a duplicate — a duplicate would burn a fresh model turn re-running
// the tour. Clicking a *different* tour intentionally mints a new session; the
// previous chat instance survives in the hoisted instance map and is
// recoverable from Recent Chats.
//
// The refocus guard keeps two dedup records and trusts neither by priority —
// it asks which one (if any) identifies the panel's CURRENTLY active session:
//   - localStorage: the cross-tab record, kept in step with the panel store's
//     own localStorage-persisted `activeSessionId`. Fresh across tabs/reloads,
//     but can go stale in-tab when a write fails (reads still return the old
//     value).
//   - In-memory module var: fresh in this tab even when storage is disabled or
//     write-blocked, but blind to what other tabs did.
// Because either can be stale in some failure mode, we refocus only when one of
// them matches `panel.activeSessionId` — the authoritative "what's open now".
// A genuinely concurrent cross-tab race (two tabs clicking the SAME tour within
// the same tick) can still mint twice — that is the same cross-tab semantics
// the panel store itself has; a distributed claim/lock is not worth it for a
// tutorial launch whose only cost is a duplicate chat.
const LAST_LAUNCH_KEY = "mcpjam:agent-tour-last-launch:v1";

interface LastLaunch {
  tourId: string;
  sessionId: string;
  projectId: string;
}

let inMemoryLastLaunch: LastLaunch | null = null;

function readPersistedLastLaunch(): LastLaunch | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_LAUNCH_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<LastLaunch>;
    if (
      p &&
      typeof p.tourId === "string" &&
      typeof p.sessionId === "string" &&
      typeof p.projectId === "string"
    ) {
      return { tourId: p.tourId, sessionId: p.sessionId, projectId: p.projectId };
    }
    return null;
  } catch {
    return null;
  }
}

function writeLastLaunch(value: LastLaunch): void {
  inMemoryLastLaunch = value;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_LAUNCH_KEY, JSON.stringify(value));
  } catch {
    // Quota/disabled storage — the in-memory layer still dedups within this
    // tab; only cross-reload/cross-tab dedup is lost. Worst case is a
    // duplicate session, not data loss.
  }
}

export function launchLessonSession({
  tour,
  projectId,
}: LaunchLessonOptions): boolean {
  // Normalize the no-project states ("none" is truthy but not a real project)
  // to null so the skip path and session scoping agree. Guest ids (synthetic
  // UUID / local_ / project_) are real projects and pass through untouched.
  const resolvedProjectId =
    projectId && projectId !== NO_PROJECT_SENTINEL ? projectId : null;

  if (!resolvedProjectId) {
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

  // Does this dedup record describe the session the panel currently has open,
  // for this tour and project? Only then is refocusing correct.
  const identifiesActiveSession = (record: LastLaunch | null): boolean =>
    record !== null &&
    record.tourId === tour.id &&
    record.projectId === resolvedProjectId &&
    record.sessionId === panel.activeSessionId &&
    panel.activeSessionProjectId === resolvedProjectId;

  if (
    identifiesActiveSession(readPersistedLastLaunch()) ||
    identifiesActiveSession(inMemoryLastLaunch)
  ) {
    // The tour's session is still the active panel session — just bring the
    // panel back into view. If the project changed or the panel moved on to a
    // different session, fall through and mint a fresh session scoped to the
    // current project (else the panel's project gate shows the empty hero, or
    // we'd re-seed over a live chat).
    panel.setOpen(true);
    return true;
  }

  const sessionId = generateId();

  // The tour's instructions ride in the request system prompt (the agent
  // transport's body() re-reads this registry on every POST of the session);
  // the visible, autosubmitted first message stays short and natural.
  writeTourSystemPrompt(sessionId, {
    tourId: tour.id,
    systemPrompt: tour.agentSystemPrompt,
  });

  // Order matters: write the pending prompt BEFORE setActiveSession (which
  // mounts the thread) so the thread's synchronous optimistic-bubble peek sees
  // it, then setActiveSession before setOpen to match the handoff and avoid a
  // one-frame hero flash in the opening panel.
  writePendingAgentPrompt(sessionId, `Start the tour: ${tour.title}`);

  // Pre-seed the recents title so the Recent Chats pill reads "Tour: <title>"
  // instead of the first 50 chars of the lesson prompt (the thread's submit
  // keeps an existing title when present). This is cosmetic and reads
  // localStorage unguarded (`loadRecentMcpjamAgentSessions`), which can throw
  // where storage access is denied — never let it abort the launch.
  try {
    appendRecentMcpjamAgentSession({
      id: sessionId,
      title: `Tour: ${tour.title}`,
      ts: Date.now(),
    });
  } catch {
    // Recents pill just won't show this session's friendly title.
  }

  panel.setActiveSession(sessionId, resolvedProjectId);
  panel.setOpen(true);

  track("mcpjam_agent_tour_launched", {
    location: "learning_tab",
    tour_id: tour.id,
    session_id: sessionId,
    estimated_minutes: tour.estimatedMinutes,
    prompt_length: tour.agentSystemPrompt.length,
  });

  writeLastLaunch({ tourId: tour.id, sessionId, projectId: resolvedProjectId });
  return true;
}

/** Test-only: clears both refocus-memory layers between cases. */
export function __resetLaunchLessonForTests(): void {
  inMemoryLastLaunch = null;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LAST_LAUNCH_KEY);
  } catch {
    // ignore
  }
}
