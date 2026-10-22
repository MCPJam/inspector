import { createStore } from "zustand/vanilla";
import {
  isAppRelativeTarget,
  isProjectIdShape,
  readProjectPathSegment,
} from "../project-route";
import { authCorrelationId } from "./correlation-id";

const KEY = "mcpjam.project-transition.v1";
export const PROJECT_TRANSITION_TTL_MS = 30 * 60 * 1000;
export type ProjectTransition = {
  path: string;
  requestedProjectId: string;
  attempt: string;
  storedAt: number;
  sourceActor: string;
};

function valid(value: unknown): value is ProjectTransition {
  if (!value || typeof value !== "object") return false;
  const m = value as ProjectTransition;
  return (
    typeof m.sourceActor === "string" &&
    /^(guest|workos):.{1,200}$/.test(m.sourceActor) &&
    typeof m.path === "string" &&
    isAppRelativeTarget(m.path) &&
    typeof m.requestedProjectId === "string" &&
    isProjectIdShape(m.requestedProjectId) &&
    readProjectPathSegment(m.path) === m.requestedProjectId &&
    typeof m.attempt === "string" &&
    /^[a-zA-Z0-9-]{1,80}$/.test(m.attempt) &&
    Number.isFinite(m.storedAt) &&
    m.storedAt <= Date.now() + 1000 &&
    Date.now() - m.storedAt < PROJECT_TRANSITION_TTL_MS
  );
}

/** Per-tab provenance: an ordinary newly opened link never arms recovery. */
export function createProjectTransitionRecovery(
  storage: () => Storage = () => sessionStorage,
) {
  let initial: ProjectTransition | null = null;
  try {
    const saved: unknown = JSON.parse(storage().getItem(KEY) ?? "null");
    if (valid(saved)) initial = saved;
    else storage().removeItem(KEY);
  } catch {
    /* Storage is optional; same-page recovery still works. */
  }
  const store = createStore<{ marker: ProjectTransition | null }>(() => ({
    marker: initial,
  }));
  let opened: { path: string; actor: string } | null = null;
  const clear = (attempt?: string) => {
    if (attempt && store.getState().marker?.attempt !== attempt) return;
    store.setState({ marker: null });
    try {
      storage().removeItem(KEY);
    } catch {
      /* Best effort. */
    }
  };
  const arm = (path: string, attempt = authCorrelationId()) => {
    if (!opened || opened.path !== path) return;
    const existing = store.getState().marker;
    if (existing?.path === path && valid(existing)) return;
    const requestedProjectId = readProjectPathSegment(path);
    const marker = {
      path,
      requestedProjectId,
      attempt,
      storedAt: Date.now(),
      sourceActor: opened.actor,
    };
    if (!valid(marker)) return;
    opened = null;
    // Persist before the app is unmounted or the browser reloads.
    try {
      storage().setItem(KEY, JSON.stringify(marker));
    } catch {
      /* Use memory. */
    }
    store.setState({ marker });
  };
  return {
    store,
    clear,
    arm,
    isValid: valid,
    remember(path: string, actor: string) {
      opened = { path, actor };
    },
    observeActor(actor: string, path: string) {
      if (opened && opened.actor !== actor) {
        // Only sign-in/account replacement; logout uses its existing routing.
        if (actor.startsWith("workos:")) arm(path);
        opened = null;
      }
    },
  };
}

export const projectTransitionRecovery = createProjectTransitionRecovery();
export function currentProjectTransitionPath() {
  return (
    window.location.pathname + window.location.search + window.location.hash
  );
}
