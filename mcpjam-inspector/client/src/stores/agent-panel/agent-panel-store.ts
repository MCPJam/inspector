/**
 * MCPJam Agent side-panel state.
 *
 * Persists `isOpen`, `width`, `activeSessionId`, and `activeSessionProjectId`
 * to localStorage so the panel survives page reloads and stays open across
 * navigation. A `storage` listener mirrors changes from other tabs so opening
 * the agent in one tab is reflected in others (matches `recent-sessions.ts`).
 *
 * The active session id is a uuid minted client-side and also persisted
 * server-side via the existing chat-history flow — this store only owns the
 * "which session is selected in the panel" pointer, not the transcript.
 *
 * `activeSessionProjectId` carries the owning project so render and effect
 * code can detect cross-project pointers (cross-tab sync, fresh reload into
 * a different active project) and avoid hydrating a session against the
 * wrong project.
 */
import { create } from "zustand";

export const AGENT_PANEL_STORAGE_KEY = "mcpjam:agent-panel:v1";
export const AGENT_PANEL_MIN_WIDTH = 360;
export const AGENT_PANEL_DEFAULT_WIDTH = 420;

export interface AgentPanelState {
  isOpen: boolean;
  width: number;
  activeSessionId: string | null;
  activeSessionProjectId: string | null;
  setOpen: (next: boolean) => void;
  toggle: () => void;
  setWidth: (next: number) => void;
  setActiveSession: (id: string | null, projectId: string | null) => void;
}

interface PersistedShape {
  isOpen?: unknown;
  width?: unknown;
  activeSessionId?: unknown;
  activeSessionProjectId?: unknown;
}

function isWindowAvailable(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

function clampWidth(raw: number): number {
  if (!Number.isFinite(raw)) return AGENT_PANEL_DEFAULT_WIDTH;
  const max =
    typeof window !== "undefined" && window.innerWidth > 0
      ? Math.floor(window.innerWidth * 0.5)
      : Number.POSITIVE_INFINITY;
  const lowerBounded = Math.max(AGENT_PANEL_MIN_WIDTH, raw);
  return Math.min(lowerBounded, max);
}

interface LoadedState {
  isOpen: boolean;
  width: number;
  activeSessionId: string | null;
  activeSessionProjectId: string | null;
}

function loadPersisted(): LoadedState {
  const fallback: LoadedState = {
    isOpen: false,
    width: AGENT_PANEL_DEFAULT_WIDTH,
    activeSessionId: null,
    activeSessionProjectId: null,
  };
  if (!isWindowAvailable()) return fallback;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || typeof parsed !== "object") return fallback;
    const sessionId =
      typeof parsed.activeSessionId === "string"
        ? parsed.activeSessionId
        : null;
    const sessionProjectId =
      typeof parsed.activeSessionProjectId === "string"
        ? parsed.activeSessionProjectId
        : null;
    return {
      isOpen: parsed.isOpen === true,
      width:
        typeof parsed.width === "number"
          ? clampWidth(parsed.width)
          : AGENT_PANEL_DEFAULT_WIDTH,
      // A v1-shape entry has a sessionId but no sessionProjectId. Treat that
      // as a cross-project pointer (we don't know its project) and drop it
      // rather than hydrate it against the wrong project.
      activeSessionId: sessionProjectId ? sessionId : null,
      activeSessionProjectId: sessionProjectId,
    };
  } catch {
    return fallback;
  }
}

function persist(state: LoadedState): void {
  if (!isWindowAvailable()) return;
  try {
    window.localStorage.setItem(
      AGENT_PANEL_STORAGE_KEY,
      JSON.stringify({
        isOpen: state.isOpen,
        width: state.width,
        activeSessionId: state.activeSessionId,
        activeSessionProjectId: state.activeSessionProjectId,
      })
    );
  } catch {
    // Quota/disabled — silently skip; panel will revert to defaults next load.
  }
}

const initial = loadPersisted();

export const useAgentPanelStore = create<AgentPanelState>((set, get) => ({
  isOpen: initial.isOpen,
  width: initial.width,
  activeSessionId: initial.activeSessionId,
  activeSessionProjectId: initial.activeSessionProjectId,
  setOpen: (next) => {
    if (get().isOpen === next) return;
    const current = get();
    persist({ ...current, isOpen: next });
    set({ isOpen: next });
  },
  toggle: () => {
    const next = !get().isOpen;
    const current = get();
    persist({ ...current, isOpen: next });
    set({ isOpen: next });
  },
  setWidth: (next) => {
    const clamped = clampWidth(next);
    if (get().width === clamped) return;
    const current = get();
    persist({ ...current, width: clamped });
    set({ width: clamped });
  },
  setActiveSession: (id, projectId) => {
    // Clearing collapses both fields so a stale projectId never lingers.
    const nextId = id;
    const nextProjectId = id === null ? null : projectId;
    const current = get();
    if (
      current.activeSessionId === nextId &&
      current.activeSessionProjectId === nextProjectId
    ) {
      return;
    }
    persist({
      ...current,
      activeSessionId: nextId,
      activeSessionProjectId: nextProjectId,
    });
    set({
      activeSessionId: nextId,
      activeSessionProjectId: nextProjectId,
    });
  },
}));

if (isWindowAvailable()) {
  window.addEventListener("storage", (event) => {
    if (event.key !== AGENT_PANEL_STORAGE_KEY) return;
    const next = loadPersisted();
    const current = useAgentPanelStore.getState();
    if (
      current.isOpen === next.isOpen &&
      current.width === next.width &&
      current.activeSessionId === next.activeSessionId &&
      current.activeSessionProjectId === next.activeSessionProjectId
    ) {
      return;
    }
    useAgentPanelStore.setState({
      isOpen: next.isOpen,
      width: next.width,
      activeSessionId: next.activeSessionId,
      activeSessionProjectId: next.activeSessionProjectId,
    });
  });

  // Re-clamp width when the viewport shrinks. Without this, a width persisted
  // at a larger viewport size would exceed the 50vw cap and overflow the main
  // layout. `setWidth` is a no-op when the clamped value equals the current
  // one, so this is cheap when the viewport grows or stays the same.
  window.addEventListener("resize", () => {
    const { width, setWidth } = useAgentPanelStore.getState();
    setWidth(width);
  });
}
