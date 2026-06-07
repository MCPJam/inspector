/**
 * MCPJam Agent side-panel state.
 *
 * Persists `isOpen`, `width`, and `activeSessionId` to localStorage so the
 * panel survives page reloads and stays open across navigation. A `storage`
 * listener mirrors changes from other tabs so opening the agent in one tab
 * is reflected in others (matches `recent-sessions.ts`).
 *
 * The active session id is a uuid minted client-side and also persisted
 * server-side via the existing chat-history flow — this store only owns the
 * "which session is selected in the panel" pointer, not the transcript.
 */
import { create } from "zustand";

export const AGENT_PANEL_STORAGE_KEY = "mcpjam:agent-panel:v1";
export const AGENT_PANEL_MIN_WIDTH = 360;
export const AGENT_PANEL_DEFAULT_WIDTH = 420;

export interface AgentPanelState {
  isOpen: boolean;
  width: number;
  activeSessionId: string | null;
  setOpen: (next: boolean) => void;
  toggle: () => void;
  setWidth: (next: number) => void;
  setActiveSessionId: (id: string | null) => void;
}

interface PersistedShape {
  isOpen?: unknown;
  width?: unknown;
  activeSessionId?: unknown;
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

function loadPersisted(): {
  isOpen: boolean;
  width: number;
  activeSessionId: string | null;
} {
  const fallback = {
    isOpen: false,
    width: AGENT_PANEL_DEFAULT_WIDTH,
    activeSessionId: null as string | null,
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
    return {
      isOpen: parsed.isOpen === true,
      width:
        typeof parsed.width === "number"
          ? clampWidth(parsed.width)
          : AGENT_PANEL_DEFAULT_WIDTH,
      activeSessionId:
        typeof parsed.activeSessionId === "string"
          ? parsed.activeSessionId
          : null,
    };
  } catch {
    return fallback;
  }
}

function persist(state: {
  isOpen: boolean;
  width: number;
  activeSessionId: string | null;
}): void {
  if (!isWindowAvailable()) return;
  try {
    window.localStorage.setItem(
      AGENT_PANEL_STORAGE_KEY,
      JSON.stringify({
        isOpen: state.isOpen,
        width: state.width,
        activeSessionId: state.activeSessionId,
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
  setOpen: (next) => {
    if (get().isOpen === next) return;
    const state = { ...get(), isOpen: next };
    persist(state);
    set({ isOpen: next });
  },
  toggle: () => {
    const next = !get().isOpen;
    const state = { ...get(), isOpen: next };
    persist(state);
    set({ isOpen: next });
  },
  setWidth: (next) => {
    const clamped = clampWidth(next);
    if (get().width === clamped) return;
    const state = { ...get(), width: clamped };
    persist(state);
    set({ width: clamped });
  },
  setActiveSessionId: (id) => {
    if (get().activeSessionId === id) return;
    const state = { ...get(), activeSessionId: id };
    persist(state);
    set({ activeSessionId: id });
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
      current.activeSessionId === next.activeSessionId
    ) {
      return;
    }
    useAgentPanelStore.setState({
      isOpen: next.isOpen,
      width: next.width,
      activeSessionId: next.activeSessionId,
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
